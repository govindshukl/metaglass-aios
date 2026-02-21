/**
 * AIOS Core Types
 *
 * Core type definitions for the AI Operating System.
 * These types are the foundation for all AIOS components.
 */
/**
 * Role in a conversation
 */
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
/**
 * A message in the conversation history
 */
interface Message {
    /** Role of the message sender */
    role: MessageRole;
    /** Content of the message */
    content: string;
    /** Tool calls made in this message (for assistant messages) */
    toolCalls?: ToolCall$1[];
    /** Tool call ID this message is responding to (for tool messages) */
    toolCallId?: string;
    /** Tool name this message is responding to (for tool messages, required by AI SDK v6) */
    toolName?: string;
}
/**
 * A tool call request from the LLM
 */
interface ToolCall$1 {
    /** Unique identifier for this tool call */
    id: string;
    /** Name of the tool to invoke */
    name: string;
    /** Parameters to pass to the tool */
    params: Record<string, unknown>;
}
/**
 * Suggested follow-up action after tool execution
 */
interface ToolFollowUpAction {
    /** Name of suggested tool to call next */
    tool: string;
    /** Reason for the suggestion */
    reason: string;
    /** Pre-filled parameters (optional) */
    params?: Record<string, unknown>;
}
/**
 * Structured tool result for better LLM parsing
 *
 * Provides a consistent schema for tool results that enables:
 * - Better LLM understanding of tool outputs
 * - Easier chaining of related tools
 * - Consistent formatting across different tool types
 */
interface StructuredToolResult {
    /** Type of result for formatting hints */
    type: 'search' | 'file' | 'list' | 'action' | 'error' | 'data';
    /** Brief summary of what happened */
    summary: string;
    /** Structured data fields specific to the result type */
    fields: Record<string, unknown>;
    /** Suggested follow-up actions/tools */
    actions?: ToolFollowUpAction[];
    /** Metadata about the operation */
    metadata?: {
        /** Time taken in milliseconds */
        durationMs?: number;
        /** Items processed/returned */
        itemCount?: number;
        /** Whether result is truncated */
        truncated?: boolean;
        /** Source identifier */
        source?: string;
    };
}
/**
 * Result from executing a tool
 */
interface ToolResult$1 {
    /** Whether the tool executed successfully */
    success: boolean;
    /** Result data if successful */
    data?: unknown;
    /** Error message if failed */
    error?: string;
    /** Human-readable observation for the LLM */
    observation?: string;
    /** Structured result for better LLM parsing (optional, backward compatible) */
    structured?: StructuredToolResult;
}
/**
 * Options for LLM chat completion
 */
interface ChatOptions {
    /** Maximum tokens in response */
    maxTokens?: number;
    /** Temperature for sampling (0-1) */
    temperature?: number;
    /** Available tools for the LLM */
    tools?: ToolDefinition[];
    /** Stop sequences */
    stop?: string[];
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}
/**
 * Response from LLM chat completion
 */
interface LLMResponse {
    /** Text content of the response */
    content: string;
    /** Tool calls requested by the LLM */
    toolCalls?: ToolCall$1[];
    /** Finish reason */
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    /** Token usage statistics */
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}
/**
 * LLM model capabilities
 */
interface LLMCapabilities {
    /** Supports tool/function calling */
    toolCalling: boolean;
    /** Supports vision/image input */
    vision: boolean;
    /** Supports streaming responses */
    streaming: boolean;
    /** Maximum context window in tokens */
    contextWindow: number;
    /** Maximum output tokens */
    maxOutputTokens: number;
}
/**
 * JSON Schema for tool parameters
 */
interface JSONSchemaProperty {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    enum?: string[];
    default?: unknown;
    items?: JSONSchemaProperty;
    properties?: Record<string, JSONSchemaProperty>;
    required?: string[];
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
}
/**
 * Tool parameter schema
 */
interface ToolParameters {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
}
/**
 * Tool definition for LLM
 */
interface ToolDefinition {
    /** Unique tool identifier */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what the tool does */
    description: string;
    /** Parameter schema */
    parameters: ToolParameters;
    /** Tool category for organization */
    category?: ToolCategory;
    /** Whether tool requires user confirmation */
    requiresConfirmation?: boolean;
}
/**
 * Tool categories (Claude Code inspired)
 */
type ToolCategory = 'read' | 'edit' | 'execute' | 'agent' | 'llm' | 'task' | 'mcp';
/**
 * Minimal user interface for tool confirmations
 */
interface ToolUserInterface {
    /** Ask for confirmation (yes/no) */
    confirm(message: string): Promise<boolean>;
}
/**
 * Context passed to tool execution
 */
interface ToolContext {
    /** Current conversation state */
    conversationId?: string;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
    /** User interface for confirmations (optional) */
    userInterface?: ToolUserInterface;
}
/**
 * Todo task status
 */
type TodoStatus$1 = 'pending' | 'in_progress' | 'completed';
/**
 * A todo task
 */
interface Todo$1 {
    /** Task description (imperative form: "Run tests") */
    content: string;
    /** Active form for display ("Running tests...") */
    activeForm: string;
    /** Current status */
    status: TodoStatus$1;
}
/**
 * Question option for user selection
 */
interface QuestionOption {
    /** Display label (1-5 words) */
    label: string;
    /** Description of what this option means */
    description: string;
}
/**
 * A question for the user
 */
interface Question {
    /** Full question text */
    question: string;
    /** Short header/label (≤12 chars) */
    header: string;
    /** Available options (2-4) */
    options: QuestionOption[];
    /** Allow multiple selections */
    multiSelect: boolean;
}
/**
 * User notification type
 */
type NotificationType = 'info' | 'success' | 'warning' | 'error';
/**
 * Conversation execution status
 */
type ConversationStatus = 'idle' | 'running' | 'waiting_for_user' | 'paused' | 'completed' | 'timeout' | 'failed' | 'cancelled';
/**
 * Result from conversation execution
 */
interface ConversationResult {
    /** Whether execution was successful */
    success: boolean;
    /** Final result/answer */
    result?: string;
    /** Error message if failed */
    error?: string;
    /** Conversation status */
    status: ConversationStatus;
    /** Number of turns taken */
    turns: number;
    /** Total duration in milliseconds */
    durationMs: number;
    /** Message history */
    messages: Message[];
    /** Reason for pause (if status is 'paused') */
    pauseReason?: string;
    /** Data associated with pause (tool-specific) */
    pauseData?: unknown;
}
/**
 * Sub-agent types
 *
 * Primary types (lowercase):
 * - explore: Read-only exploration and search
 * - contract: Smart Contract generation for goals
 * - execute: Full capability execution within a contract
 *
 * Legacy types (for backward compatibility):
 * - Explore, Plan, contract-plan, general-purpose
 */
type SubAgentType = 'explore' | 'contract' | 'execute' | 'Bash' | 'Skill' | 'Explore' | 'Plan' | 'contract-plan' | 'general-purpose';
/**
 * Model selection for sub-agents
 */
type ModelTier = 'haiku' | 'sonnet' | 'opus';
/**
 * Task spawn parameters
 */
interface TaskParams {
    /** Short description (3-5 words) */
    description: string;
    /** Detailed task prompt */
    prompt: string;
    /** Type of sub-agent */
    subagentType: SubAgentType;
    /** Model to use (optional, defaults based on type) */
    model?: ModelTier;
    /** Run in background */
    runInBackground?: boolean;
    /** Agent ID to resume */
    resume?: string;
}
/**
 * Task result
 */
interface TaskResult {
    /** Task ID */
    taskId: string;
    /** Whether task completed successfully */
    success: boolean;
    /** Result data */
    data?: unknown;
    /** Error if failed */
    error?: string;
    /** Execution status */
    status: 'running' | 'completed' | 'failed' | 'cancelled';
}
/**
 * Plan approval status
 */
type PlanApprovalStatus = 'pending' | 'approved' | 'rejected';
/**
 * Plan state
 */
interface PlanState {
    /** Whether currently in planning mode */
    isPlanning: boolean;
    /** Plan content */
    planContent?: string;
    /** Approval status */
    approvalStatus: PlanApprovalStatus;
}
/**
 * Reflection result payload for events
 */
interface ReflectionResultPayload {
    /** Whether the goal appears to be fully achieved */
    isComplete: boolean;
    /** Quality assessment of the work done */
    quality: 'good' | 'needs_improvement' | 'failed';
    /** Explanation of the assessment */
    reasoning: string;
    /** Suggested next action if not complete */
    nextAction: string | null;
    /** Whether user input is needed to proceed */
    needsUserInput: boolean;
    /** Question to ask the user if needsUserInput is true */
    userQuestion: string | null;
}
/**
 * Task complexity levels for intent classification
 */
type TaskComplexityLevel = 'trivial' | 'simple_query' | 'multi_step' | 'complex';
/**
 * Suggested actions based on intent classification
 */
type IntentSuggestedAction = 'ask_clarification' | 'create_todo' | 'checkpoint_before_execution' | 'verify_output';
/**
 * Intent classification result payload for events
 */
interface IntentClassificationResult {
    /** Detected task complexity */
    complexity: TaskComplexityLevel;
    /** Confidence score (0-1) */
    confidence: number;
    /** Suggested actions based on complexity */
    suggestedActions: IntentSuggestedAction[];
    /** Human-readable reasoning for the classification */
    reasoning: string;
}
/**
 * Configuration for tool retry behavior
 */
interface RetryConfig$1 {
    /** Maximum number of retry attempts (default: 3) */
    maxAttempts?: number;
    /** Initial delay in ms before first retry (default: 1000) */
    baseDelayMs?: number;
    /** Maximum delay in ms between retries (default: 10000) */
    maxDelayMs?: number;
    /** Multiplier for exponential backoff (default: 2) */
    backoffMultiplier?: number;
    /** Add random jitter to delays (default: true) */
    jitter?: boolean;
    /** Error message patterns that are retryable */
    retryableErrors?: string[];
}
/**
 * Configuration for context compression
 */
interface CompressionConfig {
    /** Enable compression (default: true) */
    enabled?: boolean;
    /** Maximum target tokens for context (default: 100000) */
    maxTokens?: number;
    /** Minimum turns before compression kicks in (default: 10) */
    summarizeThreshold?: number;
    /** Number of recent turns to always preserve verbatim (default: 5) */
    preserveRecentTurns?: number;
    /** Characters per token estimate (default: 4) */
    charsPerToken?: number;
    /** Maximum tokens for summary generation (default: 1000) */
    summaryMaxTokens?: number;
}
/**
 * AIOS events
 */
interface AIOSEvents {
    'conversation:started': {
        conversationId: string;
    };
    'conversation:turn': {
        turn: number;
        message: Message;
    };
    'conversation:tool-call': {
        toolCall: ToolCall$1;
    };
    'conversation:tool-result': {
        toolCall: ToolCall$1;
        result: ToolResult$1;
    };
    'conversation:reflection': {
        turn: number;
        reflection: ReflectionResultPayload;
    };
    'conversation:completed': {
        result: ConversationResult;
    };
    'conversation:failed': {
        error: string;
    };
    'conversation:cancelled': {
        conversationId: string;
    };
    'conversation:checkpoint': {
        conversationId: string;
        turn: number;
    };
    'conversation:resumed': {
        conversationId: string;
        turn: number;
    };
    'conversation:intent-classified': {
        classification: IntentClassificationResult;
        goal: string;
    };
    'todo:updated': {
        todos: Todo$1[];
    };
    'todo:task-started': {
        content: string;
    };
    'todo:task-completed': {
        content: string;
    };
    'interaction:requested': {
        questions: Question[];
    };
    'interaction:responded': {
        answers: Record<string, string | string[]>;
    };
    'interaction:cancelled': void;
    'plan:entered': void;
    'plan:exited': {
        approved: boolean;
        content?: string;
    };
    'plan:updated': {
        content: string;
    };
    'contract:pending-approval': {
        conversationId: string;
        goalId: string;
        contractPath: string;
    };
    'contract:approved': {
        goalId: string;
        contractPath: string;
    };
    'contract:changes-requested': {
        goalId: string;
        feedback: string;
    };
    'contract:rejected': {
        goalId: string;
        reason?: string;
    };
    'conversation:paused': {
        conversationId: string;
        reason: string;
        data?: unknown;
    };
    'conversation:timeout': {
        conversationId: string;
    };
    'task:spawned': {
        taskId: string;
        type: SubAgentType;
    };
    'task:completed': {
        taskId: string;
        result: TaskResult;
    };
}

/**
 * LLMProvider Interface
 *
 * Abstraction for LLM providers (Claude, OpenAI, Ollama, etc.)
 * Enables swapping providers without changing agent logic.
 */

/**
 * LLM Provider interface
 *
 * Implementations:
 * - ClaudeProvider (Anthropic API)
 * - OpenAIProvider (OpenAI API)
 * - OllamaProvider (Local models)
 */
interface LLMProvider {
    /** Unique provider identifier */
    readonly id: string;
    /** Human-readable name */
    readonly name: string;
    /**
     * Send a chat completion request
     *
     * @param messages - Conversation history
     * @param options - Chat options (max tokens, tools, etc.)
     * @returns LLM response with content and optional tool calls
     */
    chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
    /**
     * Stream a chat completion response
     *
     * @param messages - Conversation history
     * @param options - Chat options
     * @yields Partial response chunks
     */
    stream?(messages: Message[], options?: ChatOptions): AsyncGenerator<string, void, unknown>;
    /**
     * Get provider capabilities
     *
     * @returns Capability information (tool calling, vision, etc.)
     */
    getCapabilities(): LLMCapabilities;
    /**
     * Check if the provider is configured and ready
     *
     * @returns Whether the provider can be used
     */
    isConfigured(): boolean;
    /**
     * Get the model ID for a given tier
     *
     * @param tier - Model tier (haiku, sonnet, opus)
     * @returns Model identifier string
     */
    getModelForTier?(tier: ModelTier): string;
}
/**
 * Factory for creating LLM providers
 */
interface LLMProviderFactory {
    /**
     * Create a provider instance
     *
     * @param config - Provider-specific configuration
     * @returns Configured provider instance
     */
    create(config: Record<string, unknown>): LLMProvider;
}

/**
 * ToolProvider Interface
 *
 * Abstraction for tool registries and execution.
 * Tools are the capabilities available to agents.
 */

/**
 * Executable tool with handler
 */
interface Tool extends ToolDefinition {
    /**
     * Execute the tool with given parameters
     *
     * @param params - Tool parameters
     * @param context - Execution context
     * @returns Tool result
     */
    execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult$1>;
}
/**
 * Tool Provider interface
 *
 * Provides access to tools and handles execution.
 */
interface ToolProvider {
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
    execute(id: string, params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult$1>;
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
interface ToolRegistry extends ToolProvider {
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
interface CompositeToolProvider extends ToolProvider {
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

/**
 * UserInterface Interface
 *
 * Abstraction for user interactions during agent execution.
 * Enables asking questions, confirmations, and notifications.
 */

/**
 * Request for user interaction
 */
interface InteractionRequest {
    /** Type of interaction */
    type: 'question' | 'confirmation' | 'choice' | 'multi-choice';
    /** Question text */
    question: string;
    /** Short header for display */
    header?: string;
    /** Available options */
    options?: QuestionOption[];
    /** Allow custom "Other" input */
    allowOther?: boolean;
    /** Timeout in milliseconds */
    timeout?: number;
}
/**
 * User Interface abstraction
 *
 * Provides methods for agent-user interactions during execution.
 */
interface UserInterface {
    /**
     * Ask the user a question
     *
     * @param request - Interaction request
     * @returns User's answer (string for single, array for multi)
     * @throws If user cancels or timeout
     */
    ask(request: InteractionRequest): Promise<string | string[]>;
    /**
     * Ask for confirmation
     *
     * @param message - Confirmation message
     * @returns Whether user confirmed
     */
    confirm(message: string): Promise<boolean>;
    /**
     * Show a notification to the user
     *
     * @param message - Notification message
     * @param type - Notification type (info, success, warning, error)
     */
    notify(message: string, type?: NotificationType): void;
    /**
     * Ask multiple structured questions (AskUserQuestion spec)
     *
     * @param questions - Array of questions (1-4)
     * @returns Answers keyed by header
     */
    askMultiple(questions: Question[]): Promise<Record<string, string | string[]>>;
    /**
     * Check if there's a pending interaction
     *
     * @returns Whether waiting for user input
     */
    isPending(): boolean;
    /**
     * Cancel any pending interaction
     */
    cancel(): void;
}
/**
 * User Interface factory
 */
interface UserInterfaceFactory {
    /**
     * Create a UI instance for a specific context
     *
     * @param context - UI context (e.g., 'modal', 'inline', 'cli')
     * @returns UserInterface instance
     */
    create(context: string): UserInterface;
}

/**
 * EventEmitter Interface
 *
 * Type-safe event emitter for AIOS events.
 * Enables loose coupling between components.
 */

/**
 * Event subscription handle
 */
interface EventSubscription {
    /** Unsubscribe from the event */
    unsubscribe(): void;
}
/**
 * Event handler function
 */
type EventHandler<T> = (payload: T) => void | Promise<void>;
/**
 * Type-safe event emitter interface
 */
interface EventEmitter {
    /**
     * Subscribe to an event
     *
     * @param event - Event name
     * @param handler - Event handler
     * @returns Subscription handle
     */
    on<K extends keyof AIOSEvents>(event: K, handler: EventHandler<AIOSEvents[K]>): EventSubscription;
    /**
     * Subscribe to an event once (auto-unsubscribe after first emit)
     *
     * @param event - Event name
     * @param handler - Event handler
     * @returns Subscription handle
     */
    once<K extends keyof AIOSEvents>(event: K, handler: EventHandler<AIOSEvents[K]>): EventSubscription;
    /**
     * Unsubscribe from an event
     *
     * @param event - Event name
     * @param handler - Event handler to remove
     */
    off<K extends keyof AIOSEvents>(event: K, handler: EventHandler<AIOSEvents[K]>): void;
    /**
     * Emit an event
     *
     * @param event - Event name
     * @param payload - Event payload
     */
    emit<K extends keyof AIOSEvents>(event: K, payload: AIOSEvents[K]): Promise<void>;
    /**
     * Emit an event synchronously (does not wait for async handlers)
     *
     * @param event - Event name
     * @param payload - Event payload
     */
    emitSync<K extends keyof AIOSEvents>(event: K, payload: AIOSEvents[K]): void;
    /**
     * Check if an event has listeners
     *
     * @param event - Event name
     * @returns Whether event has listeners
     */
    hasListeners(event: keyof AIOSEvents): boolean;
    /**
     * Get listener count for an event
     *
     * @param event - Event name
     * @returns Number of listeners
     */
    listenerCount(event: keyof AIOSEvents): number;
    /**
     * Remove all listeners
     *
     * @param event - Optional event to clear (clears all if not specified)
     */
    removeAllListeners(event?: keyof AIOSEvents): void;
}

/**
 * StateStore Interface
 *
 * Abstraction for state management within AIOS.
 * Enables reactive state updates and subscriptions.
 */
/**
 * State change callback
 */
type StateChangeCallback<T> = (value: T, previousValue: T | undefined) => void;
/**
 * State subscription handle
 */
interface StateSubscription {
    /** Unsubscribe from state changes */
    unsubscribe(): void;
}
/**
 * State Store interface
 *
 * Provides reactive state management for AIOS components.
 */
interface StateStore {
    /**
     * Get a value from the store
     *
     * @param key - State key
     * @returns Value if exists, undefined otherwise
     */
    get<T>(key: string): T | undefined;
    /**
     * Set a value in the store
     *
     * @param key - State key
     * @param value - Value to store
     */
    set<T>(key: string, value: T): void;
    /**
     * Delete a value from the store
     *
     * @param key - State key
     * @returns Whether value was deleted
     */
    delete(key: string): boolean;
    /**
     * Check if a key exists
     *
     * @param key - State key
     * @returns Whether key exists
     */
    has(key: string): boolean;
    /**
     * Get all keys in the store
     *
     * @returns Array of keys
     */
    keys(): string[];
    /**
     * Clear all values from the store
     */
    clear(): void;
    /**
     * Subscribe to changes for a specific key
     *
     * @param key - State key to watch
     * @param callback - Callback on change
     * @returns Subscription handle
     */
    subscribe<T>(key: string, callback: StateChangeCallback<T>): StateSubscription;
    /**
     * Subscribe to all changes in the store
     *
     * @param callback - Callback with key and new value
     * @returns Subscription handle
     */
    subscribeAll(callback: (key: string, value: unknown, previousValue: unknown) => void): StateSubscription;
    /**
     * Get a snapshot of the entire store
     *
     * @returns Record of all key-value pairs
     */
    snapshot(): Record<string, unknown>;
    /**
     * Restore store from a snapshot
     *
     * @param snapshot - Snapshot to restore
     */
    restore(snapshot: Record<string, unknown>): void;
}
/**
 * Namespaced state store for component isolation
 */
interface NamespacedStateStore extends StateStore {
    /** Namespace for this store */
    readonly namespace: string;
    /**
     * Create a child namespace
     *
     * @param name - Child namespace name
     * @returns Namespaced store
     */
    createChild(name: string): NamespacedStateStore;
}

/**
 * ConversationStore - Persistence for conversation state
 *
 * Provides checkpoint/resume functionality for AIOS conversations.
 * Stores conversation snapshots including:
 * - Message history
 * - Todo list state
 * - Conversation metadata
 *
 * Storage backends:
 * - In-memory (default, for short-term/session storage)
 * - LocalStorage (for browser persistence)
 * - File-based (future, via Tauri commands)
 */

/**
 * Snapshot of a conversation at a point in time
 */
interface ConversationSnapshot {
    /** Unique conversation identifier */
    id: string;
    /** Message history */
    history: Message[];
    /** Current todo list */
    todos: Todo$1[];
    /** Conversation status */
    status: ConversationStatus;
    /** Original user goal */
    originalGoal: string;
    /** Current turn number */
    turn: number;
    /** Whether in planning mode */
    isPlanning: boolean;
    /** Unix timestamp when created */
    createdAt: number;
    /** Unix timestamp when last updated */
    updatedAt: number;
    /** Optional metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Conversation summary for listing
 */
interface ConversationSummary {
    id: string;
    originalGoal: string;
    status: ConversationStatus;
    turn: number;
    createdAt: number;
    updatedAt: number;
    /** First few words of the goal for preview */
    preview: string;
}
/**
 * Storage backend interface
 */
interface StorageBackend {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    keys(prefix?: string): Promise<string[]>;
    clear(prefix?: string): Promise<void>;
}
/**
 * Configuration for ConversationStore
 */
interface ConversationStoreConfig {
    /** Storage backend to use */
    backend?: StorageBackend;
    /** Maximum snapshots to retain (default: 50) */
    maxSnapshots?: number;
    /** Auto-save interval in ms (0 to disable, default: 30000) */
    autoSaveIntervalMs?: number;
    /** Key prefix for storage (default: 'aios:conversation:') */
    keyPrefix?: string;
}
/**
 * ConversationStore class
 *
 * Manages conversation persistence with checkpoint/resume support.
 */
declare class ConversationStore {
    private config;
    private backend;
    private indexKey;
    constructor(config?: ConversationStoreConfig);
    /**
     * Save a conversation snapshot
     */
    save(snapshot: ConversationSnapshot): Promise<void>;
    /**
     * Load a conversation snapshot by ID
     */
    load(conversationId: string): Promise<ConversationSnapshot | null>;
    /**
     * Delete a conversation snapshot
     */
    delete(conversationId: string): Promise<boolean>;
    /**
     * List all conversation summaries
     */
    list(): Promise<ConversationSummary[]>;
    /**
     * Check if a conversation exists
     */
    exists(conversationId: string): Promise<boolean>;
    /**
     * Get the most recent conversation
     */
    getLatest(): Promise<ConversationSnapshot | null>;
    /**
     * Clear all stored conversations
     */
    clear(): Promise<void>;
    /**
     * Create a new snapshot from conversation state
     */
    createSnapshot(id: string, history: Message[], todos: Todo$1[], status: ConversationStatus, originalGoal: string, turn: number, isPlanning: boolean, metadata?: Record<string, unknown>): ConversationSnapshot;
    /**
     * Get storage statistics
     */
    getStats(): Promise<{
        count: number;
        oldestCreated: number | null;
        newestUpdated: number | null;
    }>;
    /**
     * Get the storage key for a conversation snapshot
     */
    private getSnapshotKey;
    /**
     * Get the conversation index
     */
    private getIndex;
    /**
     * Update the conversation index
     */
    private updateIndex;
    /**
     * Enforce maximum snapshot limit
     */
    private enforceMaxSnapshots;
    /**
     * Create a preview string from the goal
     */
    private createPreview;
    /**
     * Update configuration
     */
    updateConfig(config: Partial<ConversationStoreConfig>): void;
}
/**
 * Default conversation store instance
 *
 * Uses localStorage in browser, memory in tests
 */
declare const conversationStore: ConversationStore;

/**
 * DecisionLogger - Observability for Agent Decisions
 *
 * Provides structured logging of agent decisions during conversation execution.
 * Enables debugging by recording why the agent made specific choices.
 *
 * Example decisions logged:
 * - Intent classification (TRIVIAL, SIMPLE_QUERY, MULTI_STEP, COMPLEX)
 * - Tool exemption checks (allowed without TodoWrite)
 * - Checkpoint triggers (user confirmation needed)
 * - TodoWrite guidance level
 */
/**
 * A single logged decision
 */
interface DecisionLog {
    /** When this decision was made */
    timestamp: Date;
    /** Which turn in the conversation */
    turn: number;
    /** Type of decision (e.g., 'classified-intent', 'tool-exemption-check') */
    decision: string;
    /** Why this decision was made */
    reason: string;
    /** Input data used to make the decision */
    inputs: Record<string, any>;
    /** The outcome/result of the decision */
    outcome: string;
}
/**
 * Input for logging a decision (timestamp added automatically)
 */
type DecisionLogInput = Omit<DecisionLog, 'timestamp'>;
/**
 * Logs and retrieves agent decisions for observability and debugging.
 *
 * Usage:
 * ```typescript
 * const logger = new DecisionLogger();
 *
 * logger.log({
 *   turn: 1,
 *   decision: 'classified-intent',
 *   reason: 'detected query verb',
 *   inputs: { goal: 'search for notes' },
 *   outcome: 'complexity=SIMPLE_QUERY'
 * });
 *
 * console.log(logger.getDecisionsSummary());
 * ```
 */
declare class DecisionLogger {
    private logs;
    /**
     * Log a decision with automatic timestamp
     */
    log(entry: DecisionLogInput): void;
    /**
     * Get all logged decisions (returns a copy)
     */
    getDecisions(): DecisionLog[];
    /**
     * Get a formatted summary of all decisions
     */
    getDecisionsSummary(): string;
    /**
     * Get decisions for a specific turn
     */
    getDecisionsByTurn(turn: number): DecisionLog[];
    /**
     * Get decisions of a specific type
     */
    getDecisionsByType(decisionType: string): DecisionLog[];
    /**
     * Clear all logged decisions
     */
    clear(): void;
}
/**
 * Standard decision type names for consistency across the codebase
 */
declare const DecisionTypes: {
    /** Intent complexity classification */
    readonly CLASSIFIED_INTENT: "classified-intent";
    /** Tool exemption from TodoWrite requirement */
    readonly TOOL_EXEMPTION_CHECK: "tool-exemption-check";
    /** Checkpoint triggered before expensive operation */
    readonly TRIGGERED_CHECKPOINT: "triggered-checkpoint";
    /** TodoWrite guidance level set */
    readonly TODOWRITE_GUIDANCE: "todowrite-guidance";
    /** Reflection result processed */
    readonly REFLECTION_RESULT: "reflection-result";
    /** Verification result processed */
    readonly VERIFICATION_RESULT: "verification-result";
};
type DecisionType = (typeof DecisionTypes)[keyof typeof DecisionTypes];

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
type MetadataCategory = 'clarification' | 'planning' | 'query' | 'mutation' | 'execution';
type SideEffects = 'none' | 'reversible' | 'irreversible';
type CostLevel = 'free' | 'cheap' | 'expensive';
/**
 * Metadata for a tool describing its behavior and requirements
 */
interface ToolMetadata {
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
interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}
/**
 * Metadata for all known tools
 */
declare const TOOL_METADATA: Record<string, ToolMetadata>;
/**
 * Get metadata for a tool, with defaults for unknown tools
 */
declare function getToolMetadata(toolName: string): ToolMetadata;
/**
 * Check if a tool requires a TodoWrite plan before execution
 */
declare function toolRequiresTodoWrite(toolName: string): boolean;
/**
 * Check if a tool requires user confirmation before execution
 */
declare function toolRequiresConfirmation(toolName: string): boolean;
/**
 * Check if a tool can be executed in parallel with other tools
 */
declare function toolAllowsParallel(toolName: string): boolean;
/**
 * Partition tool calls into parallel-safe and sequential groups
 *
 * @param toolCalls - Array of tool calls to partition
 * @returns Object with parallel and sequential arrays
 *
 * Usage:
 * - Execute all `parallel` tools concurrently (Promise.all)
 * - Execute `sequential` tools one at a time after parallel complete
 */
declare function partitionToolCalls(toolCalls: ToolCall[]): {
    parallel: ToolCall[];
    sequential: ToolCall[];
};

/**
 * CheckpointManager - User Confirmation Before Expensive Operations
 *
 * Provides a "Shall I proceed?" pattern before:
 * - Irreversible operations (delete, bash)
 * - After planning (when many steps are planned)
 * - Before expensive operations (high token cost)
 *
 * This ensures user buy-in before committing to expensive or risky work.
 */

/**
 * Checkpoint trigger types
 */
type CheckpointTrigger = {
    type: 'before-mutation';
    toolNames: string[];
} | {
    type: 'after-planning';
    minSteps: number;
} | {
    type: 'before-irreversible';
} | {
    type: 'cost-threshold';
    estimatedTokens: number;
};
/**
 * Configuration for checkpoint behavior
 */
interface CheckpointConfig {
    /** Whether checkpoints are enabled */
    enabled: boolean;
    /** Triggers that cause a checkpoint */
    triggers: CheckpointTrigger[];
}

/**
 * DebugHarness - Structured trace logging and step-mode debugging for AIOS
 *
 * Produces JSONL trace files at logs/traces/trace-{conversationId}.jsonl
 * with a sidecar index at logs/traces/trace-{conversationId}.index.json
 *
 * The sidecar index maps phase+turn to line numbers so Claude Code (or a
 * future tracing UI) can jump to any section without reading the full file.
 *
 * Step mode pauses the ConversationEngine after each turn, letting you
 * inspect state from the browser console via window.__aiosDebug.
 */

/**
 * Phase tags for trace entries.
 * Every entry belongs to exactly one phase.
 */
type TracePhase = 'init' | 'classification' | 'turn-start' | 'llm-request' | 'llm-response' | 'todowrite-gate' | 'tool-exec' | 'tool-special' | 'error' | 'turn-end' | 'pause' | 'resume' | 'completion' | 'termination';
/**
 * A single trace entry (one line in the JSONL file)
 */
interface TraceEntry {
    /** Monotonic sequence number within this trace */
    seq: number;
    /** ISO timestamp */
    ts: string;
    /** Milliseconds since conversation started */
    elapsed: number;
    /** Current turn number (0 = pre-loop phases) */
    turn: number;
    /** Phase tag */
    phase: TracePhase;
    /** What happened (e.g., 'conversation-started', 'tool:vault_search') */
    event: string;
    /** Structured payload (varies by event) */
    data: Record<string, unknown>;
}
/**
 * Section entry in the sidecar index
 */
interface TraceSectionEntry {
    phase: TracePhase;
    turn: number;
    seq: number;
    /** 1-indexed line number in the JSONL file */
    line: number;
}
/**
 * Sidecar index file (trace-{id}.index.json)
 */
interface TraceIndex {
    conversationId: string;
    goal: string;
    startedAt: string;
    config: Record<string, unknown>;
    /** Section map: phase+turn → line number */
    sections: TraceSectionEntry[];
    totalEntries: number;
    status: ConversationStatus | 'running';
}
declare class DebugHarness {
    private conversationId;
    private entries;
    private buffer;
    private seq;
    private startTime;
    private currentTurn;
    private lineCount;
    private index;
    private seenPhaseTurns;
    private _stepMode;
    private stepResolve;
    private _disposed;
    private tracePath;
    private indexPath;
    private flushTimer;
    private _getHistory;
    private _getTodos;
    private _getDecisions;
    constructor(conversationId: string, goal?: string, config?: Record<string, unknown>);
    /**
     * Record a trace entry. This is the primary API.
     *
     * @param phase - Which phase of the conversation loop
     * @param event - Specific event name (e.g., 'tool:vault_search', 'intent-classified')
     * @param data  - Structured payload (auto-truncated if large)
     */
    trace(phase: TracePhase, event: string, data?: Record<string, unknown>): void;
    /**
     * Set the current turn (called by ConversationEngine at turn start)
     */
    setTurn(turn: number): void;
    /**
     * Update the conversation ID after the engine generates the real one.
     * Updates the index metadata and file paths (no rename needed since
     * nothing has been flushed under the old placeholder ID yet).
     */
    setConversationId(id: string): void;
    /**
     * Update the goal text (may not be known at construction time)
     */
    setGoal(goal: string): void;
    /**
     * Mark the final status of this trace
     */
    setStatus(status: ConversationStatus): void;
    /**
     * Turn gate — called at the end of each turn in runLoop.
     * If step mode is active, blocks until step() is called.
     */
    turnGate(turn: number): Promise<void>;
    /** Advance one turn. Called from console: __aiosDebug.step() */
    step(): void;
    /** Enable/disable step mode */
    setStepMode(enabled: boolean): void;
    /** Whether step mode is active */
    get stepMode(): boolean;
    /** Get all entries for a specific turn */
    inspectTurn(turn: number): TraceEntry[];
    /** Get all entries for a specific phase */
    inspectPhase(phase: TracePhase): TraceEntry[];
    /** Get entries filtered by turn AND phase */
    inspect(turn: number, phase: TracePhase): TraceEntry[];
    /** Get all entries */
    allEntries(): TraceEntry[];
    /** Compact text summary of the trace so far */
    summary(): string;
    /**
     * Diagnose a query about the trace.
     * Returns a compact text summary filtered to the relevant entries.
     *
     * Examples:
     *   diagnose('turn 3')          → all entries for turn 3
     *   diagnose('errors')          → all error-phase entries
     *   diagnose('tool vault_search') → tool-exec entries matching vault_search
     *   diagnose('why blocked')     → todowrite-gate entries where blocked=true
     */
    diagnose(query: string): string;
    setHistoryRef(fn: () => Message[]): void;
    setTodosRef(fn: () => Todo$1[]): void;
    setDecisionsRef(fn: () => DecisionLog[]): void;
    getConsoleAPI(): DebugConsoleAPI;
    /**
     * Flush buffered entries to the JSONL trace file and update the sidecar index.
     */
    flush(): Promise<void>;
    /**
     * Finalize — flush remaining, update status, stop timer.
     * Called when conversation ends (success, error, cancel, timeout).
     */
    finalize(status: ConversationStatus): Promise<void>;
    /**
     * Dispose — release resources, unblock any pending step gate.
     * Safe to call multiple times.
     */
    dispose(): void;
    /**
     * Sanitize data payload — truncate large fields, handle non-serializable values.
     */
    private sanitizeData;
    private ensureDir;
}
interface DebugConsoleAPI {
    step: () => void;
    setStepMode: (on: boolean) => void;
    readonly stepMode: boolean;
    inspectTurn: (n: number) => TraceEntry[];
    inspectPhase: (p: TracePhase) => TraceEntry[];
    inspect: (turn: number, phase: TracePhase) => TraceEntry[];
    allEntries: () => TraceEntry[];
    summary: () => string;
    diagnose: (query: string) => string;
    getHistory: () => Message[];
    getTodos: () => Todo$1[];
    getDecisions: () => DecisionLog[];
    getTracePath: () => string;
    getIndexPath: () => string;
    flush: () => Promise<void>;
}
/**
 * Install a stub API on window.__aiosDebug immediately.
 * This lets you pre-configure step mode BEFORE triggering a goal:
 *
 *   window.__aiosDebugEnabled = true
 *   window.__aiosDebug.setStepMode(true)
 *   // now trigger a goal — it will pause after turn 1
 *
 * The real harness replaces this stub when execute() runs,
 * inheriting the pending config.
 */
declare function installDebugStub(): void;
/**
 * Read any pending config from the stub (if one was installed),
 * and apply it to the real harness.
 */
declare function absorbPendingConfig(harness: DebugHarness): void;
declare global {
    interface Window {
        __aiosDebug?: DebugConsoleAPI;
        __aiosDebugEnabled?: boolean;
    }
}

/**
 * ConversationEngine - Core conversation loop for AIOS
 *
 * Implements a multi-turn conversation pattern inspired by Claude Code.
 * Unlike ReAct, this uses native LLM tool calling without explicit markers.
 */

/**
 * Configuration for conversation execution
 */
interface ConversationConfig {
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
    retry?: RetryConfig$1;
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
interface GoalSessionStartContext {
    goalId: string;
    goalName: string;
    conversationId: string;
    timestamp: number;
}
/**
 * Context passed to onSessionComplete callback
 */
interface GoalSessionCompleteContext {
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
interface GoalSessionSummary {
    toolsExecuted: string[];
    outputPaths: string[];
    tasksCreated: number;
    tasksCompleted: number;
}
/**
 * Dependencies for ConversationEngine
 */
interface ConversationEngineDeps {
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
declare class ConversationEngine {
    private llm;
    private tools;
    private ui;
    private events;
    private history;
    private status;
    private abortController;
    private conversationId;
    private hasPlan;
    private planEnforcementAttempts;
    private readonly MAX_PLAN_ENFORCEMENT_ATTEMPTS;
    private originalGoal;
    private currentTodos;
    private contextCompressor;
    private retryPolicy;
    private store;
    private currentTurn;
    private autoCheckpoint;
    private intentClassification;
    private decisionLogger;
    private toolResults;
    private outputPaths;
    private hasProducedOutput;
    private lastConfig;
    private debugHarness;
    private llmClassifyFn;
    constructor(deps: ConversationEngineDeps);
    /**
     * Attach a debug harness for structured trace logging and step-mode.
     * When attached, every phase of the conversation loop emits trace entries.
     */
    setDebugHarness(harness: DebugHarness): void;
    /**
     * Execute a conversation with the given prompt
     */
    execute(prompt: string, config?: ConversationConfig): Promise<ConversationResult>;
    /**
     * Emit goal session completed event and call callback
     */
    private emitGoalSessionCompleted;
    /**
     * Cancel the current conversation
     */
    cancel(): void;
    /**
     * Check if conversation is running
     */
    isRunning(): boolean;
    /**
     * Check if conversation is paused (waiting for contract approval)
     */
    isPaused(): boolean;
    /**
     * Get current conversation status
     */
    getStatus(): ConversationStatus;
    /**
     * Get decision log for debugging/observability
     */
    getDecisionLog(): DecisionLog[];
    /**
     * Get decision log summary as a string
     */
    getDecisionSummary(): string;
    /**
     * Resume conversation after contract approval.
     * Adds approval confirmation to history and continues execution.
     */
    resumeWithApproval(contractPath: string): Promise<ConversationResult>;
    /**
     * Resume conversation with requested changes to the contract.
     * Adds feedback to history and allows agent to revise.
     */
    resumeWithChanges(feedback: string): Promise<ConversationResult>;
    /**
     * Reject the contract and end the conversation.
     */
    rejectContract(reason?: string): Promise<ConversationResult>;
    /**
     * Main conversation loop
     */
    private runLoop;
    /**
     * Execute a single tool call
     */
    private executeTool;
    /**
     * Handle AskUserQuestion tool
     */
    private handleAskUserQuestion;
    /**
     * Handle TodoWrite tool
     */
    private handleTodoWrite;
    /**
     * Handle submit_contract tool
     *
     * Submits a contract for user approval. This pauses the conversation
     * until the user approves, requests changes, or rejects.
     */
    private handleSubmitContract;
    /**
     * Handle batch_tools meta-tool
     *
     * Executes multiple tool calls from a single LLM response.
     * This allows models that can't natively produce parallel tool calls
     * to still execute multiple tools per turn.
     *
     * Pause tools (submit_contract) are deferred to execute last.
     */
    private handleBatchTools;
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
    private formatToolResult;
    /**
     * Create a conversation result
     */
    private createResult;
    /**
     * Get content from last assistant message
     */
    private getLastAssistantContent;
    /**
     * Count conversation turns (assistant messages)
     */
    private countTurns;
    /**
     * Generate a unique conversation ID
     */
    private generateId;
    /**
     * Save conversation session to goal memory
     */
    private saveGoalSession;
    /**
     * Save current conversation state as a checkpoint
     *
     * Can be called manually or automatically after each turn.
     */
    checkpoint(): Promise<void>;
    /**
     * Resume a conversation from a saved checkpoint
     *
     * @param conversationId - ID of the conversation to resume
     * @param config - Optional configuration overrides
     * @returns ConversationResult from continued execution
     */
    resume(conversationId: string, config?: ConversationConfig): Promise<ConversationResult>;
    /**
     * List all saved conversations
     */
    listCheckpoints(): Promise<Array<{
        id: string;
        originalGoal: string;
        status: ConversationStatus;
        turn: number;
        createdAt: number;
        updatedAt: number;
        preview: string;
    }>>;
    /**
     * Delete a saved conversation checkpoint
     */
    deleteCheckpoint(conversationId: string): Promise<boolean>;
    /**
     * Get the current conversation ID
     */
    getConversationId(): string;
    /**
     * Enable or disable auto-checkpoint after each turn
     */
    setAutoCheckpoint(enabled: boolean): void;
    /**
     * Set a custom conversation store
     */
    setStore(store: ConversationStore): void;
}

/**
 * TodoManager - Task management for AIOS
 *
 * Implements TodoWrite-style task tracking with:
 * - Only one task in_progress at a time
 * - Immediate completion updates
 * - Event emission for UI reactivity
 */

/**
 * Result from TodoManager operations
 */
interface TodoResult {
    success: boolean;
    error?: string;
}
/**
 * Callback for todo changes
 */
type TodoChangeCallback = (todos: Todo$1[]) => void;
/**
 * TodoManager class
 *
 * Manages a list of todos with validation and events.
 */
declare class TodoManager {
    private todos;
    private subscribers;
    private events;
    private isProcessingEvent;
    constructor(events: EventEmitter);
    /**
     * Handle external todo updates (from ConversationEngine)
     * Updates internal state and notifies subscribers without re-emitting events
     */
    private handleExternalUpdate;
    /**
     * Get all todos
     */
    getTodos(): Todo$1[];
    /**
     * Get count of todos
     */
    count(): number;
    /**
     * Set the entire todo list (replaces existing)
     */
    setTodos(todos: Todo$1[]): TodoResult;
    /**
     * Clear all todos
     */
    clear(): void;
    /**
     * Get pending todos
     */
    getPending(): Todo$1[];
    /**
     * Get in_progress todos
     */
    getInProgress(): Todo$1[];
    /**
     * Get completed todos
     */
    getCompleted(): Todo$1[];
    /**
     * Get the current task (in_progress)
     */
    getCurrentTask(): Todo$1 | null;
    /**
     * Get progress percentage (0-100)
     */
    getProgress(): number;
    /**
     * Start a task (pending -> in_progress)
     */
    startTask(index: number): TodoResult;
    /**
     * Complete a task (in_progress -> completed)
     */
    completeTask(index: number): TodoResult;
    /**
     * Add a new task
     */
    addTask(content: string, activeForm: string): TodoResult;
    /**
     * Remove a task
     */
    removeTask(index: number): TodoResult;
    /**
     * Subscribe to todo changes
     */
    subscribe(callback: TodoChangeCallback): () => void;
    /**
     * Notify subscribers of changes
     */
    private notifySubscribers;
    /**
     * Emit events for status changes
     */
    private emitStatusChangeEvents;
}

/**
 * TaskSpawner - Sub-agent spawning for AIOS
 *
 * Implements the Task tool pattern from Claude Code:
 * - Spawns isolated sub-agents for specific tasks
 * - Different agent types with different capabilities
 * - Background task execution support
 */

/**
 * Configuration for creating an agent
 */
interface AgentConfig {
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
interface Agent {
    execute(prompt: string): Promise<ConversationResult>;
    cancel(): void;
    isRunning(): boolean;
}
/**
 * Factory for creating agents
 */
interface AgentFactory {
    create(config: AgentConfig): Agent;
}
/**
 * TaskSpawner class
 *
 * Manages spawning and tracking of sub-agents.
 */
declare class TaskSpawner {
    private agentFactory;
    private events;
    private tasks;
    constructor(agentFactory: AgentFactory, events: EventEmitter);
    /**
     * Spawn a new task
     */
    spawn(params: TaskParams): Promise<TaskResult>;
    /**
     * Check if a task is running
     */
    isRunning(taskId: string): boolean;
    /**
     * Get result of a task (may be undefined if still running)
     */
    getResult(taskId: string): Promise<TaskResult | undefined>;
    /**
     * Get all running tasks
     */
    getRunningTasks(): Array<{
        taskId: string;
        type: SubAgentType;
    }>;
    /**
     * Cancel a running task
     */
    cancel(taskId: string): void;
    /**
     * Cancel all running tasks
     */
    cancelAll(): void;
    /**
     * Execute an agent and handle result
     */
    private executeAgent;
    /**
     * Handle task completion
     */
    private handleCompletion;
    /**
     * Handle task error
     */
    private handleError;
    /**
     * Create a TaskResult from ConversationResult
     */
    private createTaskResult;
    /**
     * Generate a unique task ID
     */
    private generateTaskId;
}

/**
 * PlanManager - Planning mode for AIOS
 *
 * Implements EnterPlanMode/ExitPlanMode pattern:
 * - Explicit planning mode state
 * - Plan content management
 * - Approval workflow
 */

/**
 * Result from PlanManager operations
 */
interface PlanResult {
    success: boolean;
    error?: string;
    warning?: string;
}
/**
 * Options for waiting for approval
 */
interface ApprovalWaitOptions {
    /** Timeout in milliseconds (0 = no timeout) */
    timeoutMs?: number;
}
/**
 * Callback for state changes
 */
type PlanStateCallback = (state: PlanState) => void;
/**
 * PlanManager class
 *
 * Manages planning mode state and approval workflow.
 */
declare class PlanManager {
    private _isPlanning;
    private _planContent;
    private _approvalStatus;
    private events;
    private subscribers;
    private approvalResolver;
    constructor(events: EventEmitter);
    /**
     * Check if in planning mode
     */
    isPlanning(): boolean;
    /**
     * Get current state snapshot
     */
    getState(): PlanState;
    /**
     * Enter planning mode
     */
    enter(): void;
    /**
     * Exit planning mode
     */
    exit(approved: boolean): PlanResult;
    /**
     * Set plan content
     */
    setPlanContent(content: string): PlanResult;
    /**
     * Append to plan content
     */
    appendToPlan(content: string): PlanResult;
    /**
     * Approve the plan
     */
    approve(): PlanResult;
    /**
     * Reject the plan
     */
    reject(): PlanResult;
    /**
     * Wait for user approval
     */
    waitForApproval(options?: ApprovalWaitOptions): Promise<boolean>;
    /**
     * Subscribe to state changes
     */
    subscribe(callback: PlanStateCallback): () => void;
    /**
     * Notify subscribers of state change
     */
    private notifySubscribers;
}

/**
 * ContextCompressor - Manages conversation history to prevent context overflow
 *
 * Compresses older messages by summarizing them while preserving recent context.
 * This ensures long conversations can continue without hitting token limits.
 */

/**
 * Result from compression operation
 */
interface CompressionResult {
    /** Compressed message history */
    messages: Message[];
    /** Estimated tokens in original history */
    originalTokens: number;
    /** Estimated tokens after compression */
    compressedTokens: number;
    /** Number of turns that were summarized */
    summarizedTurns: number;
    /** Whether compression was applied */
    wasCompressed: boolean;
}
declare class ContextCompressor {
    private llm;
    private config;
    constructor(llm: LLMProvider, config?: CompressionConfig);
    /**
     * Compress conversation history if needed
     *
     * @param history - Full conversation history
     * @param systemPrompt - Optional system prompt (counted separately)
     * @returns Compressed history with metadata
     */
    compress(history: Message[], systemPrompt?: string): Promise<CompressionResult>;
    /**
     * Parse history into system messages, initial user message, and turns
     */
    private parseHistory;
    /**
     * Generate a summary of conversation turns
     */
    private summarizeTurns;
    /**
     * Estimate token count for a list of messages
     */
    private estimateTokens;
    /**
     * Estimate token count for a string
     */
    private estimateMessageTokens;
    /**
     * Update configuration
     */
    updateConfig(config: Partial<CompressionConfig>): void;
    /**
     * Get current configuration
     */
    getConfig(): Required<CompressionConfig>;
}

/**
 * ToolRetryPolicy - Retry logic with exponential backoff for tool execution
 *
 * Provides automatic retry for transient failures with configurable:
 * - Maximum attempts
 * - Exponential backoff with jitter
 * - Retryable error classification
 * - Abort signal support
 */
/**
 * Configuration for retry behavior
 */
interface RetryConfig {
    /** Maximum number of retry attempts (default: 3) */
    maxAttempts?: number;
    /** Initial delay in ms before first retry (default: 1000) */
    baseDelayMs?: number;
    /** Maximum delay in ms between retries (default: 10000) */
    maxDelayMs?: number;
    /** Multiplier for exponential backoff (default: 2) */
    backoffMultiplier?: number;
    /** Add random jitter to delays (default: true) */
    jitter?: boolean;
    /** Error message patterns that are retryable */
    retryableErrors?: string[];
}
/**
 * Result from a retry operation
 */
interface RetryResult<T> {
    /** Whether the operation eventually succeeded */
    success: boolean;
    /** The result if successful */
    result?: T;
    /** Total number of attempts made */
    attempts: number;
    /** Last error message if failed */
    lastError?: string;
    /** Total time spent in ms */
    totalTimeMs: number;
}
/**
 * Options for a single retry execution
 */
interface RetryOptions {
    /** Custom function to determine if an error is retryable */
    isRetryable?: (error: Error) => boolean;
    /** Callback on each retry attempt */
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}
declare class ToolRetryPolicy {
    private config;
    constructor(config?: RetryConfig);
    /**
     * Execute a function with retry logic
     *
     * @param fn - The async function to execute
     * @param options - Retry options
     * @returns Result with success status and attempt count
     */
    execute<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<RetryResult<T>>;
    /**
     * Determine if an error should trigger a retry
     */
    private shouldRetry;
    /**
     * Calculate delay for the current attempt with exponential backoff and optional jitter
     */
    private calculateDelay;
    /**
     * Sleep for specified duration, respecting abort signal
     */
    private sleep;
    /**
     * Update configuration
     */
    updateConfig(config: Partial<RetryConfig>): void;
    /**
     * Get current configuration
     */
    getConfig(): Required<RetryConfig>;
    /**
     * Create a retry policy for specific tool characteristics
     */
    static forToolType(toolType: 'network' | 'filesystem' | 'compute'): ToolRetryPolicy;
}

/**
 * Intent Classifier
 *
 * Classifies user goals by complexity to determine appropriate handling:
 * - TRIVIAL: Direct response, no tools needed
 * - SIMPLE_QUERY: One tool call, no planning needed
 * - MULTI_STEP: Needs TodoWrite for tracking
 * - COMPLEX: Needs clarification + TodoWrite + verification
 *
 * Uses a two-phase approach:
 * 1. Fast path: Regex pattern matching (instant, no LLM call)
 * 2. LLM path: Haiku classification for nuanced understanding
 *
 * Falls back to regex if LLM is unavailable or fails.
 */

/**
 * Task complexity levels
 */
declare enum TaskComplexity {
    /** No tools needed - direct LLM response (e.g., "what is 2+2", "hello") */
    TRIVIAL = "trivial",
    /** One tool, no planning needed (e.g., "search for X", "find notes") */
    SIMPLE_QUERY = "simple_query",
    /** Needs todo, possibly clarification (e.g., "create a note", "plan a trip") */
    MULTI_STEP = "multi_step",
    /** Needs clarification + todo + verification (e.g., ambiguous goals, 3+ deliverables) */
    COMPLEX = "complex"
}
/**
 * Suggested actions based on classification
 */
type SuggestedAction = 'ask_clarification' | 'create_todo' | 'checkpoint_before_execution' | 'verify_output';
/**
 * Result of intent classification
 */
interface ClassificationResult {
    /** Detected task complexity */
    complexity: TaskComplexity;
    /** Confidence score (0-1) */
    confidence: number;
    /** Suggested actions based on complexity */
    suggestedActions: SuggestedAction[];
    /** Human-readable reasoning for the classification */
    reasoning: string;
}
/**
 * Injectable LLM function for classification.
 * Accepts messages and options, returns raw text content.
 * This decouples the classifier from any specific LLM provider.
 */
type KernelLLMClassifyFn = (messages: Message[], options?: {
    maxTokens?: number;
    temperature?: number;
}) => Promise<{
    content: string;
}>;
/**
 * Classify user intent using a two-phase approach:
 *
 * Phase 1: Regex pre-screen (fast, no LLM call)
 *   - High-confidence TRIVIAL/SIMPLE_QUERY results skip LLM entirely
 *   - This covers greetings, empty input, clear query verbs (~30-40% of inputs)
 *
 * Phase 2: LLM classification (Haiku, ~200-500ms)
 *   - For everything else: creation tasks, ambiguous input, complex goals
 *   - Uses conversation history for richer context understanding
 *
 * Fallback: If LLM fails, returns the regex classification result.
 *
 * @param goal - User's goal/request text
 * @param conversationHistory - Previous messages for context
 * @param llmFn - Optional injectable LLM function (omit for regex-only mode)
 * @returns Classification result with complexity, confidence, and suggestions
 *
 * @example
 * ```typescript
 * // With LLM (recommended)
 * const result = await classifyIntent('plan a trip to Dubai', [], myLLMFn);
 *
 * // Without LLM (regex-only fallback)
 * const result = await classifyIntent('hello', []);
 * ```
 */
declare function classifyIntent(goal: string, conversationHistory: Message[], llmFn?: KernelLLMClassifyFn): Promise<ClassificationResult>;
/**
 * Check if a task is simple enough to skip TodoWrite entirely.
 *
 * @param classification - Result from classifyIntent
 * @returns true if TodoWrite can be skipped
 */
declare function canSkipTodoWrite(classification: ClassificationResult): boolean;
/**
 * Check if a task needs clarification before proceeding.
 *
 * @param classification - Result from classifyIntent
 * @returns true if clarification should be requested
 */
declare function needsClarification(classification: ClassificationResult): boolean;

/**
 * VerificationEngine - Post-Completion Quality Assurance
 *
 * Verifies that agent output meets quality standards:
 * - All todos completed
 * - No errors in tool execution
 * - Output files exist (if applicable)
 *
 * Supports two strategies:
 * - rule-based: Fast, deterministic checks
 * - subagent: LLM-based verification for complex outputs
 * - hybrid: Rules first, subagent if rules pass
 */
/**
 * Status of a todo item
 */
type TodoStatus = 'pending' | 'in_progress' | 'completed';
/**
 * A todo item
 */
interface Todo {
    id: string;
    content: string;
    status: TodoStatus;
}
/**
 * Result of a tool execution
 */
interface ToolResult {
    toolName: string;
    success: boolean;
    output?: string;
    error?: string;
}
/**
 * Context for verification
 */
interface VerificationContext {
    /** Original user goal */
    goal: string;
    /** List of todos that were tracked */
    todos: Todo[];
    /** Names of tools that were executed */
    toolsExecuted: string[];
    /** Paths of output files created */
    outputPaths: string[];
    /** Results from tool executions */
    toolResults: ToolResult[];
}
/**
 * Result of verification
 */
interface VerificationResult {
    /** Whether all checks passed */
    passed: boolean;
    /** List of issues found */
    issues: string[];
    /** Suggestions for improvement */
    suggestions: string[];
}
/**
 * A verification rule
 */
interface VerificationRule {
    /** Rule name for identification */
    name: string;
    /** Check function - returns true if passed */
    check: (output: any, context: VerificationContext) => boolean | Promise<boolean>;
    /** Message to display if check fails */
    failureMessage: string;
    /** Optional suggestion for fixing the issue */
    suggestion?: string;
}
/**
 * Verification strategy
 */
type VerificationStrategy = 'rule-based' | 'subagent' | 'hybrid';
/**
 * Configuration for verification
 */
interface VerificationConfig {
    /** Whether verification is enabled */
    enabled: boolean;
    /** Verification strategy */
    strategy: VerificationStrategy;
    /** Rules to apply (for rule-based and hybrid) */
    rules?: VerificationRule[];
}
/**
 * Engine for verifying agent output quality
 */
declare class VerificationEngine {
    private config;
    constructor(config: VerificationConfig);
    /**
     * Verify the output against rules
     */
    verify(output: any, context: VerificationContext): Promise<VerificationResult>;
}

/**
 * TodoWriteGuidance - Gradient Guidance for TodoWrite Usage
 *
 * Provides varying levels of guidance for using TodoWrite based on:
 * - Task complexity level (from IntentClassifier)
 * - Current turn number
 * - Whether output has been produced
 *
 * Levels:
 * - 'none': No guidance needed (trivial tasks, simple queries)
 * - 'soft': Gentle reminder to consider TodoWrite
 * - 'strong': Emphatic recommendation to use TodoWrite
 *
 * Note: We no longer hard-block; this is guidance only.
 */

/**
 * Guidance levels for TodoWrite usage
 */
type TodoWriteGuidanceLevel = 'none' | 'soft' | 'strong';
/**
 * Input parameters for determining guidance
 */
interface TodoWriteGuidanceInput {
    /** Task complexity from IntentClassifier */
    complexity: TaskComplexity;
    /** Current turn number (1-indexed) */
    turnNumber: number;
    /** Whether any output has been produced */
    hasProducedOutput: boolean;
}
/**
 * Result of guidance determination
 */
interface TodoWriteGuidanceResult {
    /** The guidance level */
    level: TodoWriteGuidanceLevel;
    /** Human-readable message (null if no guidance needed) */
    message: string | null;
}
/**
 * Determine the appropriate TodoWrite guidance level based on context
 *
 * Rules:
 * - TRIVIAL / SIMPLE_QUERY: Never need TodoWrite
 * - MULTI_STEP: Soft guidance on turns 1-2, none after
 * - COMPLEX: Strong on turn 1, soft on turn 2-3, none after
 * - If output has been produced, no guidance (already working)
 */
declare function getTodoWriteGuidance(input: TodoWriteGuidanceInput): TodoWriteGuidanceResult;

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
declare const TODOWRITE_EXEMPT_TOOLS: readonly string[];
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
declare function isToolExemptFromTodoWrite(toolName: string): boolean;
/**
 * Tool call structure (minimal interface for filtering)
 * Compatible with both { arguments } from tests and { params } from AIOS types
 */
interface ToolCallLike {
    id: string;
    name: string;
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
declare function filterExemptTools<T extends ToolCallLike>(toolCalls: T[] | undefined | null): T[];
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
declare function filterActionTools<T extends ToolCallLike>(toolCalls: T[] | undefined | null): T[];

/**
 * Vercel AI SDK LLM Provider
 *
 * Implements LLMProvider interface using Vercel AI SDK.
 * This is a standalone implementation that can be configured with any
 * Vercel AI SDK compatible model.
 */

type CoreTool = any;
type LanguageModel = any;
/**
 * Interface for providing language models
 */
interface ModelProvider {
    /** Get a language model */
    getModel(modelId?: string): LanguageModel;
    /** Check if provider is configured */
    isConfigured(): boolean;
}
/**
 * Tool registry interface for getting tools with Zod schemas
 */
interface ToolRegistryProvider {
    /** Get tools for AI with proper schemas */
    getToolsForAI(options?: {
        ids?: string[];
    }): Record<string, CoreTool>;
}
/**
 * Set the model provider
 */
declare function setModelProvider(provider: ModelProvider): void;
/**
 * Set the tool registry provider (optional)
 */
declare function setToolRegistryProvider(provider: ToolRegistryProvider): void;
type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'custom';
/**
 * Configuration for VercelAILLMProvider
 */
interface VercelAILLMProviderConfig {
    /** Provider type */
    providerType?: ProviderType;
    /** Specific model ID to use */
    modelId?: string;
    /** Direct model instance (bypasses registry) */
    model?: LanguageModel;
}
/**
 * LLM Provider implementation using Vercel AI SDK
 */
declare class VercelAILLMProvider {
    readonly id: string;
    readonly name: string;
    private providerType;
    private modelId?;
    private directModel?;
    constructor(config?: VercelAILLMProviderConfig);
    /**
     * Get the language model to use
     */
    private getModel;
    /**
     * Chat completion with tool support
     */
    chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
    /**
     * Streaming chat completion
     */
    stream(messages: Message[], options?: ChatOptions): AsyncGenerator<string>;
    /**
     * Get provider capabilities
     */
    getCapabilities(): LLMCapabilities;
    /**
     * Check if provider is configured
     */
    isConfigured(): boolean;
    /**
     * Create provider with a direct model instance
     */
    static withModel(model: LanguageModel, providerType?: ProviderType): VercelAILLMProvider;
    /**
     * Create provider for specific model tier (requires modelProvider to be set)
     */
    static forTier(tier: 'haiku' | 'sonnet' | 'opus'): VercelAILLMProvider;
}
/**
 * Create default LLM provider using current settings
 */
declare function createDefaultLLMProvider(): VercelAILLMProvider;

/**
 * GoalContextProvider - Stub implementation for AIOS
 *
 * This is a minimal stub that provides the interface expected by ConversationEngine.
 * In Metaglass, this is replaced with a full implementation that connects to the goal system.
 *
 * For standalone AIOS usage, goals are optional - this stub returns no-ops.
 */
/**
 * GoalContextProvider class
 *
 * Provides a minimal implementation that can be overridden by integrators.
 */
declare class GoalContextProviderImpl {
    private context;
    /**
     * Set the active goal for context
     */
    setActiveGoal(goalId: string, goalName: string): void;
    /**
     * Clear the active goal
     */
    clearActiveGoal(): void;
    /**
     * Check if there's an active goal
     */
    hasActiveGoal(): boolean;
    /**
     * Get the current active goal ID
     */
    getActiveGoalId(): string | null;
    /**
     * Get the current active goal name
     */
    getActiveGoalName(): string | null;
    /**
     * Get context for the current goal (stub - returns empty)
     */
    getGoalContext(): Promise<string>;
}
declare const goalContextProvider: GoalContextProviderImpl;

/**
 * AIOS Service
 *
 * Main entry point for the AI Operating System.
 * Provides a high-level API for executing conversations and managing tasks.
 *
 * This service is designed to be pluggable - integrators can provide custom
 * implementations for LLM, tools, UI, and events.
 */

/**
 * Memory context for enhanced prompts
 */
interface MemoryContext {
    success: boolean;
    memories: Array<{
        content: string;
        relevance?: number;
    }>;
    userProfile?: string;
}
/**
 * Provider factories that can be injected
 */
interface AIOSProviders {
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
    getMemoryContext?: (messages: Message[], options: {
        maxMemories?: number;
        includeProfile?: boolean;
    }) => Promise<MemoryContext>;
    /** Build enhanced system prompt with memory context (optional) */
    buildEnhancedSystemPrompt?: (basePrompt: string, memoryContext: MemoryContext, userGoal: string) => Promise<string>;
}
/**
 * Set the providers for AIOS
 */
declare function setProviders(providers: Partial<AIOSProviders>): void;
/**
 * Get current providers
 */
declare function getProviders(): AIOSProviders;
/**
 * Configuration for AIOS Service
 */
interface AIOSConfig {
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
declare class AIOSService {
    private config;
    private providers;
    private conversationEngine;
    private todoManager;
    private taskSpawner;
    private planManager;
    private toolProvider;
    constructor(config?: AIOSConfig);
    /**
     * Execute a conversation with the given prompt
     */
    execute(prompt: string, config?: ConversationConfig): Promise<ConversationResult>;
    /**
     * Cancel the current conversation
     */
    cancel(): void;
    /**
     * Check if a conversation is running
     */
    isRunning(): boolean;
    getTodos(): Todo$1[];
    getProgress(): number;
    onTodosChange(callback: (todos: Todo$1[]) => void): () => void;
    isPlanning(): boolean;
    getPlanState(): PlanState;
    approvePlan(): void;
    rejectPlan(): void;
    onPlanChange(callback: (state: PlanState) => void): () => void;
    isPaused(): boolean;
    resumeWithApproval(contractPath: string): Promise<ConversationResult>;
    resumeWithChanges(feedback: string): Promise<ConversationResult>;
    rejectContract(reason?: string): Promise<ConversationResult>;
    spawnTask(params: TaskParams): Promise<TaskResult>;
    isTaskRunning(taskId: string): boolean;
    cancelTask(taskId: string): void;
    isConfigured(): boolean;
    getToolProvider(): ToolProvider;
    private createConversationEngine;
    private createAgentFactory;
}
declare function getAIOSService(): AIOSService;
declare function createAIOSService(config?: AIOSConfig): AIOSService;
declare function resetAIOSService(): void;

/**
 * Simple Logger for AIOS
 *
 * Provides structured logging with configurable levels.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/**
 * Create a logger with a specific prefix
 */
declare function createLogger(prefix: string): Logger;
/**
 * Set the global log level
 */
declare function setLogLevel(level: LogLevel): void;
/**
 * Get the current log level
 */
declare function getLogLevel(): LogLevel;

/**
 * Backend Abstraction for AIOS
 *
 * Provides an abstraction layer for backend commands that can be:
 * 1. Used with Tauri (in Metaglass)
 * 2. Used with Node.js
 * 3. Used with a custom backend
 *
 * By default, operations are no-ops. Integrators can set a custom backend.
 */
/**
 * Backend interface for AIOS operations
 */
interface AIOSBackend {
    /** Invoke a backend command */
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
/**
 * Set the backend implementation
 */
declare function setBackend(backend: AIOSBackend): void;
/**
 * Get the current backend
 */
declare function getBackend(): AIOSBackend;
/**
 * Invoke a backend command
 */
declare function invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;

/**
 * Filesystem Abstraction for AIOS
 *
 * Provides a platform-agnostic filesystem interface that can be:
 * 1. Used with Tauri (in Metaglass)
 * 2. Used with Node.js
 * 3. No-op for browser environments without filesystem access
 *
 * By default, operations are no-ops. Integrators can set a custom filesystem.
 */
/**
 * Filesystem interface for AIOS operations
 */
interface AIOSFilesystem {
    /** Write text to a file */
    writeTextFile(path: string, content: string): Promise<void>;
    /** Read text from a file */
    readTextFile(path: string): Promise<string>;
    /** Create a directory */
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    /** Check if a path exists */
    exists(path: string): Promise<boolean>;
}
/**
 * In-memory filesystem for testing
 */
declare function createMemoryFilesystem(): AIOSFilesystem;
/**
 * Set the filesystem implementation
 */
declare function setFilesystem(fs: AIOSFilesystem): void;
/**
 * Get the current filesystem
 */
declare function getFilesystem(): AIOSFilesystem;
declare function writeTextFile(path: string, content: string): Promise<void>;
declare function readTextFile(path: string): Promise<string>;
declare function mkdir(path: string, options?: {
    recursive?: boolean;
}): Promise<void>;
declare function exists(path: string): Promise<boolean>;

export { type AIOSBackend, type AIOSConfig, type AIOSEvents, type AIOSFilesystem, type AIOSProviders, AIOSService, type Agent, type AgentConfig, type AgentFactory, type ChatOptions, type ClassificationResult, type CompositeToolProvider, type CompressionConfig, ContextCompressor, type ConversationConfig, ConversationEngine, type ConversationEngineDeps, type ConversationResult, type ConversationStatus, ConversationStore, type CostLevel, type DebugConsoleAPI, DebugHarness, type DecisionLog, DecisionLogger, type DecisionType, type EventEmitter, type EventHandler, type EventSubscription, type GoalSessionCompleteContext, type GoalSessionStartContext, type GoalSessionSummary, type IntentClassificationResult, type IntentSuggestedAction, type InteractionRequest, type JSONSchemaProperty, type KernelLLMClassifyFn, type LLMCapabilities, type LLMProvider, type LLMProviderFactory, type LLMResponse, type LogLevel, type Logger, type MemoryContext, type Message, type MessageRole, type MetadataCategory, type ModelProvider, type ModelTier, type NamespacedStateStore, type NotificationType, type PlanApprovalStatus, PlanManager, type PlanState, type ProviderType, type Question, type QuestionOption, type ReflectionResultPayload, type RetryConfig$1 as RetryConfig, type RetryOptions, type RetryResult, type SideEffects, type StateChangeCallback, type StateStore, type StateSubscription, type StructuredToolResult, type SubAgentType, TODOWRITE_EXEMPT_TOOLS, TOOL_METADATA, type TaskComplexityLevel, type TaskParams, type TaskResult, TaskSpawner, type Todo$1 as Todo, type TodoChangeCallback, TodoManager, type TodoResult, type TodoStatus$1 as TodoStatus, type Tool, type ToolCall$1 as ToolCall, type ToolCategory, type ToolContext, type ToolDefinition, type ToolFollowUpAction, type ToolMetadata, type ToolParameters, type ToolProvider, type ToolRegistry, type ToolRegistryProvider, type ToolResult$1 as ToolResult, ToolRetryPolicy, type ToolUserInterface, type TraceEntry, type TraceIndex, type TracePhase, type UserInterface, type UserInterfaceFactory, VercelAILLMProvider, type VercelAILLMProviderConfig, VerificationEngine, absorbPendingConfig, canSkipTodoWrite, classifyIntent, conversationStore, createAIOSService, createDefaultLLMProvider, createLogger, createMemoryFilesystem, exists, filterActionTools, filterExemptTools, getAIOSService, getBackend, getFilesystem, getLogLevel, getProviders, getTodoWriteGuidance, getToolMetadata, goalContextProvider, installDebugStub, invoke, isToolExemptFromTodoWrite, mkdir, needsClarification, partitionToolCalls, readTextFile, resetAIOSService, setBackend, setFilesystem, setLogLevel, setModelProvider, setProviders, setToolRegistryProvider, toolAllowsParallel, toolRequiresConfirmation, toolRequiresTodoWrite, writeTextFile };
