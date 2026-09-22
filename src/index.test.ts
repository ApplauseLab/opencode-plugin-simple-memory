import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryPlugin } from "../index"

const tempRoot = join(import.meta.dir, "..", ".tmp-tests")
let testDir = ""

type Runner = (args: Record<string, unknown>) => Promise<string>

interface LoadedTools {
  recall: Runner
  remember: Runner
  update: Runner
  forget: Runner
  list: Runner
  exportMemories: Runner
  importMemories: Runner
  compact: Runner
  memoryContext: Runner
}

interface CapturedTool {
  name: string
  description: string
  input: unknown
  execute(input: unknown, context: unknown): Promise<{ content?: unknown }>
}

interface CapturedV2 {
  tools: Record<string, CapturedTool>
  hooks: Record<string, (event: any) => Promise<void>>
}

type V1Hooks = Awaited<ReturnType<typeof MemoryPlugin.server>>
type V1Tool = { execute: (args: never, context: never) => Promise<unknown> }

const toolContext = () => ({
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  directory: testDir,
  worktree: testDir,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
})

const toolOutput = (result: unknown): string => {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "output" in result && typeof (result as { output?: unknown }).output === "string") {
    return (result as { output: string }).output
  }
  throw new Error(`Unexpected tool result: ${String(result)}`)
}

const pickTool = <T>(tools: Record<string, T>, name: string): T => {
  const tool = tools[name]
  if (!tool) throw new Error(`Missing tool: ${name}`)
  return tool
}

const v1Runner = (tool: V1Tool): Runner =>
  async (args) => toolOutput(await tool.execute(args as never, toolContext() as never))

const v2Runner = (tool: CapturedTool): Runner =>
  async (args) => {
    const result = await tool.execute(args, {})
    if (typeof result.content !== "string") throw new Error("Tool did not return string content")
    return result.content
  }

const toLoadedTools = (tools: Record<string, unknown>, run: (tool: unknown) => Runner): LoadedTools => ({
  recall: run(pickTool(tools, "memory_recall")),
  remember: run(pickTool(tools, "memory_remember")),
  update: run(pickTool(tools, "memory_update")),
  forget: run(pickTool(tools, "memory_forget")),
  list: run(pickTool(tools, "memory_list")),
  exportMemories: run(pickTool(tools, "memory_export")),
  importMemories: run(pickTool(tools, "memory_import")),
  compact: run(pickTool(tools, "memory_compact")),
  memoryContext: run(pickTool(tools, "memory_context")),
})

const loadV1 = async (options: Record<string, unknown> = {}) => {
  const hooks = await MemoryPlugin.server({ directory: testDir } as never, options)
  const tools: Record<string, V1Tool> = hooks.tool ?? {}
  return {
    hooks,
    tools,
    loaded: toLoadedTools(tools, (tool) => v1Runner(tool as V1Tool)),
  }
}

const loadV1Tools = async (): Promise<LoadedTools> => (await loadV1()).loaded

const setupV2 = async (options: Record<string, unknown> = {}): Promise<CapturedV2> => {
  const tools: Record<string, CapturedTool> = {}
  const hooks: Record<string, (event: any) => Promise<void>> = {}

  await MemoryPlugin.setup({
    location: { directory: testDir },
    options,
    tool: {
      transform: async (callback: (editor: { add: (tool: CapturedTool) => void }) => void) => {
        callback({
          add: (tool) => {
            tools[tool.name] = tool
          },
        })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
    },
  } as never)

  return { tools, hooks }
}

const loadV2Tools = async (): Promise<LoadedTools> => {
  const { tools } = await setupV2()
  return toLoadedTools(tools, (tool) => v2Runner(tool as CapturedTool))
}

const sendV1Prompt = async (hooks: V1Hooks, text: string) => {
  const hook = hooks["chat.message"]
  if (!hook) throw new Error("chat.message hook missing")
  await hook(
    { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
    { message: {} as never, parts: [{ type: "text", text }] as never },
  )
}

const runV1SystemTransform = async (hooks: V1Hooks, output: { system: string[] }) => {
  const hook = hooks["experimental.chat.system.transform"]
  if (!hook) throw new Error("experimental.chat.system.transform hook missing")
  await hook({ sessionID: "session-1", model: {} as never }, output)
}

const sendV2Prompt = async (captured: CapturedV2, text: string) => {
  const hook = captured.hooks["prompt"]
  if (!hook) throw new Error("prompt hook missing")
  await hook({ sessionID: "session-1", messageID: "message-1", prompt: { text }, delivery: "steer" })
}

const runV2Context = async (captured: CapturedV2, output: { system: unknown[] }) => {
  const hook = captured.hooks["context"]
  if (!hook) throw new Error("context hook missing")
  await hook({ sessionID: "session-1", agent: "build", system: output.system })
}

const systemText = (system: unknown[]) =>
  system.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text) : String(part))).join("\n")

const writeMemories = async (...lines: string[]) => {
  await Bun.write(join(testDir, ".opencode", "memory", "2026-05-28.logfmt"), lines.join("\n") + "\n")
}

const registerToolTests = (loadTools: () => Promise<LoadedTools>) => {
  test("returns the highest scoring query matches within the limit", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="api only"',
      'ts=2026-05-28T10:01:00.000Z type=context scope=database content="api only"',
      'ts=2026-05-28T10:02:00.000Z type=decision scope=api content="api decision"',
    )

    const tools = await loadTools()
    const output = await tools.recall({ query: "api", limit: 2 })

    expect(output).toContain("[2026-05-28] decision/api: api decision")
    expect(output).toContain("[2026-05-28] context/api: api only")
    expect(output).not.toContain("context/database")
  })

  test("returns the latest chronological memories when no query is provided", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-27.logfmt"),
      'ts=2026-05-27T10:00:00.000Z type=context scope=old content="old memory"\n',
    )
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=first content="first new memory"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=second content="second new memory"',
    )

    const tools = await loadTools()
    const output = await tools.recall({ limit: 2 })

    expect(output).toContain("[2026-05-28] context/first: first new memory")
    expect(output).toContain("[2026-05-28] context/second: second new memory")
    expect(output).not.toContain("old memory")
  })

  test("round-trips multiline content written by memory_remember", async () => {
    const tools = await loadTools()
    await tools.remember({
      type: "context",
      scope: "notes",
      content: "line one\nline two with \"quotes\" and \\ slash",
    })

    const output = await tools.recall({ scope: "notes", match: "exact" })
    const raw = await Bun.file(join(testDir, ".opencode", "memory", new Date().toISOString().split("T")[0] + ".logfmt")).text()

    expect(output).toContain("line one\nline two with \"quotes\" and \\ slash")
    expect(raw).toContain('content="line one\\nline two with \\"quotes\\" and \\\\ slash"')
  })

  test("imports compatible logfmt records with escaped multiline content", async () => {
    const tools = await loadTools()
    await tools.importMemories({
      format: "logfmt",
      data: 'ts=2026-05-28T12:00:00.000Z type=context scope=imported content="first\\nsecond"',
    })

    const output = await tools.recall({ scope: "imported", match: "exact" })
    const exported = await tools.exportMemories({ format: "jsonl" })

    expect(output).toContain("first\nsecond")
    expect(JSON.parse(exported).content).toBe("first\nsecond")
  })

  test("preserves raw backslashes from older compatible records", async () => {
    await writeMemories('ts=2026-05-28T10:00:00.000Z type=context scope=paths content="C:\\tmp\\memory"')

    const tools = await loadTools()
    const output = await tools.recall({ scope: "paths", match: "exact" })

    expect(output).toContain("C:\\tmp\\memory")
  })

  test("filters by tags, date range, and exact scope matching", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="old api" tags=backend,stale',
      'ts=2026-05-28T11:00:00.000Z type=context scope=api-v2 content="new api v2" tags=backend,current',
      'ts=2026-05-28T12:00:00.000Z type=context scope=api content="new api" tags=backend,current',
    )

    const tools = await loadTools()
    const output = await tools.recall({
      scope: "api",
      match: "exact",
      tags: ["current"],
      since: "2026-05-28T11:30:00.000Z",
      until: "2026-05-28",
    })

    expect(output).toContain("new api")
    expect(output).not.toContain("old api")
    expect(output).not.toContain("api-v2")
  })

  test("memory_forget with query deletes only the best matching memory", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="keep postgres detail"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=api content="delete redis detail"',
    )

    const tools = await loadTools()
    const deleted = await tools.forget({ type: "context", scope: "api", reason: "test", query: "redis" })
    const output = await tools.recall({ scope: "api", match: "exact" })

    expect(deleted).toContain("Deleted 1 context memory(s)")
    expect(output).toContain("keep postgres detail")
    expect(output).not.toContain("delete redis detail")
  })

  test("memory_export and memory_import round-trip json", async () => {
    const tools = await loadTools()
    await tools.remember({ type: "pattern", scope: "tests", content: "use plugin interface", tags: ["testing"] })

    const exported = await tools.exportMemories({ format: "json" })
    await rm(join(testDir, ".opencode", "memory"), { recursive: true, force: true })

    const imported = await tools.importMemories({ format: "json", data: exported })
    const output = await tools.recall({ scope: "tests", match: "exact" })

    expect(imported).toBe("Imported 1 memory(s)")
    expect(output).toContain("pattern/tests: use plugin interface [testing]")
  })

  test("memory_compact removes exact duplicate records", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
    )

    const tools = await loadTools()
    const dryRun = await tools.compact({ dryRun: true })
    const compacted = await tools.compact({})
    const output = await tools.recall({})

    expect(dryRun).toContain("1 duplicate(s) removed")
    expect(compacted).toContain("1 duplicate(s) removed")
    expect(output).toContain("Found 1 memories")
  })

  test("memory_context returns a compact relevant memory pack", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy',
      'ts=2026-05-28T11:00:00.000Z type=context scope=tests content="Run make staging-live-onboarding-e2e for staging onboarding" tags=staging,e2e',
      'ts=2026-05-28T12:00:00.000Z type=context scope=runtime/local content="Local Bifrost is available through host.docker.internal" tags=local',
    )

    const tools = await loadTools()
    const output = await tools.memoryContext({ query: "staging deploy", limit: 2, maxChars: 220 })

    expect(output).toContain("Relevant Memory:")
    expect(output).toContain("deploy/staging")
    expect(output).toContain("tests")
    expect(output).not.toContain("runtime/local")
  })

  test("memory_update replaces content and writes an audit deletion record", async () => {
    await writeMemories('ts=2026-05-28T10:00:00.000Z type=preference scope=ui content="use dark theme"')

    const tools = await loadTools()
    const updated = await tools.update({ scope: "ui", type: "preference", content: "use light theme" })
    const recalled = await tools.recall({ scope: "ui", match: "exact" })
    const deletions = await Bun.file(join(testDir, ".opencode", "memory", "deletions.logfmt")).text()

    expect(updated).toContain('Updated preference in ui: "use light theme"')
    expect(recalled).toContain("use light theme")
    expect(recalled).not.toContain("use dark theme")
    expect(deletions).toContain('reason="Updated to: use light theme"')
  })

  test("memory_update asks for disambiguation on multiple matches and honors a query", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="use postgres for the main store"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=api content="use redis for the cache"',
    )

    const tools = await loadTools()
    const ambiguous = await tools.update({ scope: "api", type: "context", content: "replaced" })
    expect(ambiguous).toContain("Provide a query to select which one to update")
    expect(await tools.recall({ scope: "api", match: "exact" })).not.toContain("replaced")

    const targeted = await tools.update({ scope: "api", type: "context", content: "route cache reads through redis-cluster", query: "redis" })
    const recalled = await tools.recall({ scope: "api", match: "exact" })

    expect(targeted).toContain('Updated context in api: "route cache reads through redis-cluster"')
    expect(recalled).toContain("use postgres for the main store")
    expect(recalled).toContain("route cache reads through redis-cluster")
    expect(recalled).not.toContain("use redis for the cache")
  })

  test("memory_list reports scopes, types, and open blockers", async () => {
    await writeMemories(
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="api details"',
      'ts=2026-05-28T11:00:00.000Z type=decision scope=api content="api decision"',
      'ts=2026-05-28T12:00:00.000Z type=blocker scope=ci content="ci is flaky"',
    )

    const tools = await loadTools()
    const output = await tools.list({})

    expect(output).toContain("Total memories: 3")
    expect(output).toContain("api: 2 (context, decision)")
    expect(output).toContain("ci: 1 (blocker)")
    expect(output).toContain("blocker: 1")
    expect(output).toContain("Open blockers: 1")
  })
}

beforeEach(async () => {
  testDir = join(tempRoot, crypto.randomUUID())
  await mkdir(join(testDir, ".opencode", "memory"), { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("v1 server()", () => {
  registerToolTests(loadV1Tools)

  test("automatic hooks are disabled by default", async () => {
    const { hooks, loaded } = await loadV1()

    await writeMemories('ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy')

    await sendV1Prompt(hooks, "remember that I prefer minimal diffs and how do I restart staging deployments?")

    const system = { system: [] as string[] }
    await runV1SystemTransform(hooks, system)

    expect(await loaded.recall({ scope: "user", match: "exact" })).toContain("No matching memories")
    expect(system.system).toEqual([])
  })

  test("auto-save stores explicit remember requests when enabled", async () => {
    const { hooks, loaded } = await loadV1({ autoSave: true })

    await sendV1Prompt(hooks, "remember that I prefer minimal diffs")

    expect(await loaded.recall({ scope: "user", match: "exact" })).toContain("preference/user: I prefer minimal diffs [auto]")
  })

  test("auto-load injects relevant memories into system context when enabled", async () => {
    await writeMemories('ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy')
    const { hooks } = await loadV1({ autoLoad: true })

    await sendV1Prompt(hooks, "how do I restart staging deployments?")

    const system = { system: [] as string[] }
    await runV1SystemTransform(hooks, system)

    expect(system.system.join("\n")).toContain("Relevant Memory:")
    expect(system.system.join("\n")).toContain("deploy/staging")
  })
})

describe("v2 setup()", () => {
  registerToolTests(loadV2Tools)

  test("registers the same nine tools as the V1 entrypoint with JSON Schema inputs", async () => {
    const v1 = await loadV1()
    const v2 = await setupV2()

    expect(Object.keys(v2.tools).sort()).toEqual(Object.keys(v1.tools).sort())
    expect(Object.keys(v2.tools).sort()).toEqual([
      "memory_compact",
      "memory_context",
      "memory_export",
      "memory_forget",
      "memory_import",
      "memory_list",
      "memory_recall",
      "memory_remember",
      "memory_update",
    ])

    const remember = pickTool(v2.tools, "memory_remember")
    expect(remember.input).toMatchObject({
      type: "object",
      properties: {
        type: { type: "string", enum: ["decision", "learning", "preference", "blocker", "context", "pattern"] },
        scope: { type: "string" },
        content: { type: "string" },
        issue: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["type", "scope", "content"],
      additionalProperties: false,
    })
    expect((remember.input as Record<string, unknown>).$schema).toBeUndefined()
    expect(typeof remember.description).toBe("string")
  })

  test("automatic hooks are disabled by default", async () => {
    const captured = await setupV2()

    await writeMemories('ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy')

    await sendV2Prompt(captured, "remember that I prefer minimal diffs and how do I restart staging deployments?")

    const system = { system: [] as unknown[] }
    await runV2Context(captured, system)

    const recall = v2Runner(pickTool(captured.tools, "memory_recall"))
    expect(await recall({ scope: "user", match: "exact" })).toContain("No matching memories")
    expect(system.system).toEqual([])
  })

  test("auto-save stores explicit remember requests when enabled", async () => {
    const captured = await setupV2({ autoSave: true })

    await sendV2Prompt(captured, "remember that I prefer minimal diffs")

    const recall = v2Runner(pickTool(captured.tools, "memory_recall"))
    expect(await recall({ scope: "user", match: "exact" })).toContain("preference/user: I prefer minimal diffs [auto]")
  })

  test("auto-load injects relevant memories into system context when enabled", async () => {
    await writeMemories('ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy')
    const captured = await setupV2({ autoLoad: true })

    await sendV2Prompt(captured, "how do I restart staging deployments?")

    const system = { system: [] as unknown[] }
    await runV2Context(captured, system)

    expect(systemText(system.system)).toContain("Relevant Memory:")
    expect(systemText(system.system)).toContain("deploy/staging")
  })
})
