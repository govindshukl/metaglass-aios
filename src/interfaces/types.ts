/**
 * AIOS Core Types
 *
 * Core type definitions for the AI Operating System.
 * These types are the foundation for all AIOS components.
 */

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * Role in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A message in the conversation history
 */
export interface Message {
  /** Role of the message sender */
  role: MessageRole;
  /** Content of the message */
  content: string;
  /** Tool calls made in this message (for assistant messages) */
  toolCalls?: ToolCall[];
  /** Tool call ID this message is responding to (for tool messages) */
  toolCallId?: string;
  /** Tool name this message is responding to (for tool messages, required by AI SDK v6) */
  toolName?: string;
}

/**
 * A tool call request from the LLM
 */
export interface ToolCall {
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
export interface ToolFollowUpAction {
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
export interface StructuredToolResult {
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
export interface ToolResult {
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

// =============================================================================
// LLM TYPES
// =============================================================================

/**
 * Options for LLM chat completion
 */
export interface ChatOptions {
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
export interface LLMResponse {
  /** Text content of the response */
  content: string;
  /** Tool calls requested by the LLM */
  toolCalls?: ToolCall[];
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
export interface LLMCapabilities {
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

// =============================================================================
// TOOL TYPES
// =============================================================================

/**
 * JSON Schema for tool parameters
 */
export interface JSONSchemaProperty {
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
export interface ToolParameters {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

/**
 * Tool definition for LLM
 */
export interface ToolDefinition {
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
export type ToolCategory =
  | 'read'      // Read-only operations (search, read files)
  | 'edit'      // File modifications (write, edit)
  | 'execute'   // Command execution (bash, shell)
  | 'agent'     // Agent interactions (ask_user, confirm, plan)
  | 'llm'       // LLM operations (analyze, summarize)
  | 'task'      // Task management (spawn agents, todos)
  | 'mcp';      // User-extensible MCP tools

/**
 * Minimal user interface for tool confirmations
 */
export interface ToolUserInterface {
  /** Ask for confirmation (yes/no) */
  confirm(message: string): Promise<boolean>;
}

/**
 * Context passed to tool execution
 */
export interface ToolContext {
  /** Current conversation state */
  conversationId?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** User interface for confirmations (optional) */
  userInterface?: ToolUserInterface;
}

// =============================================================================
// TODO TYPES
// =============================================================================

/**
 * Todo task status
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * A todo task
 */
export interface Todo {
  /** Task description (imperative form: "Run tests") */
  content: string;
  /** Active form for display ("Running tests...") */
  activeForm: string;
  /** Current status */
  status: TodoStatus;
}

// =============================================================================
// USER INTERACTION TYPES
// =============================================================================

/**
 * Question option for user selection
 */
export interface QuestionOption {
  /** Display label (1-5 words) */
  label: string;
  /** Description of what this option means */
  description: string;
}

/**
 * A question for the user
 */
export interface Question {
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
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

// =============================================================================
// CONVERSATION TYPES
// =============================================================================

/**
 * Conversation execution status
 */
export type ConversationStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_user'
  | 'paused'      // Waiting for external action (contract approval, etc.)
  | 'completed'
  | 'timeout'     // Max turns reached
  | 'failed'
  | 'cancelled';

/**
 * Result from conversation execution
 */
export interface ConversationResult {
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

// =============================================================================
// SUB-AGENT TYPES
// =============================================================================

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
export type SubAgentType =
  | 'explore'           // Fast, read-only exploration
  | 'contract'          // Smart Contract generation for goals
  | 'execute'           // Full capability execution
  | 'Bash'              // Command execution
  | 'Skill'             // Declarative workflow execution
  // Legacy aliases for backward compatibility
  | 'Explore'
  | 'Plan'
  | 'contract-plan'
  | 'general-purpose';

/**
 * Model selection for sub-agents
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/**
 * Task spawn parameters
 */
export interface TaskParams {
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
export interface TaskResult {
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

// =============================================================================
// PLAN MODE TYPES
// =============================================================================

/**
 * Plan approval status
 */
export type PlanApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * Plan state
 */
export interface PlanState {
  /** Whether currently in planning mode */
  isPlanning: boolean;
  /** Plan content */
  planContent?: string;
  /** Approval status */
  approvalStatus: PlanApprovalStatus;
}

// =============================================================================
// REFLECTION TYPES
// =============================================================================

/**
 * Reflection result payload for events
 */
export interface ReflectionResultPayload {
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
export type TaskComplexityLevel = 'trivial' | 'simple_query' | 'multi_step' | 'complex';

/**
 * Suggested actions based on intent classification
 */
export type IntentSuggestedAction =
  | 'ask_clarification'
  | 'create_todo'
  | 'checkpoint_before_execution'
  | 'verify_output';

/**
 * Intent classification result payload for events
 */
export interface IntentClassificationResult {
  /** Detected task complexity */
  complexity: TaskComplexityLevel;
  /** Confidence score (0-1) */
  confidence: number;
  /** Suggested actions based on complexity */
  suggestedActions: IntentSuggestedAction[];
  /** Human-readable reasoning for the classification */
  reasoning: string;
}

// =============================================================================
// RETRY TYPES
// =============================================================================

/**
 * Configuration for tool retry behavior
 */
export interface RetryConfig {
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

// =============================================================================
// COMPRESSION TYPES
// =============================================================================

/**
 * Configuration for context compression
 */
export interface CompressionConfig {
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

// =============================================================================
// EVENT TYPES
// =============================================================================

/**
 * AIOS events
 */
export interface AIOSEvents {
  // Conversation events
  'conversation:started': { conversationId: string };
  'conversation:turn': { turn: number; message: Message };
  'conversation:tool-call': { toolCall: ToolCall };
  'conversation:tool-result': { toolCall: ToolCall; result: ToolResult };
  'conversation:reflection': { turn: number; reflection: ReflectionResultPayload };
  'conversation:completed': { result: ConversationResult };
  'conversation:failed': { error: string };
  'conversation:cancelled': { conversationId: string };
  'conversation:checkpoint': { conversationId: string; turn: number };
  'conversation:resumed': { conversationId: string; turn: number };
  'conversation:intent-classified': { classification: IntentClassificationResult; goal: string };

  // Todo events
  'todo:updated': { todos: Todo[] };
  'todo:task-started': { content: string };
  'todo:task-completed': { content: string };

  // User interaction events
  'interaction:requested': { questions: Question[] };
  'interaction:responded': { answers: Record<string, string | string[]> };
  'interaction:cancelled': void;

  // Plan events
  'plan:entered': void;
  'plan:exited': { approved: boolean; content?: string };
  'plan:updated': { content: string };

  // Contract approval events
  'contract:pending-approval': { conversationId: string; goalId: string; contractPath: string };
  'contract:approved': { goalId: string; contractPath: string };
  'contract:changes-requested': { goalId: string; feedback: string };
  'contract:rejected': { goalId: string; reason?: string };

  // Conversation state events
  'conversation:paused': { conversationId: string; reason: string; data?: unknown };
  'conversation:timeout': { conversationId: string };

  // Task events
  'task:spawned': { taskId: string; type: SubAgentType };
  'task:completed': { taskId: string; result: TaskResult };
}
