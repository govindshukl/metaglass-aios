/**
 * AIOS Service
 *
 * Main entry point for the AI Operating System.
 * Provides a high-level API for executing conversations and managing tasks.
 *
 * This service is designed to be pluggable - integrators can provide custom
 * implementations for LLM, tools, UI, and events.
 */

import type {
  ConversationResult,
  Todo,
  PlanState,
  TaskParams,
  TaskResult,
  LLMProvider,
  ToolProvider,
  UserInterface,
  EventEmitter,
  Message,
} from './interfaces';
import {
  ConversationEngine,
  type ConversationConfig,
  type ConversationEngineDeps,
} from './kernel/ConversationEngine';
import { TodoManager } from './kernel/TodoManager';
import { TaskSpawner, type AgentFactory } from './kernel/TaskSpawner';
import { PlanManager } from './kernel/PlanManager';
import { DebugHarness, installDebugStub, absorbPendingConfig } from './kernel/DebugHarness';
import { createLogger } from './logger';

const log = createLogger('AIOSService');

// =============================================================================
// PROVIDER INTERFACES
// =============================================================================

/**
 * Memory context for enhanced prompts
 */
export interface MemoryContext {
  success: boolean;
  memories: Array<{ content: string; relevance?: number }>;
  userProfile?: string;
}

/**
 * Provider factories that can be injected
 */
export interface AIOSProviders {
  /** Create an LLM provider */
  createLLMProvider: () => LLMProvider;
  /** Create a lightweight LLM for classification */
  createClassifierLLM?: () => LLMProvider;
  /** Create a tool provider */
  createToolProvider: () => ToolProvider;
  /** Create a filtered tool provider */
  createFilteredToolProvider?: (patterns: string[]) => ToolProvider;
  /** Get the user interface */
  getUserInterface: () => UserInterface;
  /** Get the event emitter */
  getEventEmitter: () => EventEmitter;
  /** Get memory context for a prompt (optional) */
  getMemoryContext?: (
    messages: Message[],
    options: { maxMemories?: number; includeProfile?: boolean }
  ) => Promise<MemoryContext>;
  /** Build enhanced system prompt with memory context (optional) */
  buildEnhancedSystemPrompt?: (
    basePrompt: string,
    memoryContext: MemoryContext,
    userGoal: string
  ) => Promise<string>;
}

// =============================================================================
// STUB IMPLEMENTATIONS
// =============================================================================

/**
 * Stub LLM provider that throws an error
 */
function createStubLLMProvider(): LLMProvider {
  return {
    id: 'stub',
    name: 'Stub LLM',
    chat: async () => {
      throw new Error('No LLM provider configured. Please set up a provider using setProviders().');
    },
    stream: async function* () {
      throw new Error('No LLM provider configured.');
    },
    getCapabilities: () => ({
      toolCalling: false,
      vision: false,
      streaming: false,
      contextWindow: 0,
      maxOutputTokens: 0,
    }),
    isConfigured: () => false,
  };
}

/**
 * Stub tool provider with no tools
 */
function createStubToolProvider(): ToolProvider {
  return {
    id: 'stub-tools',
    list: () => [],
    listByCategory: () => [],
    get: () => undefined,
    has: () => false,
    count: () => 0,
    execute: async () => ({
      success: false,
      error: 'No tool provider configured.',
      observation: 'Error: No tool provider configured.',
    }),
  };
}

/**
 * Stub user interface that logs to console
 */
function createStubUserInterface(): UserInterface {
  return {
    ask: async (request) => {
      log.warn('ask() called but no UI configured:', request.question);
      return 'No response (stub UI)';
    },
    askMultiple: async (questions) => {
      log.warn('askMultiple() called but no UI configured:', questions);
      return {};
    },
    confirm: async (message: string) => {
      log.warn('confirm() called but no UI configured:', message);
      return false;
    },
    notify: (message, type) => {
      log.info(`[${type || 'info'}]`, message);
    },
    isPending: () => false,
    cancel: () => {},
  };
}

/**
 * Stub event emitter
 */
function createStubEventEmitter(): EventEmitter {
  const handlers = new Map<string, Set<Function>>();
  return {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return { unsubscribe: () => handlers.get(event)?.delete(handler) };
    },
    once: (event, handler) => {
      const wrappedHandler = (...args: unknown[]) => {
        handlers.get(event)?.delete(wrappedHandler);
        (handler as Function)(...args);
      };
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(wrappedHandler);
      return { unsubscribe: () => handlers.get(event)?.delete(wrappedHandler) };
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: async (event, payload) => {
      const h = handlers.get(event);
      if (h) for (const handler of h) await (handler as Function)(payload);
    },
    emitSync: (event, payload) => {
      const h = handlers.get(event);
      if (h) for (const handler of h) (handler as Function)(payload);
    },
    hasListeners: (event) => (handlers.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => handlers.get(event)?.size ?? 0,
    removeAllListeners: (event) => (event ? handlers.delete(event) : handlers.clear()),
  };
}

// =============================================================================
// DEFAULT PROVIDERS (can be overridden)
// =============================================================================

let currentProviders: AIOSProviders = {
  createLLMProvider: createStubLLMProvider,
  createToolProvider: createStubToolProvider,
  getUserInterface: createStubUserInterface,
  getEventEmitter: createStubEventEmitter,
};

/**
 * Set the providers for AIOS
 */
export function setProviders(providers: Partial<AIOSProviders>): void {
  currentProviders = { ...currentProviders, ...providers };
  log.info('Providers updated');
}

/**
 * Get current providers
 */
export function getProviders(): AIOSProviders {
  return currentProviders;
}

// =============================================================================
// AIOS SERVICE
// =============================================================================

/**
 * Configuration for AIOS Service
 */
export interface AIOSConfig {
  /** System prompt for conversations */
  systemPrompt?: string;
  /** Default max turns */
  maxTurns?: number;
  /** Default timeout (ms) */
  timeoutMs?: number;
  /** Enable memory context injection (default: true) */
  enableMemoryContext?: boolean;
  /** Include user profile in memory context (default: true) */
  includeProfile?: boolean;
  /** Maximum memories to inject (default: 5) */
  maxMemories?: number;
  /** Require TodoWrite for planning (default: true) */
  requireTodoWrite?: boolean;
  /** Tool patterns to filter available tools (default: all tools) */
  toolPatterns?: string[];
  /** Custom providers (overrides global providers) */
  providers?: Partial<AIOSProviders>;
}

/**
 * AIOS Service
 *
 * Orchestrates all AIOS components:
 * - ConversationEngine for multi-turn conversations
 * - TodoManager for task tracking
 * - TaskSpawner for sub-agent execution
 * - PlanManager for planning mode
 */
export class AIOSService {
  private config: AIOSConfig;
  private providers: AIOSProviders;

  // Core components
  private conversationEngine: ConversationEngine | null = null;
  private todoManager: TodoManager;
  private taskSpawner: TaskSpawner;
  private planManager: PlanManager;

  // Providers - toolProvider is cached, llmProvider is created fresh each time
  private toolProvider: ToolProvider;

  constructor(config: AIOSConfig = {}) {
    log.info('AIOSService constructor starting');
    this.config = config;

    // Merge instance providers with global providers
    this.providers = { ...currentProviders, ...config.providers };

    // Initialize tool provider - use filtered if patterns specified
    if (config.toolPatterns && config.toolPatterns.length > 0 && this.providers.createFilteredToolProvider) {
      log.info('Creating filtered tool provider', { patterns: config.toolPatterns });
      this.toolProvider = this.providers.createFilteredToolProvider(config.toolPatterns);
    } else {
      this.toolProvider = this.providers.createToolProvider();
    }

    // Initialize event system
    log.info('Getting event emitter');
    const events = this.providers.getEventEmitter();

    // Initialize managers
    log.info('Creating TodoManager');
    this.todoManager = new TodoManager(events);
    this.planManager = new PlanManager(events);

    // Create agent factory for sub-agents
    const agentFactory = this.createAgentFactory();
    this.taskSpawner = new TaskSpawner(agentFactory, events);

    // Install debug stub so window.__aiosDebug is available immediately
    if (typeof window !== 'undefined' && window.__aiosDebugEnabled) {
      installDebugStub();
    }

    log.info('AIOSService constructor complete');
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Execute a conversation with the given prompt
   */
  async execute(prompt: string, config?: ConversationConfig): Promise<ConversationResult> {
    // Create fresh conversation engine — use filtered tools if toolPatterns specified
    const toolProvider =
      config?.toolPatterns?.length && this.providers.createFilteredToolProvider
        ? this.providers.createFilteredToolProvider(config.toolPatterns)
        : this.toolProvider;
    this.conversationEngine = this.createConversationEngine(toolProvider);

    // Merge configs
    const mergedConfig: ConversationConfig = {};

    // Add service-level config (only defined values)
    if (this.config.systemPrompt !== undefined) {
      mergedConfig.systemPrompt = this.config.systemPrompt;
    }
    if (this.config.maxTurns !== undefined) {
      mergedConfig.maxTurns = this.config.maxTurns;
    }
    if (this.config.timeoutMs !== undefined) {
      mergedConfig.timeoutMs = this.config.timeoutMs;
    }

    // Add call-specific config (only defined values)
    if (config) {
      if (config.systemPrompt !== undefined) {
        mergedConfig.systemPrompt = config.systemPrompt;
      }
      if (config.maxTurns !== undefined) {
        mergedConfig.maxTurns = config.maxTurns;
      }
      if (config.timeoutMs !== undefined) {
        mergedConfig.timeoutMs = config.timeoutMs;
      }
      if (config.signal !== undefined) {
        mergedConfig.signal = config.signal;
      }
      if (config.maxTokensPerTurn !== undefined) {
        mergedConfig.maxTokensPerTurn = config.maxTokensPerTurn;
      }
      if (config.requireTodoWrite !== undefined) {
        mergedConfig.requireTodoWrite = config.requireTodoWrite;
      }
      if (config.goalId !== undefined) {
        mergedConfig.goalId = config.goalId;
      }
      if (config.goalName !== undefined) {
        mergedConfig.goalName = config.goalName;
      }
      if (config.saveToGoalMemory !== undefined) {
        mergedConfig.saveToGoalMemory = config.saveToGoalMemory;
      }
    }

    // Apply service-level overrides for TodoWrite
    if (this.config.requireTodoWrite !== undefined && mergedConfig.requireTodoWrite === undefined) {
      mergedConfig.requireTodoWrite = this.config.requireTodoWrite;
    }

    // Inject memory context if available
    const enableMemoryContext = this.config.enableMemoryContext !== false;
    if (enableMemoryContext && this.providers.getMemoryContext && this.providers.buildEnhancedSystemPrompt) {
      try {
        log.info('Fetching memory context for conversation');
        const memoryContext = await this.providers.getMemoryContext(
          [{ role: 'user', content: prompt }],
          {
            maxMemories: this.config.maxMemories ?? 5,
            includeProfile: this.config.includeProfile !== false,
          }
        );

        if (memoryContext.success) {
          const basePrompt = mergedConfig.systemPrompt || '';
          mergedConfig.systemPrompt = await this.providers.buildEnhancedSystemPrompt(
            basePrompt,
            memoryContext,
            prompt
          );
          log.info('Enhanced system prompt built', {
            memoryCount: memoryContext.memories.length,
            hasProfile: !!memoryContext.userProfile,
          });
        }
      } catch (error) {
        log.warn('Failed to build enhanced system prompt', { error });
      }
    }

    // Attach debug harness if enabled
    if (typeof window !== 'undefined' && window.__aiosDebugEnabled) {
      installDebugStub();

      const harness = new DebugHarness('pending', prompt, {
        maxTurns: mergedConfig.maxTurns,
        timeoutMs: mergedConfig.timeoutMs,
        requireTodoWrite: mergedConfig.requireTodoWrite,
        goalId: mergedConfig.goalId,
      });

      absorbPendingConfig(harness);
      this.conversationEngine.setDebugHarness(harness);
      window.__aiosDebug = harness.getConsoleAPI();
      log.info('Debug harness attached', { tracePath: harness.getConsoleAPI().getTracePath() });
    }

    // Execute
    const result = await this.conversationEngine.execute(prompt, mergedConfig);
    return result;
  }

  /**
   * Cancel the current conversation
   */
  cancel(): void {
    if (this.conversationEngine) {
      this.conversationEngine.cancel();
    }
    this.taskSpawner.cancelAll();
  }

  /**
   * Check if a conversation is running
   */
  isRunning(): boolean {
    return this.conversationEngine?.isRunning() ?? false;
  }

  // ===========================================================================
  // TODO MANAGEMENT
  // ===========================================================================

  getTodos(): Todo[] {
    return this.todoManager.getTodos();
  }

  getProgress(): number {
    return this.todoManager.getProgress();
  }

  onTodosChange(callback: (todos: Todo[]) => void): () => void {
    log.info('onTodosChange called - subscribing to TodoManager');
    return this.todoManager.subscribe(callback);
  }

  // ===========================================================================
  // PLANNING MODE
  // ===========================================================================

  isPlanning(): boolean {
    return this.planManager.isPlanning();
  }

  getPlanState(): PlanState {
    return this.planManager.getState();
  }

  approvePlan(): void {
    this.planManager.approve();
  }

  rejectPlan(): void {
    this.planManager.reject();
  }

  onPlanChange(callback: (state: PlanState) => void): () => void {
    return this.planManager.subscribe(callback);
  }

  // ===========================================================================
  // CONTRACT APPROVAL
  // ===========================================================================

  isPaused(): boolean {
    return this.conversationEngine?.isPaused() ?? false;
  }

  async resumeWithApproval(contractPath: string): Promise<ConversationResult> {
    if (!this.conversationEngine) {
      throw new Error('No conversation to resume');
    }
    return this.conversationEngine.resumeWithApproval(contractPath);
  }

  async resumeWithChanges(feedback: string): Promise<ConversationResult> {
    if (!this.conversationEngine) {
      throw new Error('No conversation to resume');
    }
    return this.conversationEngine.resumeWithChanges(feedback);
  }

  async rejectContract(reason?: string): Promise<ConversationResult> {
    if (!this.conversationEngine) {
      throw new Error('No conversation to reject');
    }
    return this.conversationEngine.rejectContract(reason);
  }

  // ===========================================================================
  // SUB-AGENTS
  // ===========================================================================

  async spawnTask(params: TaskParams): Promise<TaskResult> {
    return this.taskSpawner.spawn(params);
  }

  isTaskRunning(taskId: string): boolean {
    return this.taskSpawner.isRunning(taskId);
  }

  cancelTask(taskId: string): void {
    this.taskSpawner.cancel(taskId);
  }

  // ===========================================================================
  // PROVIDER ACCESS
  // ===========================================================================

  isConfigured(): boolean {
    const llmProvider = this.providers.createLLMProvider();
    return llmProvider.isConfigured();
  }

  getToolProvider(): ToolProvider {
    return this.toolProvider;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private createConversationEngine(toolProviderOverride?: ToolProvider): ConversationEngine {
    const llmProvider = this.providers.createLLMProvider();
    const classifierLlm = this.providers.createClassifierLLM?.();

    const deps: ConversationEngineDeps = {
      llm: llmProvider,
      tools: toolProviderOverride ?? this.toolProvider,
      ui: this.providers.getUserInterface(),
      events: this.providers.getEventEmitter(),
      classifierLlm,
    };

    return new ConversationEngine(deps);
  }

  private createAgentFactory(): AgentFactory {
    return {
      create: (config) => {
        const type = config.type;

        // Use classifier LLM for Explore agents (lightweight)
        const llm =
          type === 'Explore' && this.providers.createClassifierLLM
            ? this.providers.createClassifierLLM()
            : this.providers.createLLMProvider();

        const tools = this.providers.createToolProvider();
        const classifierLlm = this.providers.createClassifierLLM?.();

        const deps: ConversationEngineDeps = {
          llm,
          tools,
          ui: this.providers.getUserInterface(),
          events: this.providers.getEventEmitter(),
          classifierLlm,
        };

        const engine = new ConversationEngine(deps);

        return {
          execute: (prompt: string) =>
            engine.execute(prompt, {
              maxTurns: type === 'Explore' ? 10 : 50,
              timeoutMs: type === 'Explore' ? 120000 : 600000,
            }),
          cancel: () => engine.cancel(),
          isRunning: () => engine.isRunning(),
        };
      },
    };
  }
}

// =============================================================================
// SINGLETON & FACTORY
// =============================================================================

let defaultInstance: AIOSService | null = null;

export function getAIOSService(): AIOSService {
  if (!defaultInstance) {
    log.info('Creating new AIOSService singleton instance');
    defaultInstance = new AIOSService();
  }
  return defaultInstance;
}

export function createAIOSService(config?: AIOSConfig): AIOSService {
  return new AIOSService(config);
}

export function resetAIOSService(): void {
  if (defaultInstance) {
    defaultInstance.cancel();
    defaultInstance = null;
  }
}
