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
    allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
    systemPromptSuffix: 'You are a fast exploration agent. Only use read-only tools.',
  },
  execute: {
    defaultModel: 'sonnet',
    allowedTools: '*',
    systemPromptSuffix: 'You are an execution agent with full access.',
  },

  // Legacy uppercase names (for backward compatibility)
  Explore: {
    defaultModel: 'haiku',
    allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
    systemPromptSuffix: 'You are a fast exploration agent. Only use read-only tools.',
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
 */
export class TaskSpawner {
  private agentFactory: AgentFactory;
  private events: EventEmitter;
  private tasks: Map<string, RunningTask> = new Map();

  constructor(agentFactory: AgentFactory, events: EventEmitter) {
    this.agentFactory = agentFactory;
    this.events = events;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Spawn a new task
   */
  async spawn(params: TaskParams): Promise<TaskResult> {
    const taskId = this.generateTaskId();
    const typeConfig = AGENT_TYPE_CONFIGS[params.subagentType];

    // Build agent config
    const agentConfig: AgentConfig = {
      type: params.subagentType,
      model: params.model ?? typeConfig.defaultModel,
      allowedTools: typeConfig.allowedTools,
      systemPrompt: typeConfig.systemPromptSuffix,
      resumeFrom: params.resume,
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
