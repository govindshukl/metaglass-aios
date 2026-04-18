# AIOS + Metaglass — Sequence Diagrams

**Date**: 2026-03-21
**Format**: Mermaid-compatible text diagrams

---

## 1. Full Conversation Lifecycle (MetaglassEngine Path)

```
User          GoalPalette    EngineManager   MetaglassEngine   AIOSRuntime     ConversationEngine   LLMProvider   ToolProvider   EventBus
 │                │               │                │               │                  │                  │              │            │
 │  "Create a     │               │                │               │                  │                  │              │            │
 │   note about   │               │                │               │                  │                  │              │            │
 │   AI"          │               │                │               │                  │                  │              │            │
 │───────────────▶│               │                │               │                  │                  │              │            │
 │                │  run(params)  │                │               │                  │                  │              │            │
 │                │──────────────▶│                │               │                  │                  │              │            │
 │                │               │  getEngine()   │               │                  │                  │              │            │
 │                │               │───────────────▶│               │                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │  run(input,    │               │                  │                  │              │            │
 │                │               │   config)      │               │                  │                  │              │            │
 │                │               │───────────────▶│               │                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │  getProviders()│                  │                  │              │            │
 │                │               │                │──────────────▶│                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │  ◀── providers │                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │  new ConversationEngine(deps)     │                  │              │            │
 │                │               │                │─────────────────────────────────▶│                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │  execute(prompt, config)          │                  │              │            │
 │                │               │                │─────────────────────────────────▶│                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │               │         emit conversation:started   │              │            │
 │                │               │                │               │                  │─────────────────────────────────────────────▶│
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │               │      ┌──── TURN LOOP ─────┐        │              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ classifyIntent()    │        │              │            │
 │                │               │                │               │      │ (first turn only)   │        │              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ chat(messages,tools) │        │              │            │
 │                │               │                │               │      │────────────────────▶│        │              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ ◀── LLMResponse     │        │              │            │
 │                │               │                │               │      │   (with toolCalls)  │        │              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ emit conversation:turn       │              │            │
 │                │               │                │               │      │─────────────────────────────────────────────────────────▶│
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ FOR EACH tool call:  │        │              │            │
 │                │               │                │               │      │ emit tool-call       │        │              │            │
 │                │               │                │               │      │──────────────────────────────────────────────────────────▶│
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ execute(toolId, params)       │              │            │
 │                │               │                │               │      │──────────────────────────────▶│              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ ◀── ToolResult       │        │              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ emit tool-result     │        │              │            │
 │                │               │                │               │      │──────────────────────────────────────────────────────────▶│
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      │ (compression check)  │        │              │            │
 │                │               │                │               │      │                     │        │              │            │
 │                │               │                │               │      └──── REPEAT ─────────┘        │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │               │      (LLM returns no toolCalls)     │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │               │         emit conversation:completed │              │            │
 │                │               │                │               │                  │─────────────────────────────────────────────▶│
 │                │               │                │               │                  │                  │              │            │
 │                │               │                │  ◀── ConversationResult           │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │               │  ◀── EngineRunResult           │                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │                │  ◀── result   │                │               │                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
 │  ◀── response  │               │                │               │                  │                  │              │            │
 │                │               │                │               │                  │                  │              │            │
```

---

## 2. MinimalEngine Turn Loop (Simplified Path)

```
User        EngineManager    MinimalEngine     LLMPort          ToolPort
 │               │                │               │                │
 │  query        │                │               │                │
 │──────────────▶│                │               │                │
 │               │  run(params)   │               │                │
 │               │───────────────▶│               │                │
 │               │                │               │                │
 │               │                │ ── Build messages array ──     │
 │               │                │ [system prompt, user msg]      │
 │               │                │               │                │
 │               │                │  ┌── TURN LOOP (max 20) ──┐   │
 │               │                │  │                         │   │
 │               │                │  │ complete(msgs, tools)   │   │
 │               │                │  │────────────────────────▶│   │
 │               │                │  │                         │   │
 │               │                │  │ ◀── LLMResponse         │   │
 │               │                │  │   { content, toolCalls }│   │
 │               │                │  │                         │   │
 │               │                │  │ if no toolCalls → DONE  │   │
 │               │                │  │                         │   │
 │               │                │  │ FOR EACH toolCall:      │   │
 │               │                │  │ invoke(name, params)    │   │
 │               │                │  │────────────────────────────▶│
 │               │                │  │                         │   │
 │               │                │  │ ◀── ToolResult           │   │
 │               │                │  │                         │   │
 │               │                │  │ Append to messages      │   │
 │               │                │  │                         │   │
 │               │                │  └── NEXT TURN ────────────┘   │
 │               │                │               │                │
 │               │  ◀── { success, response }     │                │
 │               │                │               │                │
 │  ◀── response │                │               │                │
 │               │                │               │                │
```

---

## 3. Engine Initialization & Registration

```
App Startup     engines/index.ts   MinimalEngine    MetaglassEngine   EngineRegistry    EngineManager
    │                │                  │                 │                │                 │
    │  import        │                  │                 │                │                 │
    │  agentic       │                  │                 │                │                 │
    │───────────────▶│                  │                 │                │                 │
    │                │                  │                 │                │                 │
    │                │ registerBuiltinEngines()           │                │                 │
    │                │──────────────────┤                 │                │                 │
    │                │                  │                 │                │                 │
    │                │  registerMinimalEngine()           │                │                 │
    │                │  ──────────────▶ │                 │                │                 │
    │                │                  │  registry.register(descriptor)   │                 │
    │                │                  │────────────────────────────────▶│                 │
    │                │                  │                 │                │                 │
    │                │  registerMetaglassEngine()         │                │                 │
    │                │  ────────────────────────────────▶│                │                 │
    │                │                  │                 │ registry.register(descriptor)    │
    │                │                  │                 │───────────────▶│                 │
    │                │                  │                 │                │                 │
    │  initializeAgenticSystem()        │                 │                │                 │
    │──────────────────────────────────────────────────────────────────────────────────────▶│
    │                │                  │                 │                │                 │
    │                │                  │                 │           manager.initialize()   │
    │                │                  │                 │                │◀────────────────│
    │                │                  │                 │                │                 │
    │                │                  │                 │     load saved engineId          │
    │                │                  │                 │     from localStorage            │
    │                │                  │                 │                │────────────────▶│
    │                │                  │                 │                │                 │
    │                │                  │                 │           activate('minimal')    │
    │                │                  │                 │                │◀────────────────│
    │                │                  │                 │                │                 │
    │                │                  │                 │     descriptor.create(config)    │
    │                │                  │                 │                │────────────────▶│
    │                │                  │                 │                │                 │
    │                │                  │                 │           ◀── engine instance    │
    │                │                  │                 │                │                 │
    │  ◀── ready     │                  │                 │                │                 │
    │                │                  │                 │                │                 │
```

---

## 4. Provider Injection (Host → Kernel)

```
AIOSRuntime           setProviders()       AIOSService        ConversationEngine
    │                      │                    │                     │
    │ configureMetaglassProviders()             │                     │
    │────────────────────▶│                     │                     │
    │                      │                    │                     │
    │  setProviders({      │                    │                     │
    │   createLLMProvider: │                    │                     │
    │     () => new VercelAILLMProvider(),      │                     │
    │   createToolProvider:│                    │                     │
    │     () => new SkillToolProvider(),        │                     │
    │   getUserInterface:  │                    │                     │
    │     () => new SolidUserInterface(),       │                     │
    │   getEventEmitter:   │                    │                     │
    │     () => new EventBusAdapter(),          │                     │
    │  })                  │                    │                     │
    │                      │                    │                     │
    │  initializeAIOSRuntime()                  │                     │
    │──────────────────────────────────────────▶│                     │
    │                      │                    │                     │
    │                      │     new AIOSService(config)              │
    │                      │                    │                     │
    │  ── later: execute(prompt) ──             │                     │
    │──────────────────────────────────────────▶│                     │
    │                      │                    │                     │
    │                      │   getProviders()   │                     │
    │                      │◀───────────────────│                     │
    │                      │                    │                     │
    │                      │   providers        │                     │
    │                      │───────────────────▶│                     │
    │                      │                    │                     │
    │                      │        new ConversationEngine({          │
    │                      │          llm: providers.createLLMProvider(),
    │                      │          tools: providers.createToolProvider(),
    │                      │          ui: providers.getUserInterface(),
    │                      │          events: providers.getEventEmitter(),
    │                      │        })           │                    │
    │                      │                    │───────────────────▶│
    │                      │                    │                     │
    │                      │        engine.execute(prompt, config)    │
    │                      │                    │───────────────────▶│
    │                      │                    │                     │
```

---

## 5. Tool Execution with Retry

```
ConversationEngine     ToolRetryPolicy     ToolProvider     EventEmitter
       │                     │                  │                │
       │ executeTool(call)   │                  │                │
       │                     │                  │                │
       │ emit tool-call      │                  │                │
       │───────────────────────────────────────────────────────▶│
       │                     │                  │                │
       │ executeWithRetry()  │                  │                │
       │────────────────────▶│                  │                │
       │                     │                  │                │
       │                     │ attempt 1        │                │
       │                     │ execute(id,params)│                │
       │                     │─────────────────▶│                │
       │                     │                  │                │
       │                     │ ◀── ERROR        │                │
       │                     │ (retryable)      │                │
       │                     │                  │                │
       │                     │ wait(1000ms      │                │
       │                     │  + jitter)       │                │
       │                     │                  │                │
       │                     │ attempt 2        │                │
       │                     │ execute(id,params)│                │
       │                     │─────────────────▶│                │
       │                     │                  │                │
       │                     │ ◀── ToolResult   │                │
       │                     │ (success)        │                │
       │                     │                  │                │
       │ ◀── RetryResult     │                  │                │
       │  { result, attempts:2 }                │                │
       │                     │                  │                │
       │ emit tool-result    │                  │                │
       │───────────────────────────────────────────────────────▶│
       │                     │                  │                │
```

---

## 6. Context Compression

```
ConversationEngine     ContextCompressor    LLMProvider
       │                     │                  │
       │ (history exceeds    │                  │
       │  token threshold)   │                  │
       │                     │                  │
       │ compress(history,   │                  │
       │  systemPrompt)      │                  │
       │────────────────────▶│                  │
       │                     │                  │
       │                     │ estimateTokens() │
       │                     │ → 85k tokens     │
       │                     │ (> 70% of 100k)  │
       │                     │                  │
       │                     │ Preserve last    │
       │                     │ 5 turns verbatim │
       │                     │                  │
       │                     │ Summarize older  │
       │                     │ turns via LLM:   │
       │                     │                  │
       │                     │ chat([           │
       │                     │  "Summarize      │
       │                     │   these turns"   │
       │                     │ ])               │
       │                     │─────────────────▶│
       │                     │                  │
       │                     │ ◀── summary text │
       │                     │                  │
       │                     │ Build compressed │
       │                     │ history:         │
       │                     │ [system,         │
       │                     │  summary_msg,    │
       │                     │  recent_5_turns] │
       │                     │                  │
       │ ◀── compressed msgs │                  │
       │                     │                  │
       │ Replace history     │                  │
       │ with compressed     │                  │
       │                     │                  │
```

---

## 7. TodoWrite Enforcement Flow

```
ConversationEngine     IntentClassifier     LLMProvider     TodoManager
       │                     │                  │                │
       │ (first turn)        │                  │                │
       │ classifyIntent()    │                  │                │
       │────────────────────▶│                  │                │
       │                     │                  │                │
       │                     │ regex fast-path  │                │
       │                     │ → MULTI_STEP     │                │
       │                     │                  │                │
       │ ◀── { complexity:   │                  │                │
       │  MULTI_STEP }       │                  │                │
       │                     │                  │                │
       │ requireTodoWrite    │                  │                │
       │ = true              │                  │                │
       │                     │                  │                │
       │ ── Turn N: LLM wants to call file.write ──             │
       │                     │                  │                │
       │ Check: hasPlan?     │                  │                │
       │ → false             │                  │                │
       │                     │                  │                │
       │ Check: isExempt?    │                  │                │
       │ → false (mutation)  │                  │                │
       │                     │                  │                │
       │ BLOCK tool call     │                  │                │
       │ Inject guidance:    │                  │                │
       │ "Use TodoWrite      │                  │                │
       │  before proceeding" │                  │                │
       │                     │                  │                │
       │ ── Turn N+1: LLM calls TodoWrite ──   │                │
       │                     │                  │                │
       │                     │                  │      setTodos()│
       │                     │                  │  ────────────▶ │
       │ hasPlan = true      │                  │                │
       │                     │                  │                │
       │ ── Turn N+2: LLM calls file.write ──  │                │
       │                     │                  │                │
       │ Check: hasPlan?     │                  │                │
       │ → true              │                  │                │
       │                     │                  │                │
       │ ALLOW tool call     │                  │                │
       │ Execute normally    │                  │                │
       │                     │                  │                │
```

---

## 8. Engine Hot-Swap

```
User           Settings UI      EngineManager    Old Engine     EngineRegistry    New Engine
 │                │                  │               │                │               │
 │ Select         │                  │               │                │               │
 │ "metaglass"    │                  │               │                │               │
 │───────────────▶│                  │               │                │               │
 │                │                  │               │                │               │
 │                │ activate(        │               │                │               │
 │                │  'metaglass')    │               │                │               │
 │                │─────────────────▶│               │                │               │
 │                │                  │               │                │               │
 │                │                  │ shutdown()    │                │               │
 │                │                  │──────────────▶│               │               │
 │                │                  │               │                │               │
 │                │                  │ ◀── done      │                │               │
 │                │                  │               │                │               │
 │                │                  │ get('metaglass')               │               │
 │                │                  │──────────────────────────────▶│               │
 │                │                  │               │                │               │
 │                │                  │ ◀── descriptor│                │               │
 │                │                  │               │                │               │
 │                │                  │ descriptor.create(config)      │               │
 │                │                  │─────────────────────────────────────────────▶ │
 │                │                  │               │                │               │
 │                │                  │ ◀── engine instance            │               │
 │                │                  │               │                │               │
 │                │                  │ Save to       │                │               │
 │                │                  │ localStorage  │                │               │
 │                │                  │               │                │               │
 │                │ ◀── activated    │               │                │               │
 │                │                  │               │                │               │
 │  ◀── UI update │                  │               │                │               │
 │  (new caps)    │                  │               │                │               │
 │                │                  │               │                │               │
```

---

## 9. Future: Parallel Tool Execution (Gap 1 Resolution)

```
ConversationEngine     ToolMetadataRegistry     ToolProvider (parallel)     ToolProvider (sequential)
       │                        │                        │                         │
       │ LLM returns 4 tool    │                        │                         │
       │ calls: [search,       │                        │                         │
       │  read, write, recall] │                        │                         │
       │                        │                        │                         │
       │ partitionToolCalls()  │                        │                         │
       │───────────────────────▶│                        │                         │
       │                        │                        │                         │
       │ ◀── {                  │                        │                         │
       │   parallel: [search,  │                        │                         │
       │    read, recall],     │                        │                         │
       │   sequential: [write] │                        │                         │
       │ }                      │                        │                         │
       │                        │                        │                         │
       │ Promise.allSettled([   │                        │                         │
       │   execute(search),    │                        │                         │
       │   execute(read),      │                        │                         │
       │   execute(recall)     │                        │                         │
       │ ])                     │                        │                         │
       │────────────────────────────────────────────────▶│                         │
       │                        │                        │                         │
       │ ◀── [result1,         │                        │                         │
       │      result2,         │                        │                         │
       │      result3]         │                        │                         │
       │                        │                        │                         │
       │ THEN sequential:      │                        │                         │
       │ execute(write)         │                        │                         │
       │──────────────────────────────────────────────────────────────────────────▶│
       │                        │                        │                         │
       │ ◀── result4            │                        │                         │
       │                        │                        │                         │
```

---

## 10. Future: Subagent Spawning (Gap 2 Resolution)

```
ConversationEngine     TaskSpawner     AgentFactory     SubAgent(explore)    LLMProvider
       │                    │               │                  │                  │
       │ LLM calls          │               │                  │                  │
       │ spawn_agent({      │               │                  │                  │
       │  type: 'explore',  │               │                  │                  │
       │  prompt: '...'     │               │                  │                  │
       │ })                 │               │                  │                  │
       │                    │               │                  │                  │
       │ spawn(config)      │               │                  │                  │
       │───────────────────▶│               │                  │                  │
       │                    │               │                  │                  │
       │                    │ create(config)│                  │                  │
       │                    │──────────────▶│                  │                  │
       │                    │               │                  │                  │
       │                    │               │ new ConversationEngine({            │
       │                    │               │   llm: haiku-tier,                  │
       │                    │               │   tools: [read-only subset],        │
       │                    │               │   ui: silent,                       │
       │                    │               │ })                │                  │
       │                    │               │─────────────────▶│                  │
       │                    │               │                  │                  │
       │                    │ ◀── agent     │                  │                  │
       │                    │               │                  │                  │
       │                    │ agent.execute(prompt)            │                  │
       │                    │─────────────────────────────────▶│                  │
       │                    │               │                  │                  │
       │                    │               │                  │ chat(...)        │
       │                    │               │                  │────────────────▶│
       │                    │               │                  │                  │
       │                    │               │                  │ ◀── response     │
       │                    │               │                  │                  │
       │ emit task:spawned  │               │                  │                  │
       │                    │               │                  │                  │
       │ ... (subagent runs independently) ...                 │                  │
       │                    │               │                  │                  │
       │                    │ ◀── result    │                  │                  │
       │                    │               │                  │                  │
       │ emit task:completed│               │                  │                  │
       │                    │               │                  │                  │
       │ ◀── AgentResult    │               │                  │                  │
       │ (inject as tool    │               │                  │                  │
       │  result in history)│               │                  │                  │
       │                    │               │                  │                  │
```

---

## Legend

```
───────▶  Synchronous call
─ ─ ─ ─▶  Asynchronous / event-driven
◀──────   Return value
│         Lifeline (object exists)
```
