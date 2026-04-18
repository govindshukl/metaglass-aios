# AIOS Kernel — Breaking Change Prevention Guidelines

**Date**: 2026-03-21
**Scope**: Rules for modifying `metaglass-aios` without breaking `learning-os` (host)

---

## The Contract

The AIOS kernel exposes a **public API surface** consumed by the Metaglass host. Any change to this surface can break the host. The host communicates with the kernel through:

1. **Provider interfaces** — `LLMProvider`, `ToolProvider`, `UserInterface`, `EventEmitter`
2. **Types** — `Message`, `ToolCall`, `ToolResult`, `ChatOptions`, `LLMResponse`, etc.
3. **Engine API** — `ConversationEngine.execute()`, `AIOSService.execute()`
4. **Configuration types** — `ConversationConfig`, `AIOSConfig`, `ConversationEngineDeps`
5. **Event names** — `AIOSEvents` keys (e.g., `conversation:turn`, `todo:updated`)
6. **Exported functions** — `setProviders()`, `getProviders()`, `classifyIntent()`, etc.

---

## Rules

### Rule 1: Never Remove or Rename Exported Symbols

**Bad:**
```typescript
// Before
export interface LLMProvider { chat(...): Promise<LLMResponse>; }

// After — BREAKING: host imports `LLMProvider` by name
export interface LanguageModelProvider { chat(...): Promise<LLMResponse>; }
```

**Good:**
```typescript
// Add new name, keep old as alias
export interface LanguageModelProvider { chat(...): Promise<LLMResponse>; }
/** @deprecated Use LanguageModelProvider */
export type LLMProvider = LanguageModelProvider;
```

**Duration**: Keep deprecated aliases for at least 1 major version.

---

### Rule 2: Never Remove Required Fields from Interfaces

**Bad:**
```typescript
// Before
interface Message { role: MessageRole; content: string; }

// After — BREAKING: host code sets `content` on every message
interface Message { role: MessageRole; parts: Part[]; }
```

**Good:**
```typescript
// Add new field, keep old as optional with migration path
interface Message {
  role: MessageRole;
  content: string;          // Keep existing
  parts?: Part[];           // Add new (optional)
}
```

---

### Rule 3: Adding Optional Fields Is Always Safe

These changes are **non-breaking** by default:

```typescript
// Safe: new optional field
interface ConversationConfig {
  maxTurns?: number;
  timeoutMs?: number;
  enableParallelTools?: boolean;  // NEW — optional, backward compatible
}

// Safe: new optional method on provider interface
interface LLMProvider {
  chat(messages, options?): Promise<LLMResponse>;
  stream?(messages, options?): AsyncGenerator<string>;  // Already optional
  countTokens?(text: string): number;                   // NEW — optional
}
```

---

### Rule 4: Never Change Method Signatures of Provider Interfaces

Provider interfaces are implemented by the **host**. Changing signatures forces host adapter rewrites.

**Bad:**
```typescript
// Before
interface ToolProvider {
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
}

// After — BREAKING: host adapter must update signature
interface ToolProvider {
  execute(id: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
```

**Good:**
```typescript
// Make new parameter optional
interface ToolProvider {
  execute(id: string, params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}
```

---

### Rule 5: Never Change Event Names in AIOSEvents

Event names are string keys. The host subscribes to them by name.

**Bad:**
```typescript
// Renaming — BREAKING
'conversation:tool-executed'  // was 'conversation:tool-result'
```

**Good:**
```typescript
// Add new event, keep old
'conversation:tool-result': { ... };        // Keep
'conversation:tool-executed': { ... };      // Add new
```

---

### Rule 6: New Provider Interfaces Must Be Optional

When adding a new provider (e.g., `MemoryProvider`, `SkillProvider`), it must not be required in `ConversationEngineDeps`.

**Bad:**
```typescript
interface ConversationEngineDeps {
  llm: LLMProvider;
  tools: ToolProvider;
  ui: UserInterface;
  events: EventEmitter;
  memory: MemoryProvider;       // BREAKING: host must now provide this
}
```

**Good:**
```typescript
interface ConversationEngineDeps {
  llm: LLMProvider;
  tools: ToolProvider;
  ui: UserInterface;
  events: EventEmitter;
  memory?: MemoryProvider;      // Optional — kernel falls back gracefully
}
```

---

### Rule 7: Default Behavior Must Not Change Silently

If you change a default value, document it and consider making it explicit.

**Risky:**
```typescript
// Before: maxTurns defaults to 50
// After: maxTurns defaults to 25 — existing users get fewer turns silently
```

**Better:**
```typescript
// Log a warning when using default, or add to changelog
if (!config.maxTurns) {
  logger.info('Using default maxTurns=25 (changed from 50 in v1.3.0)');
}
```

---

### Rule 8: ConversationResult Shape Is Sacred

`ConversationResult` is the return type of `execute()`. Every field the host reads is a contract.

**Current shape (do not remove any field):**
```typescript
interface ConversationResult {
  success: boolean;
  result?: string;
  error?: string;
  status: ConversationStatus;
  turns: number;
  durationMs: number;
  messages: Message[];
}
```

You may **add** fields. Never **remove** or **rename** existing ones.

---

## Pre-Change Checklist

Before modifying any exported symbol in `metaglass-aios`:

| Check | Action |
|-------|--------|
| Is it exported in `src/index.ts`? | If yes, it's public API — follow rules above |
| Is it a provider interface method? | Host implements this — signature changes break host |
| Is it a type used in provider signatures? | Changing it cascades to all adapters |
| Is it an event name? | Host subscribes by string — renaming breaks subscriptions |
| Is it a config default? | Changing defaults alters behavior silently |
| Is it a return type field? | Host destructures these — removing breaks host |

---

## Safe Change Patterns

### Adding a New Kernel Component

```
1. Create new file in src/kernel/ (e.g., MemoryManager.ts)
2. Keep it internal — only ConversationEngine uses it
3. If it needs a provider, add optional field to ConversationEngineDeps
4. Export from src/index.ts only if host needs direct access
5. Add tests in src/kernel/__tests__/
```

### Adding a New Provider Interface

```
1. Define interface in src/interfaces/ (e.g., MemoryProvider.ts)
2. Add to ConversationEngineDeps as OPTIONAL (memory?: MemoryProvider)
3. In ConversationEngine, check existence before using:
   if (this.deps.memory) { await this.deps.memory.recall(...); }
4. Export interface and types from src/index.ts
5. Host creates adapter when ready — no immediate changes required
```

### Modifying the Turn Loop

```
1. Changes to runLoop() in ConversationEngine are internal
2. Safe as long as:
   - Same provider methods are called with same signatures
   - Same events are emitted with same payloads
   - ConversationResult shape is preserved
3. Test: run existing test suite (450+ tests) — all must pass
```

### Adding a New Event

```
1. Add to AIOSEvents interface in src/interfaces/types.ts
2. Emit from ConversationEngine at appropriate point
3. Existing subscribers are unaffected (new key, no conflicts)
4. Host opts in when ready
```

---

## Versioning Policy

| Change Type | Version Bump | Example |
|-------------|--------------|---------|
| New optional field on config | PATCH | `enableParallelTools?: boolean` |
| New optional provider interface | MINOR | `memory?: MemoryProvider` |
| New event type | MINOR | `memory:recalled` event |
| New exported function | MINOR | `partitionToolCalls()` |
| Bug fix in turn loop | PATCH | Fix timeout race condition |
| Remove deprecated alias | MAJOR | Remove `LLMProvider` alias |
| Change required method signature | MAJOR | Never do this lightly |
| Change ConversationResult shape | MAJOR | Never remove fields |

---

## Testing Strategy for Breaking Changes

### Before Merging Any PR

1. **Unit tests pass**: `npm run test:run` (450+ tests)
2. **Type check passes**: `npm run typecheck`
3. **Build succeeds**: `npm run build`
4. **Host compatibility**: In `learning-os`, run `npm run typecheck` against the new AIOS build

### Integration Verification

```bash
# In metaglass-aios
npm run build

# In learning-os
npm install ../metaglass-aios  # Install local build
npm run typecheck               # Must pass — catches signature mismatches
npm run dev                     # Smoke test the app
```

### Type Compatibility Check

The host re-defines AIOS types locally (structural typing). To verify compatibility:

```bash
# In learning-os
# If typecheck passes with new AIOS version → types are compatible
# If typecheck fails → the change broke the structural contract
npm run typecheck
```

---

## Emergency: If You Shipped a Breaking Change

1. **Revert** the breaking change in AIOS
2. **Publish** a patch version with the revert
3. **Design** a non-breaking migration path (optional field, alias, etc.)
4. **Implement** the migration path in a new MINOR version
5. **Update** host to use new API
6. **Deprecate** old API (keep for 1 major version)
7. **Remove** in next MAJOR version
