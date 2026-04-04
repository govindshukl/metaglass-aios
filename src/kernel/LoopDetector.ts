/**
 * LoopDetector — Configurable Loop & Stale State Detection
 *
 * Extracted from ConversationEngine for testability and configurability.
 * Detects three types of looping behavior:
 *
 * 1. Exact repetition: Same tool calls with same params N turns in a row
 * 2. Stale todos: Active task list unchanged for too many turns
 * 3. Tool diversity: Low diversity of tool+param combinations signals looping
 *
 * Key fixes from Phase 2 observations:
 * - hasPlan flag now auto-set when 3+ todos created (was only set via enforcement gate)
 * - Stale todo nudge threshold raised from 3 → 6 (configurable)
 * - Tool-call diversity suppresses nudge when agent is doing varied work
 * - completedTodos count tracks forward progress
 *
 * Phase 3, Step 3 of Agentic Harness Implementation.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface LoopDetectorConfig {
  /** Turns of exact tool signature repetition before force-stop (default: 4) */
  exactRepeatThreshold: number;
  /** Turns of stale todos before nudge message (default: 6) */
  staleTodoNudgeThreshold: number;
  /** Turns of stale todos before force-stop (default: 10) */
  staleTodoForceStopThreshold: number;
  /** Tool-call diversity ratio above which stale nudge is suppressed (default: 0.5) */
  diversityThreshold: number;
  /** Window size for exact repetition detection (default: 4) */
  windowSize: number;
}

export const DEFAULT_LOOP_DETECTOR_CONFIG: LoopDetectorConfig = {
  exactRepeatThreshold: 4,
  staleTodoNudgeThreshold: 6,
  staleTodoForceStopThreshold: 10,
  diversityThreshold: 0.5,
  windowSize: 4,
};

/** Snapshot of todo state for stale detection */
export interface TodoSnapshot {
  /** Serialized active todo descriptions */
  activeTodos: string[];
  /** Number of completed todos (tracks forward progress) */
  completedCount: number;
}

/** Tool call signature for tracking */
export interface ToolCallInput {
  name: string;
  params: Record<string, unknown>;
}

/** Result of loop evaluation */
export type LoopDetectorResult =
  | { action: 'continue' }
  | { action: 'nudge'; message: string; staleTurns: number }
  | { action: 'force_stop'; reason: string };

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class LoopDetector {
  private config: LoopDetectorConfig;

  /** Recent turn signatures for exact repetition detection */
  private recentSignatures: string[] = [];

  /** All unique (tool, firstParam) pairs seen in detection window */
  private uniqueCallSignatures: Set<string> = new Set();

  /** Total tool calls in detection window */
  private totalCallsInWindow = 0;

  /** Serialized active todos from last turn */
  private lastActiveTodosKey = '';

  /** Consecutive turns with unchanged active todos */
  private staleTodoTurns = 0;

  /** Last seen completed count for progress detection */
  private lastCompletedCount = 0;

  /** Whether agent has a plan (auto-set when 3+ todos created) */
  private hasPlan = false;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_LOOP_DETECTOR_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a turn's tool calls and todo state.
   * Call after each tool execution cycle.
   */
  recordTurn(toolCalls: ToolCallInput[], todos: TodoSnapshot): void {
    // --- Build turn signature ---
    const turnSignature = toolCalls
      .map(tc => `${tc.name}:${JSON.stringify(tc.params)}`)
      .sort()
      .join('|');

    this.recentSignatures.push(turnSignature);
    if (this.recentSignatures.length > this.config.windowSize) {
      this.recentSignatures.shift();
    }

    // --- Track diversity ---
    for (const tc of toolCalls) {
      const firstParamValue = Object.values(tc.params)[0];
      const key = `${tc.name}:${String(firstParamValue ?? '')}`;
      this.uniqueCallSignatures.add(key);
    }
    this.totalCallsInWindow += toolCalls.length;

    // --- Track stale todos ---
    const activeTodosKey = todos.activeTodos.sort().join('|');

    if (activeTodosKey === this.lastActiveTodosKey) {
      // Check if completedCount increased (forward progress)
      if (todos.completedCount > this.lastCompletedCount) {
        this.staleTodoTurns = 0;
      } else {
        this.staleTodoTurns++;
      }
    } else {
      this.staleTodoTurns = 0;
      this.lastActiveTodosKey = activeTodosKey;
    }

    this.lastCompletedCount = todos.completedCount;

    // --- Auto-detect hasPlan ---
    if (!this.hasPlan && todos.activeTodos.length >= 3) {
      this.hasPlan = true;
    }
  }

  /**
   * Evaluate current state — returns action recommendation.
   */
  evaluate(): LoopDetectorResult {
    // Check 1: Exact repetition — same full signature repeated
    if (this.recentSignatures.length >= this.config.exactRepeatThreshold) {
      const window = this.recentSignatures.slice(-this.config.exactRepeatThreshold);
      const allSame = window.every(s => s === window[0]) && window[0] !== '';
      if (allSame) {
        return {
          action: 'force_stop',
          reason: `Exact tool repetition detected: same calls repeated ${this.config.exactRepeatThreshold} turns`,
        };
      }
    }

    // Check 2: Stale todo force-stop (highest stale threshold)
    if (this.staleTodoTurns >= this.config.staleTodoForceStopThreshold) {
      return {
        action: 'force_stop',
        reason: `Active tasks unchanged for ${this.staleTodoTurns} turns (force-stop threshold: ${this.config.staleTodoForceStopThreshold})`,
      };
    }

    // Check 3: Stale todo nudge (lower threshold)
    if (this.staleTodoTurns >= this.config.staleTodoNudgeThreshold) {
      // Suppress nudge if diversity is high (agent doing varied work)
      if (this.isDiverse()) {
        return { action: 'continue' };
      }

      // Suppress nudge if hasPlan and completedCount is increasing
      if (this.hasPlan && this.lastCompletedCount > 0) {
        return { action: 'continue' };
      }

      return {
        action: 'nudge',
        message: this.buildNudgeMessage(),
        staleTurns: this.staleTodoTurns,
      };
    }

    return { action: 'continue' };
  }

  /**
   * Explicitly set hasPlan flag.
   * Also auto-set when recordTurn sees 3+ active todos.
   */
  setHasPlan(value: boolean): void {
    this.hasPlan = value;
  }

  /**
   * Reset all state (e.g., when user sends new input).
   */
  reset(): void {
    this.recentSignatures = [];
    this.uniqueCallSignatures.clear();
    this.totalCallsInWindow = 0;
    this.lastActiveTodosKey = '';
    this.staleTodoTurns = 0;
    this.lastCompletedCount = 0;
    this.hasPlan = false;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Calculate tool-call diversity ratio.
   * High diversity (> threshold) means agent is doing varied work, not looping.
   */
  private isDiverse(): boolean {
    if (this.totalCallsInWindow === 0) return false;
    const diversity = this.uniqueCallSignatures.size / this.totalCallsInWindow;
    return diversity > this.config.diversityThreshold;
  }

  private buildNudgeMessage(): string {
    return (
      `[System Reminder] You appear to be repeating actions without making progress. ` +
      `Your active tasks have not changed in ${this.staleTodoTurns} turns. Either:\n` +
      `1. Mark your current tasks as completed with TodoWrite and present results to the user\n` +
      `2. Change your approach — try different tools or queries\n` +
      `3. If you have enough information, stop calling tools and respond with your findings`
    );
  }
}
