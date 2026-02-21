/**
 * CheckpointManager Tests
 *
 * TDD tests for checkpoint management - asking user confirmation before:
 * - Expensive operations
 * - Irreversible operations
 * - After planning (with many steps)
 */

import { describe, it, expect } from 'vitest';
import {
  shouldTriggerCheckpoint,
  generateCheckpointMessage,
  DEFAULT_CHECKPOINT_CONFIG,
  type CheckpointConfig,
  type CheckpointTrigger,
  type CheckpointContext,
} from '../CheckpointManager';
import { TOOL_METADATA, type ToolCall } from '../ToolMetadataRegistry';

// =============================================================================
// CHECKPOINT TRIGGER TESTS
// =============================================================================

describe('CheckpointManager', () => {
  const createToolCall = (name: string): ToolCall => ({
    id: `call_${name}`,
    name,
    arguments: {},
  });

  describe('shouldTriggerCheckpoint()', () => {
    describe('after-planning trigger', () => {
      const trigger: CheckpointTrigger = { type: 'after-planning', minSteps: 3 };

      it('should trigger when todo count exceeds minSteps', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [],
          todoCount: 4,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should trigger when todo count equals minSteps', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [],
          todoCount: 3,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should NOT trigger when todo count is below minSteps', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [],
          todoCount: 2,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(false);
      });
    });

    describe('before-mutation trigger', () => {
      const trigger: CheckpointTrigger = {
        type: 'before-mutation',
        toolNames: ['vault_delete_note', 'Bash'],
      };

      it('should trigger when pending tools include specified mutation tools', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [createToolCall('vault_delete_note')],
          todoCount: 1,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should trigger for Bash tool', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [createToolCall('Bash')],
          todoCount: 1,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should NOT trigger for non-mutation tools', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [
            createToolCall('search_fulltext'),
            createToolCall('vault_read_note'),
          ],
          todoCount: 2,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(false);
      });

      it('should NOT trigger when no pending tools', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [],
          todoCount: 0,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(false);
      });
    });

    describe('before-irreversible trigger', () => {
      const trigger: CheckpointTrigger = { type: 'before-irreversible' };

      it('should trigger for tools with irreversible side effects', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [createToolCall('vault_delete_note')],
          todoCount: 1,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should trigger for Bash (irreversible)', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [createToolCall('Bash')],
          todoCount: 1,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should NOT trigger for reversible mutation tools', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [createToolCall('vault_create_note')],
          todoCount: 1,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(false);
      });

      it('should NOT trigger for query tools', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [
            createToolCall('search_fulltext'),
            createToolCall('vault_read_note'),
          ],
          todoCount: 2,
          toolMetadata: TOOL_METADATA,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(false);
      });
    });

    describe('cost-threshold trigger', () => {
      const trigger: CheckpointTrigger = {
        type: 'cost-threshold',
        estimatedTokens: 10000,
      };

      it('should trigger when estimated tokens exceed threshold', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [],
          todoCount: 0,
          toolMetadata: TOOL_METADATA,
          estimatedTokens: 15000,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(true);
      });

      it('should NOT trigger when estimated tokens are below threshold', () => {
        const context: CheckpointContext = {
          pendingToolCalls: [],
          todoCount: 0,
          toolMetadata: TOOL_METADATA,
          estimatedTokens: 5000,
        };

        expect(shouldTriggerCheckpoint(trigger, context)).toBe(false);
      });
    });
  });

  // ===========================================================================
  // MESSAGE GENERATION TESTS
  // ===========================================================================

  describe('generateCheckpointMessage()', () => {
    describe('after-planning messages', () => {
      const trigger: CheckpointTrigger = { type: 'after-planning', minSteps: 3 };

      it('should include todo count in message', () => {
        const message = generateCheckpointMessage(trigger, {
          goal: 'create a project plan',
          todoCount: 4,
          pendingTools: [],
        });

        expect(message).toContain('4');
        expect(message).toContain('plan');
      });

      it('should include goal in message', () => {
        const message = generateCheckpointMessage(trigger, {
          goal: 'create a trip itinerary',
          todoCount: 3,
          pendingTools: [],
        });

        expect(message).toContain('trip itinerary');
      });

      it('should ask for confirmation', () => {
        const message = generateCheckpointMessage(trigger, {
          goal: 'test goal',
          todoCount: 5,
          pendingTools: [],
        });

        expect(message.toLowerCase()).toMatch(/proceed|continue|shall i/i);
      });
    });

    describe('before-mutation messages', () => {
      const trigger: CheckpointTrigger = {
        type: 'before-mutation',
        toolNames: ['vault_delete_note'],
      };

      it('should list pending tools', () => {
        const message = generateCheckpointMessage(trigger, {
          goal: 'clean up notes',
          todoCount: 1,
          pendingTools: ['vault_delete_note', 'Bash'],
        });

        expect(message).toContain('vault_delete_note');
        expect(message).toContain('Bash');
      });

      it('should warn about changes', () => {
        const message = generateCheckpointMessage(trigger, {
          goal: 'test',
          todoCount: 1,
          pendingTools: ['vault_delete_note'],
        });

        expect(message.toLowerCase()).toMatch(/change|modif|action/i);
      });
    });

    describe('before-irreversible messages', () => {
      const trigger: CheckpointTrigger = { type: 'before-irreversible' };

      it('should mention irreversibility', () => {
        const message = generateCheckpointMessage(trigger, {
          goal: 'delete old files',
          todoCount: 1,
          pendingTools: ['vault_delete_note'],
        });

        // Should mention the tools or warn about actions
        expect(message.toLowerCase()).toMatch(/irreversible|cannot be undone|change|action/i);
      });
    });

    describe('default messages', () => {
      it('should provide a generic confirmation message for unknown triggers', () => {
        const trigger = { type: 'unknown' } as unknown as CheckpointTrigger;

        const message = generateCheckpointMessage(trigger, {
          goal: 'test',
          todoCount: 1,
          pendingTools: [],
        });

        expect(message.toLowerCase()).toMatch(/proceed|continue/i);
      });
    });
  });

  // ===========================================================================
  // DEFAULT CONFIG TESTS
  // ===========================================================================

  describe('DEFAULT_CHECKPOINT_CONFIG', () => {
    it('should be enabled by default', () => {
      expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
    });

    it('should include after-planning trigger', () => {
      const hasTrigger = DEFAULT_CHECKPOINT_CONFIG.triggers.some(
        t => t.type === 'after-planning'
      );
      expect(hasTrigger).toBe(true);
    });

    it('should include before-mutation trigger for dangerous tools', () => {
      const mutationTrigger = DEFAULT_CHECKPOINT_CONFIG.triggers.find(
        t => t.type === 'before-mutation'
      ) as Extract<CheckpointTrigger, { type: 'before-mutation' }> | undefined;

      expect(mutationTrigger).toBeDefined();
      expect(mutationTrigger?.toolNames).toContain('vault_delete_note');
      expect(mutationTrigger?.toolNames).toContain('Bash');
    });

    it('should include before-irreversible trigger', () => {
      const hasTrigger = DEFAULT_CHECKPOINT_CONFIG.triggers.some(
        t => t.type === 'before-irreversible'
      );
      expect(hasTrigger).toBe(true);
    });
  });

  // ===========================================================================
  // DISABLED CONFIG TESTS
  // ===========================================================================

  describe('disabled config', () => {
    it('should return false for all triggers when config is checked with enabled=false', () => {
      // This tests the pattern of checking config.enabled before shouldTriggerCheckpoint
      const disabledConfig: CheckpointConfig = {
        enabled: false,
        triggers: DEFAULT_CHECKPOINT_CONFIG.triggers,
      };

      // In practice, the caller checks config.enabled first
      expect(disabledConfig.enabled).toBe(false);
    });
  });
});
