/**
 * ToolExemptions Tests
 *
 * TDD tests for tool exemption logic that allows certain tools
 * (clarification, query) to bypass TodoWrite requirement.
 *
 * Key behavior: agent_ask_user should work on Turn 1 without TodoWrite.
 */

import { describe, it, expect } from 'vitest';
import {
  TODOWRITE_EXEMPT_TOOLS,
  isToolExemptFromTodoWrite,
  filterExemptTools,
  filterActionTools,
} from '../ToolExemptions';

// =============================================================================
// EXEMPT TOOL LIST TESTS
// =============================================================================

describe('ToolExemptions', () => {
  describe('TODOWRITE_EXEMPT_TOOLS', () => {
    it('should include agent_ask_user', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('agent_ask_user');
    });

    it('should include agent_confirm', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('agent_confirm');
    });

    it('should include AskUserQuestion (Claude Code alias)', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('AskUserQuestion');
    });

    it('should include all search tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('search_fulltext');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('search_vector');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('search_hybrid');
    });

    it('should include all vault read tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('vault_read_note');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('vault_list_notes');
    });

    it('should include file query tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('Read');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('Glob');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('Grep');
    });

    it('should include graph query tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('graph_backlinks');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('graph_outlinks');
    });

    it('should include memory query tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('memory_recall');
      expect(TODOWRITE_EXEMPT_TOOLS).toContain('memory_search');
    });

    it('should NOT include mutation tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('vault_create_note');
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('vault_update_note');
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('vault_delete_note');
    });

    it('should NOT include execution tools', () => {
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('Bash');
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('Write');
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('Edit');
    });

    it('should NOT include TodoWrite itself', () => {
      // TodoWrite is handled separately, not in exempt list
      expect(TODOWRITE_EXEMPT_TOOLS).not.toContain('TodoWrite');
    });
  });

  // =============================================================================
  // isToolExemptFromTodoWrite TESTS
  // =============================================================================

  describe('isToolExemptFromTodoWrite', () => {
    describe('clarification tools', () => {
      it('should return true for agent_ask_user', () => {
        expect(isToolExemptFromTodoWrite('agent_ask_user')).toBe(true);
      });

      it('should return true for agent_confirm', () => {
        expect(isToolExemptFromTodoWrite('agent_confirm')).toBe(true);
      });

      it('should return true for AskUserQuestion', () => {
        expect(isToolExemptFromTodoWrite('AskUserQuestion')).toBe(true);
      });
    });

    describe('query tools', () => {
      it('should return true for search_fulltext', () => {
        expect(isToolExemptFromTodoWrite('search_fulltext')).toBe(true);
      });

      it('should return true for vault_read_note', () => {
        expect(isToolExemptFromTodoWrite('vault_read_note')).toBe(true);
      });

      it('should return true for Read', () => {
        expect(isToolExemptFromTodoWrite('Read')).toBe(true);
      });

      it('should return true for Glob', () => {
        expect(isToolExemptFromTodoWrite('Glob')).toBe(true);
      });

      it('should return true for Grep', () => {
        expect(isToolExemptFromTodoWrite('Grep')).toBe(true);
      });
    });

    describe('mutation tools', () => {
      it('should return false for vault_create_note', () => {
        expect(isToolExemptFromTodoWrite('vault_create_note')).toBe(false);
      });

      it('should return false for vault_update_note', () => {
        expect(isToolExemptFromTodoWrite('vault_update_note')).toBe(false);
      });

      it('should return false for vault_delete_note', () => {
        expect(isToolExemptFromTodoWrite('vault_delete_note')).toBe(false);
      });
    });

    describe('execution tools', () => {
      it('should return false for Bash', () => {
        expect(isToolExemptFromTodoWrite('Bash')).toBe(false);
      });

      it('should return false for Write', () => {
        expect(isToolExemptFromTodoWrite('Write')).toBe(false);
      });

      it('should return false for Edit', () => {
        expect(isToolExemptFromTodoWrite('Edit')).toBe(false);
      });
    });

    describe('unknown tools', () => {
      it('should return false for unknown tools (conservative default)', () => {
        expect(isToolExemptFromTodoWrite('unknown_tool')).toBe(false);
      });

      it('should return false for made-up tool names', () => {
        expect(isToolExemptFromTodoWrite('my_custom_dangerous_tool')).toBe(false);
      });
    });

    describe('case sensitivity', () => {
      it('should be case-sensitive (exact match required)', () => {
        // Our list has 'agent_ask_user', not 'AGENT_ASK_USER'
        expect(isToolExemptFromTodoWrite('AGENT_ASK_USER')).toBe(false);
        expect(isToolExemptFromTodoWrite('Agent_Ask_User')).toBe(false);
      });
    });
  });

  // =============================================================================
  // FILTER HELPERS TESTS
  // =============================================================================

  describe('filterExemptTools', () => {
    it('should return only exempt tools from a list', () => {
      const toolCalls = [
        { id: '1', name: 'agent_ask_user', arguments: {} },
        { id: '2', name: 'vault_create_note', arguments: {} },
        { id: '3', name: 'search_fulltext', arguments: {} },
      ];

      const exempt = filterExemptTools(toolCalls);

      expect(exempt).toHaveLength(2);
      expect(exempt.map(t => t.name)).toContain('agent_ask_user');
      expect(exempt.map(t => t.name)).toContain('search_fulltext');
      expect(exempt.map(t => t.name)).not.toContain('vault_create_note');
    });

    it('should return empty array if no tools are exempt', () => {
      const toolCalls = [
        { id: '1', name: 'vault_create_note', arguments: {} },
        { id: '2', name: 'Bash', arguments: {} },
      ];

      const exempt = filterExemptTools(toolCalls);

      expect(exempt).toHaveLength(0);
    });

    it('should return all tools if all are exempt', () => {
      const toolCalls = [
        { id: '1', name: 'agent_ask_user', arguments: {} },
        { id: '2', name: 'Read', arguments: {} },
        { id: '3', name: 'Grep', arguments: {} },
      ];

      const exempt = filterExemptTools(toolCalls);

      expect(exempt).toHaveLength(3);
    });

    it('should handle empty input', () => {
      expect(filterExemptTools([])).toEqual([]);
    });

    it('should handle undefined input gracefully', () => {
      expect(filterExemptTools(undefined as any)).toEqual([]);
    });
  });

  describe('filterActionTools', () => {
    it('should return only non-exempt (action) tools from a list', () => {
      const toolCalls = [
        { id: '1', name: 'agent_ask_user', arguments: {} },
        { id: '2', name: 'vault_create_note', arguments: {} },
        { id: '3', name: 'search_fulltext', arguments: {} },
        { id: '4', name: 'Bash', arguments: {} },
      ];

      const actions = filterActionTools(toolCalls);

      expect(actions).toHaveLength(2);
      expect(actions.map(t => t.name)).toContain('vault_create_note');
      expect(actions.map(t => t.name)).toContain('Bash');
      expect(actions.map(t => t.name)).not.toContain('agent_ask_user');
      expect(actions.map(t => t.name)).not.toContain('search_fulltext');
    });

    it('should return empty array if all tools are exempt', () => {
      const toolCalls = [
        { id: '1', name: 'agent_ask_user', arguments: {} },
        { id: '2', name: 'Read', arguments: {} },
      ];

      const actions = filterActionTools(toolCalls);

      expect(actions).toHaveLength(0);
    });

    it('should return all tools if none are exempt', () => {
      const toolCalls = [
        { id: '1', name: 'vault_create_note', arguments: {} },
        { id: '2', name: 'Bash', arguments: {} },
      ];

      const actions = filterActionTools(toolCalls);

      expect(actions).toHaveLength(2);
    });

    it('should handle empty input', () => {
      expect(filterActionTools([])).toEqual([]);
    });
  });

  // =============================================================================
  // TODOWRITE EXCLUSION TESTS
  // =============================================================================

  describe('TodoWrite handling', () => {
    it('TodoWrite should NOT be in exempt list (handled separately)', () => {
      expect(isToolExemptFromTodoWrite('TodoWrite')).toBe(false);
    });

    it('should correctly filter when TodoWrite is mixed with other tools', () => {
      const toolCalls = [
        { id: '1', name: 'TodoWrite', arguments: {} },
        { id: '2', name: 'agent_ask_user', arguments: {} },
        { id: '3', name: 'vault_create_note', arguments: {} },
      ];

      const exempt = filterExemptTools(toolCalls);
      const actions = filterActionTools(toolCalls);

      // agent_ask_user is exempt
      expect(exempt).toHaveLength(1);
      expect(exempt[0].name).toBe('agent_ask_user');

      // TodoWrite and vault_create_note are NOT exempt
      expect(actions).toHaveLength(2);
      expect(actions.map(t => t.name)).toContain('TodoWrite');
      expect(actions.map(t => t.name)).toContain('vault_create_note');
    });
  });

  // =============================================================================
  // REAL-WORLD SCENARIO TESTS
  // =============================================================================

  describe('real-world scenarios', () => {
    it('Turn 1: agent asking clarification question should be allowed', () => {
      // Scenario: User says "plan a trip to Dubai"
      // Agent wants to call agent_ask_user for clarification
      const toolCalls = [
        {
          id: '1',
          name: 'agent_ask_user',
          arguments: {
            questions: [
              {
                question: 'What are your travel dates?',
                header: 'Dates',
                options: [
                  { label: 'Flexible', description: 'Open to suggestions' },
                  { label: 'Specific', description: 'I have fixed dates' },
                ],
              },
            ],
          },
        },
      ];

      const exempt = filterExemptTools(toolCalls);
      const actions = filterActionTools(toolCalls);

      // agent_ask_user should be allowed without TodoWrite
      expect(exempt).toHaveLength(1);
      expect(actions).toHaveLength(0);
    });

    it('Turn 1: agent gathering context via search should be allowed', () => {
      // Scenario: User asks "what notes do I have about travel?"
      // Agent searches before knowing if it needs to create anything
      const toolCalls = [
        { id: '1', name: 'search_fulltext', arguments: { query: 'travel' } },
        { id: '2', name: 'vault_list_notes', arguments: {} },
      ];

      const exempt = filterExemptTools(toolCalls);
      const actions = filterActionTools(toolCalls);

      // Both are query tools, should be allowed
      expect(exempt).toHaveLength(2);
      expect(actions).toHaveLength(0);
    });

    it('Turn 1: agent trying to create without plan should be blocked', () => {
      // Scenario: Agent jumps straight to creating note without clarification
      const toolCalls = [
        {
          id: '1',
          name: 'vault_create_note',
          arguments: { title: 'Trip Plan', content: '...' },
        },
      ];

      const exempt = filterExemptTools(toolCalls);
      const actions = filterActionTools(toolCalls);

      // vault_create_note is NOT exempt
      expect(exempt).toHaveLength(0);
      expect(actions).toHaveLength(1);
      expect(actions[0].name).toBe('vault_create_note');
    });

    it('mixed clarification and action: only actions should be blocked', () => {
      // Agent calls both exempt and non-exempt tools
      const toolCalls = [
        { id: '1', name: 'agent_ask_user', arguments: {} },
        { id: '2', name: 'vault_create_note', arguments: {} },
        { id: '3', name: 'Read', arguments: {} },
        { id: '4', name: 'Bash', arguments: {} },
      ];

      const exempt = filterExemptTools(toolCalls);
      const actions = filterActionTools(toolCalls);

      // agent_ask_user and Read are exempt
      expect(exempt).toHaveLength(2);
      expect(exempt.map(t => t.name)).toEqual(['agent_ask_user', 'Read']);

      // vault_create_note and Bash are NOT exempt
      expect(actions).toHaveLength(2);
      expect(actions.map(t => t.name)).toEqual(['vault_create_note', 'Bash']);
    });
  });
});
