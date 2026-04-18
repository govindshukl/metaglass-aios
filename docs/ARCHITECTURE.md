# AIOS + Metaglass — System Architecture

**Date**: 2026-03-21
**Scope**: End-to-end architecture covering `metaglass-aios` kernel and `learning-os` host

---

## Separation of Concerns

The system is split into two repositories with a clear boundary:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        METAGLASS HOST (learning-os)                 │
│                                                                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐ │
│  │  SolidJS   │  │   Tauri    │  │   Plugin   │  │   Skill      │ │
│  │  Frontend  │  │  Backend   │  │   System   │  │   System     │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘ │
│        │               │               │                │          │
│  ┌─────┴───────────────┴───────────────┴────────────────┴───────┐  │
│  │                    AGENTIC LAYER                              │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │  │
│  │  │  Ports   │  │ Adapters │  │ Engines  │  │ Engine       │ │  │
│  │  │(7 ifaces)│  │(7 impls) │  │(2 impls) │  │ Registry +   │ │  │
│  │  │          │  │          │  │          │  │ Manager      │ │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┘ │  │
│  └───────┼──────────────┼──────────────┼────────────────────────┘  │
│          │              │              │                            │
│  ┌───────┴──────────────┴──────────────┴────────────────────────┐  │
│  │                   AIOS RUNTIME (bridge)                      │  │
│  │  configureMetaglassProviders() → setProviders()              │  │
│  │  initializeAIOSRuntime() → AIOSService singleton             │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                      │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ npm dependency
                              │ @metaglass/aios
┌─────────────────────────────┼──────────────────────────────────────┐
│                        AIOS KERNEL (metaglass-aios)                │
│                             │                                      │
│  ┌──────────────────────────┴───────────────────────────────────┐  │
│  │                    AIOSService                               │  │
│  │  execute() → ConversationEngine.execute()                    │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                      │
│  ┌──────────────────────────┴───────────────────────────────────┐  │
│  │                 ConversationEngine (kernel)                   │  │
│  │                                                              │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────────────────┐  │  │
│  │  │ Turn Loop  │ │ TodoManager  │ │ IntentClassifier      │  │  │
│  │  │ (LLM call  │ │ (task track) │ │ (regex + LLM)         │  │  │
│  │  │  + tools)  │ │              │ │                       │  │  │
│  │  └────────────┘ └──────────────┘ └───────────────────────┘  │  │
│  │                                                              │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────────────────┐  │  │
│  │  │ Context    │ │ PlanManager  │ │ ToolMetadataRegistry  │  │  │
│  │  │ Compressor │ │ (plan mode)  │ │ (parallel partition)  │  │  │
│  │  └────────────┘ └──────────────┘ └───────────────────────┘  │  │
│  │                                                              │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────────────────┐  │  │
│  │  │ TaskSpawner│ │ ToolRetry    │ │ DebugHarness          │  │  │
│  │  │ (subagents)│ │ Policy       │ │ + DecisionLogger      │  │  │
│  │  └────────────┘ └──────────────┘ └───────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              Provider Interfaces (injectable)                 │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │  │
│  │  │LLMProvide│ │ToolProvid│ │UserInter │ │EventEmit │       │  │
│  │  │r         │ │er        │ │face      │ │ter       │       │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              Shared Types (interfaces/types.ts)              │  │
│  │  Message, ToolCall, ToolResult, ToolDefinition, Todo,        │  │
│  │  ChatOptions, LLMResponse, LLMCapabilities, AIOSEvents      │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Component Ownership

| Component | Owner | Responsibility |
|-----------|-------|----------------|
| ConversationEngine | AIOS Kernel | Multi-turn loop, tool execution, turn management |
| TodoManager | AIOS Kernel | Task tracking, single-in-progress constraint |
| PlanManager | AIOS Kernel | Planning mode state machine |
| IntentClassifier | AIOS Kernel | Complexity detection (trivial → complex) |
| ContextCompressor | AIOS Kernel | Token budget management, history summarization |
| ToolMetadataRegistry | AIOS Kernel | Tool categorization, parallel/sequential partitioning |
| TaskSpawner | AIOS Kernel | Subagent spawning interface |
| ToolRetryPolicy | AIOS Kernel | Exponential backoff with jitter |
| DebugHarness | AIOS Kernel | Trace logging, step-mode debugging |
| DecisionLogger | AIOS Kernel | Structured decision audit trail |
| ConversationStore | AIOS Kernel | Session persistence (JSONL) |
| VercelAILLMProvider | AIOS Kernel | LLM abstraction (Anthropic/OpenAI/Ollama) |
| --- | --- | --- |
| Port Interfaces (7) | Host Agentic Layer | LLM, Tool, UI, Context, Memory, Skill, Storage |
| Adapters (7) | Host Agentic Layer | Bridge Metaglass services → port interfaces |
| EngineRegistry | Host Agentic Layer | Engine discovery and registration |
| EngineManager | Host Agentic Layer | Engine lifecycle, switching, settings |
| MinimalEngine | Host Agentic Layer | Lightweight turn loop (no AIOS dependency) |
| MetaglassEngine | Host Agentic Layer | Wraps ConversationEngine with adapters |
| AIOSRuntime | Host Agentic Layer | Provider configuration, singleton management |
| --- | --- | --- |
| SkillRegistry | Host Skill System | Skill discovery, matching, content loading |
| SmartSkillService | Host Skill System | Smart skill execution |
| SkillToolProvider | Host AIOS Providers | Tool registry sourced from skills |
| SolidUserInterface | Host AIOS Providers | SolidJS-based user interaction |
| EventBusAdapter | Host AIOS Providers | Metaglass EventBus → AIOS EventEmitter |

---

## Hexagonal Architecture (Ports & Adapters)

The agentic layer uses hexagonal architecture. Ports define contracts; adapters implement them.

```
                    ┌──────────────────────────┐
                    │     AgenticEngine        │
                    │  (MinimalEngine or       │
                    │   MetaglassEngine)       │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │            PortBundle                │
              │                                      │
   Required:  │  ┌─────┐  ┌──────┐  ┌────┐         │
              │  │ LLM │  │ Tool │  │ UI │         │
              │  │ Port │  │ Port │  │Port│         │
              │  └──┬──┘  └──┬───┘  └─┬──┘         │
              │     │        │        │              │
   Optional:  │  ┌──┴───┐ ┌─┴────┐ ┌─┴────┐ ┌────┐│
              │  │Contex│ │Memory│ │Skill │ │Stor││
              │  │tPort │ │Port  │ │Port  │ │Port││
              │  └──┬───┘ └──┬───┘ └──┬───┘ └─┬──┘│
              └─────┼────────┼────────┼────────┼───┘
                    │        │        │        │
              ┌─────┴────────┴────────┴────────┴───┐
              │            Adapters                  │
              │                                      │
              │  LLMAdapter      → VercelAILLMProvider
              │  ToolAdapter     → SkillToolProvider
              │  UIAdapter       → SolidUserInterface
              │  ContextAdapter  → ContextAssemblyService
              │  MemoryAdapter   → SkillToolRegistry (memory.*)
              │  SkillAdapter    → SkillRegistry
              │  StorageAdapter  → localStorage
              └──────────────────────────────────────┘
```

---

## Data Flow: User Query → Response

```
User types query in Metaglass
        │
        ▼
┌─────────────────┐
│  GoalPalette /  │  (SolidJS UI component)
│  ChatPanel      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  EngineManager  │  Resolves active engine
│  .run(params)   │
└────────┬────────┘
         │
         ├─── MinimalEngine path ──────────────────┐
         │                                         │
         ▼                                         ▼
┌─────────────────┐                    ┌──────────────────┐
│ MetaglassEngine │                    │  MinimalEngine    │
│                 │                    │                   │
│ Creates AIOS    │                    │  Direct LLM call  │
│ providers from  │                    │  via LLMPort      │
│ Metaglass svcs  │                    │                   │
└────────┬────────┘                    │  Sequential tool  │
         │                             │  loop via ToolPort│
         ▼                             └────────┬──────────┘
┌─────────────────┐                             │
│ Conversation    │                             │
│ Engine          │                             │
│ (AIOS kernel)   │                             │
│                 │                             │
│ 1. Classify     │                             │
│ 2. LLM call     │                             │
│ 3. Tool exec    │                             │
│ 4. TodoWrite    │                             │
│ 5. Compression  │                             │
│ 6. Reflection   │                             │
└────────┬────────┘                             │
         │                                      │
         ▼                                      ▼
┌─────────────────────────────────────────────────┐
│                 EngineRunResult                   │
│  { success, response, status, turns }            │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
              UI renders response
```

---

## Dependency Direction

All dependencies point inward. The kernel knows nothing about the host.

```
HOST (learning-os)  ───depends on───▶  KERNEL (metaglass-aios)
HOST defines adapters that implement kernel interfaces
KERNEL defines provider interfaces (LLMProvider, ToolProvider, etc.)
KERNEL exports types that HOST re-defines locally (structural typing)
```

**Key principle**: The AIOS kernel is a **generic conversation engine**. It has:
- No Tauri imports
- No SolidJS imports
- No Metaglass-specific logic
- No skill awareness (gap — see AGENTIC_HARNESS_GAPS.md)
- No memory provider interface (gap)

The host provides all Metaglass-specific behavior through provider injection.

---

## Two Engine Paths

| Aspect | MinimalEngine | MetaglassEngine |
|--------|---------------|-----------------|
| **Dependency** | Ports only (no AIOS) | @metaglass/aios |
| **Turn loop** | Simple for-loop | ConversationEngine |
| **Max turns** | 20 (default) | 50 (default) |
| **Timeout** | 60s | 5 min |
| **Planning** | No | Yes (PlanManager) |
| **Reflection** | No | Yes (ReflectionEngine) |
| **Parallel tools** | No | Infrastructure exists (not wired) |
| **Subagents** | No | Interface exists (not wired) |
| **Intent classification** | No | Yes (regex + LLM) |
| **Context compression** | No | Yes (LLM summarization) |
| **TodoWrite enforcement** | No | Yes (gradient guidance) |
| **Use case** | Quick Q&A, simple tasks | Complex multi-step agent work |

---

## Provider Injection Pattern

The AIOS kernel uses constructor injection for all external dependencies:

```typescript
// AIOS kernel defines interfaces
interface LLMProvider {
  chat(messages, options?): Promise<LLMResponse>;
  stream?(messages, options?): AsyncGenerator<string>;
  getCapabilities(): LLMCapabilities;
  isConfigured(): boolean;
}

// Host injects implementations
const engine = new ConversationEngine({
  llm: new VercelAILLMProvider({ model: anthropic('claude-sonnet-4-5-20250514') }),
  tools: new SkillToolProvider(),
  ui: new SolidUserInterface(),
  events: new EventBusAdapter(),
});
```

Global provider management (via `setProviders()`) allows host to configure once at startup:

```typescript
// AIOSRuntime.ts (host)
setProviders({
  createLLMProvider: () => new VercelAILLMProvider(config),
  createToolProvider: () => new SkillToolProvider(),
  getUserInterface: () => new SolidUserInterface(),
  getEventEmitter: () => new EventBusAdapter(),
});
```

---

## Event Architecture

Events flow from kernel → host for UI updates and observability:

```
ConversationEngine (kernel)
  │ emits
  ▼
EventEmitter interface (kernel)
  │ implemented by
  ▼
EventBusAdapter (host)
  │ forwards to
  ▼
Metaglass EventBus (host)
  │ subscribers
  ▼
UI Components (SolidJS reactivity)
```

**Event Categories:**
- **Conversation lifecycle**: started, turn, completed, failed, cancelled, timeout
- **Tool events**: tool-call, tool-result
- **Planning**: plan:entered, plan:updated, plan:exited
- **Tasks**: todo:updated, task:spawned, task:completed
- **Contracts**: contract:pending-approval, contract:approved, contract:rejected

---

## Type Decoupling Strategy

The host defines its own types in `src/core/agentic/ports/types.ts` that are **structurally compatible** with AIOS kernel types but share no import symbols:

```
AIOS Kernel types (source of truth)
  │
  │ TypeScript structural typing
  │ (no shared symbols needed)
  │
Host types (local definitions)
  Message, ToolCall, ToolResult, etc.
```

This means:
1. Host can evolve types independently
2. AIOS can add fields without breaking host (additive changes)
3. No circular dependency between repos
4. Host types act as a contract — if AIOS changes a required field, TypeScript catches it at compile time
