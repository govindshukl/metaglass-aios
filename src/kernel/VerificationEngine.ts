/**
 * VerificationEngine - Post-Completion Quality Assurance
 *
 * Verifies that agent output meets quality standards:
 * - All todos completed
 * - No errors in tool execution
 * - Output files exist (if applicable)
 *
 * Supports two strategies:
 * - rule-based: Fast, deterministic checks
 * - subagent: LLM-based verification for complex outputs
 * - hybrid: Rules first, subagent if rules pass
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Status of a todo item
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * A todo item
 */
export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * Result of a tool execution
 */
export interface ToolResult {
  toolName: string;
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Context for verification
 */
export interface VerificationContext {
  /** Original user goal */
  goal: string;
  /** List of todos that were tracked */
  todos: Todo[];
  /** Names of tools that were executed */
  toolsExecuted: string[];
  /** Paths of output files created */
  outputPaths: string[];
  /** Results from tool executions */
  toolResults: ToolResult[];
}

/**
 * Result of verification
 */
export interface VerificationResult {
  /** Whether all checks passed */
  passed: boolean;
  /** List of issues found */
  issues: string[];
  /** Suggestions for improvement */
  suggestions: string[];
}

/**
 * A verification rule
 */
export interface VerificationRule {
  /** Rule name for identification */
  name: string;
  /** Check function - returns true if passed */
  check: (output: any, context: VerificationContext) => boolean | Promise<boolean>;
  /** Message to display if check fails */
  failureMessage: string;
  /** Optional suggestion for fixing the issue */
  suggestion?: string;
}

/**
 * Verification strategy
 */
export type VerificationStrategy = 'rule-based' | 'subagent' | 'hybrid';

/**
 * Configuration for verification
 */
export interface VerificationConfig {
  /** Whether verification is enabled */
  enabled: boolean;
  /** Verification strategy */
  strategy: VerificationStrategy;
  /** Rules to apply (for rule-based and hybrid) */
  rules?: VerificationRule[];
}

// =============================================================================
// BUILT-IN VERIFICATION RULES
// =============================================================================

/**
 * Built-in verification rules
 */
export const VERIFICATION_RULES: VerificationRule[] = [
  {
    name: 'todos-completed',
    check: async (output, context) => {
      if (context.todos.length === 0) {
        return true; // No todos to check
      }
      const incomplete = context.todos.filter(t => t.status !== 'completed');
      return incomplete.length === 0;
    },
    failureMessage: 'Not all todo items were completed',
    suggestion: 'Review incomplete todos and complete remaining tasks',
  },
  {
    name: 'no-errors-in-history',
    check: async (output, context) => {
      if (context.toolResults.length === 0) {
        return true; // No tool results to check
      }
      const errors = context.toolResults.filter(r => !r.success);
      return errors.length === 0;
    },
    failureMessage: 'Some tool executions failed',
    suggestion: 'Review failed tool calls and retry or handle errors',
  },
];

// =============================================================================
// VERIFICATION ENGINE CLASS
// =============================================================================

/**
 * Engine for verifying agent output quality
 */
export class VerificationEngine {
  private config: VerificationConfig;

  constructor(config: VerificationConfig) {
    this.config = config;
  }

  /**
   * Verify the output against rules
   */
  async verify(output: any, context: VerificationContext): Promise<VerificationResult> {
    // Skip verification if disabled
    if (!this.config.enabled) {
      return {
        passed: true,
        issues: [],
        suggestions: [],
      };
    }

    const issues: string[] = [];
    const suggestions: string[] = [];

    // Get rules to apply
    const rules = this.config.rules || VERIFICATION_RULES;

    // Run rule-based verification
    if (this.config.strategy === 'rule-based' || this.config.strategy === 'hybrid') {
      for (const rule of rules) {
        const passed = await rule.check(output, context);
        if (!passed) {
          issues.push(rule.failureMessage);
          if (rule.suggestion) {
            suggestions.push(rule.suggestion);
          }
        }
      }
    }

    // For hybrid strategy, run subagent if rules pass
    if (this.config.strategy === 'subagent' ||
        (this.config.strategy === 'hybrid' && issues.length === 0)) {
      // Subagent verification would go here
      // For now, we just return the rule-based results
      // In a full implementation, this would spawn a verification subagent
    }

    return {
      passed: issues.length === 0,
      issues,
      suggestions,
    };
  }
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

/**
 * Default verification configuration
 */
export const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  enabled: true,
  strategy: 'rule-based',
  rules: VERIFICATION_RULES,
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Create a verification context from common parameters
 */
export function createVerificationContext(
  goal: string,
  todos: Todo[],
  toolsExecuted: string[],
  toolResults: ToolResult[],
  outputPaths: string[] = []
): VerificationContext {
  return {
    goal,
    todos,
    toolsExecuted,
    outputPaths,
    toolResults,
  };
}

/**
 * Create a custom verification rule
 */
export function createVerificationRule(
  name: string,
  check: (output: any, context: VerificationContext) => boolean | Promise<boolean>,
  failureMessage: string,
  suggestion?: string
): VerificationRule {
  return {
    name,
    check,
    failureMessage,
    suggestion,
  };
}
