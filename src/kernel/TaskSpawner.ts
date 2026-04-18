/**
 * TaskSpawner - Sub-agent spawning for AIOS
 *
 * Implements the Task tool pattern from Claude Code:
 * - Spawns isolated sub-agents for specific tasks
 * - Different agent types with different capabilities
 * - Background task execution support
 */

import type {
  SubAgentType,
  TaskParams,
  TaskResult,
  ConversationResult,
  EventEmitter,
  ModelTier,
} from '../interfaces';

// =============================================================================
// AGENT FACTORY INTERFACE
// =============================================================================

/**
 * Configuration for creating an agent
 */
export interface AgentConfig {
  /** Agent type */
  type: SubAgentType;
  /** Model to use */
  model: ModelTier;
  /** Allowed tools ('*' for all) */
  allowedTools: string[] | '*';
  /** System prompt override */
  systemPrompt?: string;
  /** Resume from previous agent ID */
  resumeFrom?: string;
  /** Current nesting depth (0 = top-level, incremented for each child) */
  depth?: number;
  /** Parent's abort signal for cascading cancellation */
  parentSignal?: AbortSignal;
}

/**
 * Agent instance interface
 */
export interface Agent {
  execute(prompt: string): Promise<ConversationResult>;
  cancel(): void;
  isRunning(): boolean;
}

/**
 * Factory for creating agents
 */
export interface AgentFactory {
  create(config: AgentConfig): Agent;
}

// =============================================================================
// AGENT TYPE CONFIGURATIONS
// =============================================================================

interface AgentTypeConfig {
  defaultModel: ModelTier;
  allowedTools: string[] | '*';
  systemPromptSuffix?: string;
}

const AGENT_TYPE_CONFIGS: Record<SubAgentType, AgentTypeConfig> = {
  // New lowercase agent types
  explore: {
    defaultModel: 'haiku',
    allowedTools: [
      // Filesystem
      'Read', 'Glob', 'Grep', 'LS',
      // Vault search & read (read-only)
      'search_fulltext', 'search_vector', 'search_hybrid',
      'vault_read_note',
      // Graph exploration (read-only)
      'graph_expand_neighbors', 'graph_centrality', 'graph_backlinks', 'graph_outlinks', 'graph_shortest_path',
      // LLM analysis (read-only)
      'llm_extract', 'llm_summarize', 'llm_classify', 'llm_analyze',
      // Memory (read-only)
      'memory_recall', 'memory_search',
      // Web research (read-only)
      'web_search', 'web_fetch',
      // Utils
      'utils_merge_dedupe', 'utils_filter', 'utils_sort', 'utils_format',
    ],
    systemPromptSuffix: `You are a fast exploration sub-agent. Your job is to search, read, and analyze information — then return your findings to the parent agent.

RULES:
- Do NOT ask the user questions. You cannot interact with the user.
- Do NOT create, update, or delete notes.
- Do NOT use TodoWrite — just do your work and return results.
- Use search_fulltext, search_vector, or search_hybrid to find notes in the vault.
- Use vault_read_note to read note content (always use the UUID from search results).
- Use web_search and web_fetch when the topic isn't in the vault (current events, external data, travel, products, etc.). After 1 failed vault search, switch to web.
- Be concise — return structured findings, not verbose explanations.
- Complete your task in as few turns as possible.`,
  },
  execute: {
    defaultModel: 'sonnet',
    allowedTools: '*',
    systemPromptSuffix: 'You are an execution agent with full access.',
  },

  // Legacy uppercase names (for backward compatibility)
  Explore: {
    defaultModel: 'haiku',
    allowedTools: [
      'Read', 'Glob', 'Grep', 'LS',
      'search_fulltext', 'search_vector', 'search_hybrid',
      'vault_read_note',
      'graph_expand_neighbors', 'graph_centrality', 'graph_backlinks', 'graph_outlinks', 'graph_shortest_path',
      'llm_extract', 'llm_summarize', 'llm_classify', 'llm_analyze',
      'memory_recall', 'memory_search',
      'web_search', 'web_fetch',
      'utils_merge_dedupe', 'utils_filter', 'utils_sort', 'utils_format',
    ],
    systemPromptSuffix: `You are a fast exploration sub-agent. Your job is to search, read, and analyze information — then return your findings to the parent agent.

RULES:
- Do NOT ask the user questions. You cannot interact with the user.
- Do NOT create, update, or delete notes.
- Do NOT use TodoWrite — just do your work and return results.
- Use search_fulltext, search_vector, or search_hybrid to find notes in the vault.
- Use vault_read_note to read note content (always use the UUID from search results).
- Use web_search and web_fetch when the topic isn't in the vault (current events, external data, travel, products, etc.). After 1 failed vault search, switch to web.
- Be concise — return structured findings, not verbose explanations.
- Complete your task in as few turns as possible.`,
  },
  'general-purpose': {
    defaultModel: 'sonnet',
    allowedTools: '*',
  },
  Plan: {
    defaultModel: 'sonnet',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    systemPromptSuffix: 'You are a planning agent. Design implementation strategies.',
  },
  Bash: {
    defaultModel: 'sonnet',
    allowedTools: ['Bash'],
    systemPromptSuffix: 'You are a command execution agent. Only run bash commands.',
  },
  Skill: {
    defaultModel: 'sonnet',
    allowedTools: ['Read', 'Glob', 'Grep'],
    systemPromptSuffix: 'You are a skill execution agent.',
  },
};

// =============================================================================
// TASK STATE
// =============================================================================

interface RunningTask {
  id: string;
  type: SubAgentType;
  agent: Agent;
  promise: Promise<ConversationResult>;
  result?: TaskResult;
}

// =============================================================================
// TASK SPAWNER
// =============================================================================

/**
 * TaskSpawner class
 *
 * Manages spawning and tracking of sub-agents.
 * Supports depth limiting, concurrency caps, and cascading cancellation.
 */
export class TaskSpawner {
  private agentFactory: AgentFactory;
  private events: EventEmitter;
  private tasks: Map<string, RunningTask> = new Map();

  /** Current nesting depth (0 = top-level agent) */
  readonly depth: number;
  /** Maximum allowed nesting depth */
  readonly maxDepth: number;
  /** Maximum concurrent running tasks */
  readonly maxConcurrent: number;

  constructor(
    agentFactory: AgentFactory,
    events: EventEmitter,
    depth: number = 0,
    maxDepth: number = 3,
    maxConcurrent: number = 5,
  ) {
    this.agentFactory = agentFactory;
    this.events = events;
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.maxConcurrent = maxConcurrent;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Spawn a new task
   */
  async spawn(params: TaskParams): Promise<TaskResult> {
    // Enforce depth limit
    if (this.depth >= this.maxDepth) {
      return {
        taskId: '',
        success: false,
        error: `Maximum agent nesting depth exceeded (depth: ${this.depth}, max: ${this.maxDepth}). Simplify by handling the task directly instead of delegating.`,
        status: 'failed',
      };
    }

    // Enforce concurrency limit
    const runningCount = this.getRunningTasks().length;
    if (runningCount >= this.maxConcurrent) {
      return {
        taskId: '',
        success: false,
        error: `Maximum concurrent sub-agents reached (${runningCount}/${this.maxConcurrent}). Wait for running tasks to complete before spawning new ones.`,
        status: 'failed',
      };
    }

    const taskId = this.generateTaskId();
    const typeConfig = AGENT_TYPE_CONFIGS[params.subagentType];

    // Build agent config with depth propagation
    const agentConfig: AgentConfig = {
      type: params.subagentType,
      model: params.model ?? typeConfig.defaultModel,
      allowedTools: typeConfig.allowedTools,
      systemPrompt: typeConfig.systemPromptSuffix,
      resumeFrom: params.resume,
      depth: this.depth + 1,
    };

    // Create agent
    const agent = this.agentFactory.create(agentConfig);

    // Emit spawned event
    await this.events.emit('task:spawned', { taskId, type: params.subagentType });

    // Start execution
    const promise = this.executeAgent(agent, params.prompt, taskId);

    // Track the task
    const task: RunningTask = {
      id: taskId,
      type: params.subagentType,
      agent,
      promise,
    };
    this.tasks.set(taskId, task);

    // If running in background, return immediately
    if (params.runInBackground) {
      // Handle completion in background
      promise.then(result => {
        this.handleCompletion(taskId, result);
      }).catch(error => {
        this.handleError(taskId, error);
      });

      return {
        taskId,
        success: true,
        status: 'running',
      };
    }

    // Wait for completion
    try {
      const result = await promise;
      return this.handleCompletion(taskId, result);
    } catch (error) {
      return this.handleError(taskId, error);
    }
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    return task.agent.isRunning();
  }

  /**
   * Get result of a task (may be undefined if still running)
   */
  async getResult(taskId: string): Promise<TaskResult | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    if (task.result) {
      return task.result;
    }

    // Wait for completion if still running
    if (task.agent.isRunning()) {
      const result = await task.promise;
      return this.createTaskResult(taskId, result);
    }

    return task.result;
  }

  /**
   * Get all running tasks
   */
  getRunningTasks(): Array<{ taskId: string; type: SubAgentType }> {
    const running: Array<{ taskId: string; type: SubAgentType }> = [];
    for (const [taskId, task] of this.tasks) {
      if (task.agent.isRunning()) {
        running.push({ taskId, type: task.type });
      }
    }
    return running;
  }

  /**
   * Cancel a running task
   */
  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.agent.cancel();
    }
  }

  /**
   * Cancel all running tasks
   */
  cancelAll(): void {
    for (const task of this.tasks.values()) {
      task.agent.cancel();
    }
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Execute an agent and handle result
   */
  private async executeAgent(agent: Agent, prompt: string, _taskId: string): Promise<ConversationResult> {
    return agent.execute(prompt);
  }

  /**
   * Handle task completion
   */
  private handleCompletion(taskId: string, result: ConversationResult): TaskResult {
    const taskResult = this.createTaskResult(taskId, result);

    // Store result
    const task = this.tasks.get(taskId);
    if (task) {
      task.result = taskResult;
    }

    // Emit completed event
    this.events.emit('task:completed', { taskId, result: taskResult });

    return taskResult;
  }

  /**
   * Handle task error
   */
  private handleError(taskId: string, error: unknown): TaskResult {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const taskResult: TaskResult = {
      taskId,
      success: false,
      error: errorMessage,
      status: 'failed',
    };

    // Store result
    const task = this.tasks.get(taskId);
    if (task) {
      task.result = taskResult;
    }

    // Emit completed event (with failure)
    this.events.emit('task:completed', { taskId, result: taskResult });

    return taskResult;
  }

  /**
   * Create a TaskResult from ConversationResult
   */
  private createTaskResult(taskId: string, result: ConversationResult): TaskResult {
    return {
      taskId,
      success: result.success,
      data: result.result,
      error: result.error,
      status: result.success ? 'completed' : 'failed',
    };
  }

  /**
   * Generate a unique task ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
