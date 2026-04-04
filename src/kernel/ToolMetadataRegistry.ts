/**
 * ToolMetadataRegistry - Tool Classification and Execution Optimization
 *
 * Provides metadata for tools including:
 * - Side effects (none, reversible, irreversible)
 * - Cost level (free, cheap, expensive)
 * - Confirmation requirements
 * - TodoWrite requirements
 * - Parallel execution capability
 *
 * This enables:
 * - Smart tool filtering (which tools need TodoWrite, confirmation)
 * - Parallel execution optimization (run independent queries concurrently)
 * - Checkpoint triggers (before irreversible operations)
 */

// =============================================================================
// TYPES
// =============================================================================

export type MetadataCategory =
  | 'clarification'
  | 'planning'
  | 'query'
  | 'mutation'
  | 'execution';

export type SideEffects = 'none' | 'reversible' | 'irreversible';

export type CostLevel = 'free' | 'cheap' | 'expensive';

/**
 * Metadata for a tool describing its behavior and requirements
 */
export interface ToolMetadata {
  /** Tool category */
  category: MetadataCategory;
  /** Side effects of the tool */
  sideEffects: SideEffects;
  /** Whether the tool requires user confirmation before execution */
  requiresConfirmation: boolean;
  /** Whether the tool requires a TodoWrite plan before execution */
  requiresTodoWrite: boolean;
  /** Cost level (for budgeting/throttling) */
  costLevel: CostLevel;
  /** Whether this tool can run in parallel with other tools */
  allowsParallelExecution: boolean;
}

/**
 * A tool call with name and arguments
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// =============================================================================
// TOOL METADATA REGISTRY
// =============================================================================

/**
 * Default metadata for unknown tools
 */
const DEFAULT_METADATA: ToolMetadata = {
  category: 'query',
  sideEffects: 'none',
  requiresConfirmation: false,
  requiresTodoWrite: false,
  costLevel: 'cheap',
  allowsParallelExecution: true, // Default to parallel-safe for queries
};

/**
 * Metadata for all known tools
 */
export const TOOL_METADATA: Record<string, ToolMetadata> = {
  // ===========================================================================
  // CLARIFICATION TOOLS - Always allowed, no side effects
  // NOT parallelizable - user interaction requires sequential flow
  // ===========================================================================
  agent_ask_user: {
    category: 'clarification',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'free',
    allowsParallelExecution: false, // User interaction must be sequential
  },
  agent_confirm: {
    category: 'clarification',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'free',
    allowsParallelExecution: false, // User interaction must be sequential
  },
  AskUserQuestion: {
    category: 'clarification',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'free',
    allowsParallelExecution: false, // User interaction must be sequential
  },

  // ===========================================================================
  // PLANNING TOOLS - Not parallelizable (depend on each other)
  // ===========================================================================
  TodoWrite: {
    category: 'planning',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'free',
    allowsParallelExecution: false, // Planning is sequential
  },
  EnterPlanMode: {
    category: 'planning',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'free',
    allowsParallelExecution: false,
  },

  // ===========================================================================
  // QUERY TOOLS - Read-only, CAN be parallelized
  // ===========================================================================
  search_fulltext: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true, // Independent reads can run in parallel
  },
  search_vector: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  search_hybrid: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  vault_read_note: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  vault_list_notes: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  Read: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  Glob: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  Grep: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  graph_backlinks: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  graph_outlinks: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  memory_recall: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },
  memory_search: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },

  // ===========================================================================
  // MUTATION TOOLS - Reversible, NOT parallelizable by default
  // (could conflict if operating on same resources)
  // ===========================================================================
  vault_create_note: {
    category: 'mutation',
    sideEffects: 'reversible',
    requiresConfirmation: false,
    requiresTodoWrite: true,
    costLevel: 'cheap',
    allowsParallelExecution: false, // Could have path conflicts
  },
  vault_update_note: {
    category: 'mutation',
    sideEffects: 'reversible',
    requiresConfirmation: false,
    requiresTodoWrite: true,
    costLevel: 'cheap',
    allowsParallelExecution: false, // Same file edits would conflict
  },
  vault_delete_note: {
    category: 'mutation',
    sideEffects: 'irreversible',
    requiresConfirmation: true,
    requiresTodoWrite: true,
    costLevel: 'cheap',
    allowsParallelExecution: false,
  },

  // ===========================================================================
  // EXECUTION TOOLS - NOT parallelizable (side effects)
  // ===========================================================================
  Bash: {
    category: 'execution',
    sideEffects: 'irreversible',
    requiresConfirmation: true,
    requiresTodoWrite: true,
    costLevel: 'expensive',
    allowsParallelExecution: false, // Commands could interfere
  },

  // ===========================================================================
  // LLM TOOLS - CAN be parallelized (independent API calls)
  // ===========================================================================
  llm_analyze: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'expensive',
    allowsParallelExecution: true, // Independent LLM calls can run in parallel
  },
  llm_summarize: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'expensive',
    allowsParallelExecution: true,
  },

  // ===========================================================================
  // SUB-AGENT TOOLS - Spawning is expensive, CAN be parallelized
  // ===========================================================================
  spawn_task: {
    category: 'execution',
    sideEffects: 'reversible',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'expensive',
    allowsParallelExecution: true, // Multiple sub-agents can run concurrently
  },
  task_status: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'cheap',
    allowsParallelExecution: true,
  },

  // ===========================================================================
  // WEB TOOLS - External API calls, can be parallelized
  // ===========================================================================
  web_search: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'expensive', // External API call with rate limits
    allowsParallelExecution: true,
  },
  web_fetch: {
    category: 'query',
    sideEffects: 'none',
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: 'expensive', // External fetch + LLM call
    allowsParallelExecution: true,
  },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get metadata for a tool, with defaults for unknown tools
 */
export function getToolMetadata(toolName: string): ToolMetadata {
  return TOOL_METADATA[toolName] || DEFAULT_METADATA;
}

/**
 * Check if a tool requires a TodoWrite plan before execution
 */
export function toolRequiresTodoWrite(toolName: string): boolean {
  return getToolMetadata(toolName).requiresTodoWrite;
}

/**
 * Check if a tool requires user confirmation before execution
 */
export function toolRequiresConfirmation(toolName: string): boolean {
  return getToolMetadata(toolName).requiresConfirmation;
}

/**
 * Check if a tool can be executed in parallel with other tools
 */
export function toolAllowsParallel(toolName: string): boolean {
  return getToolMetadata(toolName).allowsParallelExecution;
}

// =============================================================================
// PARTITION TOOL CALLS
// =============================================================================

/** Max parallel batch size */
const MAX_PARALLEL_BATCH = 8;

/** Path-scoped tool metadata — tools that operate on file paths */
const PATH_SCOPED_TOOLS: Record<string, string> = {
  vault_read_note: 'note_id',
  vault_create_note: 'title',
  vault_update_note: 'note_id',
  vault_delete_note: 'note_id',
  vault_set_frontmatter: 'note_id',
  vault_insert_content: 'note_id',
  vault_find_replace: 'note_id',
  Read: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
};

/**
 * Check if two paths overlap (one is a prefix of the other).
 */
function pathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.replace(/\\/g, '/');
  const nb = b.replace(/\\/g, '/');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/**
 * Extract the path from a tool call's arguments.
 */
function extractPath(toolName: string, args: Record<string, unknown>): string | undefined {
  const paramName = PATH_SCOPED_TOOLS[toolName];
  if (!paramName) return undefined;
  const value = args[paramName];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Partition tool calls into parallel-safe and sequential groups.
 * Enhanced with path-overlap detection for file-scoped tools.
 *
 * @param toolCalls - Array of tool calls to partition
 * @returns Object with parallel and sequential arrays
 */
export function partitionToolCalls<T extends { name: string; arguments?: Record<string, unknown> }>(
  toolCalls: T[]
): { parallel: T[]; sequential: T[] } {
  const parallel: T[] = [];
  const sequential: T[] = [];

  // Track paths used by parallel tools for overlap detection
  const parallelPaths: Array<{ call: T; path: string }> = [];

  for (const tc of toolCalls) {
    if (!toolAllowsParallel(tc.name)) {
      sequential.push(tc);
      continue;
    }

    // Check for path overlap with existing parallel calls
    const path = extractPath(tc.name, tc.arguments ?? {});
    if (path) {
      const hasOverlap = parallelPaths.some((p) => pathsOverlap(path, p.path));
      if (hasOverlap) {
        sequential.push(tc);
        continue;
      }
      parallelPaths.push({ call: tc, path });
    }

    // Cap parallel batch size
    if (parallel.length >= MAX_PARALLEL_BATCH) {
      sequential.push(tc);
      continue;
    }

    parallel.push(tc);
  }

  return { parallel, sequential };
}

/**
 * Deduplicate tool calls with identical (name, arguments) pairs.
 * Keeps the first occurrence, removes duplicates.
 * Known to trigger with Gemini and some OpenRouter-routed models.
 */
export function deduplicateToolCalls<T extends { name: string; arguments?: Record<string, unknown> }>(
  toolCalls: T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const tc of toolCalls) {
    const key = `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tc);
  }

  return result;
}
