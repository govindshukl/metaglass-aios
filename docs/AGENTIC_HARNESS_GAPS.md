# AIOS Kernel — Agentic Harness Gap Analysis & Implementation Plan

**Date**: 2026-03-21
**Scope**: `metaglass-aios` kernel only (not the host app)
**Reference**: OpenClaw/Pi-mono architecture study

---

## Current State

The AIOS kernel (`metaglass-aios`) provides:

| Component | Status | Notes |
|-----------|--------|-------|
| ConversationEngine | Solid | Multi-turn loop, cancellation, timeout, events |
| ContextCompressor | Working | LLM summarization at 70% capacity, preserves 5 recent turns |
| TaskSpawner | Exists, disconnected | 8 agent types, background tasks — **no AgentFactory wired** |
| ToolMetadataRegistry | Good | `allowsParallelExecution` flag per tool — **never used in loop** |
| `partitionToolCalls()` | Exported, unused | Separates parallel-safe from sequential tools |
| ToolRetryPolicy | Working | Retry with backoff |
| IntentClassifier | Working | Regex + LLM, complexity detection |
| ConversationStore | Working | Session persistence (JSONL) |
| AIOSService | Working | Memory injection via provider callbacks |

---

## 4 Gaps

### Gap 1: Sequential Tool Execution

**Problem**: ConversationEngine.ts line 1096 runs tools one-by-one:
```typescript
for (const toolCall of response.toolCalls) {
  const result = await this.executeTool(toolCall);
}
```

**Irony**: `ToolMetadataRegistry` already classifies every tool with `allowsParallelExecution: boolean`. The function `partitionToolCalls()` exists and is exported. The engine just never calls it.

**Impact**: When the LLM returns 3 independent queries (search + read + memory recall), they take 3x the time they should.

---

### Gap 2: TaskSpawner Has No Production AgentFactory

**Problem**: `TaskSpawner` requires an `AgentFactory` interface:
```typescript
interface AgentFactory {
  create(config: AgentConfig): Agent;
}
```
Nobody implements this. The spawner works in tests with mocks but has no production bridge to ConversationEngine.

**Impact**: Subagents are defined (explore, contract, execute, Plan, Bash, Skill) with proper tool scoping and model tiers, but can never actually run.

---

### Gap 3: No Memory Awareness in the Kernel

**Problem**: ConversationEngine has zero memory capability. Memory is bolted on externally via `AIOSService.getMemoryContext()` callback, which:
- Only runs once at conversation start (not per-turn)
- Only injects into the system prompt (not into the loop)
- Has no flush mechanism before context compaction

**Two sub-gaps**:

**A) No pre-turn memory recall**: The engine never recalls relevant memories before LLM calls. If the user asks "what did we decide about X?", the engine has no way to fetch that context mid-conversation.

**B) No flush-before-discard**: When `ContextCompressor` fires, it summarizes and discards older turns. Any details not captured in the summary are permanently lost. OpenClaw solves this with a silent "flush" turn that writes durable memories before compaction.

---

### Gap 4: No Skill Awareness in the Kernel

**Problem**: The AIOS kernel has zero skill awareness. The only reference is a `'Skill'` label in `SubAgentType` (TaskSpawner.ts line 108) — it's just a string, not a real integration.

Meanwhile, the host app has a **full skill system**:

| Host Component | What It Does |
|----------------|-------------|
| `SkillRegistry` | Registers/discovers skills from 3 sources (builtin, user, vault) with priority resolution |
| `SkillParser` | Parses `SKILL.md` files (frontmatter + markdown sections → Skill object) |
| `SkillRouter` | Routes user input to matching skills via trigger patterns |
| `SmartSkillService` | Executes multi-step skill workflows (steps, tools, variable resolution) |
| `SkillAdapter` | Bridges host skills to the agentic port layer (`SkillPort`) |
| `SkillEmbeddingService` | Semantic skill matching via embeddings |
| `SkillDirectoryWatcher` | Hot-reloads vault/user skills when files change |
| 11 builtin skills | `SKILL.md` format: project-note, concept-note, daily-note, meeting-note, etc. |

**The gap**: When the engine receives user input like "create a concept note about embeddings", it has no way to:
1. **Match** the input against registered skills
2. **Enrich** the LLM prompt with skill-specific guidance (purpose, guidelines, output template, checklist)
3. **List** available skills so the LLM knows what's possible

All skill logic runs in the host's `SkillAdapter → SkillPort`, which the engine never calls.

**Impact**: The engine operates generically on every request. It never gets domain-specific guidance, templates, or quality checklists — even when a perfectly matching skill exists.

**SKILL.md format** (what the kernel needs to consume):
```yaml
---
name: concept-note
description: "Capture a single idea with definition, examples, and connections"
triggers:
  - "create a concept note"
  - "explain {concept}"
  - "define {concept}"
inputs:
  - "title|required"
  - "domain|optional"
output: assets/template.md
node_type: concept
suggested_edges: [prerequisite, leads_to, similar_to]
tools: []
agent_ready: false
---

# Concept Note
## Purpose
Captures a single idea — clearly defined, with examples and connections.

## Guidelines
- One concept per note. If the note covers two ideas, split it.
- Use `confidence` field: high, developing, tentative

## Quality Checklist
- [ ] One concept only — note is atomic
- [ ] Concrete example included
- [ ] At least 2 typed relation links
```

---

## Implementation Plan

### Phase 1: Parallel Tool Execution
**Effort**: Small | **Files**: 1 | **Risk**: Low

**File**: `src/kernel/ConversationEngine.ts`

**Change**: Replace the sequential `for` loop (line 1096) with parallel-aware execution using the existing `partitionToolCalls()`:

```typescript
import { partitionToolCalls, toolAllowsParallel } from './ToolMetadataRegistry';

// In runLoop(), replace the sequential tool execution block:
const { parallel, sequential } = partitionToolCalls(response.toolCalls);

// Execute parallel-safe tools concurrently
if (parallel.length > 0) {
  const parallelResults = await Promise.allSettled(
    parallel.map(tc => this.executeToolWithEvents(tc))
  );
  for (let i = 0; i < parallel.length; i++) {
    const result = parallelResults[i].status === 'fulfilled'
      ? parallelResults[i].value
      : { success: false, error: parallelResults[i].reason?.message ?? 'Unknown error' };
    this.addToolResultToHistory(parallel[i], result);
  }
}

// Execute sequential tools one-by-one (mutations, confirmations)
for (const toolCall of sequential) {
  const result = await this.executeToolWithEvents(toolCall);
  this.addToolResultToHistory(toolCall, result);
}
```

**What already exists** (no new code needed):
- `partitionToolCalls()` in `ToolMetadataRegistry.ts`
- `TOOL_METADATA` with `allowsParallelExecution` per tool
- Default: unknown tools are `allowsParallelExecution: true` (safe for queries)

**Verification**:
- Existing test: `ToolMetadataRegistry.test.ts` — `partitionToolCalls` tests pass
- New test: Mock 3 parallel tools with 100ms delay each, verify total time < 200ms (not 300ms)
- Regression: Run full test suite, verify sequential tools still execute in order

---

### Phase 2: MemoryProvider Interface
**Effort**: Small | **Files**: 2 | **Risk**: Low

**New file**: `src/interfaces/MemoryProvider.ts`

```typescript
/**
 * MemoryProvider — kernel-level memory abstraction
 *
 * The host implements this to give the engine memory recall and storage.
 * The engine uses it for pre-turn recall and pre-compaction flush.
 */

/** A recalled memory item */
export interface MemoryItem {
  /** Memory content */
  content: string;
  /** Relevance score (0-1) */
  relevance?: number;
  /** Category/type of memory */
  category?: string;
  /** Source identifier */
  source?: string;
}

/** Memory provider interface */
export interface MemoryProvider {
  /** Recall memories relevant to a query */
  recall(query: string, options?: { limit?: number; category?: string }): Promise<MemoryItem[]>;

  /** Store a durable memory */
  store(content: string, options?: { category?: string; source?: string }): Promise<{ id: string }>;
}
```

**File**: `src/interfaces/index.ts` — add export

**File**: `src/kernel/ConversationEngine.ts` — add to `ConversationEngineDeps`:
```typescript
export interface ConversationEngineDeps {
  llm: LLMProvider;
  tools: ToolProvider;
  ui: UserInterface;
  events: EventEmitter;
  classifierLlm?: LLMProvider;
  memory?: MemoryProvider;  // NEW — optional, backward compatible
}
```

**Verification**:
- `npm run typecheck` passes (optional field, no breaking changes)
- Existing tests unaffected (memory not provided = no-op)

---

### Phase 3: Pre-Turn Memory Recall
**Effort**: Small | **Files**: 1 | **Risk**: Low

**File**: `src/kernel/ConversationEngine.ts`

**Where**: In `runLoop()`, after context compression (line ~837) and before the LLM call (line ~866).

```typescript
// Inject recalled memories into context (if memory provider available)
if (this.memory) {
  const recallQuery = this.extractRecallQuery(messagesToSend);
  if (recallQuery) {
    const memories = await this.memory.recall(recallQuery, { limit: 5 });
    if (memories.length > 0) {
      const memoryBlock = memories
        .map(m => `- ${m.content}`)
        .join('\n');
      // Prepend as a system-level context block (not a user message)
      messagesToSend = [
        ...messagesToSend.filter(m => m.role === 'system'),
        { role: 'system', content: `[Recalled Memories]\n${memoryBlock}` },
        ...messagesToSend.filter(m => m.role !== 'system'),
      ];
    }
  }
}
```

**Helper method**:
```typescript
private extractRecallQuery(messages: Message[]): string | null {
  // Use the last user message as the recall query
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg || lastUserMsg.content.startsWith('[System')) return null;
  // Truncate to 200 chars for efficient recall
  return lastUserMsg.content.slice(0, 200);
}
```

**Configuration**: Add to `ConversationConfig`:
```typescript
/** Enable automatic memory recall before each turn (default: true if memory provider present) */
enableMemoryRecall?: boolean;
/** Maximum memories to recall per turn */
maxRecallMemories?: number;
```

**Verification**:
- New test: Provide mock MemoryProvider, verify `recall()` called before each LLM call
- New test: Verify recalled memories appear in messages sent to LLM
- New test: Verify no recall when `enableMemoryRecall: false`

---

### Phase 4: Pre-Compaction Memory Flush
**Effort**: Medium | **Files**: 2 | **Risk**: Medium

**File**: `src/kernel/ContextCompressor.ts`

Add a "will compress" check that doesn't actually compress:
```typescript
/** Check if compression would trigger (without actually compressing) */
willCompress(history: Message[], systemPrompt?: string): boolean {
  if (!this.config.enabled) return false;
  const tokens = this.estimateTokens(history) +
    (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);
  const turns = this.countTurns(history);
  return tokens >= this.config.maxTokens * 0.7 && turns >= this.config.summarizeThreshold;
}
```

**File**: `src/kernel/ConversationEngine.ts`

**Where**: In `runLoop()`, before the existing compression block (line ~834).

```typescript
// Pre-compaction memory flush (if memory provider available)
if (this.memory && this.contextCompressor.willCompress(this.history, config.systemPrompt)) {
  log.info('Pre-compaction memory flush triggered');

  this.debugHarness?.trace('memory-flush', 'flush-started', {
    turn: this.currentTurn,
    historyLength: this.history.length,
  });

  try {
    // Silent turn: ask agent to persist important facts
    const flushMessages: Message[] = [
      ...this.history,
      {
        role: 'user',
        content: '[System] Session nearing context limit. Review the conversation and call memory_store for any important facts, decisions, or preferences worth remembering long-term. Reply with NO_REPLY if nothing to store.',
      },
    ];

    // Only give the agent the memory store tool
    const memoryStoreTool = this.tools.list().find(t => t.name === 'memory_store');
    const flushTools = memoryStoreTool ? [memoryStoreTool] : [];

    const flushResponse = await this.llm.chat(flushMessages, {
      tools: flushTools,
      maxTokens: 500,
      temperature: 0.3,
    });

    // Execute any memory.store calls
    if (flushResponse.toolCalls?.length) {
      let storedCount = 0;
      for (const tc of flushResponse.toolCalls) {
        if (tc.name === 'memory_store' || tc.name === 'memory.store') {
          await this.memory.store(
            String(tc.params.content),
            { category: String(tc.params.category || 'research') }
          );
          storedCount++;
        }
      }
      log.info('Memory flush complete', { storedCount });

      this.debugHarness?.trace('memory-flush', 'flush-complete', {
        storedCount,
        turn: this.currentTurn,
      });
    }
  } catch (error) {
    log.warn('Memory flush failed, proceeding with compression', { error });
  }

  // Track that we flushed this cycle (prevent repeated flushes)
  this.hasFlushThisCycle = true;
}
```

**Configuration**: Add to `ConversationConfig`:
```typescript
/** Memory flush settings */
memoryFlush?: {
  /** Enable pre-compaction memory flush (default: true if memory provider present) */
  enabled?: boolean;
  /** System prompt for the flush turn */
  flushPrompt?: string;
};
```

**Verification**:
- New test: Mock MemoryProvider + mock LLM that returns memory_store calls, verify `store()` called before compression
- New test: Verify flush only triggers once per compaction cycle
- New test: Verify flush skipped when `memoryFlush.enabled: false`
- New test: Verify conversation continues normally after flush

---

### Phase 5: ConversationEngine AgentFactory
**Effort**: Medium | **Files**: 2 | **Risk**: Medium

**New file**: `src/kernel/ConversationEngineAgentFactory.ts`

```typescript
import type { AgentFactory, AgentConfig, Agent } from './TaskSpawner';
import { ConversationEngine, type ConversationEngineDeps } from './ConversationEngine';

/**
 * AgentFactory that creates child ConversationEngine instances.
 * Each child gets scoped tools based on AgentConfig.allowedTools.
 */
export class ConversationEngineAgentFactory implements AgentFactory {
  private baseDeps: ConversationEngineDeps;
  private maxDepth: number;
  private currentDepth: number;

  constructor(baseDeps: ConversationEngineDeps, options?: { maxDepth?: number; currentDepth?: number }) {
    this.baseDeps = baseDeps;
    this.maxDepth = options?.maxDepth ?? 3;
    this.currentDepth = options?.currentDepth ?? 0;
  }

  create(config: AgentConfig): Agent {
    if (this.currentDepth >= this.maxDepth) {
      throw new Error(`Maximum subagent depth (${this.maxDepth}) exceeded`);
    }

    // Scope tools based on config.allowedTools
    const scopedTools = config.allowedTools === '*'
      ? this.baseDeps.tools
      : this.createScopedToolProvider(config.allowedTools);

    const childDeps: ConversationEngineDeps = {
      ...this.baseDeps,
      tools: scopedTools,
    };

    const childEngine = new ConversationEngine(childDeps);

    return {
      execute: async (prompt: string) => {
        return childEngine.execute(prompt, {
          systemPrompt: config.systemPrompt,
          maxTurns: 20,  // Child gets fewer turns
          timeoutMs: 120000,
          requireTodoWrite: false,  // Children don't need TodoWrite
        });
      },
      cancel: () => childEngine.cancel(),
      isRunning: () => childEngine.isRunning(),
    };
  }

  private createScopedToolProvider(allowedTools: string[]): ToolProvider {
    const allowSet = new Set(allowedTools);
    return {
      list: () => this.baseDeps.tools.list().filter(t => allowSet.has(t.name)),
      execute: async (id, params, context) => {
        if (!allowSet.has(id)) {
          return { success: false, error: `Tool '${id}' not allowed for this agent type` };
        }
        return this.baseDeps.tools.execute(id, params, context);
      },
    };
  }
}
```

**File**: `src/kernel/ConversationEngine.ts`

Add TaskSpawner integration:
- Add `taskSpawner?: TaskSpawner` to `ConversationEngineDeps`
- In constructor, if `taskSpawner` provided, register a `spawn_task` virtual tool
- Handle `spawn_task` calls in the tool execution block

**Verification**:
- New test: Create factory, spawn explore agent, verify only read tools available
- New test: Spawn execute agent, verify full tool access
- New test: Verify depth limit enforcement (depth 3 → error)
- New test: Verify child cancellation propagates from parent

---

### Phase 6: Wire TaskSpawner as a Tool
**Effort**: Small | **Files**: 1 | **Risk**: Low

**File**: `src/kernel/ConversationEngine.ts`

When TaskSpawner is provided in deps, inject a virtual `spawn_task` tool into the tool list returned to the LLM:

```typescript
// In runLoop(), when building toolsList:
const toolsList = this.tools.list();
if (this.taskSpawner) {
  toolsList.push({
    name: 'spawn_task',
    description: 'Spawn a sub-agent for a focused subtask. Use for research, exploration, or delegated work.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short description (3-5 words)' },
        prompt: { type: 'string', description: 'Detailed task for the sub-agent' },
        subagentType: {
          type: 'string',
          enum: ['explore', 'contract', 'execute'],
          description: 'Agent type: explore (read-only), contract (planning), execute (full access)',
        },
      },
      required: ['description', 'prompt', 'subagentType'],
    },
  });
}

// In tool execution, intercept spawn_task:
if (toolCall.name === 'spawn_task') {
  const result = await this.taskSpawner.spawn({
    description: String(toolCall.params.description),
    prompt: String(toolCall.params.prompt),
    subagentType: toolCall.params.subagentType as SubAgentType,
  });
  // Add result as tool response
  this.history.push({
    role: 'tool',
    content: JSON.stringify(result),
    toolCallId: toolCall.id,
    toolName: 'spawn_task',
  });
  continue; // Skip normal tool execution
}
```

**Verification**:
- New test: Mock LLM returns `spawn_task` call → verify TaskSpawner.spawn() invoked
- New test: Verify spawn_task result fed back to LLM
- New test: Verify spawn_task not in tool list when TaskSpawner not provided

---

### Phase 7: SkillProvider Interface
**Effort**: Small | **Files**: 2 | **Risk**: Low

**New file**: `src/interfaces/SkillProvider.ts`

```typescript
/**
 * SkillProvider — kernel-level skill abstraction
 *
 * The host implements this to give the engine skill matching and prompt enrichment.
 * The engine uses it for pre-turn skill detection and LLM prompt enrichment.
 *
 * Design: mirrors MemoryProvider pattern — optional, backward compatible.
 */

/** Skill match result */
export interface SkillMatchResult {
  /** Matched skill ID */
  skillId: string;
  /** Match confidence (0-1) */
  confidence: number;
  /** Pattern that matched */
  matchedPattern: string;
}

/** Skill prompt enrichment */
export interface SkillEnrichment {
  /** Additions to prepend to system prompt */
  systemAdditions: string;
  /** Additional tool definitions to include (for smart skills) */
  toolAdditions?: ToolDefinition[];
}

/** Skill summary for LLM awareness */
export interface SkillSummary {
  /** Skill ID */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
}

/** Skill provider interface */
export interface SkillProvider {
  /**
   * Match user input against available skills.
   * Returns the best match, or null if no skill applies.
   */
  match(input: string): Promise<SkillMatchResult | null>;

  /**
   * Build enriched prompt content for a matched skill.
   * Called after match() returns a result.
   */
  enrich(skillId: string, userInput: string): Promise<SkillEnrichment>;

  /**
   * List all available skills (for LLM system prompt awareness).
   * Called once at conversation start to inform the LLM what skills exist.
   */
  list(): Promise<SkillSummary[]>;
}
```

**File**: `src/interfaces/index.ts` — add export

**File**: `src/kernel/ConversationEngine.ts` — add to `ConversationEngineDeps`:
```typescript
export interface ConversationEngineDeps {
  // ... existing fields ...
  skills?: SkillProvider;  // NEW — optional, backward compatible
}
```

**Verification**:
- `npm run typecheck` passes (optional field, no breaking changes)
- Existing tests unaffected (skills not provided = no-op)

---

### Phase 8: Pre-Turn Skill Matching + Enrichment
**Effort**: Small | **Files**: 1 | **Risk**: Low

**File**: `src/kernel/ConversationEngine.ts`

**Where**: In `runLoop()`, after memory recall (Phase 3) and before the LLM call. This ensures skill enrichment stacks with recalled memories.

```typescript
// Skill matching + enrichment (if skills provider available)
if (this.skills) {
  // On first turn only: inject skill awareness into system prompt
  if (this.currentTurn === 1) {
    const availableSkills = await this.skills.list();
    if (availableSkills.length > 0) {
      const skillList = availableSkills
        .map(s => `- **${s.name}**: ${s.description}`)
        .join('\n');
      systemPrompt += `\n\n## Available Skills\nYou can use these skills when relevant:\n${skillList}`;
    }
  }

  // Every turn: check if user input matches a skill
  const lastUserMsg = [...messagesToSend].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    const match = await this.skills.match(lastUserMsg.content);
    if (match && match.confidence > 0.6) {
      const enrichment = await this.skills.enrich(match.skillId, lastUserMsg.content);

      if (enrichment.systemAdditions) {
        // Inject skill guidance as a system message
        messagesToSend = [
          ...messagesToSend.filter(m => m.role === 'system'),
          { role: 'system', content: `[Active Skill]\n${enrichment.systemAdditions}` },
          ...messagesToSend.filter(m => m.role !== 'system'),
        ];
      }

      // Add skill-specific tools to the tool list for this turn
      if (enrichment.toolAdditions?.length) {
        turnTools.push(...enrichment.toolAdditions);
      }

      this.debugHarness?.trace('skill-match', 'enriched', {
        skillId: match.skillId,
        confidence: match.confidence,
        turn: this.currentTurn,
      });
    }
  }
}
```

**Configuration**: Add to `ConversationConfig`:
```typescript
/** Enable automatic skill matching before each turn (default: true if skills provider present) */
enableSkillMatching?: boolean;
/** Minimum confidence threshold for skill activation */
skillMatchThreshold?: number;  // default: 0.6
```

**Verification**:
- New test: Provide mock SkillProvider, verify `match()` called per turn
- New test: Verify enrichment injected into system prompt when confidence > threshold
- New test: Verify skill list injected on turn 1 only
- New test: Verify no matching when `enableSkillMatching: false`
- New test: Verify skill-specific tools added to turn when enrichment includes them

---

### Phase 9: Skill-Aware Subagents
**Effort**: Small | **Files**: 1 | **Risk**: Low

**File**: `src/kernel/TaskSpawner.ts`

The existing `Skill` agent type already exists but with a generic prompt. Update it to accept a `skillId` parameter and pass skill enrichment to the child engine:

```typescript
// In AGENT_TYPE_CONFIGS, update the Skill type:
Skill: {
  label: 'Skill Executor',
  allowedTools: '*',
  modelTier: 'standard' as ModelTier,
  systemPromptSuffix: 'You are a skill execution agent. Follow the skill guidelines precisely.',
},
```

**File**: `src/kernel/ConversationEngineAgentFactory.ts` (from Phase 5)

When spawning a `Skill` agent, pass the skill enrichment as part of the system prompt:

```typescript
// In create(), when config.subagentType === 'Skill':
if (config.subagentType === 'Skill' && config.metadata?.skillId && this.baseDeps.skills) {
  const enrichment = await this.baseDeps.skills.enrich(
    String(config.metadata.skillId),
    String(config.metadata.prompt || '')
  );
  config.systemPrompt = (config.systemPrompt || '') + '\n\n' + enrichment.systemAdditions;
}
```

**Verification**:
- New test: Spawn Skill subagent with skillId, verify enrichment injected into child system prompt
- New test: Spawn non-Skill subagent, verify no skill enrichment

---

## Execution Order

```
Phase 1 (parallel tools)        ← Smallest change, biggest immediate impact
    ↓
Phase 2 (MemoryProvider)        ← Interface only, no behavior change
Phase 7 (SkillProvider)         ← Interface only, no behavior change
    ↓                             (2 and 7 are independent)
Phase 3 (pre-turn recall)       ← Uses Phase 2 interface
Phase 4 (pre-compaction flush)  ← Uses Phase 2 interface
Phase 8 (skill matching)        ← Uses Phase 7 interface
    ↓                             (3, 4, and 8 are independent)
Phase 5 (AgentFactory)          ← New file, self-contained
    ↓
Phase 6 (spawn_task tool)       ← Wires Phase 5 into engine
Phase 9 (skill-aware subagents) ← Uses Phase 5 + Phase 7
```

Phases 1, 2, 7 can ship independently. Phases 3+4 depend on 2. Phase 8 depends on 7. Phases 5+6 are independent of memory/skills. Phase 9 depends on 5+7.

---

## Files Changed

| File | Phase | Change |
|------|-------|--------|
| `src/kernel/ConversationEngine.ts` | 1,3,4,6 | Parallel exec, recall hook, flush hook, spawn_task |
| `src/kernel/ContextCompressor.ts` | 4 | Add `willCompress()` check |
| `src/interfaces/MemoryProvider.ts` | 2 | **NEW**: kernel memory interface |
| `src/interfaces/index.ts` | 2 | Export MemoryProvider |
| `src/kernel/ConversationEngineAgentFactory.ts` | 5 | **NEW**: AgentFactory implementation |
| `src/interfaces/SkillProvider.ts` | 7 | **NEW**: kernel skill interface |
| `src/kernel/TaskSpawner.ts` | 9 | Skill-aware subagent enrichment |
| `src/kernel/index.ts` | 5 | Export factory |
| `src/index.ts` | 2,5,7 | Export new types |

## Files NOT Changed

- `ToolMetadataRegistry.ts` — already has everything needed for parallel tools
- `TaskSpawner.ts` — already complete, just needs a factory
- `ToolRetryPolicy.ts` — unaffected
- `AIOSService.ts` — existing `getMemoryContext` callback still works (backward compatible)

---

## Backward Compatibility

All changes are additive:
- `memory?: MemoryProvider` is optional in deps — existing consumers unaffected
- `taskSpawner?: TaskSpawner` is optional — no spawn_task tool when absent
- Parallel execution uses existing metadata — unknown tools default to `allowsParallelExecution: true`
- New `ConversationConfig` fields are optional with sensible defaults
- `AIOSService.getMemoryContext()` callback continues working alongside the new MemoryProvider

---

## Verification Strategy

```bash
# After each phase:
npm run typecheck          # No type errors
npm run test:run           # All 451 existing tests pass
npm run test:coverage      # Coverage doesn't drop

# Phase-specific:
# Phase 1: Add timing test for parallel tool execution
# Phase 2: Type-check only (no behavior)
# Phase 3: Mock MemoryProvider, verify recall() called per turn
# Phase 4: Mock MemoryProvider + compression threshold, verify store() called before compress
# Phase 5: Create factory, verify scoped tool filtering
# Phase 6: Mock LLM with spawn_task call, verify TaskSpawner integration
# Phase 7: Type-check only (no behavior)
# Phase 8: Mock SkillProvider, verify match()+enrich() called per turn, list() on turn 1
# Phase 9: Spawn Skill subagent, verify enrichment injected into child
```

---

## Relationship to Host App (learning-os)

After these kernel changes, the host app needs:

| Host Change | Purpose |
|-------------|---------|
| `MemoryAdapter` implements `MemoryProvider` | Bridge hub-based memory to kernel interface |
| `SkillAdapter` implements `SkillProvider` | Bridge host SkillRegistry/SkillRouter to kernel interface (already 90% done — `MetaglassSkillAdapter` exists, just needs to implement kernel `SkillProvider` instead of port `SkillPort`) |
| Wire `MemoryProvider` into `ConversationEngineDeps` | Enable recall + flush in MetaglassEngine |
| Wire `SkillProvider` into `ConversationEngineDeps` | Enable skill matching + enrichment in MetaglassEngine |
| Wire `ConversationEngineAgentFactory` into deps | Enable subagent spawning |
| Update `MetaglassEngine` to pass new deps | Connect the pipes |

These are adapter changes only — no new Metaglass logic needed. The host's `MetaglassSkillAdapter` already has `match()`, `get()`, `list()`, and `buildPrompt()` methods that map directly to the kernel's `SkillProvider` interface.
