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
  ToolDefinition,
  ConversationResult,
  ConversationStatus,
  Todo,
  Question,
  CompressionConfig,
  RetryConfig,
  SubAgentType,
  ModelTier,
  TaskParams,
} from '../interfaces';
import type { TaskSpawner } from './TaskSpawner';
import { createLogger } from '../logger';
import { ContextCompressor } from './ContextCompressor';
import { ToolRetryPolicy } from './ToolRetryPolicy';
import { ConversationStore, conversationStore } from './ConversationStore';
import { filterExemptTools, filterActionTools } from './ToolExemptions';
import { DecisionLogger, type DecisionLog } from './DecisionLogger';
import { getToolMetadata, partitionToolCalls, deduplicateToolCalls } from './ToolMetadataRegistry';
import { repairToolMessages } from './MessageRepair';
import { type CheckpointConfig } from './CheckpointManager';
import type { DebugHarness } from './DebugHarness';

const log = createLogger('ConversationEngine');


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
  /** Tool patterns to restrict available tools for this conversation (e.g., ['vault_create_note', 'agent_ask_user']) */
  toolPatterns?: string[];
  /** Enable parallel execution of independent tools (default: true) */
  parallelTools?: boolean;
  /** Explicit list of visible tool API names. When provided, replaces the default ACTIVE_TOOLS filter.
   *  Set by ToolPolicyEngine from the application layer. */
  visibleTools?: string[];
  /** Maximum characters per tool result before truncation (default: 100_000) */
  resultMaxChars?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<Omit<ConversationConfig, 'signal' | 'systemPrompt' | 'compression' | 'retry' | 'checkpoint' | 'toolPatterns' | 'visibleTools' | 'resultMaxChars'>> = {
  maxTurns: 50,
  timeoutMs: 600000, // 10 minutes (increased from 5 min to handle slow LLM responses)
  maxTokensPerTurn: 4096,
  requireTodoWrite: false, // System prompt guides TodoWrite usage — no classifier gating
  parallelTools: true,
};

// =============================================================================
// ACTIVE TOOL SET — Only these tools are sent to the LLM
// All other tools remain registered but are hidden from the LLM.
// To re-enable a tool, add its API name (underscore format) to this set.
// =============================================================================

const ACTIVE_TOOLS: ReadonlySet<string> = new Set([
  // Search & Read
  'search_hybrid',
  // Meta
  'batch_tools',
  'vault_read_note',
  'vault_open_note',

  // Create & Edit
  'vault_create_note',
  'vault_update_note',
  'vault_set_frontmatter',

  // Agent interaction
  'agent_ask_user',
  'agent_confirm',

  // Task management
  'TodoWrite',

  // Memory
  'memory_store',
  'memory_recall',
  'memory_search',

  // Shell (merged conceptually, but kept as individual tools for now)
  'Glob',
  'Grep',
  'Read',
  'Bash',

  // Web
  'web_search',
  'web_fetch',

  // Skills (on-demand skill loading from catalog)
  'skill_load',
]);

// =============================================================================
// SUB-AGENT TOOL DEFINITIONS
// =============================================================================

/**
 * Tool definitions injected when TaskSpawner is available.
 * These are intercepted by ConversationEngine before reaching the ToolProvider.
 */
const SUBAGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'spawn_task',
    name: 'spawn_task',
    description: 'Spawn a sub-agent for a focused subtask. Use "explore" (haiku, read-only) for searching/reading notes. Use "skill" (sonnet, read-only) for skill execution. Call multiple times in one turn for parallel execution.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short summary of the task (3-5 words)' },
        prompt: { type: 'string', description: 'Detailed task instructions for the sub-agent' },
        subagentType: {
          type: 'string',
          enum: [
            'explore',
            'Skill',
            // Inactive — uncomment to re-enable:
            // 'execute',
            // 'Plan',
            // 'Bash',
            // 'general-purpose',
          ],
          description: 'Type of sub-agent to spawn',
        },
        // model override inactive — uncomment to re-enable:
        // model: {
        //   type: 'string',
        //   enum: ['haiku', 'sonnet', 'opus'],
        //   description: 'Override the default model tier for this agent type',
        // },
        // runInBackground: {
        //   type: 'boolean',
        //   description: 'If true, spawn in background. Use task_status to check results later.',
        // },
      },
      required: ['description', 'prompt', 'subagentType'],
    },
    category: 'agent',
  },
  {
    id: 'task_status',
    name: 'task_status',
    description: 'Check the status or get the result of a background sub-agent task. Use after spawning a task with runInBackground: true.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID returned from spawn_task' },
        wait: { type: 'boolean', description: 'If true, block until the task completes. Default: false.' },
      },
      required: ['taskId'],
    },
    category: 'agent',
  },
];

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
  /** Optional TaskSpawner for sub-agent execution (enables spawn_task tool) */
  taskSpawner?: TaskSpawner;
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

  // Decision logger for observability
  private decisionLogger: DecisionLogger;

  // Track tool results for session summary
  private toolResults: Array<{ toolName: string; success: boolean; output?: string; error?: string }> = [];

  // Track output paths for session summary
  private outputPaths: string[] = [];

  // Track if output has been produced (for TodoWrite guidance decay)
  private hasProducedOutput: boolean = false;

  // Store last config for resume functionality
  private lastConfig: { maxTurns: number; timeoutMs: number; maxTokensPerTurn: number; requireTodoWrite: boolean; parallelTools: boolean; systemPrompt?: string; signal?: AbortSignal; compression?: CompressionConfig; resultMaxChars?: number } | null = null;

  // Debug harness (optional — zero overhead when not attached)
  private debugHarness: DebugHarness | null = null;

  // Sub-agent spawning (optional — enables spawn_task/task_status tools)
  private taskSpawner: TaskSpawner | null = null;

  // Base system prompt (immutable) — state is appended dynamically each turn
  private baseSystemPrompt: string = '';

  // Loop detection state
  private recentToolSignatures: string[] = [];  // Tool call signatures per turn (last N turns)
  private lastActiveTodosSnapshot: string = ''; // Serialized active todos for stale detection
  private staleTodoTurns: number = 0;           // Consecutive turns with unchanged active todos
  private static readonly LOOP_DETECTION_WINDOW = 4;   // Check last N turns for repetition
  private static readonly STALE_TODO_THRESHOLD = 3;     // Nudge after N stale turns
  private static readonly STALE_TODO_FORCE_STOP = 6;    // Force-stop after N stale turns

  constructor(deps: ConversationEngineDeps) {
    this.llm = deps.llm;
    this.tools = deps.tools;
    this.ui = deps.ui;
    this.events = deps.events;
    this.taskSpawner = deps.taskSpawner ?? null;

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
      ...(config?.parallelTools !== undefined ? { parallelTools: config.parallelTools } : {}),
      // These don't have defaults in DEFAULT_CONFIG
      systemPrompt: config?.systemPrompt,
      signal: config?.signal,
      compression: config?.compression,
      visibleTools: config?.visibleTools,
      resultMaxChars: config?.resultMaxChars ?? 100_000,
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
    });

    // Add system prompt if provided — store base prompt for per-turn state injection
    if (cfg.systemPrompt) {
      this.baseSystemPrompt = cfg.systemPrompt;
      this.history.push({ role: 'system', content: cfg.systemPrompt });
      log.debug('Added system prompt', { length: cfg.systemPrompt.length });
    } else {
      log.warn('No system prompt provided - LLM may not use tools effectively');
    }

    // Add user message
    this.history.push({ role: 'user', content: prompt });

    // Store original goal for session summary
    this.originalGoal = prompt;

    // No intent classification — the system prompt guides the LLM on when to
    // clarify, plan, or respond directly (OpenClaw-style direct-to-LLM approach).
    // TodoWrite enforcement is handled by the tool gate below.

    // Emit intent event for backward compatibility (UI may listen)
    await this.events.emit('conversation:intent-classified', {
      classification: {
        complexity: 'trivial' as const,
        confidence: 1.0,
        suggestedActions: [],
        reasoning: 'Direct-to-LLM — no classification, system prompt guides behavior',
      },
      goal: prompt,
    });

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
      return await this.runLoop(cfg, startTime);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.events.emit('conversation:failed', { error: errorMessage });

      this.debugHarness?.trace('termination', 'conversation-error', {
        error: errorMessage,
        turn: this.currentTurn,
        durationMs: Date.now() - startTime,
      });

      return this.createResult(false, errorMessage, Date.now() - startTime);
    } finally {
      // Finalize debug harness (flush traces, update status)
      // Cast needed because TS narrows status in finally block, but it may have been
      // set to completed/failed/cancelled by runLoop before reaching here
      await this.debugHarness?.finalize(this.status as ConversationStatus);
      this.status = 'idle';
      this.abortController = null;
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
  // CONVERSATION LOOP
  // ===========================================================================

  /**
   * Main conversation loop
   */
  private async runLoop(config: { maxTurns: number; timeoutMs: number; maxTokensPerTurn: number; requireTodoWrite: boolean; parallelTools: boolean; systemPrompt?: string; signal?: AbortSignal; compression?: CompressionConfig; visibleTools?: string[]; resultMaxChars?: number }, startTime: number): Promise<ConversationResult> {
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
      // REBUILD SYSTEM PROMPT WITH CURRENT STATE (Phase 4)
      // Instead of injecting fake user-role messages, we append a ## Current State
      // section to the system prompt each turn. This is cleaner because:
      // - LLM sees state as system instructions, not user messages
      // - No cleanup/re-injection logic needed
      // - No risk of "user" messages confusing role-following
      // =========================================================================
      if (this.baseSystemPrompt && this.history.length > 0 && this.history[0].role === 'system') {
        const stateParts: string[] = [];

        // Active tasks
        if (this.currentTodos.length > 0) {
          const activeTodos = this.currentTodos
            .filter(t => t.status !== 'completed')
            .map(t => `- [${t.status}] ${t.content}`)
            .join('\n');

          if (activeTodos) {
            // Track stale todo detection
            if (activeTodos === this.lastActiveTodosSnapshot) {
              this.staleTodoTurns++;
            } else {
              this.staleTodoTurns = 0;
              this.lastActiveTodosSnapshot = activeTodos;
            }

            stateParts.push(`Active Tasks:\n${activeTodos}`);
          }
        }

        // Rebuild system prompt = base + state (if any state exists)
        if (stateParts.length > 0) {
          this.history[0].content = this.baseSystemPrompt + '\n\n## Current State\n' + stateParts.join('\n\n');
        } else {
          this.history[0].content = this.baseSystemPrompt;
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

        // TOOL VISIBILITY FILTER — uses policy-resolved visibleTools when available,
        // falls back to hardcoded ACTIVE_TOOLS for backward compatibility.
        // All tools remain registered for execution (sub-agents, batch_tools, etc.)
        // but only the visible set is shown to the LLM.
        const visibleSet = config?.visibleTools
          ? new Set(config.visibleTools)
          : ACTIVE_TOOLS;
        const toolsList = this.tools.list().filter(t => visibleSet.has(t.name));
        log.info('Tool visibility filter', {
          usingPolicy: !!config?.visibleTools,
          policyToolCount: config?.visibleTools?.length,
          registeredToolCount: this.tools.list().length,
          visibleToolCount: toolsList.length,
          visibleToolNames: toolsList.map(t => t.name),
        });

        // Inject sub-agent tools if TaskSpawner is available
        if (this.taskSpawner) {
          toolsList.push(...SUBAGENT_TOOL_DEFINITIONS);
        }

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
        // Repair orphaned tool messages before LLM call
        messagesToSend = repairToolMessages(messagesToSend);

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

        // Emit LLM request event for prompt inspector
        await this.events.emit('conversation:llm-request', {
          turn: this.currentTurn,
          messages: messagesToSend.map(m => ({
            role: m.role,
            contentPreview: m.content?.substring(0, 300) ?? '',
            contentLength: m.content?.length ?? 0,
            toolCalls: m.toolCalls?.map(tc => tc.name),
          })),
          toolNames: toolsList.map(t => t.name),
          compressed: compressionResult.wasCompressed,
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

        // Emit LLM response event for prompt inspector
        await this.events.emit('conversation:llm-response', {
          turn: this.currentTurn,
          content: response.content ?? '',
          finishReason: response.finishReason ?? 'unknown',
          toolCalls: (response.toolCalls ?? []).map(tc => ({ name: tc.name, params: tc.params })),
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
                content: this.truncateToolResult(this.formatToolResult(result), this.lastConfig?.resultMaxChars ?? 100_000),
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
      // NO TOOL CALLS = LLM IS DONE (unless tools were filtered out)
      // =========================================================================
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // If finishReason was 'tool_calls' but we have no tools, it means the LLM
        // tried to call tools not in the visible set. Instead of retrying (which
        // loops indefinitely), treat this as a completion with a policy message.
        if (response.finishReason === 'tool_calls') {
          log.warn('All tool calls were filtered out — completing with policy message', { turn: this.currentTurn });

          // Remove the assistant message we already pushed (it may have content
          // mixed with invisible tool calls, which creates invalid history).
          const lastMsg = this.history[this.history.length - 1];
          if (lastMsg?.role === 'assistant') {
            this.history.pop();
          }

          // Build a clear explanation and add it as an assistant message
          const policyMessage = response.content
            ? `${response.content}\n\n(Note: I attempted to use tools that are not available in this session's tool profile. The requested action cannot be performed with the current permissions.)`
            : 'I attempted to use tools that are not available in this session\'s tool profile. The requested action cannot be performed with the current permissions. Please adjust the tool profile in settings if you need write access.';

          // Push a clean assistant message so createResult can find it
          this.history.push({
            role: 'assistant',
            content: policyMessage,
          });

          this.debugHarness?.trace('turn-end', 'tools-filtered-policy-stop', {
            turn: this.currentTurn,
            finishReason: response.finishReason,
          });

          this.status = 'completed';
          return this.createResult(true, undefined, Date.now() - startTime, 'completed');
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

      // Deduplicate tool calls (Gemini/OpenRouter can emit identical calls)
      const dedupedToolCalls = deduplicateToolCalls(response.toolCalls);
      if (dedupedToolCalls.length < response.toolCalls.length) {
        log.warn('Removed duplicate tool calls', {
          original: response.toolCalls.length,
          deduped: dedupedToolCalls.length,
        });
      }

      // Execute tool calls (with parallel optimization)
      const resultMap = new Map<string, { toolCall: ToolCall; result: ToolResult }>();
      const toolTimings: Array<{ tool: string; mode: string; startMs: number; endMs: number; durationMs: number; success: boolean }> = [];

      if (config.parallelTools && dedupedToolCalls.length > 1) {
        // Partition into parallel-safe and sequential groups
        const { parallel, sequential } = partitionToolCalls(dedupedToolCalls);
        const partitionStartMs = Date.now();

        log.info('Tool execution partitioned', {
          turn: this.currentTurn,
          total: response.toolCalls.length,
          parallelCount: parallel.length,
          sequentialCount: sequential.length,
          parallelTools: parallel.map(tc => tc.name),
          sequentialTools: sequential.map(tc => tc.name),
        });

        this.debugHarness?.trace('tool-exec', 'parallel-start', {
          turn: this.currentTurn,
          count: parallel.length,
          tools: parallel.map(tc => tc.name),
        });

        // Execute parallel tools concurrently
        if (parallel.length > 0) {
          // Emit tool-call events upfront for all parallel tools
          for (const tc of parallel) {
            await this.events.emit('conversation:tool-call', { toolCall: tc });
          }

          const batchStartMs = Date.now();
          const settled = await Promise.allSettled(
            parallel.map(async (tc) => {
              const startMs = Date.now();
              log.debug(`EXECUTING TOOL (parallel): ${tc.name}`, { params: tc.params });
              const result = await this.executeTool(tc);
              const endMs = Date.now();
              toolTimings.push({ tool: tc.name, mode: 'parallel', startMs, endMs, durationMs: endMs - startMs, success: result.success });
              return { toolCall: tc, result };
            })
          );
          const batchEndMs = Date.now();

          log.info('Parallel batch completed', {
            turn: this.currentTurn,
            wallClockMs: batchEndMs - batchStartMs,
            tools: parallel.map(tc => tc.name),
            timings: toolTimings.filter(t => t.mode === 'parallel').map(t => ({
              tool: t.tool,
              durationMs: t.durationMs,
              success: t.success,
            })),
          });

          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') {
              const { toolCall, result } = outcome.value;
              resultMap.set(toolCall.id, { toolCall, result });
              await this.processToolResult(toolCall, result);
            } else {
              log.error('Unexpected parallel tool rejection', { reason: outcome.reason });
            }
          }
        }

        // Execute sequential tools one-by-one (after parallel complete)
        for (const tc of sequential) {
          await this.events.emit('conversation:tool-call', { toolCall: tc });
          const startMs = Date.now();
          log.debug(`EXECUTING TOOL (sequential): ${tc.name}`, { params: tc.params });
          const result = await this.executeTool(tc);
          const endMs = Date.now();
          toolTimings.push({ tool: tc.name, mode: 'sequential', startMs, endMs, durationMs: endMs - startMs, success: result.success });
          resultMap.set(tc.id, { toolCall: tc, result });
          await this.processToolResult(tc, result);
        }

        const totalMs = Date.now() - partitionStartMs;
        const sequentialSum = toolTimings.reduce((acc, t) => acc + t.durationMs, 0);
        log.info('Turn tool execution summary', {
          turn: this.currentTurn,
          wallClockMs: totalMs,
          sumOfIndividualMs: sequentialSum,
          savedMs: sequentialSum - totalMs,
          timings: toolTimings.map(t => ({
            tool: t.tool,
            mode: t.mode,
            durationMs: t.durationMs,
            success: t.success,
          })),
        });

        this.debugHarness?.trace('tool-exec', 'parallel-end', {
          turn: this.currentTurn,
          count: parallel.length,
          successes: [...resultMap.values()].filter(r => r.result.success).length,
          wallClockMs: totalMs,
          savedMs: sequentialSum - totalMs,
          timings: toolTimings,
        });

      } else {
        // Single tool call or parallel disabled: sequential execution
        for (const tc of dedupedToolCalls) {
          await this.events.emit('conversation:tool-call', { toolCall: tc });
          const startMs = Date.now();
          log.debug(`EXECUTING TOOL: ${tc.name}`, { params: tc.params });
          const result = await this.executeTool(tc);
          const endMs = Date.now();
          const durationMs = endMs - startMs;
          log.info(`Tool executed (single)`, { turn: this.currentTurn, tool: tc.name, durationMs, success: result.success });
          resultMap.set(tc.id, { toolCall: tc, result });
          await this.processToolResult(tc, result);
        }
      }

      // Append ALL results to history in ORIGINAL order
      for (const tc of response.toolCalls) {
        const entry = resultMap.get(tc.id);
        if (entry) {
          this.history.push({
            role: 'tool',
            content: this.truncateToolResult(this.formatToolResult(entry.result), this.lastConfig?.resultMaxChars ?? 100_000),
            toolCallId: tc.id,
            toolName: tc.name,
          });
        } else {
          // Defensive: tool execution threw unexpectedly (should not happen)
          this.history.push({
            role: 'tool',
            content: 'Error: Tool execution failed unexpectedly',
            toolCallId: tc.id,
            toolName: tc.name,
          });
        }

      }

      // =========================================================================
      // LOOP DETECTION — detect repetitive tool calls and stale todos
      // =========================================================================
      const loopAction = this.detectLoop(response.toolCalls ?? []);

      if (loopAction === 'force-stop') {
        log.warn('Loop detected — force-stopping conversation', {
          turn: this.currentTurn,
          staleTodoTurns: this.staleTodoTurns,
          recentSignatures: this.recentToolSignatures,
        });
        this.debugHarness?.trace('termination', 'loop-detected-force-stop', {
          turn: this.currentTurn,
          staleTodoTurns: this.staleTodoTurns,
          recentSignatures: this.recentToolSignatures,
        });
        this.status = 'completed';
        return this.createResult(
          true,
          'Conversation stopped: repeated actions detected without progress. Returning results gathered so far.',
          Date.now() - startTime,
          'completed'
        );
      }

      if (loopAction === 'nudge') {
        log.info('Loop detected — injecting nudge', {
          turn: this.currentTurn,
          staleTodoTurns: this.staleTodoTurns,
        });
        this.debugHarness?.trace('loop-detection', 'nudge-injected', {
          turn: this.currentTurn,
          staleTodoTurns: this.staleTodoTurns,
          recentSignatures: this.recentToolSignatures,
        });
        this.history.push({
          role: 'user',
          content: `[System Reminder] You appear to be repeating the same actions without making progress. Your active tasks have not changed in ${this.staleTodoTurns} turns. Either:\n1. Mark your current tasks as completed with TodoWrite and present results to the user\n2. Change your approach — try different tools or queries\n3. If you have enough information, stop calling tools and respond with your findings`,
        });
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
  // LOOP DETECTION
  // ===========================================================================

  /**
   * Detect if the conversation is looping — repeating the same tool calls
   * or making no progress on active todos.
   *
   * Returns:
   * - 'none'       — no loop detected, continue normally
   * - 'nudge'      — stale todos detected, inject a reminder to change approach
   * - 'force-stop' — severe loop detected, stop the conversation
   */
  private detectLoop(toolCalls: ToolCall[]): 'none' | 'nudge' | 'force-stop' {
    // Build a signature for this turn's tool calls (sorted for order independence)
    const turnSignature = toolCalls
      .map(tc => `${tc.name}:${JSON.stringify(tc.params)}`)
      .sort()
      .join('|');

    this.recentToolSignatures.push(turnSignature);

    // Keep only the last N signatures
    if (this.recentToolSignatures.length > ConversationEngine.LOOP_DETECTION_WINDOW) {
      this.recentToolSignatures.shift();
    }

    // Check 1: Exact same tool signature repeated for the entire window
    if (this.recentToolSignatures.length >= ConversationEngine.LOOP_DETECTION_WINDOW) {
      const allSame = this.recentToolSignatures.every(s => s === this.recentToolSignatures[0]);
      if (allSame) {
        log.warn('Exact tool repetition detected', {
          window: ConversationEngine.LOOP_DETECTION_WINDOW,
          signature: this.recentToolSignatures[0]?.substring(0, 200),
        });
        return 'force-stop';
      }
    }

    // Check 2: Same tool name repeated with minor param variations (e.g., re-reading same note)
    if (this.recentToolSignatures.length >= ConversationEngine.LOOP_DETECTION_WINDOW) {
      const toolNames = this.recentToolSignatures.map(s => s.split(':')[0]);
      const allSameToolName = toolNames.every(n => n === toolNames[0]);
      if (allSameToolName && this.staleTodoTurns >= ConversationEngine.STALE_TODO_THRESHOLD) {
        log.warn('Same tool type with stale todos', {
          toolName: toolNames[0],
          staleTurns: this.staleTodoTurns,
        });
        return 'force-stop';
      }
    }

    // Check 3: Stale todos — active tasks haven't changed
    if (this.staleTodoTurns >= ConversationEngine.STALE_TODO_FORCE_STOP) {
      return 'force-stop';
    }

    if (this.staleTodoTurns >= ConversationEngine.STALE_TODO_THRESHOLD) {
      return 'nudge';
    }

    return 'none';
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

    if (toolCall.name === 'batch_tools') {
      this.debugHarness?.trace('tool-special', 'batch-tools', {
        turn: this.currentTurn,
        callCount: Array.isArray(toolCall.params.calls) ? (toolCall.params.calls as unknown[]).length : 0,
      });
      return this.handleBatchTools(toolCall.params);
    }

    if (toolCall.name === 'spawn_task' && this.taskSpawner) {
      this.debugHarness?.trace('tool-special', 'spawn-task', {
        turn: this.currentTurn,
        subagentType: toolCall.params.subagentType,
        runInBackground: toolCall.params.runInBackground,
      });
      return this.handleSpawnTask(toolCall.params);
    }

    if (toolCall.name === 'task_status' && this.taskSpawner) {
      this.debugHarness?.trace('tool-special', 'task-status', {
        turn: this.currentTurn,
        taskId: toolCall.params.taskId,
      });
      return this.handleTaskStatus(toolCall.params);
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

    // Note: Multiple in_progress tasks are allowed — the LLM may work on
    // parallel subtasks (e.g., after batch_tools returns multiple results).
    // Previously this was restricted to one, but that caused wasted turns
    // when the LLM reasonably wanted to mark concurrent work.

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
   * Handle batch_tools meta-tool
   *
   * Executes multiple tool calls from a single LLM response.
   * This allows models that can't natively produce parallel tool calls
   * to still execute multiple tools per turn.
   */
  private async handleBatchTools(params: Record<string, unknown>): Promise<ToolResult> {
    let calls = params.calls as Array<{ tool: string; params: Record<string, unknown> }> | string | undefined;

    // Handle LLM sending calls as a JSON string instead of array
    if (typeof calls === 'string') {
      try {
        const parsed = JSON.parse(calls);
        if (Array.isArray(parsed)) {
          calls = parsed as Array<{ tool: string; params: Record<string, unknown> }>;
        }
      } catch {
        // Fall through to validation error below
      }
    }

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

    // Build ToolCall objects for partitioning
    const subToolCalls = calls.map((call, i) => ({
      id: `batch_${call.tool}_${i}_${Date.now()}`,
      name: call.tool,
      params: call.params || {},
    }));

    // Partition into parallel-safe and sequential groups
    const { parallel, sequential } = partitionToolCalls(subToolCalls);
    const batchResultMap = new Map<string, { tool: string; result: ToolResult }>();
    const batchTimings: Array<{ tool: string; mode: string; durationMs: number; success: boolean }> = [];

    this.debugHarness?.trace('tool-exec', 'batch-partitioned', {
      turn: this.currentTurn,
      parallelCount: parallel.length,
      sequentialCount: sequential.length,
      parallelTools: parallel.map(tc => tc.name),
      sequentialTools: sequential.map(tc => tc.name),
    });

    // Execute parallel sub-calls concurrently
    if (parallel.length > 1) {
      this.debugHarness?.trace('tool-exec', 'batch-parallel-start', {
        turn: this.currentTurn,
        count: parallel.length,
        tools: parallel.map(tc => tc.name),
      });

      for (const tc of parallel) {
        await this.events.emit('conversation:tool-call', { toolCall: tc });
      }

      const batchStartMs = Date.now();
      const settled = await Promise.allSettled(
        parallel.map(async (subToolCall) => {
          const startMs = Date.now();
          const result = await this.executeTool(subToolCall);
          batchTimings.push({ tool: subToolCall.name, mode: 'parallel', durationMs: Date.now() - startMs, success: result.success });
          return { subToolCall, result };
        })
      );
      const batchWallMs = Date.now() - batchStartMs;

      this.debugHarness?.trace('tool-exec', 'batch-parallel-end', {
        turn: this.currentTurn,
        wallClockMs: batchWallMs,
        timings: batchTimings.filter(t => t.mode === 'parallel'),
      });

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          const { subToolCall, result } = outcome.value;
          batchResultMap.set(subToolCall.id, { tool: subToolCall.name, result });
          await this.processToolResult(subToolCall, result);
        } else {
          log.error('Unexpected batch parallel tool rejection', { reason: outcome.reason });
        }
      }
    } else {
      // Single parallel tool or none: execute sequentially
      for (const tc of parallel) {
        await this.events.emit('conversation:tool-call', { toolCall: tc });
        const startMs = Date.now();
        const result = await this.executeTool(tc);
        batchTimings.push({ tool: tc.name, mode: 'sequential', durationMs: Date.now() - startMs, success: result.success });
        batchResultMap.set(tc.id, { tool: tc.name, result });
        await this.processToolResult(tc, result);
      }
    }

    // Execute sequential sub-calls one-by-one
    for (const tc of sequential) {
      await this.events.emit('conversation:tool-call', { toolCall: tc });
      const startMs = Date.now();
      const result = await this.executeTool(tc);
      batchTimings.push({ tool: tc.name, mode: 'sequential', durationMs: Date.now() - startMs, success: result.success });
      batchResultMap.set(tc.id, { tool: tc.name, result });
      await this.processToolResult(tc, result);
    }

    // Collect results in original order
    const results: Array<{ tool: string; result: ToolResult }> = [];
    for (const tc of subToolCalls) {
      const entry = batchResultMap.get(tc.id);
      if (entry) {
        results.push(entry);
      }
    }

    // Log batch execution summary
    const sumMs = batchTimings.reduce((a, t) => a + t.durationMs, 0);
    const parallelTimings = batchTimings.filter(t => t.mode === 'parallel');
    const maxParallelMs = parallelTimings.length > 0 ? Math.max(...parallelTimings.map(t => t.durationMs)) : 0;
    const parallelSumMs = parallelTimings.reduce((a, t) => a + t.durationMs, 0);

    this.debugHarness?.trace('tool-exec', 'batch-summary', {
      turn: this.currentTurn,
      toolCount: results.length,
      parallelCount: parallelTimings.length,
      wallClockMs: maxParallelMs + batchTimings.filter(t => t.mode === 'sequential').reduce((a, t) => a + t.durationMs, 0),
      savedMs: parallelSumMs > 0 ? parallelSumMs - maxParallelMs : 0,
      timings: batchTimings,
    });

    // Format combined results
    const combinedParts: string[] = [`[BATCH] Executed ${results.length} tool(s):`];
    for (const { tool, result } of results) {
      const formatted = this.truncateToolResult(this.formatToolResult(result), this.lastConfig?.resultMaxChars ?? 100_000);
      combinedParts.push(`\n--- ${tool} ---`);
      combinedParts.push(formatted);
    }

    return {
      success: results.every(r => r.result.success),
      data: { batchResults: results.map(r => ({ tool: r.tool, success: r.result.success, data: r.result.data })) },
      observation: combinedParts.join('\n'),
    };
  }

  // ===========================================================================
  // SUB-AGENT TOOLS
  // ===========================================================================

  /**
   * Handle spawn_task tool call — delegates to TaskSpawner
   */
  private async handleSpawnTask(params: Record<string, unknown>): Promise<ToolResult> {
    if (!this.taskSpawner) {
      return {
        success: false,
        error: 'Sub-agents not available',
        observation: 'Error: spawn_task is not configured. No TaskSpawner available.',
      };
    }

    const taskParams: TaskParams = {
      description: String(params.description || ''),
      prompt: String(params.prompt || ''),
      subagentType: (params.subagentType as SubAgentType) || 'general-purpose',
      model: params.model as ModelTier | undefined,
      runInBackground: Boolean(params.runInBackground),
    };

    try {
      log.info('Spawning sub-agent', {
        type: taskParams.subagentType,
        model: taskParams.model,
        background: taskParams.runInBackground,
        description: taskParams.description,
      });

      const result = await this.taskSpawner.spawn(taskParams);

      if (result.status === 'running') {
        return {
          success: true,
          data: { taskId: result.taskId },
          observation: `Sub-agent spawned in background (taskId: ${result.taskId}). Use task_status to check results.`,
        };
      }

      return {
        success: result.success,
        data: result.data,
        observation: result.success
          ? `Sub-agent completed successfully:\n${typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}`
          : `Sub-agent failed: ${result.error || 'Unknown error'}`,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      log.error('spawn_task failed', { error: errorMsg });
      return {
        success: false,
        error: errorMsg,
        observation: `spawn_task failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Handle task_status tool call — checks status of background sub-agent tasks
   */
  private async handleTaskStatus(params: Record<string, unknown>): Promise<ToolResult> {
    if (!this.taskSpawner) {
      return {
        success: false,
        error: 'Sub-agents not available',
        observation: 'Error: task_status is not configured. No TaskSpawner available.',
      };
    }

    const taskId = String(params.taskId || '');
    if (!taskId) {
      return {
        success: false,
        error: 'taskId is required',
        observation: 'Error: taskId parameter is required for task_status.',
      };
    }

    const shouldWait = Boolean(params.wait);

    try {
      if (this.taskSpawner.isRunning(taskId)) {
        if (shouldWait) {
          const result = await this.taskSpawner.getResult(taskId);
          if (result) {
            return {
              success: result.success,
              data: result.data,
              observation: result.success
                ? `Task ${taskId} completed:\n${typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}`
                : `Task ${taskId} failed: ${result.error}`,
            };
          }
        }
        return {
          success: true,
          data: { taskId, status: 'running' },
          observation: `Task ${taskId} is still running.`,
        };
      }

      // Task not running — get stored result
      const result = await this.taskSpawner.getResult(taskId);
      if (result) {
        return {
          success: result.success,
          data: result.data,
          observation: result.success
            ? `Task ${taskId} completed:\n${typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}`
            : `Task ${taskId} failed: ${result.error}`,
        };
      }

      return {
        success: false,
        error: `Task ${taskId} not found`,
        observation: `Error: No task found with ID ${taskId}.`,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        error: errorMsg,
        observation: `task_status failed: ${errorMsg}`,
      };
    }
  }

  // ===========================================================================
  // TOOL RESULT PROCESSING
  // ===========================================================================

  /**
   * Process a tool result: trace, emit events, track metadata.
   * Extracted from the main loop and handleBatchTools to avoid duplication.
   */
  private async processToolResult(toolCall: ToolCall, result: ToolResult): Promise<void> {
    // Debug harness trace
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

    // Emit tool-result event
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

      // Key fields
      if (s.fields) {
        // Separate arrays of objects (search results, file lists) from scalar fields
        const scalarFields: Array<[string, unknown]> = [];
        const objectArrayFields: Array<[string, unknown[]]> = [];

        for (const [key, value] of Object.entries(s.fields)) {
          if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            // Array of objects — always use structured format with [id: "..."] display
            objectArrayFields.push([key, value as unknown[]]);
          } else if (Array.isArray(value) && value.length > 10) {
            // Large primitive arrays — show as list
            objectArrayFields.push([key, value as unknown[]]);
          } else {
            scalarFields.push([key, value]);
          }
        }

        // Render scalar fields inline
        const fieldEntries = scalarFields
          .filter(([_key, value]) => {
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

        // Render object arrays with structured formatting (IDs visible for chaining)
        for (const [key, arr] of objectArrayFields) {
          parts.push(`\n${key} (${arr.length} items):`);
          arr.slice(0, 10).forEach((item, i) => {
            if (typeof item === 'object' && item !== null) {
              const obj = item as Record<string, unknown>;
              // Always show ID first (critical for vault_read_note chaining), then title
              const idPart = obj.id ? `[id: "${obj.id}"] ` : '';
              const label = obj.title || obj.name || (!obj.id ? JSON.stringify(item).slice(0, 80) : '');
              const scorePart = obj.score !== undefined ? ` (score: ${Number(obj.score).toFixed(2)})` : '';
              const simPart = obj.similarity !== undefined ? ` (sim: ${Number(obj.similarity).toFixed(2)})` : '';
              parts.push(`  ${i + 1}. ${idPart}${label}${scorePart}${simPart}`);
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
   * Truncate a formatted tool result if it exceeds the configured max chars.
   * Uses 70/30 head/tail strategy to preserve beginning and end context.
   */
  private truncateToolResult(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
      return content;
    }

    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = Math.min(4000, maxChars - headSize);
    const head = content.slice(0, headSize);
    const tail = content.slice(-tailSize);
    const omitted = content.length - headSize - tailSize;

    return `${head}\n\n[... ${omitted} chars omitted (${content.length} total) ...]\n\n${tail}`;
  }

  /**
   * Create a conversation result
   */
  private createResult(
    success: boolean,
    error: string | undefined,
    durationMs: number,
    status?: ConversationStatus,
  ): ConversationResult {
    return {
      success,
      result: success ? this.getLastAssistantContent() : undefined,
      error,
      status: status ?? (success ? 'completed' : 'failed'),
      turns: this.countTurns(),
      durationMs,
      messages: [...this.history],
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
        parallelTools: config?.parallelTools ?? true,
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
