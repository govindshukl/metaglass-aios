/**
 * CheckpointManager - User Confirmation Before Expensive Operations
 *
 * Provides a "Shall I proceed?" pattern before:
 * - Irreversible operations (delete, bash)
 * - After planning (when many steps are planned)
 * - Before expensive operations (high token cost)
 *
 * This ensures user buy-in before committing to expensive or risky work.
 */

import { getToolMetadata, type ToolMetadata, type ToolCall } from './ToolMetadataRegistry';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Checkpoint trigger types
 */
export type CheckpointTrigger =
  | { type: 'before-mutation'; toolNames: string[] }
  | { type: 'after-planning'; minSteps: number }
  | { type: 'before-irreversible' }
  | { type: 'cost-threshold'; estimatedTokens: number };

/**
 * Configuration for checkpoint behavior
 */
export interface CheckpointConfig {
  /** Whether checkpoints are enabled */
  enabled: boolean;
  /** Triggers that cause a checkpoint */
  triggers: CheckpointTrigger[];
}

/**
 * Context for evaluating checkpoint triggers
 */
export interface CheckpointContext {
  /** Tool calls pending execution */
  pendingToolCalls: ToolCall[];
  /** Number of todos in current plan */
  todoCount: number;
  /** Tool metadata registry */
  toolMetadata: Record<string, ToolMetadata>;
  /** Estimated tokens for operation (optional) */
  estimatedTokens?: number;
}

/**
 * Context for generating checkpoint messages
 */
export interface CheckpointMessageContext {
  /** Original user goal */
  goal: string;
  /** Number of todos in plan */
  todoCount: number;
  /** Names of pending tools */
  pendingTools: string[];
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

/**
 * Default checkpoint configuration
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  triggers: [
    { type: 'after-planning', minSteps: 3 },
    { type: 'before-mutation', toolNames: ['vault_delete_note', 'Bash'] },
    { type: 'before-irreversible' },
  ],
};

// =============================================================================
// TRIGGER EVALUATION
// =============================================================================

/**
 * Check if a trigger should fire based on the current context
 */
export function shouldTriggerCheckpoint(
  trigger: CheckpointTrigger,
  context: CheckpointContext
): boolean {
  switch (trigger.type) {
    case 'after-planning':
      return context.todoCount >= trigger.minSteps;

    case 'before-mutation':
      return context.pendingToolCalls.some(tc =>
        trigger.toolNames.includes(tc.name)
      );

    case 'before-irreversible':
      return context.pendingToolCalls.some(tc => {
        const meta = context.toolMetadata[tc.name] || getToolMetadata(tc.name);
        return meta.sideEffects === 'irreversible';
      });

    case 'cost-threshold':
      return (context.estimatedTokens ?? 0) >= trigger.estimatedTokens;

    default:
      return false;
  }
}

// =============================================================================
// MESSAGE GENERATION
// =============================================================================

/**
 * Generate a human-friendly checkpoint message for the given trigger
 */
export function generateCheckpointMessage(
  trigger: CheckpointTrigger,
  context: CheckpointMessageContext
): string {
  switch (trigger.type) {
    case 'after-planning':
      return `I've created a plan with ${context.todoCount} steps to accomplish: "${context.goal}". Shall I proceed with execution?`;

    case 'before-mutation':
    case 'before-irreversible':
      const toolList = context.pendingTools.join(', ');
      return `I'm about to execute: ${toolList}. These actions may make changes. Shall I proceed?`;

    case 'cost-threshold':
      return `This operation may consume significant resources. Shall I proceed?`;

    default:
      return 'Shall I proceed with the next steps?';
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check all triggers and return the first one that fires, or null if none
 */
export function findTriggeredCheckpoint(
  config: CheckpointConfig,
  context: CheckpointContext
): CheckpointTrigger | null {
  if (!config.enabled) {
    return null;
  }

  for (const trigger of config.triggers) {
    if (shouldTriggerCheckpoint(trigger, context)) {
      return trigger;
    }
  }

  return null;
}

/**
 * Create a checkpoint context from common parameters
 */
export function createCheckpointContext(
  pendingToolCalls: ToolCall[],
  todoCount: number,
  toolMetadata: Record<string, ToolMetadata> = {},
  estimatedTokens?: number
): CheckpointContext {
  return {
    pendingToolCalls,
    todoCount,
    toolMetadata,
    estimatedTokens,
  };
}
