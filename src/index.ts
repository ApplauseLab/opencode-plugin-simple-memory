import { type Plugin, tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"

const MEMORY_DIR = `${homedir()}/.config/opencode/memory`
const getMemoryFile = () => {
  const date = new Date().toISOString().split("T")[0]
  return Bun.file(`${MEMORY_DIR}/${date}.logfmt`)
}

const ensureDir = async () => {
  const dir = Bun.file(MEMORY_DIR)
  if (!(await dir.exists())) {
    await Bun.$`mkdir -p ${MEMORY_DIR}`
  }
}

interface Memory {
  ts: string
  type: string
  scope: string
  content: string
  issue?: string
  tags?: string[]
}

const parseLine = (line: string): Memory | null => {
  const tsMatch = line.match(/ts=([^\s]+)/)
  const typeMatch = line.match(/type=([^\s]+)/)
  const scopeMatch = line.match(/scope=([^\s]+)/)
  const contentMatch = line.match(/content="([^"]*(?:\\"[^"]*)*)"/)
  const issueMatch = line.match(/issue=([^\s]+)/)
  const tagsMatch = line.match(/tags=([^\s]+)/)

  if (!tsMatch?.[1] || !typeMatch?.[1] || !scopeMatch?.[1]) return null

  return {
    ts: tsMatch[1],
    type: typeMatch[1],
    scope: scopeMatch[1],
    content: contentMatch?.[1]?.replace(/\\"/g, '"') || "",
    issue: issueMatch?.[1],
    tags: tagsMatch?.[1]?.split(","),
  }
}

const formatMemory = (m: Memory): string => {
  const date = m.ts.split("T")[0]
  const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : ""
  const issue = m.issue ? ` (${m.issue})` : ""
  return `[${date}] ${m.type}/${m.scope}: ${m.content}${issue}${tags}`
}

const scoreMatch = (memory: Memory, words: string[]): number => {
  const searchable = `${memory.type} ${memory.scope} ${memory.content} ${memory.tags?.join(" ") || ""}`.toLowerCase()
  let score = 0
  for (const word of words) {
    if (searchable.includes(word)) score++
    if (memory.scope.toLowerCase() === word) score += 2
    if (memory.type.toLowerCase() === word) score += 2
  }
  return score
}

const remember = tool({
  description: "Store a memory (decision, learning, preference, blocker, context, pattern)",
  args: {
    type: tool.schema
      .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
      .describe("Type of memory"),
    scope: tool.schema.string().describe("Scope/area (e.g., auth, api, mobile)"),
    content: tool.schema.string().describe("The memory content"),
    issue: tool.schema.string().optional().describe("Related GitHub issue (e.g., #51)"),
    tags: tool.schema.array(tool.schema.string()).optional().describe("Additional tags"),
  },
  async execute(args) {
    await ensureDir()

    const ts = new Date().toISOString()
    const issue = args.issue ? ` issue=${args.issue}` : ""
    const tags = args.tags?.length ? ` tags=${args.tags.join(",")}` : ""
    const content = args.content.replace(/"/g, '\\"')
    const line = `ts=${ts} type=${args.type} scope=${args.scope} content="${content}"${issue}${tags}\n`

    const file = getMemoryFile()
    const existing = (await file.exists()) ? await file.text() : ""
    await Bun.write(file, existing + line)

    return `Remembered: ${args.type} in ${args.scope}`
  },
})

const getAllMemories = async (): Promise<Memory[]> => {
  const glob = new Bun.Glob("*.logfmt")
  const files = await Array.fromAsync(glob.scan(MEMORY_DIR))

  if (!files.length) return []

  const lines: string[] = []
  for (const filename of files) {
    if (filename === "deletions.logfmt") continue // skip audit log
    const file = Bun.file(`${MEMORY_DIR}/${filename}`)
    const text = await file.text()
    lines.push(...text.trim().split("\n").filter(Boolean))
  }

  return lines.map(parseLine).filter((m): m is Memory => m !== null)
}

const logDeletion = async (memory: Memory, reason: string) => {
  await ensureDir()
  const ts = new Date().toISOString()
  const content = memory.content.replace(/"/g, '\\"')
  const originalTs = memory.ts
  const issue = memory.issue ? ` issue=${memory.issue}` : ""
  const tags = memory.tags?.length ? ` tags=${memory.tags.join(",")}` : ""
  const escapedReason = reason.replace(/"/g, '\\"')
  const line = `ts=${ts} action=deleted original_ts=${originalTs} type=${memory.type} scope=${memory.scope} content="${content}" reason="${escapedReason}"${issue}${tags}\n`

  const file = Bun.file(`${MEMORY_DIR}/deletions.logfmt`)
  const existing = (await file.exists()) ? await file.text() : ""
  await Bun.write(file, existing + line)
}

const recall = tool({
  description: "Retrieve memories by scope, type, or search query",
  args: {
    scope: tool.schema.string().optional().describe("Filter by scope"),
    type: tool.schema
      .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
      .optional()
      .describe("Filter by type"),
    query: tool.schema.string().optional().describe("Search term (space-separated words, matches any)"),
    limit: tool.schema.number().optional().describe("Max results (default 20)"),
  },
  async execute(args) {
    let results = await getAllMemories()

    if (!results.length) return "No memories found"

    const totalCount = results.length

    if (args.scope) {
      results = results.filter((m) => m.scope === args.scope || m.scope.includes(args.scope!))
    }
    if (args.type) {
      results = results.filter((m) => m.type === args.type)
    }

    if (args.query) {
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
      const scored = results
        .map((m) => ({ memory: m, score: scoreMatch(m, words) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
      results = scored.map((x) => x.memory)
    }

    const filteredCount = results.length
    const limit = args.limit || 20
    const limited = results.slice(-limit)

    if (!limited.length) return "No matching memories"

    const header = filteredCount > limit
      ? `Found ${filteredCount} memories (showing last ${limit} of ${totalCount} total)\n\n`
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
    type: tool.schema
      .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
      .describe("Type of memory"),
    content: tool.schema.string().describe("The new content for the memory"),
    query: tool.schema.string().optional().describe("Search term to find specific memory if multiple exist"),
    issue: tool.schema.string().optional().describe("Update related GitHub issue (e.g., #51)"),
    tags: tool.schema.array(tool.schema.string()).optional().describe("Update tags"),
  },
  async execute(args) {
    const glob = new Bun.Glob("*.logfmt")
    const files = await Array.fromAsync(glob.scan(MEMORY_DIR))

    if (!files.length) return "No memory files found"

    // Find matching memories
    const matches: { memory: Memory; filepath: string; lineIndex: number }[] = []

    for (const filename of files) {
      if (filename === "deletions.logfmt") continue
      const filepath = `${MEMORY_DIR}/${filename}`
      const file = Bun.file(filepath)
      const text = await file.text()
      const lines = text.split("\n")

      lines.forEach((line, lineIndex) => {
        const memory = parseLine(line)
        if (!memory) return
        if (memory.scope === args.scope && memory.type === args.type) {
          matches.push({ memory, filepath, lineIndex })
        }
      })
    }

    if (matches.length === 0) {
      return `No memories found for ${args.type} in ${args.scope}`
    }

    // If multiple matches and query provided, filter by query
    let target: typeof matches[number] | undefined = matches[0]
    if (matches.length > 1) {
      if (args.query) {
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
        const scored = matches
          .map((m) => ({ ...m, score: scoreMatch(m.memory, words) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)

        if (scored.length === 0) {
          return `Found ${matches.length} memories for ${args.type}/${args.scope}, but none matched query "${args.query}". Use recall to see all matches.`
        }
        target = scored[0]
      } else {
        return `Found ${matches.length} memories for ${args.type}/${args.scope}. Provide a query to select which one to update, or use recall to see all matches.`
      }
    }

    if (!target) {
      return `No memories found for ${args.type} in ${args.scope}`
    }

    // Log the old version before updating
    await logDeletion(target.memory, `Updated to: ${args.content}`)

    // Update the memory
    const file = Bun.file(target.filepath)
    const text = await file.text()
    const lines = text.split("\n")

    const ts = new Date().toISOString()
    const issue = args.issue !== undefined ? args.issue : target.memory.issue
    const tags = args.tags !== undefined ? args.tags : target.memory.tags
    const issueStr = issue ? ` issue=${issue}` : ""
    const tagsStr = tags?.length ? ` tags=${tags.join(",")}` : ""
    const content = args.content.replace(/"/g, '\\"')
    const newLine = `ts=${ts} type=${args.type} scope=${args.scope} content="${content}"${issueStr}${tagsStr}`

    lines[target.lineIndex] = newLine
    await Bun.write(target.filepath, lines.join("\n"))

    return `Updated ${args.type} in ${args.scope}: "${args.content}"`
  },
})

const listMemories = tool({
  description: "List all unique scopes and types in memory for discovery",
  args: {},
  async execute() {
    const memories = await getAllMemories()

    if (!memories.length) return "No memories found"

    const scopes = new Map<string, number>()
    const types = new Map<string, number>()
    const scopeTypes = new Map<string, Set<string>>()

    for (const m of memories) {
      scopes.set(m.scope, (scopes.get(m.scope) || 0) + 1)
      types.set(m.type, (types.get(m.type) || 0) + 1)
      if (!scopeTypes.has(m.scope)) scopeTypes.set(m.scope, new Set())
      scopeTypes.get(m.scope)!.add(m.type)
    }

    const lines: string[] = []
    lines.push(`Total memories: ${memories.length}`)
    lines.push("")
    lines.push("Scopes:")
    for (const [scope, count] of [...scopes.entries()].sort((a, b) => b[1] - a[1])) {
      const typeList = [...scopeTypes.get(scope)!].join(", ")
      lines.push(`  ${scope}: ${count} (${typeList})`)
    }
    lines.push("")
    lines.push("Types:")
    for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${type}: ${count}`)
    }

    return lines.join("\n")
  },
})

const forget = tool({
  description: "Delete a memory by scope and type (removes matching lines from all memory files, logs deletion for audit)",
  args: {
    scope: tool.schema.string().describe("Scope of memory to delete"),
    type: tool.schema
      .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
      .describe("Type of memory"),
    reason: tool.schema.string().describe("Why this is being deleted (for audit purposes)"),
  },
  async execute(args) {
    const glob = new Bun.Glob("*.logfmt")
    const files = await Array.fromAsync(glob.scan(MEMORY_DIR))

    if (!files.length) return "No memory files found"

    let deleted = 0
    const deletedMemories: Memory[] = []

    for (const filename of files) {
      if (filename === "deletions.logfmt") continue // skip audit log
      const filepath = `${MEMORY_DIR}/${filename}`
      const file = Bun.file(filepath)
      const text = await file.text()
      const lines = text.split("\n")
      const filtered = lines.filter((line) => {
        const memory = parseLine(line)
        if (!memory) return true
        if (memory.scope === args.scope && memory.type === args.type) {
          deleted++
          deletedMemories.push(memory)
          return false
        }
        return true
      })
      if (filtered.length !== lines.length) {
        await Bun.write(filepath, filtered.join("\n"))
      }
    }

    // Log all deletions to audit file
    for (const memory of deletedMemories) {
      await logDeletion(memory, args.reason)
    }

    if (deleted === 0) return `No memories found for ${args.type} in ${args.scope}`
    return `Deleted ${deleted} ${args.type} memory(s) from ${args.scope}. Reason: ${args.reason}\nDeletions logged to ${MEMORY_DIR}/deletions.logfmt`
  },
})

export const MemoryPlugin: Plugin = async (_ctx) => {
  return {
    tool: {
      memory_remember: remember,
      memory_recall: recall,
      memory_update: update,
      memory_forget: forget,
      memory_list: listMemories,
    },
  }
}

export default MemoryPlugin
