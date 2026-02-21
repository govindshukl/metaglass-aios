/**
 * ConversationEngine - Core conversation loop for AIOS
 *
 * Implements a multi-turn conversation pattern inspired by Claude Code.
 * Unlike ReAct, this uses native LLM tool calling without explicit markers.
 */

import type {
  LLMProvider,
  ToolProvider,
  UserInterface,
  EventEmitter,
  Message,
  ToolCall,
  ToolResult,
  ConversationResult,
  ConversationStatus,
  Todo,
  Question,
  CompressionConfig,
  RetryConfig,
} from '../interfaces';
import { createLogger } from '../logger';
import { ContextCompressor } from './ContextCompressor';
import { ToolRetryPolicy } from './ToolRetryPolicy';
import { ConversationStore, conversationStore } from './ConversationStore';
import { filterExemptTools, filterActionTools } from './ToolExemptions';
import { classifyIntent, canSkipTodoWrite, needsClarification, type ClassificationResult, type KernelLLMClassifyFn } from './IntentClassifier';
import { DecisionLogger, type DecisionLog } from './DecisionLogger';
import { getToolMetadata } from './ToolMetadataRegistry';
import { type CheckpointConfig } from './CheckpointManager';
import { getTodoWriteGuidance } from './TodoWriteGuidance';
import { goalContextProvider } from '../providers/GoalContextProvider';
import { invoke } from '../backend';
import type { DebugHarness } from './DebugHarness';

const log = createLogger('ConversationEngine');

// =============================================================================
// PAUSE TOOLS - These tools trigger full conversation pause requiring manual resume
// =============================================================================
// Only submit_contract pauses the conversation for user approval.
// agent_ask_user and agent_confirm block within the turn but continue afterward.
const PAUSE_TOOLS = new Set(['submit_contract']);

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration for conversation execution
 */
export interface ConversationConfig {
  /** Maximum turns before stopping (default: 50) */
  maxTurns?: number;
  /** Timeout in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** System prompt to prepend */
  systemPrompt?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Maximum tokens per turn */
  maxTokensPerTurn?: number;
  /** Require TodoWrite for planning (default: true, false for simple queries) */
  requireTodoWrite?: boolean;
  /** Context compression settings */
  compression?: CompressionConfig;
  /** Retry policy settings for tool execution */
  retry?: RetryConfig;
  /** Checkpoint configuration for "shall I proceed?" pattern */
  checkpoint?: CheckpointConfig;
  /** Goal context for this conversation */
  goalId?: string;
  /** Goal name (for display) */
  goalName?: string;
  /** Whether to save conversation session to goal memory on completion */
  saveToGoalMemory?: boolean;
  /** Tool patterns to restrict available tools for this conversation (e.g., ['vault_create_note', 'agent_ask_user']) */
  toolPatterns?: string[];
  /** Callback invoked when goal session starts */
  onSessionStart?: (context: GoalSessionStartContext) => void | Promise<void>;
  /** Callback invoked when goal session completes */
  onSessionComplete?: (context: GoalSessionCompleteContext) => void | Promise<void>;
}

/**
 * Context passed to onSessionStart callback
 */
export interface GoalSessionStartContext {
  goalId: string;
  goalName: string;
  conversationId: string;
  timestamp: number;
}

/**
 * Context passed to onSessionComplete callback
 */
export interface GoalSessionCompleteContext {
  goalId: string;
  goalName: string;
  conversationId: string;
  success: boolean;
  cancelled?: boolean;
  result?: string;
  error?: string;
  turns: number;
  durationMs: number;
  summary: GoalSessionSummary;
}

/**
 * Summary of the goal session
 */
export interface GoalSessionSummary {
  toolsExecuted: string[];
  outputPaths: string[];
  tasksCreated: number;
  tasksCompleted: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<Omit<ConversationConfig, 'signal' | 'systemPrompt' | 'compression' | 'retry' | 'checkpoint' | 'goalId' | 'goalName' | 'saveToGoalMemory' | 'onSessionStart' | 'onSessionComplete' | 'toolPatterns'>> = {
  maxTurns: 50,
  timeoutMs: 600000, // 10 minutes (increased from 5 min to handle slow LLM responses)
  maxTokensPerTurn: 4096,
  requireTodoWrite: true,
};

// =============================================================================
// CONVERSATION ENGINE
// =============================================================================

/**
 * Dependencies for ConversationEngine
 */
export interface ConversationEngineDeps {
  llm: LLMProvider;
  tools: ToolProvider;
  ui: UserInterface;
  events: EventEmitter;
  /** Optional lightweight LLM for intent classification (e.g., Haiku) */
  classifierLlm?: LLMProvider;
}

/**
 * ConversationEngine class
 *
 * Implements a multi-turn conversation loop that:
 * 1. Sends user message to LLM
 * 2. Executes any tool calls
 * 3. Adds tool results to history
 * 4. Repeats until LLM stops or limit reached
 */
export class ConversationEngine {
  private llm: LLMProvider;
  private tools: ToolProvider;
  private ui: UserInterface;
  private events: EventEmitter;

  private history: Message[] = [];
  private status: ConversationStatus = 'idle';
  private abortController: AbortController | null = null;
  private conversationId: string = '';

  // TodoWrite enforcement state
  private hasPlan: boolean = false;
  private planEnforcementAttempts: number = 0;
  private readonly MAX_PLAN_ENFORCEMENT_ATTEMPTS = 2;
  private originalGoal: string = '';

  // Current todos for task tracking
  private currentTodos: Todo[] = [];

  // Context compression
  private contextCompressor: ContextCompressor;

  // Tool retry policy
  private retryPolicy: ToolRetryPolicy;

  // Conversation persistence
  private store: ConversationStore;
  private currentTurn: number = 0;
  private autoCheckpoint: boolean = false;

  // Intent classification (Phase 7)
  private intentClassification: ClassificationResult | null = null;

  // Decision logger for observability
  private decisionLogger: DecisionLogger;

  // Track tool results for session summary
  private toolResults: Array<{ toolName: string; success: boolean; output?: string; error?: string }> = [];

  // Track output paths for session summary
  private outputPaths: string[] = [];

  // Track if output has been produced (for TodoWrite guidance decay)
  private hasProducedOutput: boolean = false;

  // Store last config for resume functionality
  private lastConfig: { maxTurns: number; timeoutMs: number; maxTokensPerTurn: number; requireTodoWrite: boolean; systemPrompt?: string; signal?: AbortSignal; saveToGoalMemory?: boolean; goalId?: string; compression?: CompressionConfig } | null = null;

  // Debug harness (optional — zero overhead when not attached)
  private debugHarness: DebugHarness | null = null;

  // LLM function for intent classification (optional — uses regex fallback if not provided)
  private llmClassifyFn: KernelLLMClassifyFn | undefined;

  constructor(deps: ConversationEngineDeps) {
    this.llm = deps.llm;
    this.tools = deps.tools;
    this.ui = deps.ui;
    this.events = deps.events;

    // Set up classifier LLM function if a dedicated classifier provider is given
    if (deps.classifierLlm) {
      this.llmClassifyFn = async (messages, options) => {
        const response = await deps.classifierLlm!.chat(messages, {
          maxTokens: options?.maxTokens ?? 256,
          temperature: options?.temperature ?? 0.0,
        });
        return { content: response.content };
      };
    }

    // Initialize context compressor
    this.contextCompressor = new ContextCompressor(this.llm);

    // Initialize retry policy for tool execution
    this.retryPolicy = new ToolRetryPolicy();

    // Use default conversation store
    this.store = conversationStore;

    // Initialize decision logger for observability
    this.decisionLogger = new DecisionLogger();
  }

  /**
   * Attach a debug harness for structured trace logging and step-mode.
   * When attached, every phase of the conversation loop emits trace entries.
   */
  setDebugHarness(harness: DebugHarness): void {
    this.debugHarness = harness;
    // Wire up live state inspection refs
    harness.setHistoryRef(() => [...this.history]);
    harness.setTodosRef(() => [...this.currentTodos]);
    harness.setDecisionsRef(() => this.decisionLogger.getDecisions());
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Execute a conversation with the given prompt
   */
  async execute(prompt: string, config?: ConversationConfig): Promise<ConversationResult> {
    log.info('Execute called', { promptLength: prompt.length, hasConfig: !!config });

    // Check if already running
    if (this.isRunning()) {
      log.warn('Conversation already running');
      return this.createResult(false, 'Conversation already running', 0);
    }

    // Initialize - merge with defaults, but only use defined values from config
    const cfg = {
      ...DEFAULT_CONFIG,
      ...(config?.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      ...(config?.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config?.maxTokensPerTurn !== undefined ? { maxTokensPerTurn: config.maxTokensPerTurn } : {}),
      ...(config?.requireTodoWrite !== undefined ? { requireTodoWrite: config.requireTodoWrite } : {}),
      // These don't have defaults in DEFAULT_CONFIG
      systemPrompt: config?.systemPrompt,
      signal: config?.signal,
      // Additional fields for resume
      saveToGoalMemory: config?.saveToGoalMemory,
      goalId: config?.goalId,
      compression: config?.compression,
    };
    log.info('Merged config', { maxTurns: cfg.maxTurns, timeoutMs: cfg.timeoutMs, requireTodoWrite: cfg.requireTodoWrite });

    // Store config for resume functionality
    this.lastConfig = cfg;

    this.history = [];
    this.status = 'running';
    this.abortController = new AbortController();
    this.conversationId = this.generateId();

    // Sync real conversation ID to the debug harness (it was created with a placeholder)
    this.debugHarness?.setConversationId(this.conversationId);

    const startTime = Date.now();

    // Emit started event
    await this.events.emit('conversation:started', { conversationId: this.conversationId });

    // Trace: init phase
    this.debugHarness?.setGoal(prompt);
    this.debugHarness?.trace('init', 'conversation-started', {
      conversationId: this.conversationId,
      promptLength: prompt.length,
      prompt: prompt,
      config: { maxTurns: cfg.maxTurns, timeoutMs: cfg.timeoutMs, requireTodoWrite: cfg.requireTodoWrite },
      hasSystemPrompt: !!cfg.systemPrompt,
      hasGoalId: !!config?.goalId,
      goalId: config?.goalId,
    });

    // Activate goal context if provided
    if (config?.goalId) {
      goalContextProvider.setActiveGoal(config.goalId, config.goalName || 'Active Goal');
      log.info('Activated goal context', { goalId: config.goalId, goalName: config.goalName });

      // Emit goal activation event (using type assertion for custom events)
      await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
        'conversation:goal-activated',
        {
          conversationId: this.conversationId,
          goalId: config.goalId,
          goalName: config.goalName || 'Active Goal',
        }
      );

      // Emit goal session started event
      const sessionStartContext: GoalSessionStartContext = {
        goalId: config.goalId,
        goalName: config.goalName || 'Active Goal',
        conversationId: this.conversationId,
        timestamp: startTime,
      };

      await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
        'goal:session-started',
        sessionStartContext
      );

      // Call onSessionStart callback if provided
      if (config.onSessionStart) {
        try {
          await config.onSessionStart(sessionStartContext);
        } catch (error) {
          log.warn('onSessionStart callback error', { error });
        }
      }
    }

    // Add system prompt if provided
    if (cfg.systemPrompt) {
      this.history.push({ role: 'system', content: cfg.systemPrompt });
      log.debug('Added system prompt', { length: cfg.systemPrompt.length });
    } else {
      log.warn('No system prompt provided - LLM may not use tools effectively');
    }

    // Add user message
    this.history.push({ role: 'user', content: prompt });

    // Store original goal for session summary
    this.originalGoal = prompt;

    // Classify intent to determine complexity and TodoWrite requirement (Phase 7)
    // Uses two-phase approach: regex fast path → LLM classification (if available)
    this.intentClassification = await classifyIntent(prompt, this.history, this.llmClassifyFn);
    log.info('Intent classified', {
      complexity: this.intentClassification.complexity,
      confidence: this.intentClassification.confidence,
      suggestedActions: this.intentClassification.suggestedActions,
    });

    // Emit intent classification event for UI/debugging
    await this.events.emit('conversation:intent-classified', {
      classification: this.intentClassification,
      goal: prompt,
    });

    // Trace: classification phase
    this.debugHarness?.trace('classification', 'intent-classified', {
      complexity: this.intentClassification.complexity,
      confidence: this.intentClassification.confidence,
      suggestedActions: this.intentClassification.suggestedActions,
      reasoning: this.intentClassification.reasoning,
      todoWriteRequired: cfg.requireTodoWrite,
    });

    // Automatically disable TodoWrite requirement for simple queries
    if (canSkipTodoWrite(this.intentClassification)) {
      log.info('Skipping TodoWrite requirement due to task complexity', {
        complexity: this.intentClassification.complexity,
      });
      cfg.requireTodoWrite = false;

      this.debugHarness?.trace('classification', 'todowrite-skipped', {
        complexity: this.intentClassification.complexity,
        reason: 'Trivial or simple query — no plan required',
      });
    }

    // For tasks that need clarification, inject a reminder to use agent_ask_user
    // This ensures the LLM uses structured questions instead of plain text
    // Note: Using 'user' role because Anthropic API requires all system messages at the start
    if (needsClarification(this.intentClassification)) {
      log.info('Task needs clarification - injecting agent_ask_user enforcement');

      // Add a user-role message to enforce structured question usage
      // (Cannot use 'system' role here as Anthropic requires system messages before user messages)
      this.history.push({
        role: 'user',
        content: `[System Instruction] IMPORTANT: This request requires clarifying questions. You MUST use the agent_ask_user tool with structured questions and options. DO NOT ask questions in plain text. Call agent_ask_user now with 2-4 relevant questions before proceeding.`
      });
    }

    // Reset enforcement state for new conversation
    this.hasPlan = false;
    this.planEnforcementAttempts = 0;
    this.currentTodos = [];
    this.currentTurn = 0;  // Reset turn counter for new conversations
    this.toolResults = [];
    this.outputPaths = [];
    this.hasProducedOutput = false;
    this.decisionLogger.clear();

    // Update retry policy if config provided
    if (config?.retry) {
      this.retryPolicy.updateConfig(config.retry);
    }

    // Update compressor config if provided
    if (config?.compression) {
      this.contextCompressor.updateConfig(config.compression);
    }

    try {
      // Run the conversation loop
      const result = await this.runLoop(cfg, startTime);

      // Emit goal session completed event on success
      if (config?.goalId) {
        await this.emitGoalSessionCompleted(config, startTime, result);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.events.emit('conversation:failed', { error: errorMessage });

      this.debugHarness?.trace('termination', 'conversation-error', {
        error: errorMessage,
        turn: this.currentTurn,
        durationMs: Date.now() - startTime,
      });

      const errorResult = this.createResult(false, errorMessage, Date.now() - startTime);

      // Emit goal session completed event on error
      if (config?.goalId) {
        await this.emitGoalSessionCompleted(config, startTime, errorResult);
      }

      return errorResult;
    } finally {
      // Finalize debug harness (flush traces, update status)
      // Cast needed because TS narrows status in finally block, but it may have been
      // set to completed/failed/cancelled/paused by runLoop before reaching here
      await this.debugHarness?.finalize(this.status as ConversationStatus);

      // Clear goal context if this conversation was goal-bound
      if (config?.goalId) {
        goalContextProvider.clearActiveGoal();
      }
      this.status = 'idle';
      this.abortController = null;
    }
  }

  /**
   * Emit goal session completed event and call callback
   */
  private async emitGoalSessionCompleted(
    config: ConversationConfig,
    _startTime: number,
    result: ConversationResult
  ): Promise<void> {
    const sessionSummary: GoalSessionSummary = {
      toolsExecuted: this.toolResults.map(r => r.toolName),
      outputPaths: this.outputPaths,
      tasksCreated: this.currentTodos.length,
      tasksCompleted: this.currentTodos.filter(t => t.status === 'completed').length,
    };

    const sessionCompleteContext: GoalSessionCompleteContext = {
      goalId: config.goalId!,
      goalName: config.goalName || 'Active Goal',
      conversationId: this.conversationId,
      success: result.success,
      cancelled: result.status === 'cancelled',
      result: result.result,
      error: result.error,
      turns: result.turns,
      durationMs: result.durationMs,
      summary: sessionSummary,
    };

    await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
      'goal:session-completed',
      sessionCompleteContext
    );

    // Call onSessionComplete callback if provided
    if (config.onSessionComplete) {
      try {
        await config.onSessionComplete(sessionCompleteContext);
      } catch (error) {
        log.warn('onSessionComplete callback error', { error });
      }
    }
  }

  /**
   * Cancel the current conversation
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.status = 'cancelled';
    }
  }

  /**
   * Check if conversation is running
   */
  isRunning(): boolean {
    return this.status === 'running' || this.status === 'waiting_for_user';
  }

  /**
   * Check if conversation is paused (waiting for contract approval)
   */
  isPaused(): boolean {
    return this.status === 'paused';
  }

  /**
   * Get current conversation status
   */
  getStatus(): ConversationStatus {
    return this.status;
  }

  /**
   * Get decision log for debugging/observability
   */
  getDecisionLog(): DecisionLog[] {
    return this.decisionLogger.getDecisions();
  }

  /**
   * Get decision log summary as a string
   */
  getDecisionSummary(): string {
    return this.decisionLogger.getDecisionsSummary();
  }

  // ===========================================================================
  // CONTRACT RESUME METHODS
  // ===========================================================================

  /**
   * Resume conversation after contract approval.
   * Adds approval confirmation to history and continues execution.
   */
  async resumeWithApproval(contractPath: string): Promise<ConversationResult> {
    if (this.status !== 'paused') {
      return this.createResult(false, 'Cannot resume: conversation is not paused', 0, this.status);
    }

    log.info('Resuming with approval', { contractPath, conversationId: this.conversationId });

    this.debugHarness?.trace('resume', 'contract-approved', {
      contractPath,
      conversationId: this.conversationId,
    });

    // Emit approval event
    await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
      'contract:approved',
      { goalId: this.lastConfig?.goalId, contractPath }
    );

    // Add confirmation message to history
    this.history.push({
      role: 'user',
      content: `[Contract Approved] The contract at ${contractPath} has been approved. You may now proceed with execution.`,
    });

    // Resume the loop
    this.status = 'running';
    const startTime = Date.now();

    if (!this.lastConfig) {
      return this.createResult(false, 'No configuration found for resume', 0, 'failed');
    }

    return this.runLoop(this.lastConfig, startTime);
  }

  /**
   * Resume conversation with requested changes to the contract.
   * Adds feedback to history and allows agent to revise.
   */
  async resumeWithChanges(feedback: string): Promise<ConversationResult> {
    if (this.status !== 'paused') {
      return this.createResult(false, 'Cannot resume: conversation is not paused', 0, this.status);
    }

    log.info('Resuming with changes requested', { feedback, conversationId: this.conversationId });

    this.debugHarness?.trace('resume', 'changes-requested', {
      feedbackPreview: feedback.substring(0, 300),
      conversationId: this.conversationId,
    });

    // Emit changes-requested event
    await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
      'contract:changes-requested',
      { goalId: this.lastConfig?.goalId, feedback }
    );

    // Add feedback message to history
    this.history.push({
      role: 'user',
      content: `[Changes Requested] Please revise the contract with the following feedback:\n\n${feedback}\n\nAfter making changes, save the updated contract and call submit_contract again.`,
    });

    // Resume the loop
    this.status = 'running';
    const startTime = Date.now();

    if (!this.lastConfig) {
      return this.createResult(false, 'No configuration found for resume', 0, 'failed');
    }

    return this.runLoop(this.lastConfig, startTime);
  }

  /**
   * Reject the contract and end the conversation.
   */
  async rejectContract(reason?: string): Promise<ConversationResult> {
    if (this.status !== 'paused') {
      return this.createResult(false, 'Cannot reject: conversation is not paused', 0, this.status);
    }

    log.info('Contract rejected', { reason, conversationId: this.conversationId });

    this.debugHarness?.trace('resume', 'contract-rejected', {
      reason,
      conversationId: this.conversationId,
    });

    // Emit rejected event
    await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
      'contract:rejected',
      { goalId: this.lastConfig?.goalId, reason }
    );

    // Mark as cancelled
    this.status = 'cancelled';
    await this.events.emit('conversation:cancelled', { conversationId: this.conversationId });

    return this.createResult(
      false,
      reason ? `Contract rejected: ${reason}` : 'Contract rejected by user',
      0,
      'cancelled'
    );
  }

  // ===========================================================================
  // CONVERSATION LOOP
  // ===========================================================================

  /**
   * Main conversation loop
   */
  private async runLoop(config: { maxTurns: number; timeoutMs: number; maxTokensPerTurn: number; requireTodoWrite: boolean; systemPrompt?: string; signal?: AbortSignal; saveToGoalMemory?: boolean; goalId?: string; compression?: CompressionConfig }, startTime: number): Promise<ConversationResult> {
    // Use class-level turn tracking for checkpoint/resume support
    // If resuming, currentTurn will already be set from the snapshot

    log.info('Starting conversation loop', { maxTurns: config.maxTurns, timeoutMs: config.timeoutMs, startTurn: this.currentTurn });

    while (this.currentTurn < config.maxTurns) {
      // Check cancellation
      if (this.abortController?.signal.aborted || config.signal?.aborted) {
        this.debugHarness?.trace('termination', 'cancelled', {
          turn: this.currentTurn,
          durationMs: Date.now() - startTime,
        });
        this.status = 'cancelled';
        await this.events.emit('conversation:cancelled', { conversationId: this.conversationId });
        return this.createResult(false, 'Conversation cancelled', Date.now() - startTime, 'cancelled');
      }

      // Check timeout
      if (Date.now() - startTime > config.timeoutMs) {
        this.status = 'failed';
        return this.createResult(false, 'Conversation timeout', Date.now() - startTime, 'failed');
      }

      this.currentTurn++;

      // Clean up stale injected reminders from previous turns to avoid
      // accumulating duplicate [System Reminder] and [Active Tasks] messages
      this.history = this.history.filter(m =>
        !(m.role === 'user' && (
          m.content.startsWith('[System Reminder]') ||
          m.content.startsWith('[Active Tasks]')
        ))
      );

      log.info('Turn', { turn: this.currentTurn, historyLength: this.history.length });

      // Trace: turn start
      this.debugHarness?.setTurn(this.currentTurn);
      this.debugHarness?.trace('turn-start', 'turn-begin', {
        turn: this.currentTurn,
        historyLength: this.history.length,
        hasPlan: this.hasPlan,
        todosCount: this.currentTodos.length,
        activeTodos: this.currentTodos.filter(t => t.status !== 'completed').map(t => t.content),
        hasProducedOutput: this.hasProducedOutput,
      });

      // =========================================================================
      // TODOWRITE GRADIENT GUIDANCE (Soft prompting, not hard blocking)
      // =========================================================================
      if (config.requireTodoWrite && !this.hasPlan && this.intentClassification) {
        const guidance = getTodoWriteGuidance({
          complexity: this.intentClassification.complexity,
          turnNumber: this.currentTurn,
          hasProducedOutput: this.hasProducedOutput,
        });

        if (guidance.level !== 'none' && guidance.message) {
          // Log the guidance decision
          this.decisionLogger.log({
            turn: this.currentTurn,
            decision: 'todowrite-guidance',
            reason: `Complexity: ${this.intentClassification.complexity}, Level: ${guidance.level}`,
            inputs: {
              complexity: this.intentClassification.complexity,
              turnNumber: this.currentTurn,
              hasProducedOutput: this.hasProducedOutput,
            },
            outcome: guidance.level,
          });

          // Inject guidance as a user-role reminder (soft prompting)
          // Note: Using 'user' role because Anthropic API requires all system messages at the start
          this.history.push({
            role: 'user',
            content: `[System Reminder] ${guidance.message}`,
          });

          log.info('TodoWrite guidance injected', {
            level: guidance.level,
            turn: this.currentTurn,
          });

          this.debugHarness?.trace('turn-start', 'todowrite-guidance-injected', {
            level: guidance.level,
            complexity: this.intentClassification!.complexity,
            message: guidance.message,
          });
        }
      }

      // =========================================================================
      // INJECT ACTIVE TODOS AS REMINDER (No LLM call - just append to history)
      // =========================================================================
      if (this.currentTodos.length > 0) {
        const activeTodos = this.currentTodos
          .filter(t => t.status !== 'completed')
          .map(t => `- [${t.status}] ${t.content}`)
          .join('\n');

        if (activeTodos) {
          this.history.push({
            role: 'user',
            content: `[Active Tasks]\n${activeTodos}`,
          });
        }
      }

      // Get LLM response with timeout
      let response;
      try {
        const remainingTime = config.timeoutMs - (Date.now() - startTime);
        if (remainingTime <= 0) {
          this.status = 'failed';
          log.warn('Timeout before LLM call', { turn: this.currentTurn });
          return this.createResult(false, 'Conversation timeout', Date.now() - startTime, 'failed');
        }

        const toolsList = this.tools.list();

        // DEBUG: Log prompt being sent to LLM
        log.debug('='.repeat(80));
        log.debug(`TURN ${this.currentTurn} - SENDING TO LLM`);
        log.debug('='.repeat(80));
        log.debug('Message History:', {
          messageCount: this.history.length,
          messages: this.history.map((msg, idx) => ({
            index: idx,
            role: msg.role,
            contentLength: msg.content?.length ?? 0,
            contentPreview: msg.content ? msg.content.substring(0, 200) : '(no content)',
            hasToolCalls: !!msg.toolCalls,
            toolCallCount: msg.toolCalls?.length ?? 0,
            toolNames: msg.toolCalls?.map(tc => tc.name),
          }))
        });
        log.debug('Available Tools:', { count: toolsList.length, tools: toolsList.map(t => t.name) });
        log.debug('Full Prompt:', { history: this.history });
        log.debug('='.repeat(80));

        // Apply context compression if configured
        let messagesToSend = this.history;
        if (config.compression) {
          this.contextCompressor.updateConfig(config.compression);
        }
        const compressionResult = await this.contextCompressor.compress(
          this.history,
          config.systemPrompt
        );
        if (compressionResult.wasCompressed) {
          messagesToSend = compressionResult.messages;
          log.info('Context compressed before LLM call', {
            originalTokens: compressionResult.originalTokens,
            compressedTokens: compressionResult.compressedTokens,
            summarizedTurns: compressionResult.summarizedTurns,
          });
        }

        // Trace: LLM request
        this.debugHarness?.trace('llm-request', 'sending-to-llm', {
          turn: this.currentTurn,
          messageCount: messagesToSend.length,
          toolCount: toolsList.length,
          toolNames: toolsList.map(t => t.name),
          compressed: compressionResult.wasCompressed,
          messages: messagesToSend.map((m, i) => ({
            idx: i,
            role: m.role,
            len: m.content?.length ?? 0,
            preview: m.content?.substring(0, 120),
            toolCalls: m.toolCalls?.map(tc => tc.name),
          })),
        });

        const llmPromise = this.llm.chat(messagesToSend, {
          tools: toolsList,
          maxTokens: config.maxTokensPerTurn,
          signal: this.abortController?.signal,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            const error = new Error('Conversation timeout');
            error.name = 'TimeoutError';
            reject(error);
          }, remainingTime);
        });

        response = await Promise.race([llmPromise, timeoutPromise]);

        // DEBUG: Log response received from LLM
        log.debug('='.repeat(80));
        log.debug(`TURN ${this.currentTurn} - RECEIVED FROM LLM`);
        log.debug('='.repeat(80));
        log.debug('Response Summary:', {
          contentLength: response.content?.length ?? 0,
          hasToolCalls: !!response.toolCalls,
          toolCallCount: response.toolCalls?.length ?? 0,
          finishReason: response.finishReason,
        });
        log.debug('Content:', { content: response.content });
        if (response.toolCalls && response.toolCalls.length > 0) {
          log.debug('Tool Calls:', {
            toolCalls: response.toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              params: tc.params,
            }))
          });
        }
        log.debug('Full Response:', { response });
        log.debug('='.repeat(80));

        // Trace: LLM response
        this.debugHarness?.trace('llm-response', 'received-from-llm', {
          turn: this.currentTurn,
          contentLength: response.content?.length ?? 0,
          contentPreview: response.content?.substring(0, 200),
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls?.length ?? 0,
          toolCalls: response.toolCalls?.map(tc => ({ name: tc.name, paramKeys: Object.keys(tc.params) })),
          usage: response.usage,
        });

      } catch (error) {
        log.error('LLM call failed', { turn: this.currentTurn, error: (error as Error).message, name: (error as Error).name });

        this.debugHarness?.trace('error', 'llm-call-failed', {
          turn: this.currentTurn,
          errorName: (error as Error).name,
          errorMessage: (error as Error).message,
        });

        if ((error as Error).name === 'AbortError') {
          this.status = 'cancelled';
          return this.createResult(false, 'Conversation cancelled', Date.now() - startTime, 'cancelled');
        }
        if ((error as Error).name === 'TimeoutError') {
          this.status = 'failed';
          return this.createResult(false, 'Conversation timeout', Date.now() - startTime, 'failed');
        }
        throw error;
      }

      // Add assistant message to history
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      };

      this.history.push(assistantMessage);

      // Emit turn event
      await this.events.emit('conversation:turn', { turn: this.currentTurn, message: assistantMessage });

      // =========================================================================
      // TODOWRITE ENFORCEMENT (Phase 6: Tool Exemptions integrated)
      // =========================================================================
      // Enforce TodoWrite on early turns for multi-step tasks (if enabled)
      // BUT: Allow clarification and query tools through without blocking (Phase 6)
      if (config.requireTodoWrite && !this.hasPlan && this.currentTurn <= this.MAX_PLAN_ENFORCEMENT_ATTEMPTS) {
        // Check for TodoWrite either as a direct call or inside a batch_tools call
        const hasTodoWrite = response.toolCalls?.some(tc =>
          tc.name === 'TodoWrite' ||
          (tc.name === 'batch_tools' && Array.isArray(tc.params.calls) &&
            (tc.params.calls as Array<{ tool: string }>).some(c => c.tool === 'TodoWrite'))
        );

        if (hasTodoWrite) {
          this.hasPlan = true;
          log.info('TodoWrite called - plan established', { turn: this.currentTurn });

          this.debugHarness?.trace('todowrite-gate', 'plan-established', {
            turn: this.currentTurn,
          });
        } else if (response.toolCalls && response.toolCalls.length > 0) {
          // Separate exempt tools (clarification, query) from action tools (mutation, execution)
          const exemptTools = filterExemptTools(response.toolCalls);
          const actionTools = filterActionTools(response.toolCalls);

          log.debug('Tool exemption check', {
            turn: this.currentTurn,
            exemptTools: exemptTools.map(tc => tc.name),
            actionTools: actionTools.map(tc => tc.name),
          });

          // If ONLY exempt tools are called, allow them through without blocking
          if (actionTools.length === 0 && exemptTools.length > 0) {
            log.info('Allowing exempt tools without TodoWrite', {
              turn: this.currentTurn,
              tools: exemptTools.map(tc => tc.name),
            });

            this.debugHarness?.trace('todowrite-gate', 'exempt-tools-allowed', {
              turn: this.currentTurn,
              exemptTools: exemptTools.map(tc => tc.name),
              blocked: false,
            });
            // Don't block - let them execute normally below
          } else if (actionTools.length > 0) {
            // Agent is using action tools but hasn't created a plan
            this.planEnforcementAttempts++;
            log.warn('Agent using action tools without TodoWrite plan', {
              turn: this.currentTurn,
              attempt: this.planEnforcementAttempts,
              maxAttempts: this.MAX_PLAN_ENFORCEMENT_ATTEMPTS,
              actionTools: actionTools.map(tc => tc.name),
              exemptTools: exemptTools.map(tc => tc.name),
            });

            this.debugHarness?.trace('todowrite-gate', 'action-tools-blocked', {
              turn: this.currentTurn,
              attempt: this.planEnforcementAttempts,
              maxAttempts: this.MAX_PLAN_ENFORCEMENT_ATTEMPTS,
              actionTools: actionTools.map(tc => tc.name),
              exemptTools: exemptTools.map(tc => tc.name),
              blocked: true,
            });

            // Add "rejected" tool results ONLY for action tools
            for (const toolCall of actionTools) {
              this.history.push({
                role: 'tool',
                content: `Tool call blocked: You must call TodoWrite first to create a task plan before using "${toolCall.name}". However, clarification tools (like agent_ask_user) and query tools are allowed without a plan.`,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              });
            }

            // Execute exempt tools normally (they're allowed without TodoWrite)
            // Cast back to ToolCall since filterExemptTools preserves the original type
            for (const toolCall of exemptTools as ToolCall[]) {
              await this.events.emit('conversation:tool-call', { toolCall });
              const result = await this.executeTool(toolCall);
              await this.events.emit('conversation:tool-result', { toolCall, result });

              this.history.push({
                role: 'tool',
                content: this.formatToolResult(result),
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              });
            }

            // Inject user reminder to create a plan (using 'user' role for Claude compatibility)
            this.history.push({
              role: 'user',
              content: `IMPORTANT: You MUST call TodoWrite to create a task plan before proceeding with action tools like ${actionTools.map(tc => tc.name).join(', ')}. This is reminder ${this.planEnforcementAttempts}/${this.MAX_PLAN_ENFORCEMENT_ATTEMPTS}. Clarification and query tools are allowed without a plan.`,
            });

            // Continue to next iteration without counting this as progress
            continue;
          }
        }
        // If no tool calls at all on turn 1, that's fine - might be a simple response
      }

      // Log if max enforcement attempts reached without plan
      if (!this.hasPlan && this.currentTurn > this.MAX_PLAN_ENFORCEMENT_ATTEMPTS) {
        log.warn('Agent proceeding without TodoWrite plan after max enforcement attempts');
      }

      // =========================================================================
      // NO TOOL CALLS = LLM IS DONE
      // =========================================================================
      // Trust the model's decision to stop. No reflection or verification.
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Save goal session if active
        if (config?.saveToGoalMemory && goalContextProvider.hasActiveGoal()) {
          try {
            await this.saveGoalSession(config.goalId!, startTime);
          } catch (error) {
            log.warn('Failed to save goal session', { error });
          }
        }

        // Clear goal context if this conversation was goal-bound
        if (config?.goalId) {
          goalContextProvider.clearActiveGoal();
        }

        // Complete - model decided to stop
        log.info('Conversation complete', { turn: this.currentTurn, finishReason: response.finishReason });

        this.debugHarness?.trace('completion', 'conversation-done', {
          turn: this.currentTurn,
          finishReason: response.finishReason,
          totalToolsExecuted: this.toolResults.length,
          totalOutputPaths: this.outputPaths.length,
          todosCreated: this.currentTodos.length,
          todosCompleted: this.currentTodos.filter(t => t.status === 'completed').length,
          durationMs: Date.now() - startTime,
          resultPreview: response.content?.substring(0, 300),
        });

        this.status = 'completed';
        await this.events.emit('conversation:completed', {
          result: this.createResult(true, undefined, Date.now() - startTime),
        });
        return this.createResult(true, undefined, Date.now() - startTime);
      }

      // Execute tool calls
      for (const toolCall of response.toolCalls) {
        await this.events.emit('conversation:tool-call', { toolCall });

        // DEBUG: Log tool execution
        log.debug('-'.repeat(80));
        log.debug(`EXECUTING TOOL: ${toolCall.name}`);
        log.debug('Tool Parameters:', { params: toolCall.params });

        const result = await this.executeTool(toolCall);

        // DEBUG: Log tool result
        log.debug('Tool Result:', {
          success: result.success,
          hasData: !!result.data,
          hasError: !!result.error,
          observation: result.observation,
          fullResult: result,
        });
        log.debug('-'.repeat(80));

        // Trace: tool execution
        this.debugHarness?.trace('tool-exec', `tool:${toolCall.name}`, {
          turn: this.currentTurn,
          toolName: toolCall.name,
          params: toolCall.params,
          success: result.success,
          error: result.error,
          observationPreview: result.observation?.substring(0, 300),
          hasStructured: !!result.structured,
          structuredType: result.structured?.type,
          structuredSummary: result.structured?.summary,
        });

        await this.events.emit('conversation:tool-result', { toolCall, result });

        // Track tool results for verification
        this.toolResults.push({
          toolName: toolCall.name,
          success: result.success,
          output: result.observation,
          error: result.error,
        });

        // Track output paths for verification (from mutation tools)
        const toolMeta = getToolMetadata(toolCall.name);
        if (toolMeta.category === 'mutation' && result.success && result.data) {
          // Try to extract path from common patterns
          const data = result.data as Record<string, unknown>;
          if (data.path) this.outputPaths.push(String(data.path));
          if (data.notePath) this.outputPaths.push(String(data.notePath));
          if (data.filePath) this.outputPaths.push(String(data.filePath));
        }

        // Mark that output has been produced (for TodoWrite guidance decay)
        if (toolMeta.category === 'mutation' && result.success) {
          this.hasProducedOutput = true;
        }

        // Log decision for observability
        this.decisionLogger.log({
          turn: this.currentTurn,
          decision: 'tool-executed',
          reason: `Executed ${toolCall.name}`,
          inputs: { toolName: toolCall.name, params: toolCall.params },
          outcome: result.success ? 'success' : 'failure',
        });

        // Add tool result to history
        const toolResultContent = this.formatToolResult(result);
        this.history.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: toolCall.id,
          toolName: toolCall.name, // Required by AI SDK v6
        });

        // =========================================================================
        // PAUSE TOOL CHECK
        // =========================================================================
        // Certain tools signal the conversation should pause for user input
        // Also check batch_tools results that contain a pause tool
        const isPauseTool = PAUSE_TOOLS.has(toolCall.name);
        const isBatchWithPause = toolCall.name === 'batch_tools'
          && result.success
          && (result.data as Record<string, unknown>)?._hasPause;
        const pauseToolName = isPauseTool
          ? toolCall.name
          : isBatchWithPause
            ? String((result.data as Record<string, unknown>)._pauseToolName)
            : null;

        if ((isPauseTool || isBatchWithPause) && result.success) {
          log.info('Pause tool triggered', { toolName: pauseToolName });

          this.debugHarness?.trace('pause', 'contract-submitted', {
            turn: this.currentTurn,
            toolName: pauseToolName,
            contractData: result.data,
          });

          this.status = 'paused';

          await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
            'conversation:paused',
            {
              conversationId: this.conversationId,
              reason: pauseToolName,
              data: result.data,
            }
          );

          return this.createResult(
            true,
            undefined,
            Date.now() - startTime,
            'paused',
            { pauseReason: pauseToolName!, pauseData: result.data }
          );
        }
      }

      // Trace: turn end
      this.debugHarness?.trace('turn-end', 'turn-complete', {
        turn: this.currentTurn,
        toolsExecutedThisTurn: response.toolCalls?.length ?? 0,
        toolNames: response.toolCalls?.map(tc => tc.name),
        historyLength: this.history.length,
        hasPlan: this.hasPlan,
        elapsedMs: Date.now() - startTime,
      });

      // Step gate — if step mode, pause here until step() is called
      await this.debugHarness?.turnGate(this.currentTurn);

      // Auto-checkpoint at end of each turn if enabled
      if (this.autoCheckpoint) {
        await this.checkpoint();
      }
    }

    // Trace: termination (max turns)
    this.debugHarness?.trace('termination', 'max-turns-reached', {
      maxTurns: config.maxTurns,
      actualTurns: this.currentTurn,
      durationMs: Date.now() - startTime,
    });

    // Max turns reached - emit timeout event
    this.status = 'timeout' as ConversationStatus;
    log.warn('Max turns reached', { maxTurns: config.maxTurns, actualTurns: this.currentTurn });
    await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
      'conversation:timeout',
      { conversationId: this.conversationId }
    );
    return this.createResult(false, 'Reached max turns limit', Date.now() - startTime, 'timeout' as ConversationStatus);
  }

  // ===========================================================================
  // TOOL EXECUTION
  // ===========================================================================

  /**
   * Execute a single tool call
   */
  private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    log.info('Tool', { name: toolCall.name });

    // Handle special built-in tools
    if (toolCall.name === 'AskUserQuestion') {
      this.debugHarness?.trace('tool-special', 'ask-user-question', {
        turn: this.currentTurn,
        questionCount: Array.isArray(toolCall.params.questions) ? (toolCall.params.questions as unknown[]).length : 0,
      });
      return this.handleAskUserQuestion(toolCall.params);
    }

    if (toolCall.name === 'TodoWrite') {
      this.debugHarness?.trace('tool-special', 'todo-write', {
        turn: this.currentTurn,
        todoCount: Array.isArray(toolCall.params.todos) ? (toolCall.params.todos as unknown[]).length : 0,
        todos: toolCall.params.todos,
      });
      return this.handleTodoWrite(toolCall.params);
    }

    if (toolCall.name === 'submit_contract') {
      this.debugHarness?.trace('tool-special', 'submit-contract', {
        turn: this.currentTurn,
        contractPath: toolCall.params.contract_path,
        goalId: toolCall.params.goal_id,
      });
      return this.handleSubmitContract(toolCall.params);
    }

    if (toolCall.name === 'batch_tools') {
      this.debugHarness?.trace('tool-special', 'batch-tools', {
        turn: this.currentTurn,
        callCount: Array.isArray(toolCall.params.calls) ? (toolCall.params.calls as unknown[]).length : 0,
      });
      return this.handleBatchTools(toolCall.params);
    }

    // Check if tool exists
    if (!this.tools.has(toolCall.name)) {
      this.debugHarness?.trace('error', 'tool-not-found', {
        turn: this.currentTurn,
        toolName: toolCall.name,
      });
      return {
        success: false,
        error: `Tool not found: ${toolCall.name}`,
        observation: `Error: Tool "${toolCall.name}" not found`,
      };
    }

    // Execute the tool with retry logic for transient failures
    const retryResult = await this.retryPolicy.execute(
      async () => {
        const result = await this.tools.execute(toolCall.name, toolCall.params, {
          conversationId: this.conversationId,
          signal: this.abortController?.signal,
          // Pass UI for tool confirmation dialogs
          userInterface: this.ui,
        });

        // Throw on failure to trigger retry logic
        if (!result.success && result.error) {
          throw new Error(result.error);
        }

        return result;
      },
      {
        signal: this.abortController?.signal,
        onRetry: (attempt, error, delayMs) => {
          log.info(`Retrying tool ${toolCall.name}`, {
            attempt,
            error: error.message,
            delayMs,
          });
        },
      }
    );

    // If retry succeeded, return the result
    if (retryResult.success && retryResult.result) {
      return retryResult.result;
    }

    // All retries exhausted or non-retryable error
    return {
      success: false,
      error: retryResult.lastError || 'Tool execution failed',
      observation: `Error executing ${toolCall.name}: ${retryResult.lastError || 'Unknown error'} (after ${retryResult.attempts} attempt${retryResult.attempts > 1 ? 's' : ''})`,
    };
  }

  /**
   * Handle AskUserQuestion tool
   */
  private async handleAskUserQuestion(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      this.status = 'waiting_for_user';

      const questions = params.questions as Question[];
      const answers = await this.ui.askMultiple(questions);

      this.status = 'running';

      return {
        success: true,
        data: { answers },
        observation: `User answers: ${JSON.stringify(answers)}`,
      };
    } catch (error) {
      this.status = 'running';
      return {
        success: false,
        error: 'User cancelled',
        observation: 'User cancelled the question',
      };
    }
  }

  /**
   * Handle TodoWrite tool
   */
  private async handleTodoWrite(params: Record<string, unknown>): Promise<ToolResult> {
    const todos = params.todos as Todo[];

    // Validate: only one in_progress
    const inProgress = todos.filter(t => t.status === 'in_progress');
    if (inProgress.length > 1) {
      return {
        success: false,
        error: 'Only one task can be in_progress at a time',
        observation: 'Error: Only one task can be in_progress at a time',
      };
    }

    // Store todos for reflection
    this.currentTodos = todos;

    // Emit todo:updated event
    await this.events.emit('todo:updated', { todos });

    // Emit task-started/task-completed events
    for (const todo of todos) {
      if (todo.status === 'in_progress') {
        await this.events.emit('todo:task-started', { content: todo.content });
      }
    }

    return {
      success: true,
      data: { todoCount: todos.length },
      observation: `Updated ${todos.length} todos`,
    };
  }

  /**
   * Handle submit_contract tool
   *
   * Submits a contract for user approval. This pauses the conversation
   * until the user approves, requests changes, or rejects.
   */
  private async handleSubmitContract(params: Record<string, unknown>): Promise<ToolResult> {
    const contractPath = params.contract_path as string;
    const goalId = params.goal_id as string;

    if (!contractPath || !goalId) {
      return {
        success: false,
        error: 'Missing required parameters: contract_path and goal_id',
        observation: 'Error: submit_contract requires contract_path and goal_id parameters.',
      };
    }

    // Emit event for frontend to show contract approval UI
    await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
      'contract:pending-approval',
      {
        conversationId: this.conversationId,
        goalId,
        contractPath,
      }
    );

    return {
      success: true,
      data: { contractPath, goalId, awaitingApproval: true },
      observation: 'Contract submitted for user approval. The conversation will pause until the user approves, requests changes, or rejects.',
    };
  }

  /**
   * Handle batch_tools meta-tool
   *
   * Executes multiple tool calls from a single LLM response.
   * This allows models that can't natively produce parallel tool calls
   * to still execute multiple tools per turn.
   *
   * Pause tools (submit_contract) are deferred to execute last.
   */
  private async handleBatchTools(params: Record<string, unknown>): Promise<ToolResult> {
    const calls = params.calls as Array<{ tool: string; params: Record<string, unknown> }> | undefined;

    // Validate
    if (!calls || !Array.isArray(calls)) {
      return {
        success: false,
        error: 'batch_tools requires a "calls" array',
        observation: 'Error: batch_tools requires a "calls" array with tool call objects.',
      };
    }

    if (calls.length === 0) {
      return {
        success: false,
        error: 'batch_tools "calls" array is empty',
        observation: 'Error: batch_tools "calls" array is empty. Provide at least one tool call.',
      };
    }

    log.info('Executing batch_tools', { callCount: calls.length, tools: calls.map(c => c.tool) });

    // Separate pause tools from regular tools so pause tools execute last
    const regularCalls: typeof calls = [];
    const pauseCalls: typeof calls = [];
    for (const call of calls) {
      if (PAUSE_TOOLS.has(call.tool)) {
        pauseCalls.push(call);
      } else {
        regularCalls.push(call);
      }
    }

    const orderedCalls = [...regularCalls, ...pauseCalls];
    const results: Array<{ tool: string; result: ToolResult }> = [];
    let pauseResult: ToolResult | null = null;

    for (const call of orderedCalls) {
      const subToolCall: ToolCall = {
        id: `batch_${call.tool}_${Date.now()}`,
        name: call.tool,
        params: call.params || {},
      };

      log.debug('Batch: executing sub-tool', { tool: call.tool });

      // Execute the sub-tool using the existing executeTool method
      const result = await this.executeTool(subToolCall);
      results.push({ tool: call.tool, result });

      // Emit events for each sub-tool
      await this.events.emit('conversation:tool-call', { toolCall: subToolCall });
      await this.events.emit('conversation:tool-result', { toolCall: subToolCall, result });

      // Track tool results for session summary
      this.toolResults.push({
        toolName: call.tool,
        success: result.success,
        output: result.observation,
        error: result.error,
      });

      // Track output paths for mutation tools
      const toolMeta = getToolMetadata(call.tool);
      if (toolMeta.category === 'mutation' && result.success && result.data) {
        const data = result.data as Record<string, unknown>;
        if (data.path) this.outputPaths.push(String(data.path));
        if (data.notePath) this.outputPaths.push(String(data.notePath));
        if (data.filePath) this.outputPaths.push(String(data.filePath));
      }
      if (toolMeta.category === 'mutation' && result.success) {
        this.hasProducedOutput = true;
      }

      // If this is a pause tool, remember it for special handling
      if (PAUSE_TOOLS.has(call.tool) && result.success) {
        pauseResult = result;
      }
    }

    // Format combined results
    const combinedParts: string[] = [`[BATCH] Executed ${results.length} tool(s):`];
    for (const { tool, result } of results) {
      const formatted = this.formatToolResult(result);
      combinedParts.push(`\n--- ${tool} ---`);
      combinedParts.push(formatted);
    }

    const combinedResult: ToolResult = {
      success: results.every(r => r.result.success),
      data: { batchResults: results.map(r => ({ tool: r.tool, success: r.result.success, data: r.result.data })) },
      observation: combinedParts.join('\n'),
    };

    // If a pause tool was executed, mark the result so the main loop can handle it
    if (pauseResult) {
      combinedResult.data = {
        ...(combinedResult.data as Record<string, unknown>),
        ...pauseResult.data as Record<string, unknown>,
        _hasPause: true,
        _pauseToolName: results.find(r => PAUSE_TOOLS.has(r.tool))?.tool,
      };
    }

    return combinedResult;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Format tool result for message history
   */
  /**
   * Format a tool result for the LLM
   *
   * Priority:
   * 1. Structured result (if available) - formatted for better LLM parsing
   * 2. Observation string (human-readable summary)
   * 3. JSON data fallback
   */
  private formatToolResult(result: ToolResult): string {
    // 0. For agent_ask_user results, always prefer the observation string which
    //    contains the actual user answers. The generic structured result may
    //    strip the answers (see buildDataResult fallback).
    if (result.observation && result.observation.startsWith('User answered:')) {
      return result.observation;
    }

    // 1. Use structured result if available (provides consistent format for LLM)
    if (result.structured) {
      const s = result.structured;
      const parts: string[] = [];

      // Header with type and summary
      parts.push(`[${s.type.toUpperCase()}] ${s.summary}`);

      // Key fields (excluding large data)
      if (s.fields) {
        const fieldEntries = Object.entries(s.fields)
          .filter(([_key, value]) => {
            // Skip large arrays/objects in inline format
            if (Array.isArray(value) && value.length > 5) return false;
            if (typeof value === 'object' && value !== null) {
              const str = JSON.stringify(value);
              if (str.length > 200) return false;
            }
            return true;
          })
          .map(([key, value]) => `  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);

        if (fieldEntries.length > 0) {
          parts.push('Fields:');
          parts.push(...fieldEntries);
        }

        // Handle large result arrays separately (search results, file lists)
        const resultArrays = Object.entries(s.fields).filter(
          ([_, value]) => Array.isArray(value) && value.length > 5
        );
        for (const [key, value] of resultArrays) {
          const arr = value as unknown[];
          parts.push(`\n${key} (${arr.length} items):`);
          arr.slice(0, 10).forEach((item, i) => {
            if (typeof item === 'object' && item !== null) {
              const obj = item as Record<string, unknown>;
              const summary = obj.title || obj.name || obj.id || JSON.stringify(item).slice(0, 80);
              parts.push(`  ${i + 1}. ${summary}`);
            } else {
              parts.push(`  ${i + 1}. ${item}`);
            }
          });
          if (arr.length > 10) {
            parts.push(`  ... and ${arr.length - 10} more`);
          }
        }
      }

      // Suggested follow-up actions
      if (s.actions && s.actions.length > 0) {
        parts.push('\nSuggested next steps:');
        s.actions.forEach((action) => {
          parts.push(`  - ${action.tool}: ${action.reason}`);
        });
      }

      // Metadata (timing, counts)
      if (s.metadata) {
        const metaParts: string[] = [];
        if (s.metadata.durationMs) metaParts.push(`${s.metadata.durationMs}ms`);
        if (s.metadata.itemCount !== undefined) metaParts.push(`${s.metadata.itemCount} items`);
        if (s.metadata.truncated) metaParts.push('truncated');
        if (metaParts.length > 0) {
          parts.push(`\n(${metaParts.join(', ')})`);
        }
      }

      return parts.join('\n');
    }

    // 2. Fall back to observation string
    if (result.observation) {
      return result.observation;
    }

    // 3. Fall back to JSON data
    if (result.success) {
      return JSON.stringify(result.data ?? { success: true });
    }

    return result.error ?? 'Tool execution failed';
  }

  /**
   * Create a conversation result
   */
  private createResult(
    success: boolean,
    error: string | undefined,
    durationMs: number,
    status?: ConversationStatus,
    pauseInfo?: { pauseReason: string; pauseData: unknown }
  ): ConversationResult {
    return {
      success,
      result: success ? this.getLastAssistantContent() : undefined,
      error,
      status: status ?? (success ? 'completed' : 'failed'),
      turns: this.countTurns(),
      durationMs,
      messages: [...this.history],
      pauseReason: pauseInfo?.pauseReason,
      pauseData: pauseInfo?.pauseData,
    };
  }

  /**
   * Get content from last assistant message
   */
  private getLastAssistantContent(): string | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'assistant') {
        return this.history[i].content;
      }
    }
    return undefined;
  }

  /**
   * Count conversation turns (assistant messages)
   */
  private countTurns(): number {
    return this.history.filter(m => m.role === 'assistant').length;
  }

  /**
   * Generate a unique conversation ID
   */
  private generateId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // ===========================================================================
  // GOAL SESSION MANAGEMENT
  // ===========================================================================

  /**
   * Save conversation session to goal memory
   */
  private async saveGoalSession(goalId: string, startTime: number): Promise<void> {
    log.info('Saving goal session', { goalId, conversationId: this.conversationId });

    // Create session summary
    const endTime = Date.now();
    const sessionData = {
      conversationId: this.conversationId,
      startTime,
      endTime,
      turns: this.currentTurn,
      originalGoal: this.originalGoal,
      tasksCreated: this.currentTodos.length,
      toolsExecuted: this.toolResults.length,
      outputPaths: this.outputPaths,
      status: this.status,
    };

    // Format for episodic memory
    const dateStr = new Date().toISOString().split('T')[0];
    const durationSecs = Math.round((endTime - startTime) / 1000);
    const tasksSummary = this.currentTodos
      .map(t => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`)
      .join('\n');

    const sessionEntry = `
## Session ${dateStr}

**Goal**: ${this.originalGoal}
**Duration**: ${durationSecs}s
**Turns**: ${this.currentTurn}
**Tasks Created**: ${this.currentTodos.length}
**Files Modified**: ${this.outputPaths.length}

### Summary
${tasksSummary || '- No tasks tracked'}

---
`;

    try {
      // Append to episodic memory
      await invoke('append_goal_memory', {
        goalId,
        memoryType: 'episodic',
        content: sessionEntry,
      });

      log.info('Goal session saved to episodic memory', { goalId });

      // Emit event (using type assertion for custom events)
      await (this.events as unknown as { emit(event: string, data: unknown): Promise<void> }).emit(
        'conversation:goal-session-saved',
        {
          conversationId: this.conversationId,
          goalId,
          sessionData,
        }
      );
    } catch (error) {
      log.error('Failed to save goal session to memory', { error, goalId });
      throw error;
    }
  }

  // ===========================================================================
  // CHECKPOINT/RESUME
  // ===========================================================================

  /**
   * Save current conversation state as a checkpoint
   *
   * Can be called manually or automatically after each turn.
   */
  async checkpoint(): Promise<void> {
    if (!this.conversationId) {
      log.warn('Cannot checkpoint: no active conversation');
      return;
    }

    const snapshot = this.store.createSnapshot(
      this.conversationId,
      this.history,
      this.currentTodos,
      this.status,
      this.originalGoal,
      this.currentTurn,
      false, // isPlanning removed - pass false for backward compatibility
      {
        hasPlan: this.hasPlan,
        planEnforcementAttempts: this.planEnforcementAttempts,
      }
    );

    await this.store.save(snapshot);
    log.debug('Checkpoint saved', { id: this.conversationId, turn: this.currentTurn });

    // Emit checkpoint event
    await this.events.emit('conversation:checkpoint', {
      conversationId: this.conversationId,
      turn: this.currentTurn,
    });
  }

  /**
   * Resume a conversation from a saved checkpoint
   *
   * @param conversationId - ID of the conversation to resume
   * @param config - Optional configuration overrides
   * @returns ConversationResult from continued execution
   */
  async resume(conversationId: string, config?: ConversationConfig): Promise<ConversationResult> {
    log.info('Resuming conversation', { id: conversationId });

    // Load checkpoint
    const snapshot = await this.store.load(conversationId);
    if (!snapshot) {
      log.error('Cannot resume: conversation not found', { id: conversationId });
      return this.createResult(false, `Conversation ${conversationId} not found`, 0, 'failed');
    }

    // Check if already running
    if (this.isRunning()) {
      log.warn('Cannot resume: conversation already running');
      return this.createResult(false, 'Conversation already running', 0);
    }

    // Restore state from snapshot
    this.conversationId = snapshot.id;
    this.history = [...snapshot.history];
    this.currentTodos = [...snapshot.todos];
    this.status = snapshot.status;
    this.originalGoal = snapshot.originalGoal;
    this.currentTurn = snapshot.turn;
    // Note: isPlanning state removed - no longer used

    // Restore metadata
    if (snapshot.metadata) {
      this.hasPlan = (snapshot.metadata.hasPlan as boolean) ?? false;
      this.planEnforcementAttempts = (snapshot.metadata.planEnforcementAttempts as number) ?? 0;
    }

    // Initialize abort controller
    this.abortController = new AbortController();
    this.status = 'running';

    const startTime = Date.now();

    // Emit resume event
    await this.events.emit('conversation:resumed', {
      conversationId: this.conversationId,
      turn: this.currentTurn,
    });

    // Emit todo restore event if there are todos
    if (this.currentTodos.length > 0) {
      await this.events.emit('todo:updated', { todos: this.currentTodos });
    }

    try {
      // Build config with defaults
      const cfg = {
        maxTurns: config?.maxTurns ?? 50,
        timeoutMs: config?.timeoutMs ?? 300000,
        maxTokensPerTurn: config?.maxTokensPerTurn ?? 4096,
        requireTodoWrite: config?.requireTodoWrite ?? true,
        systemPrompt: config?.systemPrompt,
        signal: config?.signal,
      };

      // Continue the conversation loop
      const result = await this.runLoop(cfg, startTime);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.events.emit('conversation:failed', { error: errorMessage });
      return this.createResult(false, errorMessage, Date.now() - startTime);
    } finally {
      this.status = 'idle';
      this.abortController = null;
    }
  }

  /**
   * List all saved conversations
   */
  async listCheckpoints(): Promise<Array<{
    id: string;
    originalGoal: string;
    status: ConversationStatus;
    turn: number;
    createdAt: number;
    updatedAt: number;
    preview: string;
  }>> {
    return this.store.list();
  }

  /**
   * Delete a saved conversation checkpoint
   */
  async deleteCheckpoint(conversationId: string): Promise<boolean> {
    return this.store.delete(conversationId);
  }

  /**
   * Get the current conversation ID
   */
  getConversationId(): string {
    return this.conversationId;
  }

  /**
   * Enable or disable auto-checkpoint after each turn
   */
  setAutoCheckpoint(enabled: boolean): void {
    this.autoCheckpoint = enabled;
    log.debug('Auto-checkpoint', { enabled });
  }

  /**
   * Set a custom conversation store
   */
  setStore(store: ConversationStore): void {
    this.store = store;
  }
}
