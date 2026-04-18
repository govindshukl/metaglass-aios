/**
 * DebugHarness - Structured trace logging and step-mode debugging for AIOS
 *
 * Produces JSONL trace files at logs/traces/trace-{conversationId}.jsonl
 * with a sidecar index at logs/traces/trace-{conversationId}.index.json
 *
 * The sidecar index maps phase+turn to line numbers so Claude Code (or a
 * future tracing UI) can jump to any section without reading the full file.
 *
 * Step mode pauses the ConversationEngine after each turn, letting you
 * inspect state from the browser console via window.__aiosDebug.
 */

import { writeTextFile, readTextFile, mkdir, exists } from '../fs';
import type { Message, Todo, ConversationStatus } from '../interfaces';
import type { DecisionLog } from './DecisionLogger';

// =============================================================================
// TRACE TYPES
// =============================================================================

/**
 * Phase tags for trace entries.
 * Every entry belongs to exactly one phase.
 */
export type TracePhase =
  | 'init'              // execute() entry, config merge, history setup
  | 'classification'    // IntentClassifier result + TodoWrite decision
  | 'turn-start'        // Turn N begins, guidance injection, todo reminders
  | 'llm-request'       // Message history + tools sent to LLM
  | 'llm-response'      // LLM content + toolCalls received
  | 'todowrite-gate'    // Enforcement: has plan? exempt? blocked?
  | 'tool-exec'         // Per-tool: name, params, result
  | 'tool-special'      // TodoWrite, AskUserQuestion
  | 'loop-detection'    // Loop/stale-todo nudge or force-stop
  | 'error'             // Caught exception, retry decision, fallback
  | 'turn-end'          // Turn summary, checkpoint
  | 'completion'        // Natural stop, goal session save
  | 'termination'       // Timeout, cancellation, max-turns
  ;

/**
 * A single trace entry (one line in the JSONL file)
 */
export interface TraceEntry {
  /** Monotonic sequence number within this trace */
  seq: number;
  /** ISO timestamp */
  ts: string;
  /** Milliseconds since conversation started */
  elapsed: number;
  /** Current turn number (0 = pre-loop phases) */
  turn: number;
  /** Phase tag */
  phase: TracePhase;
  /** What happened (e.g., 'conversation-started', 'tool:vault_search') */
  event: string;
  /** Structured payload (varies by event) */
  data: Record<string, unknown>;
}

/**
 * Section entry in the sidecar index
 */
export interface TraceSectionEntry {
  phase: TracePhase;
  turn: number;
  seq: number;
  /** 1-indexed line number in the JSONL file */
  line: number;
}

/**
 * Sidecar index file (trace-{id}.index.json)
 */
export interface TraceIndex {
  conversationId: string;
  goal: string;
  startedAt: string;
  config: Record<string, unknown>;
  /** Section map: phase+turn → line number */
  sections: TraceSectionEntry[];
  totalEntries: number;
  status: ConversationStatus | 'running';
}

// =============================================================================
// PAYLOAD TRUNCATION
// =============================================================================

const DEFAULT_MAX_PAYLOAD_BYTES = 2048;

/**
 * Truncate a payload object if its JSON representation exceeds maxBytes.
 * Returns the original if small enough, or a truncated marker.
 */
function truncatePayload(obj: unknown, maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES): unknown {
  if (obj === undefined || obj === null) return obj;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxBytes) return obj;
    return {
      _truncated: true,
      preview: s.substring(0, maxBytes),
      originalSize: s.length,
    };
  } catch {
    return { _truncated: true, error: 'non-serializable' };
  }
}

// =============================================================================
// DEBUG HARNESS
// =============================================================================

const TRACES_DIR = '/Users/govind/metaglass/learning-os/logs/traces';
const FLUSH_INTERVAL_MS = 1000;

export class DebugHarness {
  private conversationId: string;
  private entries: TraceEntry[] = [];
  private buffer: string[] = [];
  private seq: number = 0;
  private startTime: number;
  private currentTurn: number = 0;
  private lineCount: number = 0;

  // Sidecar index
  private index: TraceIndex;
  private seenPhaseTurns: Set<string> = new Set();

  // Step mode
  private _stepMode: boolean = false;
  private stepResolve: (() => void) | null = null;
  private _disposed: boolean = false;

  // File paths
  private tracePath: string;
  private indexPath: string;

  // Flush timer
  private flushTimer: number | null = null;

  // References for inspection (set externally)
  private _getHistory: (() => Message[]) | null = null;
  private _getTodos: (() => Todo[]) | null = null;
  private _getDecisions: (() => DecisionLog[]) | null = null;

  constructor(conversationId: string, goal: string = '', config: Record<string, unknown> = {}) {
    this.conversationId = conversationId;
    this.startTime = Date.now();

    this.tracePath = `${TRACES_DIR}/trace-${conversationId}.jsonl`;
    this.indexPath = `${TRACES_DIR}/trace-${conversationId}.index.json`;

    this.index = {
      conversationId,
      goal,
      startedAt: new Date().toISOString(),
      config,
      sections: [],
      totalEntries: 0,
      status: 'running',
    };

    // Start periodic flush (use global setInterval for Node.js compatibility)
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS) as unknown as number;

    // Ensure traces directory exists
    this.ensureDir();
  }

  // ===========================================================================
  // TRACE API (called from ConversationEngine)
  // ===========================================================================

  /**
   * Record a trace entry. This is the primary API.
   *
   * @param phase - Which phase of the conversation loop
   * @param event - Specific event name (e.g., 'tool:vault_search', 'intent-classified')
   * @param data  - Structured payload (auto-truncated if large)
   */
  trace(phase: TracePhase, event: string, data: Record<string, unknown> = {}): void {
    if (this._disposed) return;

    const entry: TraceEntry = {
      seq: this.seq++,
      ts: new Date().toISOString(),
      elapsed: Date.now() - this.startTime,
      turn: this.currentTurn,
      phase,
      event,
      data: this.sanitizeData(data),
    };

    this.entries.push(entry);
    this.lineCount++;

    // Track section boundaries for the index
    const key = `${phase}:${this.currentTurn}`;
    if (!this.seenPhaseTurns.has(key)) {
      this.seenPhaseTurns.add(key);
      this.index.sections.push({
        phase,
        turn: this.currentTurn,
        seq: entry.seq,
        line: this.lineCount,
      });
    }

    // Buffer for file write
    try {
      this.buffer.push(JSON.stringify(entry));
    } catch {
      this.buffer.push(JSON.stringify({ ...entry, data: { _error: 'serialize-failed' } }));
    }
  }

  /**
   * Set the current turn (called by ConversationEngine at turn start)
   */
  setTurn(turn: number): void {
    this.currentTurn = turn;
  }

  /**
   * Update the conversation ID after the engine generates the real one.
   * Updates the index metadata and file paths (no rename needed since
   * nothing has been flushed under the old placeholder ID yet).
   */
  setConversationId(id: string): void {
    this.conversationId = id;
    this.index.conversationId = id;
    this.tracePath = `${TRACES_DIR}/trace-${id}.jsonl`;
    this.indexPath = `${TRACES_DIR}/trace-${id}.index.json`;
  }

  /**
   * Update the goal text (may not be known at construction time)
   */
  setGoal(goal: string): void {
    this.index.goal = goal;
  }

  /**
   * Mark the final status of this trace
   */
  setStatus(status: ConversationStatus): void {
    this.index.status = status;
  }

  // ===========================================================================
  // STEP MODE
  // ===========================================================================

  /**
   * Turn gate — called at the end of each turn in runLoop.
   * If step mode is active, blocks until step() is called.
   */
  async turnGate(turn: number): Promise<void> {
    if (!this._stepMode || this._disposed) return;

    this.trace('turn-end', 'step-waiting', {
      turn,
      message: 'Paused — call __aiosDebug.step() to continue.',
    });

    // Force flush so the trace file is up-to-date while paused
    await this.flush();

    const pauseStart = Date.now();

    await new Promise<void>(resolve => {
      this.stepResolve = resolve;
    });

    // Log how long the user took to step (distinguishes wait time from processing)
    this.trace('turn-start', 'step-resumed', {
      turn,
      pauseDurationMs: Date.now() - pauseStart,
    });
  }

  /** Advance one turn. Called from console: __aiosDebug.step() */
  step(): void {
    if (this.stepResolve) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      resolve();
    }
  }

  /** Enable/disable step mode */
  setStepMode(enabled: boolean): void {
    this._stepMode = enabled;
    if (!enabled && this.stepResolve) {
      // Unblock if currently waiting
      this.step();
    }
  }

  /** Whether step mode is active */
  get stepMode(): boolean {
    return this._stepMode;
  }

  // ===========================================================================
  // INSPECTION API (for console and future UI)
  // ===========================================================================

  /** Get all entries for a specific turn */
  inspectTurn(turn: number): TraceEntry[] {
    return this.entries.filter(e => e.turn === turn);
  }

  /** Get all entries for a specific phase */
  inspectPhase(phase: TracePhase): TraceEntry[] {
    return this.entries.filter(e => e.phase === phase);
  }

  /** Get entries filtered by turn AND phase */
  inspect(turn: number, phase: TracePhase): TraceEntry[] {
    return this.entries.filter(e => e.turn === turn && e.phase === phase);
  }

  /** Get all entries */
  allEntries(): TraceEntry[] {
    return [...this.entries];
  }

  /** Compact text summary of the trace so far */
  summary(): string {
    const lines: string[] = [];
    lines.push(`Trace: ${this.conversationId}`);
    lines.push(`Goal: ${this.index.goal}`);
    lines.push(`Status: ${this.index.status}`);
    lines.push(`Turns: ${this.currentTurn}, Entries: ${this.entries.length}`);
    lines.push(`Elapsed: ${Date.now() - this.startTime}ms`);
    lines.push('');

    // Group by turn
    const byTurn = new Map<number, TraceEntry[]>();
    for (const e of this.entries) {
      if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
      byTurn.get(e.turn)!.push(e);
    }

    for (const [turn, entries] of byTurn) {
      const phases = [...new Set(entries.map(e => e.phase))];
      const tools = entries
        .filter(e => e.phase === 'tool-exec')
        .map(e => `${e.data.toolName}(${e.data.success ? 'ok' : 'err'})`);
      const errors = entries.filter(e => e.phase === 'error');

      lines.push(`Turn ${turn}: [${phases.join(' → ')}]`);
      if (tools.length > 0) lines.push(`  tools: ${tools.join(', ')}`);
      if (errors.length > 0) lines.push(`  errors: ${errors.length}`);
    }

    return lines.join('\n');
  }

  /**
   * Diagnose a query about the trace.
   * Returns a compact text summary filtered to the relevant entries.
   *
   * Examples:
   *   diagnose('turn 3')          → all entries for turn 3
   *   diagnose('errors')          → all error-phase entries
   *   diagnose('tool vault_search') → tool-exec entries matching vault_search
   *   diagnose('why blocked')     → todowrite-gate entries where blocked=true
   */
  diagnose(query: string): string {
    const q = query.toLowerCase().trim();
    let filtered: TraceEntry[] = [];
    let label = query;

    // Turn-specific
    const turnMatch = q.match(/turn\s*(\d+)/);
    if (turnMatch) {
      const turn = parseInt(turnMatch[1], 10);
      filtered = this.inspectTurn(turn);
      label = `Turn ${turn}`;
    }
    // Error queries
    else if (q.includes('error') || q.includes('fail') || q.includes('why')) {
      filtered = this.entries.filter(e =>
        e.phase === 'error' ||
        e.phase === 'termination' ||
        (e.data.success === false) ||
        (e.data.blocked === true)
      );
      label = 'Errors & failures';
    }
    // Tool queries
    else if (q.includes('tool')) {
      const toolName = q.replace(/tool\s*/i, '').trim();
      filtered = this.entries.filter(e =>
        e.phase === 'tool-exec' || e.phase === 'tool-special'
      );
      if (toolName) {
        filtered = filtered.filter(e =>
          e.event.includes(toolName) ||
          String(e.data.toolName).includes(toolName)
        );
        label = `Tool: ${toolName}`;
      } else {
        label = 'All tools';
      }
    }
    // TodoWrite / plan queries
    else if (q.includes('plan') || q.includes('todo') || q.includes('block')) {
      filtered = this.entries.filter(e =>
        e.phase === 'todowrite-gate' || e.phase === 'tool-special'
      );
      label = 'TodoWrite & planning';
    }
    // LLM queries
    else if (q.includes('llm') || q.includes('response') || q.includes('request')) {
      filtered = this.entries.filter(e =>
        e.phase === 'llm-request' || e.phase === 'llm-response'
      );
      label = 'LLM interactions';
    }
    // Phase query
    else {
      const phase = q as TracePhase;
      filtered = this.entries.filter(e => e.phase === phase);
      if (filtered.length === 0) {
        // Fallback: full-text search on event name
        filtered = this.entries.filter(e =>
          e.event.toLowerCase().includes(q) ||
          JSON.stringify(e.data).toLowerCase().includes(q)
        );
        label = `Search: "${query}"`;
      } else {
        label = `Phase: ${phase}`;
      }
    }

    if (filtered.length === 0) {
      return `No entries found for: ${query}`;
    }

    const lines: string[] = [`--- ${label} (${filtered.length} entries) ---`];
    for (const e of filtered) {
      const dataStr = JSON.stringify(e.data, null, 0);
      const dataTrunc = dataStr.length > 300 ? dataStr.substring(0, 300) + '...' : dataStr;
      lines.push(`[${e.seq}] +${e.elapsed}ms T${e.turn} ${e.phase}/${e.event} ${dataTrunc}`);
    }

    return lines.join('\n');
  }

  // ===========================================================================
  // REFERENCE SETTERS (for inspection of live engine state)
  // ===========================================================================

  setHistoryRef(fn: () => Message[]): void { this._getHistory = fn; }
  setTodosRef(fn: () => Todo[]): void { this._getTodos = fn; }
  setDecisionsRef(fn: () => DecisionLog[]): void { this._getDecisions = fn; }

  // ===========================================================================
  // CONSOLE API (exposed on window.__aiosDebug)
  // ===========================================================================

  getConsoleAPI(): DebugConsoleAPI {
    // Capture reference for getter closure
    const harness = this;
    return {
      // Step control
      step: () => this.step(),
      setStepMode: (on: boolean) => this.setStepMode(on),
      get stepMode() { return harness.stepMode; },

      // Inspection
      inspectTurn: (n: number) => this.inspectTurn(n),
      inspectPhase: (p: TracePhase) => this.inspectPhase(p),
      inspect: (turn: number, phase: TracePhase) => this.inspect(turn, phase),
      allEntries: () => this.allEntries(),
      summary: () => this.summary(),
      diagnose: (query: string) => this.diagnose(query),

      // Live state
      getHistory: () => this._getHistory?.() ?? [],
      getTodos: () => this._getTodos?.() ?? [],
      getDecisions: () => this._getDecisions?.() ?? [],

      // File access
      getTracePath: () => this.tracePath,
      getIndexPath: () => this.indexPath,
      flush: () => this.flush(),
    };
  }

  // ===========================================================================
  // FILE I/O
  // ===========================================================================

  /**
   * Flush buffered entries to the JSONL trace file and update the sidecar index.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 && this.entries.length === 0) return;

    // Flush JSONL entries
    if (this.buffer.length > 0) {
      const lines = this.buffer.splice(0, this.buffer.length);
      const chunk = lines.join('\n') + '\n';

      try {
        let existing = '';
        try {
          existing = await readTextFile(this.tracePath);
        } catch {
          // File doesn't exist yet
        }
        await writeTextFile(this.tracePath, existing + chunk);
      } catch (err) {
        console.error('[DebugHarness] Failed to write trace file:', err);
        // Put lines back
        this.buffer.unshift(...lines);
      }
    }

    // Update sidecar index
    this.index.totalEntries = this.entries.length;
    try {
      await writeTextFile(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch (err) {
      console.error('[DebugHarness] Failed to write index file:', err);
    }
  }

  /**
   * Finalize — flush remaining, update status, stop timer.
   * Called when conversation ends (success, error, cancel, timeout).
   */
  async finalize(status: ConversationStatus): Promise<void> {
    this.index.status = status;
    await this.flush();
    this.dispose();
  }

  /**
   * Dispose — release resources, unblock any pending step gate.
   * Safe to call multiple times.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._stepMode = false;

    // Unblock if paused in step mode
    if (this.stepResolve) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      resolve();
    }

    // Stop flush timer
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  /**
   * Sanitize data payload — truncate large fields, handle non-serializable values.
   */
  private sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;

      // Known large fields get individual truncation
      if (key === 'params' || key === 'toolParams') {
        result[key] = truncatePayload(value, 1024);
      } else if (key === 'messages' || key === 'history') {
        // Message arrays: keep structure, truncate content
        if (Array.isArray(value)) {
          result[key] = (value as Array<Record<string, unknown>>).map(msg => ({
            ...msg,
            content: typeof msg.content === 'string' && msg.content.length > 200
              ? msg.content.substring(0, 200) + `... (${msg.content.length} chars)`
              : msg.content,
          }));
        } else {
          result[key] = truncatePayload(value);
        }
      } else if (typeof value === 'string' && value.length > 2048) {
        result[key] = value.substring(0, 2048) + `... (${value.length} chars)`;
      } else {
        result[key] = truncatePayload(value);
      }
    }
    return result;
  }

  private async ensureDir(): Promise<void> {
    try {
      const dirExists = await exists(TRACES_DIR);
      if (!dirExists) {
        await mkdir(TRACES_DIR, { recursive: true });
      }
    } catch (err) {
      console.error('[DebugHarness] Failed to create traces directory:', err);
    }
  }
}

// =============================================================================
// CONSOLE API TYPE (for window.__aiosDebug)
// =============================================================================

export interface DebugConsoleAPI {
  // Step control
  step: () => void;
  setStepMode: (on: boolean) => void;
  readonly stepMode: boolean;

  // Inspection
  inspectTurn: (n: number) => TraceEntry[];
  inspectPhase: (p: TracePhase) => TraceEntry[];
  inspect: (turn: number, phase: TracePhase) => TraceEntry[];
  allEntries: () => TraceEntry[];
  summary: () => string;
  diagnose: (query: string) => string;

  // Live state
  getHistory: () => Message[];
  getTodos: () => Todo[];
  getDecisions: () => DecisionLog[];

  // File access
  getTracePath: () => string;
  getIndexPath: () => string;
  flush: () => Promise<void>;
}

// =============================================================================
// STUB API (available before a goal is triggered)
// =============================================================================

/**
 * Pending configuration captured by the stub before a real harness exists.
 * The real harness reads this on creation.
 */
export interface PendingDebugConfig {
  stepMode: boolean;
}

/**
 * Install a stub API on window.__aiosDebug immediately.
 * This lets you pre-configure step mode BEFORE triggering a goal:
 *
 *   window.__aiosDebugEnabled = true
 *   window.__aiosDebug.setStepMode(true)
 *   // now trigger a goal — it will pause after turn 1
 *
 * The real harness replaces this stub when execute() runs,
 * inheriting the pending config.
 */
export function installDebugStub(): void {
  if (typeof window === 'undefined') return;

  // Don't overwrite if anything is already installed (stub or real harness)
  if (window.__aiosDebug) return;

  const pending: PendingDebugConfig = { stepMode: false };
  const notReady = () => 'Debug harness not active yet. Trigger a goal first.';

  const stub: DebugConsoleAPI & { _isStub: true; _pending: PendingDebugConfig } = {
    _isStub: true as const,
    _pending: pending,

    // Step control — captured for the real harness
    step: () => { console.log('[DebugHarness] Not active yet. Trigger a goal first.'); },
    setStepMode: (on: boolean) => {
      pending.stepMode = on;
      console.log(`[DebugHarness] Step mode ${on ? 'enabled' : 'disabled'} (will apply when goal starts)`);
    },
    get stepMode() { return pending.stepMode; },

    // Inspection — not available until harness is live
    inspectTurn: () => { console.log(notReady()); return []; },
    inspectPhase: () => { console.log(notReady()); return []; },
    inspect: () => { console.log(notReady()); return []; },
    allEntries: () => { console.log(notReady()); return []; },
    summary: () => notReady(),
    diagnose: () => notReady(),

    // Live state
    getHistory: () => [],
    getTodos: () => [],
    getDecisions: () => [],

    // File access
    getTracePath: () => '',
    getIndexPath: () => '',
    flush: async () => {},
  };

  window.__aiosDebug = stub as unknown as DebugConsoleAPI;
}

/**
 * Read any pending config from the stub (if one was installed),
 * and apply it to the real harness.
 */
export function absorbPendingConfig(harness: DebugHarness): void {
  if (typeof window === 'undefined') return;
  const current = window.__aiosDebug as unknown as { _isStub?: boolean; _pending?: PendingDebugConfig };
  if (current?._isStub && current._pending) {
    if (current._pending.stepMode) {
      harness.setStepMode(true);
    }
  }
}

// =============================================================================
// REACTIVE DEBUG FLAG
// =============================================================================

/**
 * Make `window.__aiosDebugEnabled` a reactive setter.
 * When the user types `window.__aiosDebugEnabled = true` in the console,
 * the stub is installed automatically — no need to wait for AIOSService
 * constructor or execute().
 *
 * Called once at module load time.
 */
function initDebugFlag(): void {
  if (typeof window === 'undefined') return;

  // If already defined as a property (e.g., this module loaded twice), skip
  const descriptor = Object.getOwnPropertyDescriptor(window, '__aiosDebugEnabled');
  if (descriptor && (descriptor.get || descriptor.set)) return;

  // Capture any existing value (user may have set it before this module loaded)
  let _enabled = !!window.__aiosDebugEnabled;

  Object.defineProperty(window, '__aiosDebugEnabled', {
    get() { return _enabled; },
    set(val: boolean) {
      _enabled = !!val;
      if (_enabled) {
        installDebugStub();
      }
    },
    configurable: true,
    enumerable: true,
  });

  // If it was already true before we hijacked it, install the stub now
  if (_enabled) {
    installDebugStub();
  }
}

// Auto-initialize when this module is imported
initDebugFlag();

// =============================================================================
// GLOBAL TYPE AUGMENTATION
// =============================================================================

declare global {
  interface Window {
    __aiosDebug?: DebugConsoleAPI;
    __aiosDebugEnabled?: boolean;
  }
}
