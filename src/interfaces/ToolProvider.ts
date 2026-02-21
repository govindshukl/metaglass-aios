/**
 * ToolProvider Interface
 *
 * Abstraction for tool registries and execution.
 * Tools are the capabilities available to agents.
 */

import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolCategory,
} from './types';

/**
 * Executable tool with handler
 */
export interface Tool extends ToolDefinition {
  /**
   * Execute the tool with given parameters
   *
   * @param params - Tool parameters
   * @param context - Execution context
   * @returns Tool result
   */
  execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}

/**
 * Tool Provider interface
 *
 * Provides access to tools and handles execution.
 */
export interface ToolProvider {
  /** Unique provider identifier */
  readonly id: string;

  /**
   * Get all available tools
   *
   * @returns Array of tool definitions
   */
  list(): ToolDefinition[];

  /**
   * Get tools filtered by category
   *
   * @param category - Tool category to filter by
   * @returns Array of matching tool definitions
   */
  listByCategory(category: ToolCategory): ToolDefinition[];

  /**
   * Get a specific tool by ID
   *
   * @param id - Tool identifier
   * @returns Tool if found, undefined otherwise
   */
  get(id: string): Tool | undefined;

  /**
   * Check if a tool exists
   *
   * @param id - Tool identifier
   * @returns Whether tool exists
   */
  has(id: string): boolean;

  /**
   * Execute a tool by ID
   *
   * @param id - Tool identifier
   * @param params - Tool parameters
   * @param context - Execution context
   * @returns Tool result
   */
  execute(
    id: string,
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult>;

  /**
   * Get the count of registered tools
   *
   * @returns Number of tools
   */
  count(): number;
}

/**
 * Mutable tool registry for runtime registration
 */
export interface ToolRegistry extends ToolProvider {
  /**
   * Register a new tool
   *
   * @param tool - Tool to register
   */
  register(tool: Tool): void;

  /**
   * Unregister a tool
   *
   * @param id - Tool identifier
   * @returns Whether tool was unregistered
   */
  unregister(id: string): boolean;

  /**
   * Clear all registered tools
   */
  clear(): void;
}

/**
 * Composite tool provider that combines multiple providers
 */
export interface CompositeToolProvider extends ToolProvider {
  /**
   * Add a provider to the composite
   *
   * @param provider - Provider to add
   */
  addProvider(provider: ToolProvider): void;

  /**
   * Remove a provider from the composite
   *
   * @param id - Provider identifier
   * @returns Whether provider was removed
   */
  removeProvider(id: string): boolean;

  /**
   * Get all underlying providers
   *
   * @returns Array of providers
   */
  getProviders(): ToolProvider[];
}
