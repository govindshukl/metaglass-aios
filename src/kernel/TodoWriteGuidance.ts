/**
 * TodoWriteGuidance - Gradient Guidance for TodoWrite Usage
 *
 * Provides varying levels of guidance for using TodoWrite based on:
 * - Task complexity level (from IntentClassifier)
 * - Current turn number
 * - Whether output has been produced
 *
 * Levels:
 * - 'none': No guidance needed (trivial tasks, simple queries)
 * - 'soft': Gentle reminder to consider TodoWrite
 * - 'strong': Emphatic recommendation to use TodoWrite
 *
 * Note: We no longer hard-block; this is guidance only.
 */

import { TaskComplexity } from './IntentClassifier';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Guidance levels for TodoWrite usage
 */
export type TodoWriteGuidanceLevel = 'none' | 'soft' | 'strong';

/**
 * Input parameters for determining guidance
 */
export interface TodoWriteGuidanceInput {
  /** Task complexity from IntentClassifier */
  complexity: TaskComplexity;
  /** Current turn number (1-indexed) */
  turnNumber: number;
  /** Whether any output has been produced */
  hasProducedOutput: boolean;
}

/**
 * Result of guidance determination
 */
export interface TodoWriteGuidanceResult {
  /** The guidance level */
  level: TodoWriteGuidanceLevel;
  /** Human-readable message (null if no guidance needed) */
  message: string | null;
}

// =============================================================================
// MESSAGES
// =============================================================================

const SOFT_MESSAGE =
  'Consider using TodoWrite to track progress and give the user visibility into your work.';

const STRONG_MESSAGE =
  'This task has multiple steps. Please use TodoWrite to plan and track your progress.';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Determine the appropriate TodoWrite guidance level based on context
 *
 * Rules:
 * - TRIVIAL / SIMPLE_QUERY: Never need TodoWrite
 * - MULTI_STEP: Soft guidance on turns 1-2, none after
 * - COMPLEX: Strong on turn 1, soft on turn 2-3, none after
 * - If output has been produced, no guidance (already working)
 */
export function getTodoWriteGuidance(
  input: TodoWriteGuidanceInput
): TodoWriteGuidanceResult {
  const { complexity, turnNumber, hasProducedOutput } = input;

  // If output has been produced, no guidance needed
  if (hasProducedOutput) {
    return { level: 'none', message: null };
  }

  // TRIVIAL and SIMPLE_QUERY never need TodoWrite
  if (
    complexity === TaskComplexity.TRIVIAL ||
    complexity === TaskComplexity.SIMPLE_QUERY
  ) {
    return { level: 'none', message: null };
  }

  // MULTI_STEP: Soft guidance on turns 1-2
  if (complexity === TaskComplexity.MULTI_STEP) {
    if (turnNumber <= 2) {
      return { level: 'soft', message: SOFT_MESSAGE };
    }
    return { level: 'none', message: null };
  }

  // COMPLEX: Strong on turn 1, soft on turns 2-3, none after
  if (complexity === TaskComplexity.COMPLEX) {
    if (turnNumber === 1) {
      return { level: 'strong', message: STRONG_MESSAGE };
    }
    if (turnNumber <= 3) {
      return { level: 'soft', message: SOFT_MESSAGE };
    }
    return { level: 'none', message: null };
  }

  // Default: no guidance
  return { level: 'none', message: null };
}
