# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`@metaglass/aios` — the kernel of the Metaglass Agentic AI Operating System. A multi-turn conversation engine with reflection, planning, and tool orchestration. Published as a standalone npm package consumed by the `learning-os` host app.

## Commands

```bash
npm run build          # Build CJS + ESM + types via tsup
npm run dev            # Watch mode build
npm run test           # Run Vitest in watch mode
npm run test:run       # Run all tests once (CI)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src --ext .ts

# Run a single test file
npx vitest run src/kernel/__tests__/TodoManager.test.ts

# Run tests matching a pattern
npx vitest run -t "should track"
```

## Breaking Change Rules

**Read `docs/BREAKING_CHANGE_GUIDELINES.md` before modifying any exported symbol.** Key rules:
- Never remove/rename exported types, interfaces, or functions — deprecate with aliases instead
- Never remove required fields from interfaces — add new fields as optional
- Never change provider method signatures — host implements these
- Never change event names — host subscribes by string
- `ConversationResult` shape is sacred — add fields, never remove
- New providers must be optional in `ConversationEngineDeps`
- Run `npm run typecheck` in both this repo and learning-os before merging

## Local Development with learning-os

This package is `npm link`ed into the `learning-os` host app at `/Users/govind/metaglass/learning-os`. After making changes here, rebuild so they reflect in the host:

```bash
npm run build   # Rebuild CJS + ESM + types
```

If the link breaks (e.g. after `npm install` in learning-os), re-establish it:
```bash
cd /Users/govind/metaglass/metaglass-aios && npm link
cd /Users/govind/metaglass/learning-os && npm link @metaglass/aios
```

## Architecture

**Hexagonal architecture (ports & adapters).** The kernel defines provider interfaces; the host supplies implementations.

### Provider Interfaces (`src/interfaces/`)
- **LLMProvider** — Chat completion and streaming
- **ToolProvider** — Tool registry and execution
- **UserInterface** — User interactions (ask, confirm, notify)
- **EventEmitter** — Type-safe event pub/sub
- **StateStore** — Key-value persistence

These are the public API contracts. See `docs/BREAKING_CHANGE_GUIDELINES.md` for rules — never remove/rename exported symbols, never change provider method signatures, never remove fields from `ConversationResult`.

### Kernel Components (`src/kernel/`)
- **ConversationEngine** (~1600 lines) — The core multi-turn loop: classify intent → LLM call → tool execution → context compression → reflection
- **TodoManager** — Task tracking (enforces max 1 in_progress at a time)
- **ContextCompressor** — LLM-based context summarization when approaching token limits
- **IntentClassifier** — Regex + LLM complexity detection
- **ToolMetadataRegistry** — Tool categorization, parallel/sequential partitioning
- **ToolRetryPolicy** — Exponential backoff with jitter
- **VerificationEngine** — Contract verification for user approval flows
- **PlanManager** — Planning mode state machine
- **TaskSpawner** — Subagent spawning (8 agent types)
- **ReflectionEngine** — Post-turn reflection and decision logging

### High-Level API (`src/AIOSService.ts`)
`createAIOSService(config)` / `getAIOSService()` — singleton factory wrapping the engine with methods for execute, cancel, planning, contracts, task spawning, and todo tracking.

### Dependency Injection
All external dependencies are constructor-injected. Global provider management via `setProviders()` / `getProviders()`. The kernel never imports host code.

### Events
Type-safe events flow kernel → host. Key categories: `conversation:*`, `todo:updated`, `plan:*`, `tool-call`, `tool-result`, `contract:*`, `task:*`.

## Breaking Change Safeguards

This package is consumed by the `learning-os` host app. **Every export is a contract.** Before modifying any code, check whether it touches the public API surface:

### What counts as public API
1. **Provider interfaces** — `LLMProvider`, `ToolProvider`, `UserInterface`, `EventEmitter`, `StateStore`
2. **Types used in provider signatures** — `Message`, `ToolCall`, `ToolResult`, `ChatOptions`, `LLMResponse`, etc.
3. **Engine API** — `ConversationEngine.execute()`, `AIOSService.execute()`
4. **Configuration types** — `ConversationConfig`, `AIOSConfig`, `ConversationEngineDeps`
5. **Event names** — `AIOSEvents` keys (e.g., `conversation:turn`, `todo:updated`)
6. **Exported functions** — `setProviders()`, `getProviders()`, `classifyIntent()`, etc.
7. **ConversationResult** — the return type of `execute()`; its shape is sacred

### Rules to follow
- **Never remove or rename** anything exported from `src/index.ts`. To rename, add a new name and keep the old as a `@deprecated` alias for at least 1 major version.
- **Never remove required fields** from interfaces. Add new fields as optional instead.
- **Never change method signatures** on provider interfaces — the host implements these. New parameters must be optional.
- **Never rename event names** in `AIOSEvents`. Add new events alongside old ones.
- **New provider interfaces** added to `ConversationEngineDeps` must be optional, with graceful fallback in the kernel.
- **Never change defaults silently** (e.g., `maxTurns` from 50 to 25). Log a warning or document in changelog.
- **Never remove fields** from `ConversationResult`. Adding fields is fine.

### Safe changes (no host impact)
- Adding optional fields to configs or interfaces
- Adding new optional methods to provider interfaces
- Adding new events to `AIOSEvents`
- Internal changes to `ConversationEngine.runLoop()` as long as provider call signatures, emitted events, and `ConversationResult` shape are preserved
- New kernel components in `src/kernel/` that are only used internally

### Before merging any PR
```bash
npm run test:run       # All 450+ tests must pass
npm run typecheck      # Must pass
npm run build          # Must succeed

# Then verify host compatibility:
cd ../learning-os
npm install ../metaglass-aios
npm run typecheck      # Catches signature mismatches against host adapters
```

### Versioning
| Change | Bump |
|--------|------|
| New optional config field | PATCH |
| New optional provider interface / new event | MINOR |
| Remove deprecated alias / change required signature | MAJOR |
| Bug fix in turn loop internals | PATCH |

### If you shipped a breaking change
Revert immediately, publish a patch, then design a non-breaking migration path (optional field, alias, etc.) in a new MINOR.

## Key Conventions

- **Peer dependencies**: `ai` (Vercel AI SDK ^6.0) and `zod` (^3.0) are peers, not bundled
- **Tests live in** `src/kernel/__tests__/` — 16 files, 451+ tests using Vitest with `vi.fn()` mocking
- **All provider interfaces are mocked** in tests — look at existing test files for patterns
- **TypeScript strict mode** is enabled; target is ES2022
