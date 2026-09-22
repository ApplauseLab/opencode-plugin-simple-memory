# Agent Guidelines

## Commands
- **Install**: `bun install`
- **Type check**: `bun run tsc --noEmit`
- **Run**: `bun run index.ts`
- **Test manually**: `bun -e "import { MemoryPlugin } from './index.ts'; ..."`

## Code Style
- **Runtime**: Bun (use Bun APIs: `Bun.file()`, `Bun.write()`, `Bun.Glob`, `Bun.$`)
- **Imports**: Use `import type` for type-only imports (`verbatimModuleSyntax`)
- **Types**: Strict mode enabled, handle `undefined` from indexed access (`noUncheckedIndexedAccess`)
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces
- **Exports**: Re-export public API from `index.ts`, implementation in `src/`

## Plugin Structure
- Dual entrypoint in one default export: OpenCode 2 (V2) reads `id`/`setup()` from `Plugin.define`, OpenCode 1 (≥1.18.29) calls `server()`
- Dependencies: `@opencode/plugin` (SDK v2, backs `setup()`) and `@opencode-ai/plugin` (SDK v1, backs `server()`)
- Tools are defined once via the V1 `tool()` helper; the V2 registration derives each JSON Schema `input` with `tool.schema.toJSONSchema`, so both hosts expose the same tool surface
- V2 hooks: `ctx.session.hook("prompt")` (auto-save) and `ctx.session.hook("context")` (auto-load); V1 hooks: `chat.message` and `experimental.chat.system.transform`
- Hook work runs through `failOpen` (timeout + catch) so memory errors never block responses or prompt admission
- Memories stored in `.opencode/memory/` as logfmt files
