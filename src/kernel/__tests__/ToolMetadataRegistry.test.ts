/**
 * ToolMetadataRegistry Tests
 *
 * TDD tests for tool metadata that tracks side effects, cost, and parallel execution.
 * This enables smart tool execution with parallel optimization.
 */

import { describe, it, expect } from 'vitest';
import {
  getToolMetadata,
  toolRequiresTodoWrite,
  toolRequiresConfirmation,
  toolAllowsParallel,
  partitionToolCalls,
  TOOL_METADATA,
  type ToolMetadata,
  type ToolCall,
} from '../ToolMetadataRegistry';

// =============================================================================
// METADATA RETRIEVAL TESTS
// =============================================================================

describe('ToolMetadataRegistry', () => {
  describe('getToolMetadata()', () => {
    it('should return metadata for known clarification tools', () => {
      const meta = getToolMetadata('agent_ask_user');
      expect(meta.category).toBe('clarification');
      expect(meta.sideEffects).toBe('none');
      expect(meta.requiresTodoWrite).toBe(false);
      expect(meta.allowsParallelExecution).toBe(false); // User interaction is sequential
    });

    it('should return metadata for known query tools', () => {
      const meta = getToolMetadata('search_fulltext');
      expect(meta.category).toBe('query');
      expect(meta.sideEffects).toBe('none');
      expect(meta.requiresTodoWrite).toBe(false);
      expect(meta.allowsParallelExecution).toBe(true); // Queries can run in parallel
    });

    it('should return metadata for known mutation tools', () => {
      const meta = getToolMetadata('vault_create_note');
      expect(meta.category).toBe('mutation');
      expect(meta.sideEffects).toBe('reversible');
      expect(meta.requiresTodoWrite).toBe(true);
    });

    it('should return metadata for irreversible tools', () => {
      const meta = getToolMetadata('vault_delete_note');
      expect(meta.sideEffects).toBe('irreversible');
      expect(meta.requiresConfirmation).toBe(true);
    });

    it('should return default metadata for unknown tools', () => {
      const meta = getToolMetadata('unknown_tool_xyz');
      expect(meta.category).toBe('query'); // Default assumption
      expect(meta.sideEffects).toBe('none');
      expect(meta.requiresConfirmation).toBe(false);
      expect(meta.requiresTodoWrite).toBe(false);
      expect(meta.costLevel).toBe('cheap');
      expect(meta.allowsParallelExecution).toBe(true); // Default to parallel-safe
    });
  });

  // ===========================================================================
  // HELPER FUNCTION TESTS
  // ===========================================================================

  describe('toolRequiresTodoWrite()', () => {
    it('should return false for clarification tools', () => {
      expect(toolRequiresTodoWrite('agent_ask_user')).toBe(false);
      expect(toolRequiresTodoWrite('agent_confirm')).toBe(false);
      expect(toolRequiresTodoWrite('AskUserQuestion')).toBe(false);
    });

    it('should return false for query tools', () => {
      expect(toolRequiresTodoWrite('search_fulltext')).toBe(false);
      expect(toolRequiresTodoWrite('search_vector')).toBe(false);
      expect(toolRequiresTodoWrite('vault_read_note')).toBe(false);
      expect(toolRequiresTodoWrite('Read')).toBe(false);
      expect(toolRequiresTodoWrite('Glob')).toBe(false);
      expect(toolRequiresTodoWrite('Grep')).toBe(false);
    });

    it('should return true for mutation tools', () => {
      expect(toolRequiresTodoWrite('vault_create_note')).toBe(true);
      expect(toolRequiresTodoWrite('vault_update_note')).toBe(true);
      expect(toolRequiresTodoWrite('vault_delete_note')).toBe(true);
    });

    it('should return true for execution tools', () => {
      expect(toolRequiresTodoWrite('Bash')).toBe(true);
    });

    it('should return false for planning tools', () => {
      expect(toolRequiresTodoWrite('TodoWrite')).toBe(false);
      expect(toolRequiresTodoWrite('EnterPlanMode')).toBe(false);
    });
  });

  describe('toolRequiresConfirmation()', () => {
    it('should return false for safe tools', () => {
      expect(toolRequiresConfirmation('search_fulltext')).toBe(false);
      expect(toolRequiresConfirmation('vault_read_note')).toBe(false);
      expect(toolRequiresConfirmation('vault_create_note')).toBe(false);
    });

    it('should return true for irreversible tools', () => {
      expect(toolRequiresConfirmation('vault_delete_note')).toBe(true);
      expect(toolRequiresConfirmation('Bash')).toBe(true);
    });
  });

  describe('toolAllowsParallel()', () => {
    it('should return true for query tools', () => {
      expect(toolAllowsParallel('search_fulltext')).toBe(true);
      expect(toolAllowsParallel('search_vector')).toBe(true);
      expect(toolAllowsParallel('vault_read_note')).toBe(true);
      expect(toolAllowsParallel('Read')).toBe(true);
      expect(toolAllowsParallel('Glob')).toBe(true);
      expect(toolAllowsParallel('Grep')).toBe(true);
    });

    it('should return false for user interaction tools', () => {
      expect(toolAllowsParallel('agent_ask_user')).toBe(false);
      expect(toolAllowsParallel('agent_confirm')).toBe(false);
    });

    it('should return false for mutation tools', () => {
      expect(toolAllowsParallel('vault_create_note')).toBe(false);
      expect(toolAllowsParallel('vault_update_note')).toBe(false);
      expect(toolAllowsParallel('vault_delete_note')).toBe(false);
    });

    it('should return false for execution tools', () => {
      expect(toolAllowsParallel('Bash')).toBe(false);
    });

    it('should return true for LLM tools (independent API calls)', () => {
      expect(toolAllowsParallel('llm_analyze')).toBe(true);
      expect(toolAllowsParallel('llm_summarize')).toBe(true);
    });
  });

  // ===========================================================================
  // PARTITION TOOL CALLS TESTS
  // ===========================================================================

  describe('partitionToolCalls()', () => {
    const createToolCall = (name: string, id?: string): ToolCall => ({
      id: id || `call_${name}`,
      name,
      arguments: {},
    });

    it('should separate parallel-safe tools from sequential tools', () => {
      const toolCalls: ToolCall[] = [
        createToolCall('search_fulltext'),
        createToolCall('vault_read_note'),
        createToolCall('agent_ask_user'),
        createToolCall('vault_create_note'),
      ];

      const { parallel, sequential } = partitionToolCalls(toolCalls);

      // search_fulltext and vault_read_note are parallel-safe
      expect(parallel).toHaveLength(2);
      expect(parallel.map(tc => tc.name)).toContain('search_fulltext');
      expect(parallel.map(tc => tc.name)).toContain('vault_read_note');

      // agent_ask_user and vault_create_note are sequential
      expect(sequential).toHaveLength(2);
      expect(sequential.map(tc => tc.name)).toContain('agent_ask_user');
      expect(sequential.map(tc => tc.name)).toContain('vault_create_note');
    });

    it('should return all tools as parallel when all are parallel-safe', () => {
      const toolCalls: ToolCall[] = [
        createToolCall('search_fulltext'),
        createToolCall('search_vector'),
        createToolCall('Read'),
        createToolCall('Glob'),
      ];

      const { parallel, sequential } = partitionToolCalls(toolCalls);

      expect(parallel).toHaveLength(4);
      expect(sequential).toHaveLength(0);
    });

    it('should return all tools as sequential when none are parallel-safe', () => {
      const toolCalls: ToolCall[] = [
        createToolCall('agent_ask_user'),
        createToolCall('vault_create_note'),
        createToolCall('Bash'),
      ];

      const { parallel, sequential } = partitionToolCalls(toolCalls);

      expect(parallel).toHaveLength(0);
      expect(sequential).toHaveLength(3);
    });

    it('should handle empty tool calls array', () => {
      const { parallel, sequential } = partitionToolCalls([]);

      expect(parallel).toHaveLength(0);
      expect(sequential).toHaveLength(0);
    });

    it('should preserve tool call order within each partition', () => {
      const toolCalls: ToolCall[] = [
        createToolCall('search_fulltext', 'call_1'),
        createToolCall('Read', 'call_2'),
        createToolCall('Grep', 'call_3'),
      ];

      const { parallel } = partitionToolCalls(toolCalls);

      expect(parallel[0].id).toBe('call_1');
      expect(parallel[1].id).toBe('call_2');
      expect(parallel[2].id).toBe('call_3');
    });
  });

  // ===========================================================================
  // TOOL METADATA COVERAGE TESTS
  // ===========================================================================

  describe('TOOL_METADATA coverage', () => {
    it('should have metadata for all clarification tools', () => {
      const clarificationTools = ['agent_ask_user', 'agent_confirm', 'AskUserQuestion'];
      for (const tool of clarificationTools) {
        expect(TOOL_METADATA[tool]).toBeDefined();
        expect(TOOL_METADATA[tool].category).toBe('clarification');
      }
    });

    it('should have metadata for all query tools', () => {
      const queryTools = [
        'search_fulltext',
        'search_vector',
        'search_hybrid',
        'vault_read_note',
        'vault_list_notes',
        'Read',
        'Glob',
        'Grep',
        'graph_backlinks',
        'graph_outlinks',
        'memory_recall',
        'memory_search',
      ];
      for (const tool of queryTools) {
        expect(TOOL_METADATA[tool]).toBeDefined();
        expect(TOOL_METADATA[tool].category).toBe('query');
      }
    });

    it('should have metadata for all mutation tools', () => {
      const mutationTools = ['vault_create_note', 'vault_update_note', 'vault_delete_note'];
      for (const tool of mutationTools) {
        expect(TOOL_METADATA[tool]).toBeDefined();
        expect(TOOL_METADATA[tool].category).toBe('mutation');
      }
    });

    it('should have metadata for planning tools', () => {
      const planningTools = ['TodoWrite', 'EnterPlanMode'];
      for (const tool of planningTools) {
        expect(TOOL_METADATA[tool]).toBeDefined();
        expect(TOOL_METADATA[tool].category).toBe('planning');
      }
    });

    it('should have metadata for execution tools', () => {
      expect(TOOL_METADATA['Bash']).toBeDefined();
      expect(TOOL_METADATA['Bash'].category).toBe('execution');
    });
  });

  // ===========================================================================
  // COST LEVEL TESTS
  // ===========================================================================

  describe('cost levels', () => {
    it('should mark clarification tools as free', () => {
      expect(getToolMetadata('agent_ask_user').costLevel).toBe('free');
      expect(getToolMetadata('TodoWrite').costLevel).toBe('free');
    });

    it('should mark query tools as cheap', () => {
      expect(getToolMetadata('search_fulltext').costLevel).toBe('cheap');
      expect(getToolMetadata('vault_read_note').costLevel).toBe('cheap');
    });

    it('should mark LLM tools as expensive', () => {
      expect(getToolMetadata('llm_analyze').costLevel).toBe('expensive');
      expect(getToolMetadata('llm_summarize').costLevel).toBe('expensive');
    });

    it('should mark Bash as expensive', () => {
      expect(getToolMetadata('Bash').costLevel).toBe('expensive');
    });
  });
});
