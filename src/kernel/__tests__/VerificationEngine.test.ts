/**
 * VerificationEngine Tests
 *
 * TDD tests for post-completion verification that checks:
 * - Todos completed
 * - No errors in tool execution
 * - Output quality (via rules or subagent)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  VerificationEngine,
  VERIFICATION_RULES,
  type VerificationConfig,
  type VerificationContext,
  type VerificationResult,
  type VerificationRule,
  type Todo,
} from '../VerificationEngine';

// =============================================================================
// VERIFICATION RULES TESTS
// =============================================================================

describe('VerificationEngine', () => {
  describe('VERIFICATION_RULES', () => {
    describe('todos-completed rule', () => {
      const rule = VERIFICATION_RULES.find(r => r.name === 'todos-completed')!;

      it('should fail when todos are incomplete', async () => {
        const context: VerificationContext = {
          goal: 'create a note',
          todos: [
            { id: '1', content: 'Step 1', status: 'completed' },
            { id: '2', content: 'Step 2', status: 'in_progress' },
            { id: '3', content: 'Step 3', status: 'pending' },
          ],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [],
        };

        const passed = await rule.check(null, context);
        expect(passed).toBe(false);
      });

      it('should pass when all todos are completed', async () => {
        const context: VerificationContext = {
          goal: 'create a note',
          todos: [
            { id: '1', content: 'Step 1', status: 'completed' },
            { id: '2', content: 'Step 2', status: 'completed' },
            { id: '3', content: 'Step 3', status: 'completed' },
          ],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [],
        };

        const passed = await rule.check(null, context);
        expect(passed).toBe(true);
      });

      it('should pass when there are no todos', async () => {
        const context: VerificationContext = {
          goal: 'simple query',
          todos: [],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [],
        };

        const passed = await rule.check(null, context);
        expect(passed).toBe(true);
      });
    });

    describe('no-errors-in-history rule', () => {
      const rule = VERIFICATION_RULES.find(r => r.name === 'no-errors-in-history')!;

      it('should fail when tool results contain errors', async () => {
        const context: VerificationContext = {
          goal: 'test',
          todos: [],
          toolsExecuted: ['search_fulltext', 'vault_create_note'],
          outputPaths: [],
          toolResults: [
            { toolName: 'search_fulltext', success: true, output: 'found 5 notes' },
            { toolName: 'vault_create_note', success: false, error: 'Permission denied' },
          ],
        };

        const passed = await rule.check(null, context);
        expect(passed).toBe(false);
      });

      it('should pass when all tool results are successful', async () => {
        const context: VerificationContext = {
          goal: 'test',
          todos: [],
          toolsExecuted: ['search_fulltext', 'vault_read_note'],
          outputPaths: [],
          toolResults: [
            { toolName: 'search_fulltext', success: true, output: 'found 5 notes' },
            { toolName: 'vault_read_note', success: true, output: 'note content' },
          ],
        };

        const passed = await rule.check(null, context);
        expect(passed).toBe(true);
      });

      it('should pass when there are no tool results', async () => {
        const context: VerificationContext = {
          goal: 'test',
          todos: [],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [],
        };

        const passed = await rule.check(null, context);
        expect(passed).toBe(true);
      });
    });
  });

  // ===========================================================================
  // VERIFICATION ENGINE TESTS
  // ===========================================================================

  describe('VerificationEngine class', () => {
    describe('verify()', () => {
      it('should return passed=true when all rules pass', async () => {
        const config: VerificationConfig = {
          enabled: true,
          strategy: 'rule-based',
          rules: VERIFICATION_RULES,
        };

        const engine = new VerificationEngine(config);

        const context: VerificationContext = {
          goal: 'create a note',
          todos: [
            { id: '1', content: 'Step 1', status: 'completed' },
          ],
          toolsExecuted: ['vault_create_note'],
          outputPaths: ['/notes/new-note.md'],
          toolResults: [
            { toolName: 'vault_create_note', success: true, output: 'created' },
          ],
        };

        const result = await engine.verify(null, context);

        expect(result.passed).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should return passed=false with issues when rules fail', async () => {
        const config: VerificationConfig = {
          enabled: true,
          strategy: 'rule-based',
          rules: VERIFICATION_RULES,
        };

        const engine = new VerificationEngine(config);

        const context: VerificationContext = {
          goal: 'create a note',
          todos: [
            { id: '1', content: 'Step 1', status: 'pending' }, // Not completed
          ],
          toolsExecuted: ['vault_create_note'],
          outputPaths: [],
          toolResults: [
            { toolName: 'vault_create_note', success: false, error: 'Failed' }, // Error
          ],
        };

        const result = await engine.verify(null, context);

        expect(result.passed).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
      });

      it('should aggregate issues from multiple failing rules', async () => {
        const config: VerificationConfig = {
          enabled: true,
          strategy: 'rule-based',
          rules: VERIFICATION_RULES,
        };

        const engine = new VerificationEngine(config);

        const context: VerificationContext = {
          goal: 'test',
          todos: [
            { id: '1', content: 'Step 1', status: 'in_progress' },
          ],
          toolsExecuted: ['Bash'],
          outputPaths: [],
          toolResults: [
            { toolName: 'Bash', success: false, error: 'Command failed' },
          ],
        };

        const result = await engine.verify(null, context);

        // Should have issues from both todos-completed and no-errors-in-history
        expect(result.issues.length).toBeGreaterThanOrEqual(2);
      });

      it('should skip verification when disabled', async () => {
        const config: VerificationConfig = {
          enabled: false,
          strategy: 'rule-based',
          rules: VERIFICATION_RULES,
        };

        const engine = new VerificationEngine(config);

        const context: VerificationContext = {
          goal: 'test',
          todos: [{ id: '1', content: 'incomplete', status: 'pending' }],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [{ toolName: 'test', success: false, error: 'error' }],
        };

        const result = await engine.verify(null, context);

        // Should pass because verification is disabled
        expect(result.passed).toBe(true);
        expect(result.issues).toHaveLength(0);
      });
    });

    describe('custom rules', () => {
      it('should support custom verification rules', async () => {
        const customRule: VerificationRule = {
          name: 'custom-check',
          check: async (output, context) => context.outputPaths.length > 0,
          failureMessage: 'No output files were created',
        };

        const config: VerificationConfig = {
          enabled: true,
          strategy: 'rule-based',
          rules: [customRule],
        };

        const engine = new VerificationEngine(config);

        // Context without output paths - should fail
        const contextWithoutOutput: VerificationContext = {
          goal: 'test',
          todos: [],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [],
        };

        const result1 = await engine.verify(null, contextWithoutOutput);
        expect(result1.passed).toBe(false);
        expect(result1.issues).toContain('No output files were created');

        // Context with output paths - should pass
        const contextWithOutput: VerificationContext = {
          goal: 'test',
          todos: [],
          toolsExecuted: [],
          outputPaths: ['/path/to/file.md'],
          toolResults: [],
        };

        const result2 = await engine.verify(null, contextWithOutput);
        expect(result2.passed).toBe(true);
      });
    });

    describe('suggestions', () => {
      it('should provide suggestions for failed rules', async () => {
        const ruleWithSuggestion: VerificationRule = {
          name: 'check-with-suggestion',
          check: async () => false,
          failureMessage: 'Something failed',
          suggestion: 'Try doing X instead',
        };

        const config: VerificationConfig = {
          enabled: true,
          strategy: 'rule-based',
          rules: [ruleWithSuggestion],
        };

        const engine = new VerificationEngine(config);

        const context: VerificationContext = {
          goal: 'test',
          todos: [],
          toolsExecuted: [],
          outputPaths: [],
          toolResults: [],
        };

        const result = await engine.verify(null, context);

        expect(result.suggestions).toContain('Try doing X instead');
      });
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty rules array', async () => {
      const config: VerificationConfig = {
        enabled: true,
        strategy: 'rule-based',
        rules: [],
      };

      const engine = new VerificationEngine(config);

      const context: VerificationContext = {
        goal: 'test',
        todos: [],
        toolsExecuted: [],
        outputPaths: [],
        toolResults: [],
      };

      const result = await engine.verify(null, context);

      expect(result.passed).toBe(true);
    });

    it('should handle async rule checks', async () => {
      const asyncRule: VerificationRule = {
        name: 'async-rule',
        check: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return true;
        },
        failureMessage: 'Async check failed',
      };

      const config: VerificationConfig = {
        enabled: true,
        strategy: 'rule-based',
        rules: [asyncRule],
      };

      const engine = new VerificationEngine(config);

      const context: VerificationContext = {
        goal: 'test',
        todos: [],
        toolsExecuted: [],
        outputPaths: [],
        toolResults: [],
      };

      const result = await engine.verify(null, context);

      expect(result.passed).toBe(true);
    });
  });
});
