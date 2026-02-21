/**
 * DecisionLogger - Observability for Agent Decisions
 *
 * Provides structured logging of agent decisions during conversation execution.
 * Enables debugging by recording why the agent made specific choices.
 *
 * Example decisions logged:
 * - Intent classification (TRIVIAL, SIMPLE_QUERY, MULTI_STEP, COMPLEX)
 * - Tool exemption checks (allowed without TodoWrite)
 * - Checkpoint triggers (user confirmation needed)
 * - TodoWrite guidance level
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * A single logged decision
 */
export interface DecisionLog {
  /** When this decision was made */
  timestamp: Date;
  /** Which turn in the conversation */
  turn: number;
  /** Type of decision (e.g., 'classified-intent', 'tool-exemption-check') */
  decision: string;
  /** Why this decision was made */
  reason: string;
  /** Input data used to make the decision */
  inputs: Record<string, any>;
  /** The outcome/result of the decision */
  outcome: string;
}

/**
 * Input for logging a decision (timestamp added automatically)
 */
export type DecisionLogInput = Omit<DecisionLog, 'timestamp'>;

// =============================================================================
// DECISION LOGGER CLASS
// =============================================================================

/**
 * Logs and retrieves agent decisions for observability and debugging.
 *
 * Usage:
 * ```typescript
 * const logger = new DecisionLogger();
 *
 * logger.log({
 *   turn: 1,
 *   decision: 'classified-intent',
 *   reason: 'detected query verb',
 *   inputs: { goal: 'search for notes' },
 *   outcome: 'complexity=SIMPLE_QUERY'
 * });
 *
 * console.log(logger.getDecisionsSummary());
 * ```
 */
export class DecisionLogger {
  private logs: DecisionLog[] = [];

  /**
   * Log a decision with automatic timestamp
   */
  log(entry: DecisionLogInput): void {
    const logEntry: DecisionLog = {
      ...entry,
      timestamp: new Date(),
    };

    this.logs.push(logEntry);
  }

  /**
   * Get all logged decisions (returns a copy)
   */
  getDecisions(): DecisionLog[] {
    return [...this.logs];
  }

  /**
   * Get a formatted summary of all decisions
   */
  getDecisionsSummary(): string {
    if (this.logs.length === 0) {
      return '';
    }

    return this.logs
      .map(d => `[Turn ${d.turn}] ${d.decision}: ${d.reason} → ${d.outcome}`)
      .join('\n');
  }

  /**
   * Get decisions for a specific turn
   */
  getDecisionsByTurn(turn: number): DecisionLog[] {
    return this.logs.filter(d => d.turn === turn);
  }

  /**
   * Get decisions of a specific type
   */
  getDecisionsByType(decisionType: string): DecisionLog[] {
    return this.logs.filter(d => d.decision === decisionType);
  }

  /**
   * Clear all logged decisions
   */
  clear(): void {
    this.logs = [];
  }
}

// =============================================================================
// COMMON DECISION TYPES (for consistency)
// =============================================================================

/**
 * Standard decision type names for consistency across the codebase
 */
export const DecisionTypes = {
  /** Intent complexity classification */
  CLASSIFIED_INTENT: 'classified-intent',
  /** Tool exemption from TodoWrite requirement */
  TOOL_EXEMPTION_CHECK: 'tool-exemption-check',
  /** Checkpoint triggered before expensive operation */
  TRIGGERED_CHECKPOINT: 'triggered-checkpoint',
  /** TodoWrite guidance level set */
  TODOWRITE_GUIDANCE: 'todowrite-guidance',
  /** Reflection result processed */
  REFLECTION_RESULT: 'reflection-result',
  /** Verification result processed */
  VERIFICATION_RESULT: 'verification-result',
} as const;

export type DecisionType = (typeof DecisionTypes)[keyof typeof DecisionTypes];
