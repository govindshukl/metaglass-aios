/**
 * Tool Exemptions
 *
 * Defines which tools are exempt from the TodoWrite requirement.
 * Clarification and query tools should always be allowed, even on Turn 1.
 *
 * This fixes the issue where agent_ask_user is blocked on Turn 1,
 * causing 3-4 extra turns for simple clarification questions.
 */

/**
 * Tools that should NEVER require TodoWrite to be called first.
 *
 * Categories:
 * 1. Clarification tools - user interaction for gathering requirements
 * 2. Query tools - read-only operations that gather context
 * 3. Memory tools - recall and search existing knowledge
 *
 * NOT included:
 * - Mutation tools (vault_create_*, vault_update_*, vault_delete_*)
 * - Execution tools (Bash, Write, Edit)
 * - TodoWrite itself (handled separately in enforcement logic)
 */
export const TODOWRITE_EXEMPT_TOOLS: readonly string[] = [
  // ==========================================================================
  // CLARIFICATION TOOLS
  // User interaction for gathering requirements - always allowed
  // ==========================================================================
  'agent_ask_user',
  'agent_confirm',
  'AskUserQuestion', // Claude Code alias

  // ==========================================================================
  // SEARCH TOOLS
  // Full-text, vector, and hybrid search - read-only
  // ==========================================================================
  'search_fulltext',
  'search_vector',
  'search_hybrid',

  // ==========================================================================
  // VAULT QUERY TOOLS
  // Read-only vault operations
  // ==========================================================================
  'vault_read_note',
  'vault_list_notes',

  // ==========================================================================
  // FILE QUERY TOOLS
  // Read-only file system operations
  // ==========================================================================
  'Read',
  'Glob',
  'Grep',

  // ==========================================================================
  // GRAPH QUERY TOOLS
  // Knowledge graph queries - read-only
  // ==========================================================================
  'graph_backlinks',
  'graph_outlinks',

  // ==========================================================================
  // MEMORY TOOLS
  // Recall and search - read-only
  // ==========================================================================
  'memory_recall',
  'memory_search',
] as const;

/**
 * Check if a tool is exempt from the TodoWrite requirement.
 *
 * @param toolName - Name of the tool to check
 * @returns true if the tool can be used without TodoWrite being called first
 *
 * @example
 * ```typescript
 * isToolExemptFromTodoWrite('agent_ask_user'); // true - clarification tool
 * isToolExemptFromTodoWrite('vault_create_note'); // false - mutation tool
 * isToolExemptFromTodoWrite('unknown_tool'); // false - conservative default
 * ```
 */
export function isToolExemptFromTodoWrite(toolName: string): boolean {
  return TODOWRITE_EXEMPT_TOOLS.includes(toolName);
}

/**
 * Tool call structure (minimal interface for filtering)
 * Compatible with both { arguments } from tests and { params } from AIOS types
 */
interface ToolCallLike {
  id: string;
  name: string;
  // Support both 'arguments' (test format) and 'params' (AIOS format)
  arguments?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

/**
 * Filter tool calls to return only those that are exempt from TodoWrite.
 *
 * @param toolCalls - Array of tool calls to filter
 * @returns Array of tool calls that are exempt (can run without TodoWrite)
 *
 * @example
 * ```typescript
 * const toolCalls = [
 *   { id: '1', name: 'agent_ask_user', arguments: {} },
 *   { id: '2', name: 'vault_create_note', arguments: {} },
 * ];
 * const exempt = filterExemptTools(toolCalls);
 * // Returns: [{ id: '1', name: 'agent_ask_user', arguments: {} }]
 * ```
 */
export function filterExemptTools<T extends ToolCallLike>(toolCalls: T[] | undefined | null): T[] {
  if (!toolCalls || !Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter((tc) => isToolExemptFromTodoWrite(tc.name));
}

/**
 * Filter tool calls to return only those that are NOT exempt (action tools).
 * These are the tools that require TodoWrite to be called first.
 *
 * @param toolCalls - Array of tool calls to filter
 * @returns Array of tool calls that are NOT exempt (require TodoWrite)
 *
 * @example
 * ```typescript
 * const toolCalls = [
 *   { id: '1', name: 'agent_ask_user', arguments: {} },
 *   { id: '2', name: 'vault_create_note', arguments: {} },
 * ];
 * const actions = filterActionTools(toolCalls);
 * // Returns: [{ id: '2', name: 'vault_create_note', arguments: {} }]
 * ```
 */
export function filterActionTools<T extends ToolCallLike>(toolCalls: T[] | undefined | null): T[] {
  if (!toolCalls || !Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter((tc) => !isToolExemptFromTodoWrite(tc.name));
}
