import { Plugin } from "@opencode/plugin"
import { tool, type PluginModule, type ToolDefinition } from "@opencode-ai/plugin"
import { appendFile, mkdir, rename } from "node:fs/promises"
import { join } from "node:path"

const MEMORY_TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const

type MemoryType = typeof MEMORY_TYPES[number]

interface Memory {
  ts: string
  type: MemoryType
  scope: string
  content: string
  issue?: string
  tags?: string[]
}

interface MemoryEntry {
  memory: Memory
  filepath: string
  lineIndex: number
}

interface MemoryStore {
  dir: string
  ensureDir(): Promise<void>
  appendMemory(memory: Memory): Promise<void>
  appendDeletion(memory: Memory, reason: string): Promise<void>
  readEntries(): Promise<MemoryEntry[]>
  readDeletionLines(): Promise<string[]>
  rewriteFile(filepath: string, lines: string[]): Promise<void>
}

// A type alias (not an interface) so plugin options passed as a plain
// `Record<string, unknown>` by the V1 host convert cleanly.
type PluginOptions = {
  autoLoad?: boolean
  autoSave?: boolean
  autoHookTimeoutMs?: number
  contextLimit?: number
  contextMaxChars?: number
  contextMinScore?: number
  autoSaveScope?: string
}

interface ContextOptions {
  query?: string
  scope?: string
  tags?: string[]
  types?: MemoryType[]
  limit?: number
  maxChars?: number
  minScore?: number
}

const isMemoryType = (value: string): value is MemoryType => MEMORY_TYPES.includes(value as MemoryType)

const dateFromTs = (ts: string) => ts.split("T")[0] || new Date().toISOString().split("T")[0]!

const escapeValue = (value: string) => value
  .replace(/\\/g, "\\\\")
  .replace(/\n/g, "\\n")
  .replace(/\r/g, "\\r")
  .replace(/"/g, '\\"')

const unescapeValue = (value: string) => {
  let result = ""
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== "\\") {
      result += char
      continue
    }

    const next = value[++i]
    if (next === "n") result += "\n"
    else if (next === "r") result += "\r"
    else if (next === '"') result += '"'
    else if (next === "\\") result += "\\"
    else if (next !== undefined) result += `\\${next}`
  }
  return result
}

const needsQuotes = (value: string) => value === "" || /\s|"|\\/.test(value)

const field = (key: string, value: string, alwaysQuote = false) => {
  if (!alwaysQuote && !needsQuotes(value)) return `${key}=${value}`
  return `${key}="${escapeValue(value)}"`
}

const parseFields = (line: string): Record<string, string> => {
  const fields: Record<string, string> = {}
  let index = 0

  while (index < line.length) {
    while (line[index] === " ") index++

    const keyStart = index
    while (index < line.length && line[index] !== "=" && line[index] !== " ") index++
    const key = line.slice(keyStart, index)
    if (!key || line[index] !== "=") break
    index++

    if (line[index] === '"') {
      index++
      let value = ""
      while (index < line.length) {
        const char = line[index]
        if (char === '"') {
          index++
          break
        }
        if (char === "\\" && index + 1 < line.length) {
          value += char + line[index + 1]
          index += 2
          continue
        }
        value += char
        index++
      }
      fields[key] = unescapeValue(value)
      continue
    }

    const valueStart = index
    while (index < line.length && line[index] !== " ") index++
    fields[key] = line.slice(valueStart, index)
  }

  return fields
}

const parseLine = (line: string): Memory | null => {
  const fields = parseFields(line)
  const { ts, type, scope } = fields

  if (!ts || !type || !scope || !isMemoryType(type)) return null

  return {
    ts,
    type,
    scope,
    content: fields.content || "",
    issue: fields.issue,
    tags: fields.tags ? fields.tags.split(",").filter(Boolean) : undefined,
  }
}

const encodeMemory = (memory: Memory): string => {
  const parts = [
    field("ts", memory.ts),
    field("type", memory.type),
    field("scope", memory.scope),
    field("content", memory.content, true),
  ]

  if (memory.issue) parts.push(field("issue", memory.issue))
  if (memory.tags?.length) parts.push(field("tags", memory.tags.join(",")))

  return parts.join(" ")
}

const encodeDeletion = (memory: Memory, reason: string): string => {
  const parts = [
    field("ts", new Date().toISOString()),
    field("action", "deleted"),
    field("original_ts", memory.ts),
    field("type", memory.type),
    field("scope", memory.scope),
    field("content", memory.content, true),
    field("reason", reason, true),
  ]

  if (memory.issue) parts.push(field("issue", memory.issue))
  if (memory.tags?.length) parts.push(field("tags", memory.tags.join(",")))

  return parts.join(" ")
}

const formatMemory = (memory: Memory): string => {
  const date = dateFromTs(memory.ts)
  const tags = memory.tags?.length ? ` [${memory.tags.join(", ")}]` : ""
  const issue = memory.issue ? ` (${memory.issue})` : ""
  return `[${date}] ${memory.type}/${memory.scope}: ${memory.content}${issue}${tags}`
}

const scoreMatch = (memory: Memory, words: string[]): number => {
  const searchable = `${memory.type} ${memory.scope} ${memory.content} ${memory.tags?.join(" ") || ""}`.toLowerCase()
  let score = 0
  for (const word of words) {
    if (searchable.includes(word)) score++
    if (memory.scope.toLowerCase() === word) score += 2
    if (memory.type.toLowerCase() === word) score += 2
    if (memory.tags?.some((tag) => tag.toLowerCase() === word)) score += 2
  }
  return score
}

const typePriority: Record<MemoryType, number> = {
  preference: 6,
  decision: 5,
  blocker: 4,
  pattern: 3,
  context: 2,
  learning: 1,
}

const truncate = (value: string, maxLength: number) => {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

const buildContextPack = (memories: Memory[], options: ContextOptions) => {
  const query = options.query?.trim()
  const words = query?.toLowerCase().split(/\s+/).filter(Boolean) || []
  const minScore = options.minScore ?? (query ? 1 : 0)
  const maxChars = options.maxChars && options.maxChars > 0 ? Math.floor(options.maxChars) : 1200
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 5
  let results = memories

  if (options.scope) results = results.filter((memory) => matchesScope(memory, options.scope!, "contains"))
  if (options.types?.length) results = results.filter((memory) => options.types!.includes(memory.type))
  if (options.tags?.length) {
    const tags = options.tags.map((tag) => tag.toLowerCase())
    results = results.filter((memory) => {
      const memoryTags = memory.tags?.map((tag) => tag.toLowerCase()) || []
      return tags.every((tag) => memoryTags.includes(tag))
    })
  }

  const ranked = results
    .map((memory) => ({
      memory,
      score: words.length ? scoreMatch(memory, words) : 0,
    }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => {
      const priority = typePriority[b.memory.type] - typePriority[a.memory.type]
      return b.score - a.score || priority || b.memory.ts.localeCompare(a.memory.ts)
    })
    .slice(0, limit)

  if (!ranked.length) return ""

  const lines = ["Relevant Memory:"]
  let used = lines[0]!.length + 1

  for (const { memory } of ranked) {
    const prefix = `- ${memory.type}/${memory.scope}: `
    const remaining = maxChars - used - prefix.length
    if (remaining <= 20) break

    const line = `${prefix}${truncate(memory.content, Math.min(remaining, 260))}`
    lines.push(line)
    used += line.length + 1
  }

  return lines.length > 1 ? lines.join("\n") : ""
}

const textFromParts = (parts: unknown[]) => parts
  .map((part) => {
    if (typeof part !== "object" || !part) return ""
    if (!("type" in part) || part.type !== "text") return ""
    if (!("text" in part) || typeof part.text !== "string") return ""
    return part.text
  })
  .filter(Boolean)
  .join("\n")
  .trim()

const inferExplicitMemory = (text: string, defaultScope: string): Omit<Memory, "ts"> | null => {
  if (/\b(don't|do not|dont)\s+remember\b/i.test(text)) return null

  const match = text.match(/(?:^|\b)(?:please\s+)?remember(?:\s+that|:)?\s+([\s\S]+)$/i)
  const content = match?.[1]?.trim()
  if (!content) return null

  const lower = content.toLowerCase()
  const type: MemoryType = lower.includes("prefer")
    ? "preference"
    : lower.includes("decided") || lower.includes("decision")
      ? "decision"
      : lower.includes("blocked") || lower.includes("blocker")
        ? "blocker"
        : lower.includes("pattern") || lower.includes("always")
          ? "pattern"
          : "context"

  return {
    type,
    scope: defaultScope,
    content,
    tags: ["auto"],
  }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const createStore = (dir: string): MemoryStore => ({
  dir,
  async ensureDir() {
    await mkdir(dir, { recursive: true })
  },
  async appendMemory(memory) {
    await this.ensureDir()
    await appendFile(join(dir, `${dateFromTs(memory.ts)}.logfmt`), `${encodeMemory(memory)}\n`, "utf8")
  },
  async appendDeletion(memory, reason) {
    await this.ensureDir()
    await appendFile(join(dir, "deletions.logfmt"), `${encodeDeletion(memory, reason)}\n`, "utf8")
  },
  async readEntries() {
    await this.ensureDir()
    const glob = new Bun.Glob("*.logfmt")
    const files = (await Array.fromAsync(glob.scan(dir)))
      .filter((filename) => filename !== "deletions.logfmt")
      .sort()
    const entries: MemoryEntry[] = []

    for (const filename of files) {
      const filepath = join(dir, filename)
      const file = Bun.file(filepath)
      const text = await file.text()
      const lines = text.split("\n")

      lines.forEach((line, lineIndex) => {
        const memory = parseLine(line)
        if (memory) entries.push({ memory, filepath, lineIndex })
      })
    }

    return entries.sort((a, b) => a.memory.ts.localeCompare(b.memory.ts))
  },
  async readDeletionLines() {
    const file = Bun.file(join(dir, "deletions.logfmt"))
    if (!(await file.exists())) return []
    return (await file.text()).trim().split("\n").filter(Boolean)
  },
  async rewriteFile(filepath, lines) {
    await this.ensureDir()
    const tmp = `${filepath}.${crypto.randomUUID()}.tmp`
    await Bun.write(tmp, lines.length ? `${lines.join("\n")}\n` : "")
    await rename(tmp, filepath)
  },
})

const matchesScope = (memory: Memory, scope: string, mode: "contains" | "exact" | "prefix") => {
  if (mode === "exact") return memory.scope === scope
  if (mode === "prefix") return memory.scope.startsWith(scope)
  return memory.scope === scope || memory.scope.includes(scope)
}

const startOfDateFilter = (value: string) => value.includes("T") ? value : `${value}T00:00:00.000Z`

const endOfDateFilter = (value: string) => value.includes("T") ? value : `${value}T23:59:59.999Z`

const filterMemories = (
  memories: Memory[],
  args: {
    scope?: string
    type?: MemoryType
    query?: string
    tags?: string[]
    since?: string
    until?: string
    match?: "contains" | "exact" | "prefix"
  },
) => {
  let results = memories
  const match = args.match || "contains"

  if (args.scope) results = results.filter((memory) => matchesScope(memory, args.scope!, match))
  if (args.type) results = results.filter((memory) => memory.type === args.type)
  if (args.tags?.length) {
    const tags = args.tags.map((tag) => tag.toLowerCase())
    results = results.filter((memory) => {
      const memoryTags = memory.tags?.map((tag) => tag.toLowerCase()) || []
      return tags.every((tag) => memoryTags.includes(tag))
    })
  }
  if (args.since) {
    const since = startOfDateFilter(args.since)
    results = results.filter((memory) => memory.ts >= since)
  }
  if (args.until) {
    const until = endOfDateFilter(args.until)
    results = results.filter((memory) => memory.ts <= until)
  }

  if (!args.query) return results

  const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
  return results
    .map((memory) => ({ memory, score: scoreMatch(memory, words) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.ts.localeCompare(a.memory.ts))
    .map((item) => item.memory)
}

const chooseUpdateTarget = (matches: MemoryEntry[], query?: string) => {
  if (matches.length <= 1) return { target: matches[0], message: undefined }
  if (!query) {
    return {
      target: undefined,
      message: `Found ${matches.length} memories for ${matches[0]!.memory.type}/${matches[0]!.memory.scope}. Provide a query to select which one to update, or use recall to see all matches.`,
    }
  }

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = matches
    .map((entry) => ({ ...entry, score: scoreMatch(entry.memory, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.ts.localeCompare(a.memory.ts))

  if (!scored.length) {
    return {
      target: undefined,
      message: `Found ${matches.length} memories for ${matches[0]!.memory.type}/${matches[0]!.memory.scope}, but none matched query "${query}". Use recall to see all matches.`,
    }
  }

  return { target: scored[0], message: undefined }
}

const createTools = (store: MemoryStore) => {
  const remember = tool({
    description: "Store a memory (decision, learning, preference, blocker, context, pattern)",
    args: {
      type: tool.schema.enum(MEMORY_TYPES).describe("Type of memory"),
      scope: tool.schema.string().describe("Scope/area (e.g., auth, api, mobile)"),
      content: tool.schema.string().describe("The memory content"),
      issue: tool.schema.string().optional().describe("Related GitHub issue (e.g., #51)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Additional tags"),
    },
    async execute(args) {
      await store.appendMemory({
        ts: new Date().toISOString(),
        type: args.type,
        scope: args.scope.trim(),
        content: args.content,
        issue: args.issue?.trim() || undefined,
        tags: args.tags?.map((tag) => tag.trim()).filter(Boolean),
      })

      return `Remembered: ${args.type} in ${args.scope}`
    },
  })

  const recall = tool({
    description: "Retrieve memories by scope, type, tag, date, or search query",
    args: {
      scope: tool.schema.string().optional().describe("Filter by scope"),
      type: tool.schema.enum(MEMORY_TYPES).optional().describe("Filter by type"),
      query: tool.schema.string().optional().describe("Search term (space-separated words, matches any)"),
      limit: tool.schema.number().optional().describe("Max results (default 20)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Only include memories with all of these tags"),
      since: tool.schema.string().optional().describe("Only include memories at or after this ISO timestamp/date"),
      until: tool.schema.string().optional().describe("Only include memories at or before this ISO timestamp/date"),
      match: tool.schema.enum(["contains", "exact", "prefix"]).optional().describe("Scope match mode (default contains, matching earlier behavior)"),
    },
    async execute(args) {
      const memories = (await store.readEntries()).map((entry) => entry.memory)

      if (!memories.length) return "No memories found"

      const totalCount = memories.length
      const results = filterMemories(memories, args)
      const filteredCount = results.length
      const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 20
      const limited = args.query ? results.slice(0, limit) : results.slice(-limit)

      if (!limited.length) return "No matching memories"

      const header = filteredCount > limit
        ? `Found ${filteredCount} memories (showing ${args.query ? "best" : "last"} ${limit} of ${totalCount} total)\n\n`
        : filteredCount !== totalCount
          ? `Found ${filteredCount} memories (${totalCount} total)\n\n`
          : `Found ${filteredCount} memories\n\n`

      return header + limited.map(formatMemory).join("\n")
    },
  })

  const update = tool({
    description: "Update an existing memory by scope and type (finds matching memory and updates its content)",
    args: {
      scope: tool.schema.string().describe("Scope of memory to update"),
      type: tool.schema.enum(MEMORY_TYPES).describe("Type of memory"),
      content: tool.schema.string().describe("The new content for the memory"),
      query: tool.schema.string().optional().describe("Search term to find specific memory if multiple exist"),
      issue: tool.schema.string().optional().describe("Update related GitHub issue (e.g., #51)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Update tags"),
    },
    async execute(args) {
      const matches = (await store.readEntries()).filter((entry) => entry.memory.scope === args.scope && entry.memory.type === args.type)

      if (!matches.length) return `No memories found for ${args.type} in ${args.scope}`

      const { target, message } = chooseUpdateTarget(matches, args.query)
      if (message) return message
      if (!target) return `No memories found for ${args.type} in ${args.scope}`

      await store.appendDeletion(target.memory, `Updated to: ${args.content}`)

      const file = Bun.file(target.filepath)
      const lines = (await file.text()).split("\n")
      lines[target.lineIndex] = encodeMemory({
        ts: new Date().toISOString(),
        type: args.type,
        scope: args.scope,
        content: args.content,
        issue: args.issue !== undefined ? args.issue : target.memory.issue,
        tags: args.tags !== undefined ? args.tags : target.memory.tags,
      })
      await store.rewriteFile(target.filepath, lines.filter((line) => line.length > 0))

      return `Updated ${args.type} in ${args.scope}: "${args.content}"`
    },
  })

  const listMemories = tool({
    description: "List all unique scopes and types in memory for discovery",
    args: {},
    async execute() {
      const memories = (await store.readEntries()).map((entry) => entry.memory)

      if (!memories.length) return "No memories found"

      const scopes = new Map<string, number>()
      const types = new Map<string, number>()
      const scopeTypes = new Map<string, Set<string>>()

      for (const memory of memories) {
        scopes.set(memory.scope, (scopes.get(memory.scope) || 0) + 1)
        types.set(memory.type, (types.get(memory.type) || 0) + 1)
        if (!scopeTypes.has(memory.scope)) scopeTypes.set(memory.scope, new Set())
        scopeTypes.get(memory.scope)!.add(memory.type)
      }

      const blockers = memories.filter((memory) => memory.type === "blocker")
      const lines = [`Total memories: ${memories.length}`, "", "Scopes:"]
      for (const [scope, count] of [...scopes.entries()].sort((a, b) => b[1] - a[1])) {
        const typeList = [...scopeTypes.get(scope)!].join(", ")
        lines.push(`  ${scope}: ${count} (${typeList})`)
      }
      lines.push("", "Types:")
      for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${type}: ${count}`)
      }
      if (blockers.length) lines.push("", `Open blockers: ${blockers.length}`)

      return lines.join("\n")
    },
  })

  const forget = tool({
    description: "Delete memories by scope and type (optionally narrowed by query; logs deletion for audit)",
    args: {
      scope: tool.schema.string().describe("Scope of memory to delete"),
      type: tool.schema.enum(MEMORY_TYPES).describe("Type of memory"),
      reason: tool.schema.string().describe("Why this is being deleted (for audit purposes)"),
      query: tool.schema.string().optional().describe("Optional search term to delete only the best matching memory"),
    },
    async execute(args) {
      const entries = await store.readEntries()
      let matches = entries.filter((entry) => entry.memory.scope === args.scope && entry.memory.type === args.type)

      if (args.query && matches.length) {
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
        const scored = matches
          .map((entry) => ({ ...entry, score: scoreMatch(entry.memory, words) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || b.memory.ts.localeCompare(a.memory.ts))
        matches = scored[0] ? [scored[0]] : []
      }

      if (!matches.length) return `No memories found for ${args.type} in ${args.scope}`

      const byFile = new Map<string, Set<number>>()
      for (const match of matches) {
        if (!byFile.has(match.filepath)) byFile.set(match.filepath, new Set())
        byFile.get(match.filepath)!.add(match.lineIndex)
      }

      for (const [filepath, lineIndexes] of byFile) {
        const lines = (await Bun.file(filepath).text()).split("\n")
        const filtered = lines.filter((line, index) => line.length > 0 && !lineIndexes.has(index))
        await store.rewriteFile(filepath, filtered)
      }
      for (const match of matches) await store.appendDeletion(match.memory, args.reason)

      return `Deleted ${matches.length} ${args.type} memory(s) from ${args.scope}. Reason: ${args.reason}\nDeletions logged to ${join(store.dir, "deletions.logfmt")}`
    },
  })

  const exportMemories = tool({
    description: "Export memories as jsonl, json, or logfmt",
    args: {
      format: tool.schema.enum(["jsonl", "json", "logfmt"]).optional().describe("Export format (default jsonl)"),
      includeDeletions: tool.schema.boolean().optional().describe("Include deletion audit lines for logfmt exports"),
    },
    async execute(args) {
      const format = args.format || "jsonl"
      const memories = (await store.readEntries()).map((entry) => entry.memory)

      if (format === "json") return JSON.stringify(memories, null, 2)
      if (format === "logfmt") {
        const lines = memories.map(encodeMemory)
        if (args.includeDeletions) lines.push(...await store.readDeletionLines())
        return lines.join("\n")
      }
      return memories.map((memory) => JSON.stringify(memory)).join("\n")
    },
  })

  const importMemories = tool({
    description: "Import memories from jsonl, json, or compatible logfmt",
    args: {
      data: tool.schema.string().describe("Memory data to import"),
      format: tool.schema.enum(["jsonl", "json", "logfmt"]).optional().describe("Import format (default jsonl)"),
    },
    async execute(args) {
      const format = args.format || "jsonl"
      const imported: Memory[] = []

      if (format === "json") {
        const parsed = JSON.parse(args.data) as Memory[]
        imported.push(...parsed)
      } else if (format === "logfmt") {
        imported.push(...args.data.split("\n").map(parseLine).filter((memory): memory is Memory => memory !== null))
      } else {
        imported.push(...args.data.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Memory))
      }

      let count = 0
      for (const memory of imported) {
        if (!isMemoryType(memory.type)) continue
        await store.appendMemory({
          ts: memory.ts || new Date().toISOString(),
          type: memory.type,
          scope: memory.scope,
          content: memory.content,
          issue: memory.issue,
          tags: memory.tags,
        })
        count++
      }

      return `Imported ${count} memory(s)`
    },
  })

  const compact = tool({
    description: "Rewrite memory files in chronological order and remove exact duplicate records",
    args: {
      dryRun: tool.schema.boolean().optional().describe("Report what would change without rewriting files"),
    },
    async execute(args) {
      const entries = await store.readEntries()
      const unique = new Map<string, Memory>()
      for (const entry of entries) {
        const key = JSON.stringify(entry.memory)
        if (!unique.has(key)) unique.set(key, entry.memory)
      }

      const duplicateCount = entries.length - unique.size
      if (args.dryRun) return `Would compact ${entries.length} memories to ${unique.size} unique memories (${duplicateCount} duplicate(s) removed)`

      const byDate = new Map<string, string[]>()
      for (const memory of [...unique.values()].sort((a, b) => a.ts.localeCompare(b.ts))) {
        const date = dateFromTs(memory.ts)
        if (!byDate.has(date)) byDate.set(date, [])
        byDate.get(date)!.push(encodeMemory(memory))
      }

      const files = new Set(entries.map((entry) => entry.filepath))
      for (const filepath of files) await store.rewriteFile(filepath, [])
      for (const [date, lines] of byDate) await store.rewriteFile(join(store.dir, `${date}.logfmt`), lines)

      return `Compacted ${entries.length} memories to ${unique.size} unique memories (${duplicateCount} duplicate(s) removed)`
    },
  })

  const context = tool({
    description: "Build a compact relevant-memory context pack for the current task",
    args: {
      query: tool.schema.string().optional().describe("Task text to match against memories"),
      scope: tool.schema.string().optional().describe("Optional scope filter"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Only include memories with all of these tags"),
      types: tool.schema.array(tool.schema.enum(MEMORY_TYPES)).optional().describe("Only include these memory types"),
      limit: tool.schema.number().optional().describe("Maximum memories to include (default 5)"),
      maxChars: tool.schema.number().optional().describe("Maximum characters in the context pack (default 1200)"),
      minScore: tool.schema.number().optional().describe("Minimum query relevance score (default 1 when query is provided)"),
    },
    async execute(args) {
      const memories = (await store.readEntries()).map((entry) => entry.memory)
      const pack = buildContextPack(memories, args)
      return pack || "No relevant memories"
    },
  })

  return {
    memory_remember: remember,
    memory_recall: recall,
    memory_update: update,
    memory_forget: forget,
    memory_list: listMemories,
    memory_export: exportMemories,
    memory_import: importMemories,
    memory_compact: compact,
    memory_context: context,
  }
}

const SYSTEM_INSTRUCTION = "Use these memories only when they are relevant. Do not mention this block unless asked."

// Hooks fail open: a timeout or a storage error must never block a response
// (or, for the V2 prompt hook, prompt admission).
const failOpen = async <T>(task: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  try {
    return await withTimeout(task, timeoutMs)
  } catch {
    return undefined
  }
}

const jsonSchemaFromArgs = (args: ToolDefinition["args"]) => {
  const { $schema, ...schema } = tool.schema.toJSONSchema(tool.schema.object(args))
  return schema
}

interface MemoryRuntime {
  tools: Record<string, ToolDefinition>
  handlePromptText(text: string): Promise<void>
  buildSystemBlock(): Promise<string | undefined>
}

/**
 * Shared behavior for both entrypoints: the V2 `setup()` registrations and the
 * legacy V1 `server()` hooks. Tool definitions are created once; the V2 tool
 * registrations derive their JSON Schema from the V1 zod arg schemas, so both
 * OpenCode versions expose the exact same tool surface.
 */
const createRuntime = (directory: string, options?: PluginOptions): MemoryRuntime => {
  const store = createStore(join(directory, ".opencode", "memory"))
  const autoLoad = options?.autoLoad ?? false
  const autoSave = options?.autoSave ?? false
  const autoHookTimeoutMs = options?.autoHookTimeoutMs && options.autoHookTimeoutMs > 0 ? options.autoHookTimeoutMs : 100
  let latestPrompt: string | undefined

  return {
    tools: createTools(store),

    async handlePromptText(text) {
      if (!text) return
      latestPrompt = text
      if (!autoSave) return

      await failOpen((async () => {
        const memory = inferExplicitMemory(text, options?.autoSaveScope || "user")
        if (!memory) return

        await store.appendMemory({
          ...memory,
          ts: new Date().toISOString(),
        })
      })(), autoHookTimeoutMs)
    },

    async buildSystemBlock() {
      if (!autoLoad) return undefined
      if (!latestPrompt) return undefined

      const prompt = latestPrompt
      const pack = await failOpen((async () => {
        const memories = (await store.readEntries()).map((entry) => entry.memory)
        return buildContextPack(memories, {
          query: prompt,
          limit: options?.contextLimit,
          maxChars: options?.contextMaxChars,
          minScore: options?.contextMinScore,
        })
      })(), autoHookTimeoutMs)
      if (!pack) return undefined

      return `${pack}\n\n${SYSTEM_INSTRUCTION}`
    },
  }
}

/**
 * Legacy OpenCode 1 entrypoint (object form supported since OpenCode 1.18.29).
 * V1 calls `server()`; V2 reads `id`/`setup()` and ignores it.
 */
const server: PluginModule["server"] = async (input, options) => {
  const runtime = createRuntime(input.directory, options as PluginOptions | undefined)

  return {
    tool: runtime.tools,
    "chat.message": async (_input, output) => {
      await runtime.handlePromptText(textFromParts(output.parts))
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const block = await runtime.buildSystemBlock()
      if (block) output.system.push(block)
    },
  }
}

export const MemoryPlugin = {
  ...Plugin.define({
    id: "knikolov.simple-memory",
    async setup(ctx) {
      const runtime = createRuntime(ctx.location.directory, ctx.options)

      await ctx.tool.transform((editor) => {
        for (const [name, definition] of Object.entries(runtime.tools)) {
          editor.add({
            name,
            description: definition.description,
            input: jsonSchemaFromArgs(definition.args),
            execute: async (input) => {
              const result = await definition.execute(
                input as Parameters<ToolDefinition["execute"]>[0],
                {} as Parameters<ToolDefinition["execute"]>[1],
              )
              return { content: typeof result === "string" ? result : result.output }
            },
          })
        }
      })

      await ctx.session.hook("prompt", async (event) => {
        await runtime.handlePromptText(event.prompt.text)
      })

      await ctx.session.hook("context", async (event) => {
        const block = await runtime.buildSystemBlock()
        if (block) event.system.push({ type: "text", text: block })
      })
    },
  }),
  server,
} satisfies ReturnType<typeof Plugin.define> & PluginModule

export default MemoryPlugin
