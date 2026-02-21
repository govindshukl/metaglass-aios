'use strict';

var ai = require('ai');

// src/logger.ts
var globalLogLevel = "info";
var LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function createLogger(prefix) {
  const shouldLog = (level) => {
    return LOG_LEVELS[level] >= LOG_LEVELS[globalLogLevel];
  };
  return {
    debug(message, ...args) {
      if (shouldLog("debug")) {
        console.debug(`[${prefix}]`, message, ...args);
      }
    },
    info(message, ...args) {
      if (shouldLog("info")) {
        console.info(`[${prefix}]`, message, ...args);
      }
    },
    warn(message, ...args) {
      if (shouldLog("warn")) {
        console.warn(`[${prefix}]`, message, ...args);
      }
    },
    error(message, ...args) {
      if (shouldLog("error")) {
        console.error(`[${prefix}]`, message, ...args);
      }
    }
  };
}
function setLogLevel(level) {
  globalLogLevel = level;
}
function getLogLevel() {
  return globalLogLevel;
}

// src/kernel/ContextCompressor.ts
var log = createLogger("ContextCompressor");
var DEFAULT_CONFIG = {
  enabled: true,
  maxTokens: 1e5,
  summarizeThreshold: 10,
  preserveRecentTurns: 5,
  charsPerToken: 4,
  summaryMaxTokens: 1e3
};
var SUMMARIZATION_PROMPT = `You are summarizing a conversation between a user and an AI assistant.
Summarize the following conversation turns, preserving:
1. Key decisions and actions taken
2. Important information discovered
3. Tools called and their significant results
4. Any user preferences or clarifications

Be concise but preserve essential context. Format as a brief narrative.`;
var ContextCompressor = class {
  llm;
  config;
  constructor(llm, config) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  /**
   * Compress conversation history if needed
   *
   * @param history - Full conversation history
   * @param systemPrompt - Optional system prompt (counted separately)
   * @returns Compressed history with metadata
   */
  async compress(history, systemPrompt) {
    if (!this.config.enabled) {
      return {
        messages: history,
        originalTokens: this.estimateTokens(history),
        compressedTokens: this.estimateTokens(history),
        summarizedTurns: 0,
        wasCompressed: false
      };
    }
    const originalTokens = this.estimateTokens(history) + (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);
    if (originalTokens < this.config.maxTokens * 0.7) {
      log.debug("Compression not needed", { originalTokens, threshold: this.config.maxTokens * 0.7 });
      return {
        messages: history,
        originalTokens,
        compressedTokens: originalTokens,
        summarizedTurns: 0,
        wasCompressed: false
      };
    }
    const { systemMessages, userMessage, turns } = this.parseHistory(history);
    if (turns.length < this.config.summarizeThreshold) {
      log.debug("Not enough turns to compress", { turns: turns.length, threshold: this.config.summarizeThreshold });
      return {
        messages: history,
        originalTokens,
        compressedTokens: originalTokens,
        summarizedTurns: 0,
        wasCompressed: false
      };
    }
    const preserveCount = Math.min(this.config.preserveRecentTurns, turns.length);
    const turnsToSummarize = turns.slice(0, turns.length - preserveCount);
    const turnsToPreserve = turns.slice(-preserveCount);
    if (turnsToSummarize.length === 0) {
      return {
        messages: history,
        originalTokens,
        compressedTokens: originalTokens,
        summarizedTurns: 0,
        wasCompressed: false
      };
    }
    log.info("Compressing context", {
      totalTurns: turns.length,
      summarizing: turnsToSummarize.length,
      preserving: preserveCount
    });
    const summary = await this.summarizeTurns(turnsToSummarize);
    const compressedHistory = [
      ...systemMessages,
      ...userMessage ? [userMessage] : [],
      {
        role: "assistant",
        content: `[Previous conversation summary: ${summary}]`
      },
      ...turnsToPreserve.flatMap((t) => t.messages)
    ];
    const compressedTokens = this.estimateTokens(compressedHistory) + (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);
    log.info("Context compressed", {
      originalTokens,
      compressedTokens,
      reduction: `${Math.round((1 - compressedTokens / originalTokens) * 100)}%`,
      summarizedTurns: turnsToSummarize.length
    });
    return {
      messages: compressedHistory,
      originalTokens,
      compressedTokens,
      summarizedTurns: turnsToSummarize.length,
      wasCompressed: true
    };
  }
  /**
   * Parse history into system messages, initial user message, and turns
   */
  parseHistory(history) {
    const systemMessages = [];
    let userMessage = null;
    const turns = [];
    let currentTurn = [];
    let turnIndex = 0;
    for (const msg of history) {
      if (msg.role === "system") {
        systemMessages.push(msg);
        continue;
      }
      if (msg.role === "user" && userMessage === null) {
        userMessage = msg;
        continue;
      }
      if (msg.role === "assistant") {
        if (currentTurn.length > 0) {
          turns.push({
            index: turnIndex++,
            messages: currentTurn,
            tokenCount: this.estimateTokens(currentTurn)
          });
        }
        currentTurn = [msg];
      } else {
        currentTurn.push(msg);
      }
    }
    if (currentTurn.length > 0) {
      turns.push({
        index: turnIndex,
        messages: currentTurn,
        tokenCount: this.estimateTokens(currentTurn)
      });
    }
    return { systemMessages, userMessage, turns };
  }
  /**
   * Generate a summary of conversation turns
   */
  async summarizeTurns(turns) {
    const turnTexts = turns.map((turn) => {
      const parts = [];
      for (const msg of turn.messages) {
        if (msg.role === "assistant") {
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const toolNames = msg.toolCalls.map((tc) => tc.name).join(", ");
            parts.push(`Assistant called tools: ${toolNames}`);
          }
          if (msg.content) {
            const preview = msg.content.slice(0, 200);
            parts.push(`Assistant: ${preview}${msg.content.length > 200 ? "..." : ""}`);
          }
        } else if (msg.role === "tool") {
          const preview = msg.content.slice(0, 100);
          const toolName = msg.toolName || "tool";
          parts.push(`${toolName} result: ${preview}${msg.content.length > 100 ? "..." : ""}`);
        } else if (msg.role === "user") {
          parts.push(`User: ${msg.content.slice(0, 150)}`);
        }
      }
      return `Turn ${turn.index + 1}:
${parts.join("\n")}`;
    });
    const conversationToSummarize = turnTexts.join("\n\n");
    try {
      const response = await this.llm.chat([
        { role: "system", content: SUMMARIZATION_PROMPT },
        { role: "user", content: conversationToSummarize }
      ], {
        maxTokens: this.config.summaryMaxTokens,
        temperature: 0.3
        // Lower temperature for consistent summaries
      });
      return response.content;
    } catch (error) {
      log.error("Failed to generate summary, using fallback", { error });
      const toolCalls = turns.flatMap(
        (t) => t.messages.filter((m) => m.toolCalls).flatMap((m) => m.toolCalls.map((tc) => tc.name))
      );
      return `Previous conversation included ${turns.length} turns with tools: ${[...new Set(toolCalls)].join(", ")}`;
    }
  }
  /**
   * Estimate token count for a list of messages
   */
  estimateTokens(messages) {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg.content), 0);
  }
  /**
   * Estimate token count for a string
   */
  estimateMessageTokens(content) {
    return Math.ceil(content.length / this.config.charsPerToken);
  }
  /**
   * Update configuration
   */
  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }
  /**
   * Get current configuration
   */
  getConfig() {
    return { ...this.config };
  }
};

// src/kernel/ToolRetryPolicy.ts
var log2 = createLogger("ToolRetryPolicy");
var DEFAULT_CONFIG2 = {
  maxAttempts: 3,
  baseDelayMs: 1e3,
  maxDelayMs: 1e4,
  backoffMultiplier: 2,
  jitter: true,
  retryableErrors: [
    // Network errors
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "network",
    "timeout",
    "fetch failed",
    // Rate limiting
    "rate limit",
    "too many requests",
    "429",
    // Temporary server errors
    "502",
    "503",
    "504",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    // Generic transient
    "temporarily unavailable",
    "try again",
    "EAGAIN"
  ]
};
var NON_RETRYABLE_ERRORS = [
  "not found",
  "404",
  "unauthorized",
  "401",
  "forbidden",
  "403",
  "invalid",
  "validation",
  "permission denied",
  "access denied",
  "already exists",
  "conflict",
  "bad request",
  "400"
];
var ToolRetryPolicy = class _ToolRetryPolicy {
  config;
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG2, ...config };
  }
  /**
   * Execute a function with retry logic
   *
   * @param fn - The async function to execute
   * @param options - Retry options
   * @returns Result with success status and attempt count
   */
  async execute(fn, options) {
    const startTime = Date.now();
    let lastError;
    let attempt = 0;
    while (attempt < this.config.maxAttempts) {
      attempt++;
      if (options?.signal?.aborted) {
        return {
          success: false,
          attempts: attempt,
          lastError: "Operation cancelled",
          totalTimeMs: Date.now() - startTime
        };
      }
      try {
        const result = await fn();
        log2.debug("Retry operation succeeded", { attempt, totalAttempts: this.config.maxAttempts });
        return {
          success: true,
          result,
          attempts: attempt,
          totalTimeMs: Date.now() - startTime
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryable = this.shouldRetry(lastError, options?.isRetryable);
        const isLastAttempt = attempt >= this.config.maxAttempts;
        if (!isRetryable || isLastAttempt) {
          log2.debug("Retry operation failed permanently", {
            attempt,
            maxAttempts: this.config.maxAttempts,
            isRetryable,
            error: lastError.message
          });
          break;
        }
        const delay = this.calculateDelay(attempt);
        log2.info("Retrying after error", {
          attempt,
          maxAttempts: this.config.maxAttempts,
          error: lastError.message,
          delayMs: delay
        });
        if (options?.onRetry) {
          options.onRetry(attempt, lastError, delay);
        }
        await this.sleep(delay, options?.signal);
      }
    }
    return {
      success: false,
      attempts: attempt,
      lastError: lastError?.message,
      totalTimeMs: Date.now() - startTime
    };
  }
  /**
   * Determine if an error should trigger a retry
   */
  shouldRetry(error, customIsRetryable) {
    if (customIsRetryable) {
      return customIsRetryable(error);
    }
    const errorMessage = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();
    for (const pattern of NON_RETRYABLE_ERRORS) {
      if (errorMessage.includes(pattern) || errorName.includes(pattern)) {
        return false;
      }
    }
    for (const pattern of this.config.retryableErrors) {
      if (errorMessage.includes(pattern.toLowerCase()) || errorName.includes(pattern.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
  /**
   * Calculate delay for the current attempt with exponential backoff and optional jitter
   */
  calculateDelay(attempt) {
    let delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    delay = Math.min(delay, this.config.maxDelayMs);
    if (this.config.jitter) {
      const jitterRange = delay * 0.25;
      delay = delay + Math.random() * jitterRange * 2 - jitterRange;
    }
    return Math.round(delay);
  }
  /**
   * Sleep for specified duration, respecting abort signal
   */
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Operation cancelled"));
        }, { once: true });
      }
    });
  }
  /**
   * Update configuration
   */
  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }
  /**
   * Get current configuration
   */
  getConfig() {
    return { ...this.config };
  }
  /**
   * Create a retry policy for specific tool characteristics
   */
  static forToolType(toolType) {
    switch (toolType) {
      case "network":
        return new _ToolRetryPolicy({
          maxAttempts: 4,
          baseDelayMs: 1e3,
          maxDelayMs: 15e3
        });
      case "filesystem":
        return new _ToolRetryPolicy({
          maxAttempts: 2,
          baseDelayMs: 500,
          maxDelayMs: 2e3
        });
      case "compute":
        return new _ToolRetryPolicy();
      default:
        return new _ToolRetryPolicy();
    }
  }
};

// src/kernel/ConversationStore.ts
var log3 = createLogger("ConversationStore");
var MemoryStorageBackend = class {
  store = /* @__PURE__ */ new Map();
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async set(key, value) {
    this.store.set(key, value);
  }
  async delete(key) {
    return this.store.delete(key);
  }
  async keys(prefix) {
    const allKeys = Array.from(this.store.keys());
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }
  async clear(prefix) {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
};
function getLocalStorage() {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return null;
}
var LocalStorageBackend = class {
  async get(key) {
    try {
      const storage = getLocalStorage();
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  async set(key, value) {
    try {
      const storage = getLocalStorage();
      storage?.setItem(key, value);
    } catch (error) {
      log3.warn("LocalStorage write failed", { key, error });
    }
  }
  async delete(key) {
    try {
      const storage = getLocalStorage();
      if (!storage) return false;
      const existed = storage.getItem(key) !== null;
      storage.removeItem(key);
      return existed;
    } catch {
      return false;
    }
  }
  async keys(prefix) {
    try {
      const storage = getLocalStorage();
      if (!storage) return [];
      const allKeys = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key) allKeys.push(key);
      }
      if (!prefix) return allKeys;
      return allKeys.filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }
  async clear(prefix) {
    try {
      const storage = getLocalStorage();
      if (!storage) return;
      if (!prefix) {
        storage.clear();
        return;
      }
      const keysToDelete = await this.keys(prefix);
      for (const key of keysToDelete) {
        storage.removeItem(key);
      }
    } catch {
    }
  }
};
var DEFAULT_CONFIG3 = {
  backend: new MemoryStorageBackend(),
  maxSnapshots: 50,
  autoSaveIntervalMs: 3e4,
  keyPrefix: "aios:conversation:"
};
var ConversationStore = class {
  config;
  backend;
  indexKey;
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG3, ...config };
    this.backend = this.config.backend;
    this.indexKey = `${this.config.keyPrefix}index`;
  }
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  /**
   * Save a conversation snapshot
   */
  async save(snapshot) {
    const key = this.getSnapshotKey(snapshot.id);
    snapshot.updatedAt = Date.now();
    const serialized = JSON.stringify(snapshot);
    await this.backend.set(key, serialized);
    await this.updateIndex(snapshot.id, "add");
    await this.enforceMaxSnapshots();
    log3.debug("Saved conversation snapshot", { id: snapshot.id, turn: snapshot.turn });
  }
  /**
   * Load a conversation snapshot by ID
   */
  async load(conversationId) {
    const key = this.getSnapshotKey(conversationId);
    const serialized = await this.backend.get(key);
    if (!serialized) {
      log3.debug("Conversation not found", { id: conversationId });
      return null;
    }
    try {
      const snapshot = JSON.parse(serialized);
      log3.debug("Loaded conversation snapshot", { id: conversationId, turn: snapshot.turn });
      return snapshot;
    } catch (error) {
      log3.error("Failed to parse conversation snapshot", { id: conversationId, error });
      return null;
    }
  }
  /**
   * Delete a conversation snapshot
   */
  async delete(conversationId) {
    const key = this.getSnapshotKey(conversationId);
    const deleted = await this.backend.delete(key);
    if (deleted) {
      await this.updateIndex(conversationId, "remove");
      log3.debug("Deleted conversation", { id: conversationId });
    }
    return deleted;
  }
  /**
   * List all conversation summaries
   */
  async list() {
    const index = await this.getIndex();
    const summaries = [];
    for (const id of index) {
      const snapshot = await this.load(id);
      if (snapshot) {
        summaries.push({
          id: snapshot.id,
          originalGoal: snapshot.originalGoal,
          status: snapshot.status,
          turn: snapshot.turn,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          preview: this.createPreview(snapshot.originalGoal)
        });
      }
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }
  /**
   * Check if a conversation exists
   */
  async exists(conversationId) {
    const key = this.getSnapshotKey(conversationId);
    const serialized = await this.backend.get(key);
    return serialized !== null;
  }
  /**
   * Get the most recent conversation
   */
  async getLatest() {
    const summaries = await this.list();
    if (summaries.length === 0) return null;
    return this.load(summaries[0].id);
  }
  /**
   * Clear all stored conversations
   */
  async clear() {
    await this.backend.clear(this.config.keyPrefix);
    log3.info("Cleared all conversations");
  }
  /**
   * Create a new snapshot from conversation state
   */
  createSnapshot(id, history, todos, status, originalGoal, turn, isPlanning, metadata) {
    const now = Date.now();
    return {
      id,
      history,
      todos,
      status,
      originalGoal,
      turn,
      isPlanning,
      createdAt: now,
      updatedAt: now,
      metadata
    };
  }
  /**
   * Get storage statistics
   */
  async getStats() {
    const summaries = await this.list();
    if (summaries.length === 0) {
      return { count: 0, oldestCreated: null, newestUpdated: null };
    }
    const oldestCreated = Math.min(...summaries.map((s) => s.createdAt));
    const newestUpdated = Math.max(...summaries.map((s) => s.updatedAt));
    return {
      count: summaries.length,
      oldestCreated,
      newestUpdated
    };
  }
  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================
  /**
   * Get the storage key for a conversation snapshot
   */
  getSnapshotKey(conversationId) {
    return `${this.config.keyPrefix}${conversationId}`;
  }
  /**
   * Get the conversation index
   */
  async getIndex() {
    const serialized = await this.backend.get(this.indexKey);
    if (!serialized) return [];
    try {
      return JSON.parse(serialized);
    } catch {
      return [];
    }
  }
  /**
   * Update the conversation index
   */
  async updateIndex(conversationId, action) {
    let index = await this.getIndex();
    if (action === "add") {
      index = [conversationId, ...index.filter((id) => id !== conversationId)];
    } else {
      index = index.filter((id) => id !== conversationId);
    }
    await this.backend.set(this.indexKey, JSON.stringify(index));
  }
  /**
   * Enforce maximum snapshot limit
   */
  async enforceMaxSnapshots() {
    const index = await this.getIndex();
    if (index.length <= this.config.maxSnapshots) return;
    const toRemove = index.slice(this.config.maxSnapshots);
    for (const id of toRemove) {
      await this.delete(id);
    }
    log3.debug("Cleaned up old snapshots", { removed: toRemove.length });
  }
  /**
   * Create a preview string from the goal
   */
  createPreview(goal, maxLength = 50) {
    if (goal.length <= maxLength) return goal;
    return goal.slice(0, maxLength - 3) + "...";
  }
  /**
   * Update configuration
   */
  updateConfig(config) {
    if (config.backend) {
      this.backend = config.backend;
    }
    this.config = { ...this.config, ...config };
  }
};
var conversationStore = new ConversationStore({
  backend: typeof window !== "undefined" && window.localStorage ? new LocalStorageBackend() : new MemoryStorageBackend()
});

// src/kernel/ToolExemptions.ts
var TODOWRITE_EXEMPT_TOOLS = [
  // ==========================================================================
  // CLARIFICATION TOOLS
  // User interaction for gathering requirements - always allowed
  // ==========================================================================
  "agent_ask_user",
  "agent_confirm",
  "AskUserQuestion",
  // Claude Code alias
  // ==========================================================================
  // CONTRACT SUBMISSION
  // Allowed before TodoWrite (pauses for user approval)
  // ==========================================================================
  "submit_contract",
  // ==========================================================================
  // SEARCH TOOLS
  // Full-text, vector, and hybrid search - read-only
  // ==========================================================================
  "search_fulltext",
  "search_vector",
  "search_hybrid",
  // ==========================================================================
  // VAULT QUERY TOOLS
  // Read-only vault operations
  // ==========================================================================
  "vault_read_note",
  "vault_list_notes",
  // ==========================================================================
  // FILE QUERY TOOLS
  // Read-only file system operations
  // ==========================================================================
  "Read",
  "Glob",
  "Grep",
  // ==========================================================================
  // GRAPH QUERY TOOLS
  // Knowledge graph queries - read-only
  // ==========================================================================
  "graph_backlinks",
  "graph_outlinks",
  // ==========================================================================
  // MEMORY TOOLS
  // Recall and search - read-only
  // ==========================================================================
  "memory_recall",
  "memory_search"
];
function isToolExemptFromTodoWrite(toolName) {
  return TODOWRITE_EXEMPT_TOOLS.includes(toolName);
}
function filterExemptTools(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter((tc) => isToolExemptFromTodoWrite(tc.name));
}
function filterActionTools(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter((tc) => !isToolExemptFromTodoWrite(tc.name));
}

// src/kernel/IntentClassifier.ts
var log4 = createLogger("IntentClassifier");
var CREATE_VERBS = /\b(create|build|make|implement|design|develop|write|generate|compose|draft|prepare|schedule|plan|organize)\b/i;
var QUERY_VERBS = /\b(find|search|look\s+up|where\s+is|show\s+me|list|get|fetch)\b/i;
var TRIVIAL_QUESTION = /^(what\s+is|how\s+do|what\s+are)\s+\w+(\s+\w+)?[?!.]*$/i;
var AMBIGUITY_INDICATORS = /\b(something|stuff|things|etc|maybe|probably|perhaps|might|could\s+be|not\s+sure|somehow)\b/i;
var GREETING_PATTERNS = /^(hi|hello|hey|thanks|thank\s+you|good\s+(morning|afternoon|evening)|yo|sup|bye|goodbye|ok|okay|sure|yes|no|yeah|nope|yep)[\s!.?]*$/i;
var SUBJECTIVE_TASK_PATTERNS = /\b(plan|guide|schedule|routine|program|curriculum|roadmap|strategy|approach)\b/i;
var KERNEL_CLASSIFICATION_SYSTEM_PROMPT = `You are a task complexity classifier for an AI assistant that manages a knowledge base. Your job is to analyze a user's goal and classify its complexity level.

## Complexity Levels

1. **trivial** - No tools needed, direct conversational response.
   - Greetings: "hello", "hi", "thanks", "bye"
   - Simple factual questions: "what is 2+2", "what is a mutex"
   - Acknowledgments: "ok", "sure", "yes", "no"
   - Very short inputs (<15 chars) without action verbs

2. **simple_query** - Single read-only tool call, no planning needed.
   - Search/find patterns: "find notes about React", "search for meeting notes"
   - Show/list patterns: "show me my recent notes", "list files about ML"
   - Lookup patterns: "where is the config file", "look up API docs"

3. **multi_step** - Requires planning and multiple tool calls (creation, modification, multi-phase work).
   - Creation: "create a note about project planning", "write a summary of my research"
   - Modification: "update my study notes with new findings"
   - Planning: "plan a trip to Dubai", "build a learning roadmap"
   - Composition: "generate a weekly review from my notes"

4. **complex** - Ambiguous, has multiple deliverables (3+), requires clarification, or involves subjective decisions with unclear scope.
   - Ambiguous language: "help me with some stuff", "maybe create something about things"
   - Multiple deliverables: "create a plan, build a tracker, and write documentation"
   - Very long goals (100+ chars) with unclear scope
   - Broad/vague requests: "organize everything", "fix all my notes"

## Suggested Actions

Based on complexity, include zero or more actions:
- "ask_clarification" \u2014 goal is ambiguous, subjective (plans, guides, schedules, routines), or needs user preferences before proceeding
- "create_todo" \u2014 task has multiple steps that should be tracked
- "checkpoint_before_execution" \u2014 task is complex enough to warrant verification before executing
- "verify_output" \u2014 output should be verified against the original goal

Rules:
- trivial: no actions, confidence 0.90-0.95
- simple_query: no actions, confidence 0.85-0.95
- multi_step: always include "create_todo"; add "ask_clarification" if the goal is subjective or preference-based; confidence 0.75-0.90
- complex: include all four actions; confidence 0.50-0.75 (lower when ambiguity is present)

## Conversation Context

You may receive recent conversation history. Use it to disambiguate:
- Short follow-ups like "do it" or "yes" should be classified based on what was discussed
- Multi-turn context reveals whether a request is part of a larger task

## Response Format

Respond with ONLY a JSON object. No markdown fences, no explanation, no text before or after:
{"complexity":"<level>","confidence":<0.0-1.0>,"suggestedActions":[<actions>],"reasoning":"<brief explanation>"}`;
function buildKernelClassificationPrompt(goal, conversationHistory) {
  let prompt = "";
  const recentHistory = conversationHistory.filter((m) => m.role === "user" || m.role === "assistant").slice(-6).map((m) => `${m.role}: ${m.content.substring(0, 200)}`);
  if (recentHistory.length > 0) {
    prompt += `## Recent Conversation
${recentHistory.join("\n")}

`;
  }
  prompt += `## Current User Goal
"${goal}"

Classify this goal.`;
  return prompt;
}
var VALID_COMPLEXITIES = /* @__PURE__ */ new Set(["trivial", "simple_query", "multi_step", "complex"]);
var VALID_ACTIONS = /* @__PURE__ */ new Set([
  "ask_clarification",
  "create_todo",
  "checkpoint_before_execution",
  "verify_output"
]);
var COMPLEXITY_MAP = {
  "trivial": "trivial" /* TRIVIAL */,
  "simple_query": "simple_query" /* SIMPLE_QUERY */,
  "multi_step": "multi_step" /* MULTI_STEP */,
  "complex": "complex" /* COMPLEX */
};
function parseClassificationResponse(content) {
  const cleaned = content.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.complexity || !VALID_COMPLEXITIES.has(parsed.complexity)) {
    throw new Error(`Invalid complexity value: "${parsed.complexity}". Expected one of: ${[...VALID_COMPLEXITIES].join(", ")}`);
  }
  const complexity = COMPLEXITY_MAP[parsed.complexity];
  const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7;
  const suggestedActions = Array.isArray(parsed.suggestedActions) ? parsed.suggestedActions.filter((a) => VALID_ACTIONS.has(a)) : [];
  const reasoning = typeof parsed.reasoning === "string" && parsed.reasoning.length > 0 ? `LLM: ${parsed.reasoning}` : `LLM classified as ${parsed.complexity}`;
  return {
    complexity,
    confidence,
    suggestedActions,
    reasoning
  };
}
function classifyIntentRegex(goal, _conversationHistory) {
  const trimmedGoal = goal.trim();
  const goalLength = trimmedGoal.length;
  const hasCreateVerb = CREATE_VERBS.test(trimmedGoal);
  const hasQueryVerb = QUERY_VERBS.test(trimmedGoal);
  const hasAmbiguity = AMBIGUITY_INDICATORS.test(trimmedGoal);
  const isGreeting = GREETING_PATTERNS.test(trimmedGoal);
  const isTrivialQuestion = TRIVIAL_QUESTION.test(trimmedGoal);
  const isSubjectiveTask = SUBJECTIVE_TASK_PATTERNS.test(trimmedGoal);
  const commaCount = (trimmedGoal.match(/,/g) || []).length;
  const andCount = (trimmedGoal.match(/\band\b/gi) || []).length;
  const deliverableCount = commaCount + andCount + 1;
  let complexity;
  const suggestedActions = [];
  let confidence = 0.85;
  let reasoning;
  if (goalLength === 0 || isGreeting || isTrivialQuestion || goalLength < 15 && !hasCreateVerb && !hasQueryVerb) {
    complexity = "trivial" /* TRIVIAL */;
    reasoning = `Trivial input: ${isGreeting ? "greeting detected" : goalLength === 0 ? "empty input" : isTrivialQuestion ? "trivial question" : "very short input without action verbs"}`;
    confidence = 0.95;
  } else if (hasAmbiguity || deliverableCount >= 3 || goalLength > 100) {
    complexity = "complex" /* COMPLEX */;
    suggestedActions.push("ask_clarification", "create_todo", "checkpoint_before_execution", "verify_output");
    const reasons = [];
    if (hasAmbiguity) reasons.push("ambiguous language detected");
    if (deliverableCount >= 3) reasons.push(`${deliverableCount} potential deliverables`);
    if (goalLength > 100) reasons.push(`long goal (${goalLength} chars)`);
    reasoning = `Complex task: ${reasons.join(", ")}`;
    confidence = hasAmbiguity ? 0.6 : 0.75;
  } else if (hasCreateVerb) {
    complexity = "multi_step" /* MULTI_STEP */;
    suggestedActions.push("create_todo");
    if (hasAmbiguity || isSubjectiveTask) {
      suggestedActions.unshift("ask_clarification");
      confidence = hasAmbiguity ? 0.7 : 0.8;
    }
    reasoning = `Multi-step task: detected creation verb${hasAmbiguity ? " with ambiguity" : isSubjectiveTask ? " (subjective/preference-based)" : ""}`;
  } else if (hasQueryVerb) {
    complexity = "simple_query" /* SIMPLE_QUERY */;
    reasoning = `Simple query: detected query verb (${trimmedGoal.match(QUERY_VERBS)?.[0] || "query"})`;
    confidence = 0.9;
  } else if (goalLength >= 15 && goalLength <= 50) {
    complexity = "simple_query" /* SIMPLE_QUERY */;
    reasoning = `Defaulting to simple query: medium-length input (${goalLength} chars) without clear action indicators`;
    confidence = 0.65;
  } else {
    complexity = "multi_step" /* MULTI_STEP */;
    suggestedActions.push("create_todo");
    reasoning = `Defaulting to multi-step: longer input (${goalLength} chars) may require planning`;
    confidence = 0.6;
  }
  return {
    complexity,
    confidence,
    suggestedActions,
    reasoning
  };
}
async function classifyIntentLLM(goal, conversationHistory, llmFn) {
  const messages = [
    { role: "system", content: KERNEL_CLASSIFICATION_SYSTEM_PROMPT },
    { role: "user", content: buildKernelClassificationPrompt(goal, conversationHistory) }
  ];
  const response = await llmFn(messages, { maxTokens: 256, temperature: 0 });
  return parseClassificationResponse(response.content);
}
async function classifyIntent(goal, conversationHistory, llmFn) {
  const regexResult = classifyIntentRegex(goal);
  if (regexResult.confidence >= 0.9 && (regexResult.complexity === "trivial" /* TRIVIAL */ || regexResult.complexity === "simple_query" /* SIMPLE_QUERY */)) {
    log4.debug("Intent classified via regex fast path", {
      complexity: regexResult.complexity,
      confidence: regexResult.confidence
    });
    return regexResult;
  }
  if (!llmFn) {
    log4.debug("No LLM function provided, using regex classification", {
      complexity: regexResult.complexity
    });
    return regexResult;
  }
  try {
    log4.debug("Classifying intent via LLM", { goalPreview: goal.substring(0, 80) });
    const llmResult = await classifyIntentLLM(goal, conversationHistory, llmFn);
    log4.info("Intent classified via LLM", {
      complexity: llmResult.complexity,
      confidence: llmResult.confidence,
      suggestedActions: llmResult.suggestedActions
    });
    return llmResult;
  } catch (error) {
    log4.warn("LLM classification failed, falling back to regex", {
      error: error instanceof Error ? error.message : String(error),
      regexComplexity: regexResult.complexity
    });
    return {
      ...regexResult,
      reasoning: `${regexResult.reasoning} (LLM fallback: ${error instanceof Error ? error.message : "unknown error"})`
    };
  }
}
function canSkipTodoWrite(classification) {
  return classification.complexity === "trivial" /* TRIVIAL */ || classification.complexity === "simple_query" /* SIMPLE_QUERY */;
}
function needsClarification(classification) {
  return classification.suggestedActions.includes("ask_clarification");
}

// src/kernel/DecisionLogger.ts
var DecisionLogger = class {
  logs = [];
  /**
   * Log a decision with automatic timestamp
   */
  log(entry) {
    const logEntry = {
      ...entry,
      timestamp: /* @__PURE__ */ new Date()
    };
    this.logs.push(logEntry);
  }
  /**
   * Get all logged decisions (returns a copy)
   */
  getDecisions() {
    return [...this.logs];
  }
  /**
   * Get a formatted summary of all decisions
   */
  getDecisionsSummary() {
    if (this.logs.length === 0) {
      return "";
    }
    return this.logs.map((d) => `[Turn ${d.turn}] ${d.decision}: ${d.reason} \u2192 ${d.outcome}`).join("\n");
  }
  /**
   * Get decisions for a specific turn
   */
  getDecisionsByTurn(turn) {
    return this.logs.filter((d) => d.turn === turn);
  }
  /**
   * Get decisions of a specific type
   */
  getDecisionsByType(decisionType) {
    return this.logs.filter((d) => d.decision === decisionType);
  }
  /**
   * Clear all logged decisions
   */
  clear() {
    this.logs = [];
  }
};

// src/kernel/ToolMetadataRegistry.ts
var DEFAULT_METADATA = {
  category: "query",
  sideEffects: "none",
  requiresConfirmation: false,
  requiresTodoWrite: false,
  costLevel: "cheap",
  allowsParallelExecution: true
  // Default to parallel-safe for queries
};
var TOOL_METADATA = {
  // ===========================================================================
  // CLARIFICATION TOOLS - Always allowed, no side effects
  // NOT parallelizable - user interaction requires sequential flow
  // ===========================================================================
  agent_ask_user: {
    category: "clarification",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "free",
    allowsParallelExecution: false
    // User interaction must be sequential
  },
  agent_confirm: {
    category: "clarification",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "free",
    allowsParallelExecution: false
    // User interaction must be sequential
  },
  AskUserQuestion: {
    category: "clarification",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "free",
    allowsParallelExecution: false
    // User interaction must be sequential
  },
  // ===========================================================================
  // PLANNING TOOLS - Not parallelizable (depend on each other)
  // ===========================================================================
  TodoWrite: {
    category: "planning",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "free",
    allowsParallelExecution: false
    // Planning is sequential
  },
  EnterPlanMode: {
    category: "planning",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "free",
    allowsParallelExecution: false
  },
  // ===========================================================================
  // QUERY TOOLS - Read-only, CAN be parallelized
  // ===========================================================================
  search_fulltext: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
    // Independent reads can run in parallel
  },
  search_vector: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  search_hybrid: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  vault_read_note: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  vault_list_notes: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  Read: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  Glob: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  Grep: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  graph_backlinks: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  graph_outlinks: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  memory_recall: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  memory_search: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "cheap",
    allowsParallelExecution: true
  },
  // ===========================================================================
  // MUTATION TOOLS - Reversible, NOT parallelizable by default
  // (could conflict if operating on same resources)
  // ===========================================================================
  vault_create_note: {
    category: "mutation",
    sideEffects: "reversible",
    requiresConfirmation: false,
    requiresTodoWrite: true,
    costLevel: "cheap",
    allowsParallelExecution: false
    // Could have path conflicts
  },
  vault_update_note: {
    category: "mutation",
    sideEffects: "reversible",
    requiresConfirmation: false,
    requiresTodoWrite: true,
    costLevel: "cheap",
    allowsParallelExecution: false
    // Same file edits would conflict
  },
  vault_delete_note: {
    category: "mutation",
    sideEffects: "irreversible",
    requiresConfirmation: true,
    requiresTodoWrite: true,
    costLevel: "cheap",
    allowsParallelExecution: false
  },
  // ===========================================================================
  // EXECUTION TOOLS - NOT parallelizable (side effects)
  // ===========================================================================
  Bash: {
    category: "execution",
    sideEffects: "irreversible",
    requiresConfirmation: true,
    requiresTodoWrite: true,
    costLevel: "expensive",
    allowsParallelExecution: false
    // Commands could interfere
  },
  // ===========================================================================
  // LLM TOOLS - CAN be parallelized (independent API calls)
  // ===========================================================================
  llm_analyze: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "expensive",
    allowsParallelExecution: true
    // Independent LLM calls can run in parallel
  },
  llm_summarize: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "expensive",
    allowsParallelExecution: true
  },
  // ===========================================================================
  // WEB TOOLS - External API calls, can be parallelized
  // ===========================================================================
  web_search: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "expensive",
    // External API call with rate limits
    allowsParallelExecution: true
  },
  web_fetch: {
    category: "query",
    sideEffects: "none",
    requiresConfirmation: false,
    requiresTodoWrite: false,
    costLevel: "expensive",
    // External fetch + LLM call
    allowsParallelExecution: true
  }
};
function getToolMetadata(toolName) {
  return TOOL_METADATA[toolName] || DEFAULT_METADATA;
}
function toolRequiresTodoWrite(toolName) {
  return getToolMetadata(toolName).requiresTodoWrite;
}
function toolRequiresConfirmation(toolName) {
  return getToolMetadata(toolName).requiresConfirmation;
}
function toolAllowsParallel(toolName) {
  return getToolMetadata(toolName).allowsParallelExecution;
}
function partitionToolCalls(toolCalls) {
  const parallel = [];
  const sequential = [];
  for (const tc of toolCalls) {
    if (toolAllowsParallel(tc.name)) {
      parallel.push(tc);
    } else {
      sequential.push(tc);
    }
  }
  return { parallel, sequential };
}

// src/kernel/TodoWriteGuidance.ts
var SOFT_MESSAGE = "Consider using TodoWrite to track progress and give the user visibility into your work.";
var STRONG_MESSAGE = "This task has multiple steps. Please use TodoWrite to plan and track your progress.";
function getTodoWriteGuidance(input) {
  const { complexity, turnNumber, hasProducedOutput } = input;
  if (hasProducedOutput) {
    return { level: "none", message: null };
  }
  if (complexity === "trivial" /* TRIVIAL */ || complexity === "simple_query" /* SIMPLE_QUERY */) {
    return { level: "none", message: null };
  }
  if (complexity === "multi_step" /* MULTI_STEP */) {
    if (turnNumber <= 2) {
      return { level: "soft", message: SOFT_MESSAGE };
    }
    return { level: "none", message: null };
  }
  if (complexity === "complex" /* COMPLEX */) {
    if (turnNumber === 1) {
      return { level: "strong", message: STRONG_MESSAGE };
    }
    if (turnNumber <= 3) {
      return { level: "soft", message: SOFT_MESSAGE };
    }
    return { level: "none", message: null };
  }
  return { level: "none", message: null };
}

// src/providers/GoalContextProvider.ts
var log5 = createLogger("GoalContextProvider");
var GoalContextProviderImpl = class {
  context = {
    goalId: null,
    goalName: null
  };
  /**
   * Set the active goal for context
   */
  setActiveGoal(goalId, goalName) {
    this.context.goalId = goalId;
    this.context.goalName = goalName;
    log5.debug("Active goal set", { goalId, goalName });
  }
  /**
   * Clear the active goal
   */
  clearActiveGoal() {
    this.context.goalId = null;
    this.context.goalName = null;
    log5.debug("Active goal cleared");
  }
  /**
   * Check if there's an active goal
   */
  hasActiveGoal() {
    return this.context.goalId !== null;
  }
  /**
   * Get the current active goal ID
   */
  getActiveGoalId() {
    return this.context.goalId;
  }
  /**
   * Get the current active goal name
   */
  getActiveGoalName() {
    return this.context.goalName;
  }
  /**
   * Get context for the current goal (stub - returns empty)
   */
  async getGoalContext() {
    if (!this.context.goalId) {
      return "";
    }
    return `Goal: ${this.context.goalName || this.context.goalId}`;
  }
};
var goalContextProvider = new GoalContextProviderImpl();

// src/backend.ts
var log6 = createLogger("Backend");
var noopBackend = {
  async invoke(command, args) {
    log6.debug("Backend invoke (no-op)", { command, args });
    return null;
  }
};
var currentBackend = noopBackend;
function setBackend(backend) {
  currentBackend = backend;
  log6.info("Backend set", { hasInvoke: typeof backend.invoke === "function" });
}
function getBackend() {
  return currentBackend;
}
async function invoke(command, args) {
  return currentBackend.invoke(command, args);
}

// src/kernel/ConversationEngine.ts
var log7 = createLogger("ConversationEngine");
var PAUSE_TOOLS = /* @__PURE__ */ new Set(["submit_contract"]);
var DEFAULT_CONFIG4 = {
  maxTurns: 50,
  timeoutMs: 6e5,
  // 10 minutes (increased from 5 min to handle slow LLM responses)
  maxTokensPerTurn: 4096,
  requireTodoWrite: true
};
var ConversationEngine = class {
  llm;
  tools;
  ui;
  events;
  history = [];
  status = "idle";
  abortController = null;
  conversationId = "";
  // TodoWrite enforcement state
  hasPlan = false;
  planEnforcementAttempts = 0;
  MAX_PLAN_ENFORCEMENT_ATTEMPTS = 2;
  originalGoal = "";
  // Current todos for task tracking
  currentTodos = [];
  // Context compression
  contextCompressor;
  // Tool retry policy
  retryPolicy;
  // Conversation persistence
  store;
  currentTurn = 0;
  autoCheckpoint = false;
  // Intent classification (Phase 7)
  intentClassification = null;
  // Decision logger for observability
  decisionLogger;
  // Track tool results for session summary
  toolResults = [];
  // Track output paths for session summary
  outputPaths = [];
  // Track if output has been produced (for TodoWrite guidance decay)
  hasProducedOutput = false;
  // Store last config for resume functionality
  lastConfig = null;
  // Debug harness (optional — zero overhead when not attached)
  debugHarness = null;
  // LLM function for intent classification (optional — uses regex fallback if not provided)
  llmClassifyFn;
  constructor(deps) {
    this.llm = deps.llm;
    this.tools = deps.tools;
    this.ui = deps.ui;
    this.events = deps.events;
    if (deps.classifierLlm) {
      this.llmClassifyFn = async (messages, options) => {
        const response = await deps.classifierLlm.chat(messages, {
          maxTokens: options?.maxTokens ?? 256,
          temperature: options?.temperature ?? 0
        });
        return { content: response.content };
      };
    }
    this.contextCompressor = new ContextCompressor(this.llm);
    this.retryPolicy = new ToolRetryPolicy();
    this.store = conversationStore;
    this.decisionLogger = new DecisionLogger();
  }
  /**
   * Attach a debug harness for structured trace logging and step-mode.
   * When attached, every phase of the conversation loop emits trace entries.
   */
  setDebugHarness(harness) {
    this.debugHarness = harness;
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
  async execute(prompt, config) {
    log7.info("Execute called", { promptLength: prompt.length, hasConfig: !!config });
    if (this.isRunning()) {
      log7.warn("Conversation already running");
      return this.createResult(false, "Conversation already running", 0);
    }
    const cfg = {
      ...DEFAULT_CONFIG4,
      ...config?.maxTurns !== void 0 ? { maxTurns: config.maxTurns } : {},
      ...config?.timeoutMs !== void 0 ? { timeoutMs: config.timeoutMs } : {},
      ...config?.maxTokensPerTurn !== void 0 ? { maxTokensPerTurn: config.maxTokensPerTurn } : {},
      ...config?.requireTodoWrite !== void 0 ? { requireTodoWrite: config.requireTodoWrite } : {},
      // These don't have defaults in DEFAULT_CONFIG
      systemPrompt: config?.systemPrompt,
      signal: config?.signal,
      // Additional fields for resume
      saveToGoalMemory: config?.saveToGoalMemory,
      goalId: config?.goalId,
      compression: config?.compression
    };
    log7.info("Merged config", { maxTurns: cfg.maxTurns, timeoutMs: cfg.timeoutMs, requireTodoWrite: cfg.requireTodoWrite });
    this.lastConfig = cfg;
    this.history = [];
    this.status = "running";
    this.abortController = new AbortController();
    this.conversationId = this.generateId();
    this.debugHarness?.setConversationId(this.conversationId);
    const startTime = Date.now();
    await this.events.emit("conversation:started", { conversationId: this.conversationId });
    this.debugHarness?.setGoal(prompt);
    this.debugHarness?.trace("init", "conversation-started", {
      conversationId: this.conversationId,
      promptLength: prompt.length,
      prompt,
      config: { maxTurns: cfg.maxTurns, timeoutMs: cfg.timeoutMs, requireTodoWrite: cfg.requireTodoWrite },
      hasSystemPrompt: !!cfg.systemPrompt,
      hasGoalId: !!config?.goalId,
      goalId: config?.goalId
    });
    if (config?.goalId) {
      goalContextProvider.setActiveGoal(config.goalId, config.goalName || "Active Goal");
      log7.info("Activated goal context", { goalId: config.goalId, goalName: config.goalName });
      await this.events.emit(
        "conversation:goal-activated",
        {
          conversationId: this.conversationId,
          goalId: config.goalId,
          goalName: config.goalName || "Active Goal"
        }
      );
      const sessionStartContext = {
        goalId: config.goalId,
        goalName: config.goalName || "Active Goal",
        conversationId: this.conversationId,
        timestamp: startTime
      };
      await this.events.emit(
        "goal:session-started",
        sessionStartContext
      );
      if (config.onSessionStart) {
        try {
          await config.onSessionStart(sessionStartContext);
        } catch (error) {
          log7.warn("onSessionStart callback error", { error });
        }
      }
    }
    if (cfg.systemPrompt) {
      this.history.push({ role: "system", content: cfg.systemPrompt });
      log7.debug("Added system prompt", { length: cfg.systemPrompt.length });
    } else {
      log7.warn("No system prompt provided - LLM may not use tools effectively");
    }
    this.history.push({ role: "user", content: prompt });
    this.originalGoal = prompt;
    this.intentClassification = await classifyIntent(prompt, this.history, this.llmClassifyFn);
    log7.info("Intent classified", {
      complexity: this.intentClassification.complexity,
      confidence: this.intentClassification.confidence,
      suggestedActions: this.intentClassification.suggestedActions
    });
    await this.events.emit("conversation:intent-classified", {
      classification: this.intentClassification,
      goal: prompt
    });
    this.debugHarness?.trace("classification", "intent-classified", {
      complexity: this.intentClassification.complexity,
      confidence: this.intentClassification.confidence,
      suggestedActions: this.intentClassification.suggestedActions,
      reasoning: this.intentClassification.reasoning,
      todoWriteRequired: cfg.requireTodoWrite
    });
    if (canSkipTodoWrite(this.intentClassification)) {
      log7.info("Skipping TodoWrite requirement due to task complexity", {
        complexity: this.intentClassification.complexity
      });
      cfg.requireTodoWrite = false;
      this.debugHarness?.trace("classification", "todowrite-skipped", {
        complexity: this.intentClassification.complexity,
        reason: "Trivial or simple query \u2014 no plan required"
      });
    }
    if (needsClarification(this.intentClassification)) {
      log7.info("Task needs clarification - injecting agent_ask_user enforcement");
      this.history.push({
        role: "user",
        content: `[System Instruction] IMPORTANT: This request requires clarifying questions. You MUST use the agent_ask_user tool with structured questions and options. DO NOT ask questions in plain text. Call agent_ask_user now with 2-4 relevant questions before proceeding.`
      });
    }
    this.hasPlan = false;
    this.planEnforcementAttempts = 0;
    this.currentTodos = [];
    this.currentTurn = 0;
    this.toolResults = [];
    this.outputPaths = [];
    this.hasProducedOutput = false;
    this.decisionLogger.clear();
    if (config?.retry) {
      this.retryPolicy.updateConfig(config.retry);
    }
    if (config?.compression) {
      this.contextCompressor.updateConfig(config.compression);
    }
    try {
      const result = await this.runLoop(cfg, startTime);
      if (config?.goalId) {
        await this.emitGoalSessionCompleted(config, startTime, result);
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.events.emit("conversation:failed", { error: errorMessage });
      this.debugHarness?.trace("termination", "conversation-error", {
        error: errorMessage,
        turn: this.currentTurn,
        durationMs: Date.now() - startTime
      });
      const errorResult = this.createResult(false, errorMessage, Date.now() - startTime);
      if (config?.goalId) {
        await this.emitGoalSessionCompleted(config, startTime, errorResult);
      }
      return errorResult;
    } finally {
      await this.debugHarness?.finalize(this.status);
      if (config?.goalId) {
        goalContextProvider.clearActiveGoal();
      }
      this.status = "idle";
      this.abortController = null;
    }
  }
  /**
   * Emit goal session completed event and call callback
   */
  async emitGoalSessionCompleted(config, _startTime, result) {
    const sessionSummary = {
      toolsExecuted: this.toolResults.map((r) => r.toolName),
      outputPaths: this.outputPaths,
      tasksCreated: this.currentTodos.length,
      tasksCompleted: this.currentTodos.filter((t) => t.status === "completed").length
    };
    const sessionCompleteContext = {
      goalId: config.goalId,
      goalName: config.goalName || "Active Goal",
      conversationId: this.conversationId,
      success: result.success,
      cancelled: result.status === "cancelled",
      result: result.result,
      error: result.error,
      turns: result.turns,
      durationMs: result.durationMs,
      summary: sessionSummary
    };
    await this.events.emit(
      "goal:session-completed",
      sessionCompleteContext
    );
    if (config.onSessionComplete) {
      try {
        await config.onSessionComplete(sessionCompleteContext);
      } catch (error) {
        log7.warn("onSessionComplete callback error", { error });
      }
    }
  }
  /**
   * Cancel the current conversation
   */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.status = "cancelled";
    }
  }
  /**
   * Check if conversation is running
   */
  isRunning() {
    return this.status === "running" || this.status === "waiting_for_user";
  }
  /**
   * Check if conversation is paused (waiting for contract approval)
   */
  isPaused() {
    return this.status === "paused";
  }
  /**
   * Get current conversation status
   */
  getStatus() {
    return this.status;
  }
  /**
   * Get decision log for debugging/observability
   */
  getDecisionLog() {
    return this.decisionLogger.getDecisions();
  }
  /**
   * Get decision log summary as a string
   */
  getDecisionSummary() {
    return this.decisionLogger.getDecisionsSummary();
  }
  // ===========================================================================
  // CONTRACT RESUME METHODS
  // ===========================================================================
  /**
   * Resume conversation after contract approval.
   * Adds approval confirmation to history and continues execution.
   */
  async resumeWithApproval(contractPath) {
    if (this.status !== "paused") {
      return this.createResult(false, "Cannot resume: conversation is not paused", 0, this.status);
    }
    log7.info("Resuming with approval", { contractPath, conversationId: this.conversationId });
    this.debugHarness?.trace("resume", "contract-approved", {
      contractPath,
      conversationId: this.conversationId
    });
    await this.events.emit(
      "contract:approved",
      { goalId: this.lastConfig?.goalId, contractPath }
    );
    this.history.push({
      role: "user",
      content: `[Contract Approved] The contract at ${contractPath} has been approved. You may now proceed with execution.`
    });
    this.status = "running";
    const startTime = Date.now();
    if (!this.lastConfig) {
      return this.createResult(false, "No configuration found for resume", 0, "failed");
    }
    return this.runLoop(this.lastConfig, startTime);
  }
  /**
   * Resume conversation with requested changes to the contract.
   * Adds feedback to history and allows agent to revise.
   */
  async resumeWithChanges(feedback) {
    if (this.status !== "paused") {
      return this.createResult(false, "Cannot resume: conversation is not paused", 0, this.status);
    }
    log7.info("Resuming with changes requested", { feedback, conversationId: this.conversationId });
    this.debugHarness?.trace("resume", "changes-requested", {
      feedbackPreview: feedback.substring(0, 300),
      conversationId: this.conversationId
    });
    await this.events.emit(
      "contract:changes-requested",
      { goalId: this.lastConfig?.goalId, feedback }
    );
    this.history.push({
      role: "user",
      content: `[Changes Requested] Please revise the contract with the following feedback:

${feedback}

After making changes, save the updated contract and call submit_contract again.`
    });
    this.status = "running";
    const startTime = Date.now();
    if (!this.lastConfig) {
      return this.createResult(false, "No configuration found for resume", 0, "failed");
    }
    return this.runLoop(this.lastConfig, startTime);
  }
  /**
   * Reject the contract and end the conversation.
   */
  async rejectContract(reason) {
    if (this.status !== "paused") {
      return this.createResult(false, "Cannot reject: conversation is not paused", 0, this.status);
    }
    log7.info("Contract rejected", { reason, conversationId: this.conversationId });
    this.debugHarness?.trace("resume", "contract-rejected", {
      reason,
      conversationId: this.conversationId
    });
    await this.events.emit(
      "contract:rejected",
      { goalId: this.lastConfig?.goalId, reason }
    );
    this.status = "cancelled";
    await this.events.emit("conversation:cancelled", { conversationId: this.conversationId });
    return this.createResult(
      false,
      reason ? `Contract rejected: ${reason}` : "Contract rejected by user",
      0,
      "cancelled"
    );
  }
  // ===========================================================================
  // CONVERSATION LOOP
  // ===========================================================================
  /**
   * Main conversation loop
   */
  async runLoop(config, startTime) {
    log7.info("Starting conversation loop", { maxTurns: config.maxTurns, timeoutMs: config.timeoutMs, startTurn: this.currentTurn });
    while (this.currentTurn < config.maxTurns) {
      if (this.abortController?.signal.aborted || config.signal?.aborted) {
        this.debugHarness?.trace("termination", "cancelled", {
          turn: this.currentTurn,
          durationMs: Date.now() - startTime
        });
        this.status = "cancelled";
        await this.events.emit("conversation:cancelled", { conversationId: this.conversationId });
        return this.createResult(false, "Conversation cancelled", Date.now() - startTime, "cancelled");
      }
      if (Date.now() - startTime > config.timeoutMs) {
        this.status = "failed";
        return this.createResult(false, "Conversation timeout", Date.now() - startTime, "failed");
      }
      this.currentTurn++;
      this.history = this.history.filter(
        (m) => !(m.role === "user" && (m.content.startsWith("[System Reminder]") || m.content.startsWith("[Active Tasks]")))
      );
      log7.info("Turn", { turn: this.currentTurn, historyLength: this.history.length });
      this.debugHarness?.setTurn(this.currentTurn);
      this.debugHarness?.trace("turn-start", "turn-begin", {
        turn: this.currentTurn,
        historyLength: this.history.length,
        hasPlan: this.hasPlan,
        todosCount: this.currentTodos.length,
        activeTodos: this.currentTodos.filter((t) => t.status !== "completed").map((t) => t.content),
        hasProducedOutput: this.hasProducedOutput
      });
      if (config.requireTodoWrite && !this.hasPlan && this.intentClassification) {
        const guidance = getTodoWriteGuidance({
          complexity: this.intentClassification.complexity,
          turnNumber: this.currentTurn,
          hasProducedOutput: this.hasProducedOutput
        });
        if (guidance.level !== "none" && guidance.message) {
          this.decisionLogger.log({
            turn: this.currentTurn,
            decision: "todowrite-guidance",
            reason: `Complexity: ${this.intentClassification.complexity}, Level: ${guidance.level}`,
            inputs: {
              complexity: this.intentClassification.complexity,
              turnNumber: this.currentTurn,
              hasProducedOutput: this.hasProducedOutput
            },
            outcome: guidance.level
          });
          this.history.push({
            role: "user",
            content: `[System Reminder] ${guidance.message}`
          });
          log7.info("TodoWrite guidance injected", {
            level: guidance.level,
            turn: this.currentTurn
          });
          this.debugHarness?.trace("turn-start", "todowrite-guidance-injected", {
            level: guidance.level,
            complexity: this.intentClassification.complexity,
            message: guidance.message
          });
        }
      }
      if (this.currentTodos.length > 0) {
        const activeTodos = this.currentTodos.filter((t) => t.status !== "completed").map((t) => `- [${t.status}] ${t.content}`).join("\n");
        if (activeTodos) {
          this.history.push({
            role: "user",
            content: `[Active Tasks]
${activeTodos}`
          });
        }
      }
      let response;
      try {
        const remainingTime = config.timeoutMs - (Date.now() - startTime);
        if (remainingTime <= 0) {
          this.status = "failed";
          log7.warn("Timeout before LLM call", { turn: this.currentTurn });
          return this.createResult(false, "Conversation timeout", Date.now() - startTime, "failed");
        }
        const toolsList = this.tools.list();
        log7.debug("=".repeat(80));
        log7.debug(`TURN ${this.currentTurn} - SENDING TO LLM`);
        log7.debug("=".repeat(80));
        log7.debug("Message History:", {
          messageCount: this.history.length,
          messages: this.history.map((msg, idx) => ({
            index: idx,
            role: msg.role,
            contentLength: msg.content?.length ?? 0,
            contentPreview: msg.content ? msg.content.substring(0, 200) : "(no content)",
            hasToolCalls: !!msg.toolCalls,
            toolCallCount: msg.toolCalls?.length ?? 0,
            toolNames: msg.toolCalls?.map((tc) => tc.name)
          }))
        });
        log7.debug("Available Tools:", { count: toolsList.length, tools: toolsList.map((t) => t.name) });
        log7.debug("Full Prompt:", { history: this.history });
        log7.debug("=".repeat(80));
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
          log7.info("Context compressed before LLM call", {
            originalTokens: compressionResult.originalTokens,
            compressedTokens: compressionResult.compressedTokens,
            summarizedTurns: compressionResult.summarizedTurns
          });
        }
        this.debugHarness?.trace("llm-request", "sending-to-llm", {
          turn: this.currentTurn,
          messageCount: messagesToSend.length,
          toolCount: toolsList.length,
          toolNames: toolsList.map((t) => t.name),
          compressed: compressionResult.wasCompressed,
          messages: messagesToSend.map((m, i) => ({
            idx: i,
            role: m.role,
            len: m.content?.length ?? 0,
            preview: m.content?.substring(0, 120),
            toolCalls: m.toolCalls?.map((tc) => tc.name)
          }))
        });
        const llmPromise = this.llm.chat(messagesToSend, {
          tools: toolsList,
          maxTokens: config.maxTokensPerTurn,
          signal: this.abortController?.signal
        });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error("Conversation timeout");
            error.name = "TimeoutError";
            reject(error);
          }, remainingTime);
        });
        response = await Promise.race([llmPromise, timeoutPromise]);
        log7.debug("=".repeat(80));
        log7.debug(`TURN ${this.currentTurn} - RECEIVED FROM LLM`);
        log7.debug("=".repeat(80));
        log7.debug("Response Summary:", {
          contentLength: response.content?.length ?? 0,
          hasToolCalls: !!response.toolCalls,
          toolCallCount: response.toolCalls?.length ?? 0,
          finishReason: response.finishReason
        });
        log7.debug("Content:", { content: response.content });
        if (response.toolCalls && response.toolCalls.length > 0) {
          log7.debug("Tool Calls:", {
            toolCalls: response.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              params: tc.params
            }))
          });
        }
        log7.debug("Full Response:", { response });
        log7.debug("=".repeat(80));
        this.debugHarness?.trace("llm-response", "received-from-llm", {
          turn: this.currentTurn,
          contentLength: response.content?.length ?? 0,
          contentPreview: response.content?.substring(0, 200),
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls?.length ?? 0,
          toolCalls: response.toolCalls?.map((tc) => ({ name: tc.name, paramKeys: Object.keys(tc.params) })),
          usage: response.usage
        });
      } catch (error) {
        log7.error("LLM call failed", { turn: this.currentTurn, error: error.message, name: error.name });
        this.debugHarness?.trace("error", "llm-call-failed", {
          turn: this.currentTurn,
          errorName: error.name,
          errorMessage: error.message
        });
        if (error.name === "AbortError") {
          this.status = "cancelled";
          return this.createResult(false, "Conversation cancelled", Date.now() - startTime, "cancelled");
        }
        if (error.name === "TimeoutError") {
          this.status = "failed";
          return this.createResult(false, "Conversation timeout", Date.now() - startTime, "failed");
        }
        throw error;
      }
      const assistantMessage = {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls
      };
      this.history.push(assistantMessage);
      await this.events.emit("conversation:turn", { turn: this.currentTurn, message: assistantMessage });
      if (config.requireTodoWrite && !this.hasPlan && this.currentTurn <= this.MAX_PLAN_ENFORCEMENT_ATTEMPTS) {
        const hasTodoWrite = response.toolCalls?.some(
          (tc) => tc.name === "TodoWrite" || tc.name === "batch_tools" && Array.isArray(tc.params.calls) && tc.params.calls.some((c) => c.tool === "TodoWrite")
        );
        if (hasTodoWrite) {
          this.hasPlan = true;
          log7.info("TodoWrite called - plan established", { turn: this.currentTurn });
          this.debugHarness?.trace("todowrite-gate", "plan-established", {
            turn: this.currentTurn
          });
        } else if (response.toolCalls && response.toolCalls.length > 0) {
          const exemptTools = filterExemptTools(response.toolCalls);
          const actionTools = filterActionTools(response.toolCalls);
          log7.debug("Tool exemption check", {
            turn: this.currentTurn,
            exemptTools: exemptTools.map((tc) => tc.name),
            actionTools: actionTools.map((tc) => tc.name)
          });
          if (actionTools.length === 0 && exemptTools.length > 0) {
            log7.info("Allowing exempt tools without TodoWrite", {
              turn: this.currentTurn,
              tools: exemptTools.map((tc) => tc.name)
            });
            this.debugHarness?.trace("todowrite-gate", "exempt-tools-allowed", {
              turn: this.currentTurn,
              exemptTools: exemptTools.map((tc) => tc.name),
              blocked: false
            });
          } else if (actionTools.length > 0) {
            this.planEnforcementAttempts++;
            log7.warn("Agent using action tools without TodoWrite plan", {
              turn: this.currentTurn,
              attempt: this.planEnforcementAttempts,
              maxAttempts: this.MAX_PLAN_ENFORCEMENT_ATTEMPTS,
              actionTools: actionTools.map((tc) => tc.name),
              exemptTools: exemptTools.map((tc) => tc.name)
            });
            this.debugHarness?.trace("todowrite-gate", "action-tools-blocked", {
              turn: this.currentTurn,
              attempt: this.planEnforcementAttempts,
              maxAttempts: this.MAX_PLAN_ENFORCEMENT_ATTEMPTS,
              actionTools: actionTools.map((tc) => tc.name),
              exemptTools: exemptTools.map((tc) => tc.name),
              blocked: true
            });
            for (const toolCall of actionTools) {
              this.history.push({
                role: "tool",
                content: `Tool call blocked: You must call TodoWrite first to create a task plan before using "${toolCall.name}". However, clarification tools (like agent_ask_user) and query tools are allowed without a plan.`,
                toolCallId: toolCall.id,
                toolName: toolCall.name
              });
            }
            for (const toolCall of exemptTools) {
              await this.events.emit("conversation:tool-call", { toolCall });
              const result = await this.executeTool(toolCall);
              await this.events.emit("conversation:tool-result", { toolCall, result });
              this.history.push({
                role: "tool",
                content: this.formatToolResult(result),
                toolCallId: toolCall.id,
                toolName: toolCall.name
              });
            }
            this.history.push({
              role: "user",
              content: `IMPORTANT: You MUST call TodoWrite to create a task plan before proceeding with action tools like ${actionTools.map((tc) => tc.name).join(", ")}. This is reminder ${this.planEnforcementAttempts}/${this.MAX_PLAN_ENFORCEMENT_ATTEMPTS}. Clarification and query tools are allowed without a plan.`
            });
            continue;
          }
        }
      }
      if (!this.hasPlan && this.currentTurn > this.MAX_PLAN_ENFORCEMENT_ATTEMPTS) {
        log7.warn("Agent proceeding without TodoWrite plan after max enforcement attempts");
      }
      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (config?.saveToGoalMemory && goalContextProvider.hasActiveGoal()) {
          try {
            await this.saveGoalSession(config.goalId, startTime);
          } catch (error) {
            log7.warn("Failed to save goal session", { error });
          }
        }
        if (config?.goalId) {
          goalContextProvider.clearActiveGoal();
        }
        log7.info("Conversation complete", { turn: this.currentTurn, finishReason: response.finishReason });
        this.debugHarness?.trace("completion", "conversation-done", {
          turn: this.currentTurn,
          finishReason: response.finishReason,
          totalToolsExecuted: this.toolResults.length,
          totalOutputPaths: this.outputPaths.length,
          todosCreated: this.currentTodos.length,
          todosCompleted: this.currentTodos.filter((t) => t.status === "completed").length,
          durationMs: Date.now() - startTime,
          resultPreview: response.content?.substring(0, 300)
        });
        this.status = "completed";
        await this.events.emit("conversation:completed", {
          result: this.createResult(true, void 0, Date.now() - startTime)
        });
        return this.createResult(true, void 0, Date.now() - startTime);
      }
      for (const toolCall of response.toolCalls) {
        await this.events.emit("conversation:tool-call", { toolCall });
        log7.debug("-".repeat(80));
        log7.debug(`EXECUTING TOOL: ${toolCall.name}`);
        log7.debug("Tool Parameters:", { params: toolCall.params });
        const result = await this.executeTool(toolCall);
        log7.debug("Tool Result:", {
          success: result.success,
          hasData: !!result.data,
          hasError: !!result.error,
          observation: result.observation,
          fullResult: result
        });
        log7.debug("-".repeat(80));
        this.debugHarness?.trace("tool-exec", `tool:${toolCall.name}`, {
          turn: this.currentTurn,
          toolName: toolCall.name,
          params: toolCall.params,
          success: result.success,
          error: result.error,
          observationPreview: result.observation?.substring(0, 300),
          hasStructured: !!result.structured,
          structuredType: result.structured?.type,
          structuredSummary: result.structured?.summary
        });
        await this.events.emit("conversation:tool-result", { toolCall, result });
        this.toolResults.push({
          toolName: toolCall.name,
          success: result.success,
          output: result.observation,
          error: result.error
        });
        const toolMeta = getToolMetadata(toolCall.name);
        if (toolMeta.category === "mutation" && result.success && result.data) {
          const data = result.data;
          if (data.path) this.outputPaths.push(String(data.path));
          if (data.notePath) this.outputPaths.push(String(data.notePath));
          if (data.filePath) this.outputPaths.push(String(data.filePath));
        }
        if (toolMeta.category === "mutation" && result.success) {
          this.hasProducedOutput = true;
        }
        this.decisionLogger.log({
          turn: this.currentTurn,
          decision: "tool-executed",
          reason: `Executed ${toolCall.name}`,
          inputs: { toolName: toolCall.name, params: toolCall.params },
          outcome: result.success ? "success" : "failure"
        });
        const toolResultContent = this.formatToolResult(result);
        this.history.push({
          role: "tool",
          content: toolResultContent,
          toolCallId: toolCall.id,
          toolName: toolCall.name
          // Required by AI SDK v6
        });
        const isPauseTool = PAUSE_TOOLS.has(toolCall.name);
        const isBatchWithPause = toolCall.name === "batch_tools" && result.success && result.data?._hasPause;
        const pauseToolName = isPauseTool ? toolCall.name : isBatchWithPause ? String(result.data._pauseToolName) : null;
        if ((isPauseTool || isBatchWithPause) && result.success) {
          log7.info("Pause tool triggered", { toolName: pauseToolName });
          this.debugHarness?.trace("pause", "contract-submitted", {
            turn: this.currentTurn,
            toolName: pauseToolName,
            contractData: result.data
          });
          this.status = "paused";
          await this.events.emit(
            "conversation:paused",
            {
              conversationId: this.conversationId,
              reason: pauseToolName,
              data: result.data
            }
          );
          return this.createResult(
            true,
            void 0,
            Date.now() - startTime,
            "paused",
            { pauseReason: pauseToolName, pauseData: result.data }
          );
        }
      }
      this.debugHarness?.trace("turn-end", "turn-complete", {
        turn: this.currentTurn,
        toolsExecutedThisTurn: response.toolCalls?.length ?? 0,
        toolNames: response.toolCalls?.map((tc) => tc.name),
        historyLength: this.history.length,
        hasPlan: this.hasPlan,
        elapsedMs: Date.now() - startTime
      });
      await this.debugHarness?.turnGate(this.currentTurn);
      if (this.autoCheckpoint) {
        await this.checkpoint();
      }
    }
    this.debugHarness?.trace("termination", "max-turns-reached", {
      maxTurns: config.maxTurns,
      actualTurns: this.currentTurn,
      durationMs: Date.now() - startTime
    });
    this.status = "timeout";
    log7.warn("Max turns reached", { maxTurns: config.maxTurns, actualTurns: this.currentTurn });
    await this.events.emit(
      "conversation:timeout",
      { conversationId: this.conversationId }
    );
    return this.createResult(false, "Reached max turns limit", Date.now() - startTime, "timeout");
  }
  // ===========================================================================
  // TOOL EXECUTION
  // ===========================================================================
  /**
   * Execute a single tool call
   */
  async executeTool(toolCall) {
    log7.info("Tool", { name: toolCall.name });
    if (toolCall.name === "AskUserQuestion") {
      this.debugHarness?.trace("tool-special", "ask-user-question", {
        turn: this.currentTurn,
        questionCount: Array.isArray(toolCall.params.questions) ? toolCall.params.questions.length : 0
      });
      return this.handleAskUserQuestion(toolCall.params);
    }
    if (toolCall.name === "TodoWrite") {
      this.debugHarness?.trace("tool-special", "todo-write", {
        turn: this.currentTurn,
        todoCount: Array.isArray(toolCall.params.todos) ? toolCall.params.todos.length : 0,
        todos: toolCall.params.todos
      });
      return this.handleTodoWrite(toolCall.params);
    }
    if (toolCall.name === "submit_contract") {
      this.debugHarness?.trace("tool-special", "submit-contract", {
        turn: this.currentTurn,
        contractPath: toolCall.params.contract_path,
        goalId: toolCall.params.goal_id
      });
      return this.handleSubmitContract(toolCall.params);
    }
    if (toolCall.name === "batch_tools") {
      this.debugHarness?.trace("tool-special", "batch-tools", {
        turn: this.currentTurn,
        callCount: Array.isArray(toolCall.params.calls) ? toolCall.params.calls.length : 0
      });
      return this.handleBatchTools(toolCall.params);
    }
    if (!this.tools.has(toolCall.name)) {
      this.debugHarness?.trace("error", "tool-not-found", {
        turn: this.currentTurn,
        toolName: toolCall.name
      });
      return {
        success: false,
        error: `Tool not found: ${toolCall.name}`,
        observation: `Error: Tool "${toolCall.name}" not found`
      };
    }
    const retryResult = await this.retryPolicy.execute(
      async () => {
        const result = await this.tools.execute(toolCall.name, toolCall.params, {
          conversationId: this.conversationId,
          signal: this.abortController?.signal,
          // Pass UI for tool confirmation dialogs
          userInterface: this.ui
        });
        if (!result.success && result.error) {
          throw new Error(result.error);
        }
        return result;
      },
      {
        signal: this.abortController?.signal,
        onRetry: (attempt, error, delayMs) => {
          log7.info(`Retrying tool ${toolCall.name}`, {
            attempt,
            error: error.message,
            delayMs
          });
        }
      }
    );
    if (retryResult.success && retryResult.result) {
      return retryResult.result;
    }
    return {
      success: false,
      error: retryResult.lastError || "Tool execution failed",
      observation: `Error executing ${toolCall.name}: ${retryResult.lastError || "Unknown error"} (after ${retryResult.attempts} attempt${retryResult.attempts > 1 ? "s" : ""})`
    };
  }
  /**
   * Handle AskUserQuestion tool
   */
  async handleAskUserQuestion(params) {
    try {
      this.status = "waiting_for_user";
      const questions = params.questions;
      const answers = await this.ui.askMultiple(questions);
      this.status = "running";
      return {
        success: true,
        data: { answers },
        observation: `User answers: ${JSON.stringify(answers)}`
      };
    } catch (error) {
      this.status = "running";
      return {
        success: false,
        error: "User cancelled",
        observation: "User cancelled the question"
      };
    }
  }
  /**
   * Handle TodoWrite tool
   */
  async handleTodoWrite(params) {
    const todos = params.todos;
    const inProgress = todos.filter((t) => t.status === "in_progress");
    if (inProgress.length > 1) {
      return {
        success: false,
        error: "Only one task can be in_progress at a time",
        observation: "Error: Only one task can be in_progress at a time"
      };
    }
    this.currentTodos = todos;
    await this.events.emit("todo:updated", { todos });
    for (const todo of todos) {
      if (todo.status === "in_progress") {
        await this.events.emit("todo:task-started", { content: todo.content });
      }
    }
    return {
      success: true,
      data: { todoCount: todos.length },
      observation: `Updated ${todos.length} todos`
    };
  }
  /**
   * Handle submit_contract tool
   *
   * Submits a contract for user approval. This pauses the conversation
   * until the user approves, requests changes, or rejects.
   */
  async handleSubmitContract(params) {
    const contractPath = params.contract_path;
    const goalId = params.goal_id;
    if (!contractPath || !goalId) {
      return {
        success: false,
        error: "Missing required parameters: contract_path and goal_id",
        observation: "Error: submit_contract requires contract_path and goal_id parameters."
      };
    }
    await this.events.emit(
      "contract:pending-approval",
      {
        conversationId: this.conversationId,
        goalId,
        contractPath
      }
    );
    return {
      success: true,
      data: { contractPath, goalId, awaitingApproval: true },
      observation: "Contract submitted for user approval. The conversation will pause until the user approves, requests changes, or rejects."
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
  async handleBatchTools(params) {
    const calls = params.calls;
    if (!calls || !Array.isArray(calls)) {
      return {
        success: false,
        error: 'batch_tools requires a "calls" array',
        observation: 'Error: batch_tools requires a "calls" array with tool call objects.'
      };
    }
    if (calls.length === 0) {
      return {
        success: false,
        error: 'batch_tools "calls" array is empty',
        observation: 'Error: batch_tools "calls" array is empty. Provide at least one tool call.'
      };
    }
    log7.info("Executing batch_tools", { callCount: calls.length, tools: calls.map((c) => c.tool) });
    const regularCalls = [];
    const pauseCalls = [];
    for (const call of calls) {
      if (PAUSE_TOOLS.has(call.tool)) {
        pauseCalls.push(call);
      } else {
        regularCalls.push(call);
      }
    }
    const orderedCalls = [...regularCalls, ...pauseCalls];
    const results = [];
    let pauseResult = null;
    for (const call of orderedCalls) {
      const subToolCall = {
        id: `batch_${call.tool}_${Date.now()}`,
        name: call.tool,
        params: call.params || {}
      };
      log7.debug("Batch: executing sub-tool", { tool: call.tool });
      const result = await this.executeTool(subToolCall);
      results.push({ tool: call.tool, result });
      await this.events.emit("conversation:tool-call", { toolCall: subToolCall });
      await this.events.emit("conversation:tool-result", { toolCall: subToolCall, result });
      this.toolResults.push({
        toolName: call.tool,
        success: result.success,
        output: result.observation,
        error: result.error
      });
      const toolMeta = getToolMetadata(call.tool);
      if (toolMeta.category === "mutation" && result.success && result.data) {
        const data = result.data;
        if (data.path) this.outputPaths.push(String(data.path));
        if (data.notePath) this.outputPaths.push(String(data.notePath));
        if (data.filePath) this.outputPaths.push(String(data.filePath));
      }
      if (toolMeta.category === "mutation" && result.success) {
        this.hasProducedOutput = true;
      }
      if (PAUSE_TOOLS.has(call.tool) && result.success) {
        pauseResult = result;
      }
    }
    const combinedParts = [`[BATCH] Executed ${results.length} tool(s):`];
    for (const { tool: tool2, result } of results) {
      const formatted = this.formatToolResult(result);
      combinedParts.push(`
--- ${tool2} ---`);
      combinedParts.push(formatted);
    }
    const combinedResult = {
      success: results.every((r) => r.result.success),
      data: { batchResults: results.map((r) => ({ tool: r.tool, success: r.result.success, data: r.result.data })) },
      observation: combinedParts.join("\n")
    };
    if (pauseResult) {
      combinedResult.data = {
        ...combinedResult.data,
        ...pauseResult.data,
        _hasPause: true,
        _pauseToolName: results.find((r) => PAUSE_TOOLS.has(r.tool))?.tool
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
  formatToolResult(result) {
    if (result.observation && result.observation.startsWith("User answered:")) {
      return result.observation;
    }
    if (result.structured) {
      const s = result.structured;
      const parts = [];
      parts.push(`[${s.type.toUpperCase()}] ${s.summary}`);
      if (s.fields) {
        const fieldEntries = Object.entries(s.fields).filter(([_key, value]) => {
          if (Array.isArray(value) && value.length > 5) return false;
          if (typeof value === "object" && value !== null) {
            const str = JSON.stringify(value);
            if (str.length > 200) return false;
          }
          return true;
        }).map(([key, value]) => `  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
        if (fieldEntries.length > 0) {
          parts.push("Fields:");
          parts.push(...fieldEntries);
        }
        const resultArrays = Object.entries(s.fields).filter(
          ([_, value]) => Array.isArray(value) && value.length > 5
        );
        for (const [key, value] of resultArrays) {
          const arr = value;
          parts.push(`
${key} (${arr.length} items):`);
          arr.slice(0, 10).forEach((item, i) => {
            if (typeof item === "object" && item !== null) {
              const obj = item;
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
      if (s.actions && s.actions.length > 0) {
        parts.push("\nSuggested next steps:");
        s.actions.forEach((action) => {
          parts.push(`  - ${action.tool}: ${action.reason}`);
        });
      }
      if (s.metadata) {
        const metaParts = [];
        if (s.metadata.durationMs) metaParts.push(`${s.metadata.durationMs}ms`);
        if (s.metadata.itemCount !== void 0) metaParts.push(`${s.metadata.itemCount} items`);
        if (s.metadata.truncated) metaParts.push("truncated");
        if (metaParts.length > 0) {
          parts.push(`
(${metaParts.join(", ")})`);
        }
      }
      return parts.join("\n");
    }
    if (result.observation) {
      return result.observation;
    }
    if (result.success) {
      return JSON.stringify(result.data ?? { success: true });
    }
    return result.error ?? "Tool execution failed";
  }
  /**
   * Create a conversation result
   */
  createResult(success, error, durationMs, status, pauseInfo) {
    return {
      success,
      result: success ? this.getLastAssistantContent() : void 0,
      error,
      status: status ?? (success ? "completed" : "failed"),
      turns: this.countTurns(),
      durationMs,
      messages: [...this.history],
      pauseReason: pauseInfo?.pauseReason,
      pauseData: pauseInfo?.pauseData
    };
  }
  /**
   * Get content from last assistant message
   */
  getLastAssistantContent() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "assistant") {
        return this.history[i].content;
      }
    }
    return void 0;
  }
  /**
   * Count conversation turns (assistant messages)
   */
  countTurns() {
    return this.history.filter((m) => m.role === "assistant").length;
  }
  /**
   * Generate a unique conversation ID
   */
  generateId() {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  // ===========================================================================
  // GOAL SESSION MANAGEMENT
  // ===========================================================================
  /**
   * Save conversation session to goal memory
   */
  async saveGoalSession(goalId, startTime) {
    log7.info("Saving goal session", { goalId, conversationId: this.conversationId });
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
      status: this.status
    };
    const dateStr = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const durationSecs = Math.round((endTime - startTime) / 1e3);
    const tasksSummary = this.currentTodos.map((t) => `- [${t.status === "completed" ? "x" : " "}] ${t.content}`).join("\n");
    const sessionEntry = `
## Session ${dateStr}

**Goal**: ${this.originalGoal}
**Duration**: ${durationSecs}s
**Turns**: ${this.currentTurn}
**Tasks Created**: ${this.currentTodos.length}
**Files Modified**: ${this.outputPaths.length}

### Summary
${tasksSummary || "- No tasks tracked"}

---
`;
    try {
      await invoke("append_goal_memory", {
        goalId,
        memoryType: "episodic",
        content: sessionEntry
      });
      log7.info("Goal session saved to episodic memory", { goalId });
      await this.events.emit(
        "conversation:goal-session-saved",
        {
          conversationId: this.conversationId,
          goalId,
          sessionData
        }
      );
    } catch (error) {
      log7.error("Failed to save goal session to memory", { error, goalId });
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
  async checkpoint() {
    if (!this.conversationId) {
      log7.warn("Cannot checkpoint: no active conversation");
      return;
    }
    const snapshot = this.store.createSnapshot(
      this.conversationId,
      this.history,
      this.currentTodos,
      this.status,
      this.originalGoal,
      this.currentTurn,
      false,
      // isPlanning removed - pass false for backward compatibility
      {
        hasPlan: this.hasPlan,
        planEnforcementAttempts: this.planEnforcementAttempts
      }
    );
    await this.store.save(snapshot);
    log7.debug("Checkpoint saved", { id: this.conversationId, turn: this.currentTurn });
    await this.events.emit("conversation:checkpoint", {
      conversationId: this.conversationId,
      turn: this.currentTurn
    });
  }
  /**
   * Resume a conversation from a saved checkpoint
   *
   * @param conversationId - ID of the conversation to resume
   * @param config - Optional configuration overrides
   * @returns ConversationResult from continued execution
   */
  async resume(conversationId, config) {
    log7.info("Resuming conversation", { id: conversationId });
    const snapshot = await this.store.load(conversationId);
    if (!snapshot) {
      log7.error("Cannot resume: conversation not found", { id: conversationId });
      return this.createResult(false, `Conversation ${conversationId} not found`, 0, "failed");
    }
    if (this.isRunning()) {
      log7.warn("Cannot resume: conversation already running");
      return this.createResult(false, "Conversation already running", 0);
    }
    this.conversationId = snapshot.id;
    this.history = [...snapshot.history];
    this.currentTodos = [...snapshot.todos];
    this.status = snapshot.status;
    this.originalGoal = snapshot.originalGoal;
    this.currentTurn = snapshot.turn;
    if (snapshot.metadata) {
      this.hasPlan = snapshot.metadata.hasPlan ?? false;
      this.planEnforcementAttempts = snapshot.metadata.planEnforcementAttempts ?? 0;
    }
    this.abortController = new AbortController();
    this.status = "running";
    const startTime = Date.now();
    await this.events.emit("conversation:resumed", {
      conversationId: this.conversationId,
      turn: this.currentTurn
    });
    if (this.currentTodos.length > 0) {
      await this.events.emit("todo:updated", { todos: this.currentTodos });
    }
    try {
      const cfg = {
        maxTurns: config?.maxTurns ?? 50,
        timeoutMs: config?.timeoutMs ?? 3e5,
        maxTokensPerTurn: config?.maxTokensPerTurn ?? 4096,
        requireTodoWrite: config?.requireTodoWrite ?? true,
        systemPrompt: config?.systemPrompt,
        signal: config?.signal
      };
      const result = await this.runLoop(cfg, startTime);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.events.emit("conversation:failed", { error: errorMessage });
      return this.createResult(false, errorMessage, Date.now() - startTime);
    } finally {
      this.status = "idle";
      this.abortController = null;
    }
  }
  /**
   * List all saved conversations
   */
  async listCheckpoints() {
    return this.store.list();
  }
  /**
   * Delete a saved conversation checkpoint
   */
  async deleteCheckpoint(conversationId) {
    return this.store.delete(conversationId);
  }
  /**
   * Get the current conversation ID
   */
  getConversationId() {
    return this.conversationId;
  }
  /**
   * Enable or disable auto-checkpoint after each turn
   */
  setAutoCheckpoint(enabled) {
    this.autoCheckpoint = enabled;
    log7.debug("Auto-checkpoint", { enabled });
  }
  /**
   * Set a custom conversation store
   */
  setStore(store) {
    this.store = store;
  }
};

// src/kernel/TodoManager.ts
var log8 = createLogger("TodoManager");
var VALID_STATUSES = ["pending", "in_progress", "completed"];
function validateTodo(todo) {
  if (!todo.content || todo.content.trim() === "") {
    return "Todo content cannot be empty";
  }
  if (!todo.activeForm || todo.activeForm.trim() === "") {
    return "Todo activeForm cannot be empty";
  }
  if (!VALID_STATUSES.includes(todo.status)) {
    return `Invalid status: ${todo.status}. Must be one of: ${VALID_STATUSES.join(", ")}`;
  }
  return null;
}
var TodoManager = class {
  todos = [];
  subscribers = /* @__PURE__ */ new Set();
  events;
  isProcessingEvent = false;
  constructor(events) {
    this.events = events;
    log8.info("TodoManager constructor - subscribing to todo:updated events");
    this.events.on("todo:updated", (payload) => {
      log8.info("TodoManager received todo:updated event", {
        isProcessingEvent: this.isProcessingEvent,
        payload
      });
      if (this.isProcessingEvent) {
        log8.debug("Ignoring event - self-emitted");
        return;
      }
      const todos = payload.todos;
      this.handleExternalUpdate(todos);
    });
    log8.info("TodoManager constructor complete - subscription active");
  }
  /**
   * Handle external todo updates (from ConversationEngine)
   * Updates internal state and notifies subscribers without re-emitting events
   */
  handleExternalUpdate(todos) {
    log8.info("handleExternalUpdate called", { todoCount: todos.length, todos });
    for (const todo of todos) {
      const error = validateTodo(todo);
      if (error) {
        log8.warn("Invalid todo from external update", { error, todo });
        return;
      }
    }
    const inProgress = todos.filter((t) => t.status === "in_progress");
    if (inProgress.length > 1) {
      log8.warn("External update has multiple in_progress tasks");
      return;
    }
    this.todos = todos.map((t) => ({ ...t }));
    log8.info("Internal todos updated", { todoCount: this.todos.length });
    log8.info("Notifying subscribers", { subscriberCount: this.subscribers.size });
    this.notifySubscribers();
  }
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  /**
   * Get all todos
   */
  getTodos() {
    return [...this.todos];
  }
  /**
   * Get count of todos
   */
  count() {
    return this.todos.length;
  }
  /**
   * Set the entire todo list (replaces existing)
   */
  setTodos(todos) {
    for (const todo of todos) {
      const error = validateTodo(todo);
      if (error) {
        return { success: false, error };
      }
    }
    const inProgress = todos.filter((t) => t.status === "in_progress");
    if (inProgress.length > 1) {
      return {
        success: false,
        error: "Only one task can be in_progress at a time"
      };
    }
    const previousTodos = this.todos;
    this.todos = todos.map((t) => ({ ...t }));
    this.emitStatusChangeEvents(previousTodos, this.todos);
    this.isProcessingEvent = true;
    try {
      this.events.emit("todo:updated", { todos: this.getTodos() });
    } finally {
      this.isProcessingEvent = false;
    }
    this.notifySubscribers();
    return { success: true };
  }
  /**
   * Clear all todos
   */
  clear() {
    this.todos = [];
    this.isProcessingEvent = true;
    try {
      this.events.emit("todo:updated", { todos: [] });
    } finally {
      this.isProcessingEvent = false;
    }
    this.notifySubscribers();
  }
  // ===========================================================================
  // STATUS HELPERS
  // ===========================================================================
  /**
   * Get pending todos
   */
  getPending() {
    return this.todos.filter((t) => t.status === "pending");
  }
  /**
   * Get in_progress todos
   */
  getInProgress() {
    return this.todos.filter((t) => t.status === "in_progress");
  }
  /**
   * Get completed todos
   */
  getCompleted() {
    return this.todos.filter((t) => t.status === "completed");
  }
  /**
   * Get the current task (in_progress)
   */
  getCurrentTask() {
    const inProgress = this.getInProgress();
    return inProgress.length > 0 ? inProgress[0] : null;
  }
  // ===========================================================================
  // PROGRESS
  // ===========================================================================
  /**
   * Get progress percentage (0-100)
   */
  getProgress() {
    if (this.todos.length === 0) return 0;
    const completed = this.getCompleted().length;
    return Math.round(completed / this.todos.length * 100);
  }
  // ===========================================================================
  // CONVENIENCE METHODS
  // ===========================================================================
  /**
   * Start a task (pending -> in_progress)
   */
  startTask(index) {
    if (index < 0 || index >= this.todos.length) {
      return { success: false, error: "Invalid task index" };
    }
    const current = this.getCurrentTask();
    if (current) {
      return { success: false, error: "Another task is already in progress" };
    }
    const newTodos = [...this.todos];
    newTodos[index] = { ...newTodos[index], status: "in_progress" };
    return this.setTodos(newTodos);
  }
  /**
   * Complete a task (in_progress -> completed)
   */
  completeTask(index) {
    if (index < 0 || index >= this.todos.length) {
      return { success: false, error: "Invalid task index" };
    }
    if (this.todos[index].status !== "in_progress") {
      return { success: false, error: "Task is not in progress" };
    }
    const newTodos = [...this.todos];
    newTodos[index] = { ...newTodos[index], status: "completed" };
    return this.setTodos(newTodos);
  }
  /**
   * Add a new task
   */
  addTask(content, activeForm) {
    const newTodo = {
      content,
      activeForm,
      status: "pending"
    };
    return this.setTodos([...this.todos, newTodo]);
  }
  /**
   * Remove a task
   */
  removeTask(index) {
    if (index < 0 || index >= this.todos.length) {
      return { success: false, error: "Invalid task index" };
    }
    const newTodos = this.todos.filter((_, i) => i !== index);
    return this.setTodos(newTodos);
  }
  // ===========================================================================
  // SUBSCRIPTION
  // ===========================================================================
  /**
   * Subscribe to todo changes
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    log8.info("Subscriber added to TodoManager", { subscriberCount: this.subscribers.size });
    return () => {
      this.subscribers.delete(callback);
      log8.info("Subscriber removed from TodoManager", { subscriberCount: this.subscribers.size });
    };
  }
  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================
  /**
   * Notify subscribers of changes
   */
  notifySubscribers() {
    const todos = this.getTodos();
    for (const callback of this.subscribers) {
      callback(todos);
    }
  }
  /**
   * Emit events for status changes
   */
  emitStatusChangeEvents(previous, current) {
    const prevByContent = new Map(previous.map((t) => [t.content, t.status]));
    for (const todo of current) {
      const prevStatus = prevByContent.get(todo.content);
      if (todo.status === "in_progress" && prevStatus !== "in_progress") {
        this.events.emit("todo:task-started", { content: todo.content });
      }
      if (todo.status === "completed" && prevStatus !== "completed") {
        this.events.emit("todo:task-completed", { content: todo.content });
      }
    }
  }
};

// src/kernel/TaskSpawner.ts
var AGENT_TYPE_CONFIGS = {
  // New lowercase agent types
  explore: {
    defaultModel: "haiku",
    allowedTools: ["Read", "Glob", "Grep", "LS"],
    systemPromptSuffix: "You are a fast exploration agent. Only use read-only tools."
  },
  contract: {
    defaultModel: "sonnet",
    allowedTools: ["Read", "Glob", "Grep", "agent_ask_user", "vault_create_note", "submit_contract"],
    systemPromptSuffix: "You are a contract planning agent. Generate Smart Contracts for goals."
  },
  execute: {
    defaultModel: "sonnet",
    allowedTools: "*",
    systemPromptSuffix: "You are an execution agent with full access."
  },
  // Legacy uppercase names (for backward compatibility)
  Explore: {
    defaultModel: "haiku",
    allowedTools: ["Read", "Glob", "Grep", "LS"],
    systemPromptSuffix: "You are a fast exploration agent. Only use read-only tools."
  },
  "general-purpose": {
    defaultModel: "sonnet",
    allowedTools: "*"
  },
  Plan: {
    defaultModel: "sonnet",
    allowedTools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    systemPromptSuffix: "You are a planning agent. Design implementation strategies."
  },
  "contract-plan": {
    defaultModel: "sonnet",
    allowedTools: ["Read", "Glob", "Grep", "agent_ask_user", "vault_create_note", "submit_contract"],
    systemPromptSuffix: "You are a contract planning agent. Generate Smart Contracts for goals."
  },
  Bash: {
    defaultModel: "sonnet",
    allowedTools: ["Bash"],
    systemPromptSuffix: "You are a command execution agent. Only run bash commands."
  },
  Skill: {
    defaultModel: "sonnet",
    allowedTools: ["Read", "Glob", "Grep"],
    systemPromptSuffix: "You are a skill execution agent."
  }
};
var TaskSpawner = class {
  agentFactory;
  events;
  tasks = /* @__PURE__ */ new Map();
  constructor(agentFactory, events) {
    this.agentFactory = agentFactory;
    this.events = events;
  }
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  /**
   * Spawn a new task
   */
  async spawn(params) {
    const taskId = this.generateTaskId();
    const typeConfig = AGENT_TYPE_CONFIGS[params.subagentType];
    const agentConfig = {
      type: params.subagentType,
      model: params.model ?? typeConfig.defaultModel,
      allowedTools: typeConfig.allowedTools,
      systemPrompt: typeConfig.systemPromptSuffix,
      resumeFrom: params.resume
    };
    const agent = this.agentFactory.create(agentConfig);
    await this.events.emit("task:spawned", { taskId, type: params.subagentType });
    const promise = this.executeAgent(agent, params.prompt, taskId);
    const task = {
      id: taskId,
      type: params.subagentType,
      agent,
      promise
    };
    this.tasks.set(taskId, task);
    if (params.runInBackground) {
      promise.then((result) => {
        this.handleCompletion(taskId, result);
      }).catch((error) => {
        this.handleError(taskId, error);
      });
      return {
        taskId,
        success: true,
        status: "running"
      };
    }
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
  isRunning(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    return task.agent.isRunning();
  }
  /**
   * Get result of a task (may be undefined if still running)
   */
  async getResult(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    if (task.result) {
      return task.result;
    }
    if (task.agent.isRunning()) {
      const result = await task.promise;
      return this.createTaskResult(taskId, result);
    }
    return task.result;
  }
  /**
   * Get all running tasks
   */
  getRunningTasks() {
    const running = [];
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
  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.agent.cancel();
    }
  }
  /**
   * Cancel all running tasks
   */
  cancelAll() {
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
  async executeAgent(agent, prompt, _taskId) {
    return agent.execute(prompt);
  }
  /**
   * Handle task completion
   */
  handleCompletion(taskId, result) {
    const taskResult = this.createTaskResult(taskId, result);
    const task = this.tasks.get(taskId);
    if (task) {
      task.result = taskResult;
    }
    this.events.emit("task:completed", { taskId, result: taskResult });
    return taskResult;
  }
  /**
   * Handle task error
   */
  handleError(taskId, error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const taskResult = {
      taskId,
      success: false,
      error: errorMessage,
      status: "failed"
    };
    const task = this.tasks.get(taskId);
    if (task) {
      task.result = taskResult;
    }
    this.events.emit("task:completed", { taskId, result: taskResult });
    return taskResult;
  }
  /**
   * Create a TaskResult from ConversationResult
   */
  createTaskResult(taskId, result) {
    return {
      taskId,
      success: result.success,
      data: result.result,
      error: result.error,
      status: result.success ? "completed" : "failed"
    };
  }
  /**
   * Generate a unique task ID
   */
  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
};

// src/kernel/PlanManager.ts
var PlanManager = class {
  _isPlanning = false;
  _planContent = void 0;
  _approvalStatus = "pending";
  events;
  subscribers = /* @__PURE__ */ new Set();
  approvalResolver = null;
  constructor(events) {
    this.events = events;
  }
  // ===========================================================================
  // PUBLIC API - STATE
  // ===========================================================================
  /**
   * Check if in planning mode
   */
  isPlanning() {
    return this._isPlanning;
  }
  /**
   * Get current state snapshot
   */
  getState() {
    return {
      isPlanning: this._isPlanning,
      planContent: this._planContent,
      approvalStatus: this._approvalStatus
    };
  }
  // ===========================================================================
  // PUBLIC API - PLAN MODE CONTROL
  // ===========================================================================
  /**
   * Enter planning mode
   */
  enter() {
    this._isPlanning = true;
    this._planContent = void 0;
    this._approvalStatus = "pending";
    this.events.emit("plan:entered", void 0);
    this.notifySubscribers();
  }
  /**
   * Exit planning mode
   */
  exit(approved) {
    if (!this._isPlanning) {
      return { success: false, error: "Not in planning mode" };
    }
    const warning = !this._planContent ? "Exiting with no plan content" : void 0;
    this._isPlanning = false;
    this._approvalStatus = approved ? "approved" : "rejected";
    this.events.emit("plan:exited", { approved });
    this.notifySubscribers();
    if (this.approvalResolver) {
      this.approvalResolver(approved);
      this.approvalResolver = null;
    }
    return { success: true, warning };
  }
  // ===========================================================================
  // PUBLIC API - PLAN CONTENT
  // ===========================================================================
  /**
   * Set plan content
   */
  setPlanContent(content) {
    if (!this._isPlanning) {
      return { success: false, error: "Not in planning mode" };
    }
    this._planContent = content;
    this.events.emit("plan:updated", { content });
    this.notifySubscribers();
    return { success: true };
  }
  /**
   * Append to plan content
   */
  appendToPlan(content) {
    if (!this._isPlanning) {
      return { success: false, error: "Not in planning mode" };
    }
    this._planContent = (this._planContent ?? "") + content;
    this.events.emit("plan:updated", { content: this._planContent });
    this.notifySubscribers();
    return { success: true };
  }
  // ===========================================================================
  // PUBLIC API - APPROVAL
  // ===========================================================================
  /**
   * Approve the plan
   */
  approve() {
    if (!this._isPlanning) {
      return { success: false, error: "Not in planning mode" };
    }
    return this.exit(true);
  }
  /**
   * Reject the plan
   */
  reject() {
    if (!this._isPlanning) {
      return { success: false, error: "Not in planning mode" };
    }
    return this.exit(false);
  }
  /**
   * Wait for user approval
   */
  async waitForApproval(options) {
    const timeoutMs = options?.timeoutMs ?? 0;
    return new Promise((resolve) => {
      this.approvalResolver = resolve;
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.approvalResolver === resolve) {
            this.approvalResolver = null;
            this._approvalStatus = "rejected";
            this._isPlanning = false;
            this.notifySubscribers();
            resolve(false);
          }
        }, timeoutMs);
      }
    });
  }
  // ===========================================================================
  // PUBLIC API - SUBSCRIPTION
  // ===========================================================================
  /**
   * Subscribe to state changes
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================
  /**
   * Notify subscribers of state change
   */
  notifySubscribers() {
    const state = this.getState();
    for (const callback of this.subscribers) {
      callback(state);
    }
  }
};

// src/kernel/VerificationEngine.ts
var VERIFICATION_RULES = [
  {
    name: "todos-completed",
    check: async (output, context) => {
      if (context.todos.length === 0) {
        return true;
      }
      const incomplete = context.todos.filter((t) => t.status !== "completed");
      return incomplete.length === 0;
    },
    failureMessage: "Not all todo items were completed",
    suggestion: "Review incomplete todos and complete remaining tasks"
  },
  {
    name: "no-errors-in-history",
    check: async (output, context) => {
      if (context.toolResults.length === 0) {
        return true;
      }
      const errors = context.toolResults.filter((r) => !r.success);
      return errors.length === 0;
    },
    failureMessage: "Some tool executions failed",
    suggestion: "Review failed tool calls and retry or handle errors"
  }
];
var VerificationEngine = class {
  config;
  constructor(config) {
    this.config = config;
  }
  /**
   * Verify the output against rules
   */
  async verify(output, context) {
    if (!this.config.enabled) {
      return {
        passed: true,
        issues: [],
        suggestions: []
      };
    }
    const issues = [];
    const suggestions = [];
    const rules = this.config.rules || VERIFICATION_RULES;
    if (this.config.strategy === "rule-based" || this.config.strategy === "hybrid") {
      for (const rule of rules) {
        const passed = await rule.check(output, context);
        if (!passed) {
          issues.push(rule.failureMessage);
          if (rule.suggestion) {
            suggestions.push(rule.suggestion);
          }
        }
      }
    }
    if (this.config.strategy === "subagent" || this.config.strategy === "hybrid" && issues.length === 0) ;
    return {
      passed: issues.length === 0,
      issues,
      suggestions
    };
  }
};

// src/fs.ts
var log9 = createLogger("Filesystem");
var noopFilesystem = {
  async writeTextFile(path, _content) {
    log9.debug("writeTextFile (no-op)", { path });
  },
  async readTextFile(path) {
    log9.debug("readTextFile (no-op)", { path });
    return "";
  },
  async mkdir(path, _options) {
    log9.debug("mkdir (no-op)", { path });
  },
  async exists(path) {
    log9.debug("exists (no-op)", { path });
    return false;
  }
};
function createMemoryFilesystem() {
  const files = /* @__PURE__ */ new Map();
  const dirs = /* @__PURE__ */ new Set();
  return {
    async writeTextFile(path, content) {
      files.set(path, content);
    },
    async readTextFile(path) {
      const content = files.get(path);
      if (content === void 0) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    async mkdir(path, _options) {
      dirs.add(path);
    },
    async exists(path) {
      return files.has(path) || dirs.has(path);
    }
  };
}
var currentFilesystem = noopFilesystem;
function setFilesystem(fs) {
  currentFilesystem = fs;
  log9.info("Filesystem set");
}
function getFilesystem() {
  return currentFilesystem;
}
async function writeTextFile(path, content) {
  return currentFilesystem.writeTextFile(path, content);
}
async function readTextFile(path) {
  return currentFilesystem.readTextFile(path);
}
async function mkdir(path, options) {
  return currentFilesystem.mkdir(path, options);
}
async function exists(path) {
  return currentFilesystem.exists(path);
}

// src/kernel/DebugHarness.ts
var DEFAULT_MAX_PAYLOAD_BYTES = 2048;
function truncatePayload(obj, maxBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
  if (obj === void 0 || obj === null) return obj;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxBytes) return obj;
    return {
      _truncated: true,
      preview: s.substring(0, maxBytes),
      originalSize: s.length
    };
  } catch {
    return { _truncated: true, error: "non-serializable" };
  }
}
var TRACES_DIR = "/Users/govind/metaglass/learning-os/logs/traces";
var FLUSH_INTERVAL_MS = 1e3;
var DebugHarness = class {
  conversationId;
  entries = [];
  buffer = [];
  seq = 0;
  startTime;
  currentTurn = 0;
  lineCount = 0;
  // Sidecar index
  index;
  seenPhaseTurns = /* @__PURE__ */ new Set();
  // Step mode
  _stepMode = false;
  stepResolve = null;
  _disposed = false;
  // File paths
  tracePath;
  indexPath;
  // Flush timer
  flushTimer = null;
  // References for inspection (set externally)
  _getHistory = null;
  _getTodos = null;
  _getDecisions = null;
  constructor(conversationId, goal = "", config = {}) {
    this.conversationId = conversationId;
    this.startTime = Date.now();
    this.tracePath = `${TRACES_DIR}/trace-${conversationId}.jsonl`;
    this.indexPath = `${TRACES_DIR}/trace-${conversationId}.index.json`;
    this.index = {
      conversationId,
      goal,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      config,
      sections: [],
      totalEntries: 0,
      status: "running"
    };
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.ensureDir();
  }
  // ===========================================================================
  // TRACE API (called from ConversationEngine)
  // ===========================================================================
  /**
   * Record a trace entry. This is the primary API.
   *
   * @param phase - Which phase of the conversation loop
   * @param event - Specific event name (e.g., 'tool:vault_search', 'intent-classified')
   * @param data  - Structured payload (auto-truncated if large)
   */
  trace(phase, event, data = {}) {
    if (this._disposed) return;
    const entry = {
      seq: this.seq++,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      elapsed: Date.now() - this.startTime,
      turn: this.currentTurn,
      phase,
      event,
      data: this.sanitizeData(data)
    };
    this.entries.push(entry);
    this.lineCount++;
    const key = `${phase}:${this.currentTurn}`;
    if (!this.seenPhaseTurns.has(key)) {
      this.seenPhaseTurns.add(key);
      this.index.sections.push({
        phase,
        turn: this.currentTurn,
        seq: entry.seq,
        line: this.lineCount
      });
    }
    try {
      this.buffer.push(JSON.stringify(entry));
    } catch {
      this.buffer.push(JSON.stringify({ ...entry, data: { _error: "serialize-failed" } }));
    }
  }
  /**
   * Set the current turn (called by ConversationEngine at turn start)
   */
  setTurn(turn) {
    this.currentTurn = turn;
  }
  /**
   * Update the conversation ID after the engine generates the real one.
   * Updates the index metadata and file paths (no rename needed since
   * nothing has been flushed under the old placeholder ID yet).
   */
  setConversationId(id) {
    this.conversationId = id;
    this.index.conversationId = id;
    this.tracePath = `${TRACES_DIR}/trace-${id}.jsonl`;
    this.indexPath = `${TRACES_DIR}/trace-${id}.index.json`;
  }
  /**
   * Update the goal text (may not be known at construction time)
   */
  setGoal(goal) {
    this.index.goal = goal;
  }
  /**
   * Mark the final status of this trace
   */
  setStatus(status) {
    this.index.status = status;
  }
  // ===========================================================================
  // STEP MODE
  // ===========================================================================
  /**
   * Turn gate — called at the end of each turn in runLoop.
   * If step mode is active, blocks until step() is called.
   */
  async turnGate(turn) {
    if (!this._stepMode || this._disposed) return;
    this.trace("turn-end", "step-waiting", {
      turn,
      message: "Paused \u2014 call __aiosDebug.step() to continue."
    });
    await this.flush();
    const pauseStart = Date.now();
    await new Promise((resolve) => {
      this.stepResolve = resolve;
    });
    this.trace("turn-start", "step-resumed", {
      turn,
      pauseDurationMs: Date.now() - pauseStart
    });
  }
  /** Advance one turn. Called from console: __aiosDebug.step() */
  step() {
    if (this.stepResolve) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      resolve();
    }
  }
  /** Enable/disable step mode */
  setStepMode(enabled) {
    this._stepMode = enabled;
    if (!enabled && this.stepResolve) {
      this.step();
    }
  }
  /** Whether step mode is active */
  get stepMode() {
    return this._stepMode;
  }
  // ===========================================================================
  // INSPECTION API (for console and future UI)
  // ===========================================================================
  /** Get all entries for a specific turn */
  inspectTurn(turn) {
    return this.entries.filter((e) => e.turn === turn);
  }
  /** Get all entries for a specific phase */
  inspectPhase(phase) {
    return this.entries.filter((e) => e.phase === phase);
  }
  /** Get entries filtered by turn AND phase */
  inspect(turn, phase) {
    return this.entries.filter((e) => e.turn === turn && e.phase === phase);
  }
  /** Get all entries */
  allEntries() {
    return [...this.entries];
  }
  /** Compact text summary of the trace so far */
  summary() {
    const lines = [];
    lines.push(`Trace: ${this.conversationId}`);
    lines.push(`Goal: ${this.index.goal}`);
    lines.push(`Status: ${this.index.status}`);
    lines.push(`Turns: ${this.currentTurn}, Entries: ${this.entries.length}`);
    lines.push(`Elapsed: ${Date.now() - this.startTime}ms`);
    lines.push("");
    const byTurn = /* @__PURE__ */ new Map();
    for (const e of this.entries) {
      if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
      byTurn.get(e.turn).push(e);
    }
    for (const [turn, entries] of byTurn) {
      const phases = [...new Set(entries.map((e) => e.phase))];
      const tools = entries.filter((e) => e.phase === "tool-exec").map((e) => `${e.data.toolName}(${e.data.success ? "ok" : "err"})`);
      const errors = entries.filter((e) => e.phase === "error");
      lines.push(`Turn ${turn}: [${phases.join(" \u2192 ")}]`);
      if (tools.length > 0) lines.push(`  tools: ${tools.join(", ")}`);
      if (errors.length > 0) lines.push(`  errors: ${errors.length}`);
    }
    return lines.join("\n");
  }
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
  diagnose(query) {
    const q = query.toLowerCase().trim();
    let filtered = [];
    let label = query;
    const turnMatch = q.match(/turn\s*(\d+)/);
    if (turnMatch) {
      const turn = parseInt(turnMatch[1], 10);
      filtered = this.inspectTurn(turn);
      label = `Turn ${turn}`;
    } else if (q.includes("error") || q.includes("fail") || q.includes("why")) {
      filtered = this.entries.filter(
        (e) => e.phase === "error" || e.phase === "termination" || e.data.success === false || e.data.blocked === true
      );
      label = "Errors & failures";
    } else if (q.includes("tool")) {
      const toolName = q.replace(/tool\s*/i, "").trim();
      filtered = this.entries.filter(
        (e) => e.phase === "tool-exec" || e.phase === "tool-special"
      );
      if (toolName) {
        filtered = filtered.filter(
          (e) => e.event.includes(toolName) || String(e.data.toolName).includes(toolName)
        );
        label = `Tool: ${toolName}`;
      } else {
        label = "All tools";
      }
    } else if (q.includes("plan") || q.includes("todo") || q.includes("block")) {
      filtered = this.entries.filter(
        (e) => e.phase === "todowrite-gate" || e.phase === "tool-special"
      );
      label = "TodoWrite & planning";
    } else if (q.includes("llm") || q.includes("response") || q.includes("request")) {
      filtered = this.entries.filter(
        (e) => e.phase === "llm-request" || e.phase === "llm-response"
      );
      label = "LLM interactions";
    } else {
      const phase = q;
      filtered = this.entries.filter((e) => e.phase === phase);
      if (filtered.length === 0) {
        filtered = this.entries.filter(
          (e) => e.event.toLowerCase().includes(q) || JSON.stringify(e.data).toLowerCase().includes(q)
        );
        label = `Search: "${query}"`;
      } else {
        label = `Phase: ${phase}`;
      }
    }
    if (filtered.length === 0) {
      return `No entries found for: ${query}`;
    }
    const lines = [`--- ${label} (${filtered.length} entries) ---`];
    for (const e of filtered) {
      const dataStr = JSON.stringify(e.data, null, 0);
      const dataTrunc = dataStr.length > 300 ? dataStr.substring(0, 300) + "..." : dataStr;
      lines.push(`[${e.seq}] +${e.elapsed}ms T${e.turn} ${e.phase}/${e.event} ${dataTrunc}`);
    }
    return lines.join("\n");
  }
  // ===========================================================================
  // REFERENCE SETTERS (for inspection of live engine state)
  // ===========================================================================
  setHistoryRef(fn) {
    this._getHistory = fn;
  }
  setTodosRef(fn) {
    this._getTodos = fn;
  }
  setDecisionsRef(fn) {
    this._getDecisions = fn;
  }
  // ===========================================================================
  // CONSOLE API (exposed on window.__aiosDebug)
  // ===========================================================================
  getConsoleAPI() {
    const harness = this;
    return {
      // Step control
      step: () => this.step(),
      setStepMode: (on) => this.setStepMode(on),
      get stepMode() {
        return harness.stepMode;
      },
      // Inspection
      inspectTurn: (n) => this.inspectTurn(n),
      inspectPhase: (p) => this.inspectPhase(p),
      inspect: (turn, phase) => this.inspect(turn, phase),
      allEntries: () => this.allEntries(),
      summary: () => this.summary(),
      diagnose: (query) => this.diagnose(query),
      // Live state
      getHistory: () => this._getHistory?.() ?? [],
      getTodos: () => this._getTodos?.() ?? [],
      getDecisions: () => this._getDecisions?.() ?? [],
      // File access
      getTracePath: () => this.tracePath,
      getIndexPath: () => this.indexPath,
      flush: () => this.flush()
    };
  }
  // ===========================================================================
  // FILE I/O
  // ===========================================================================
  /**
   * Flush buffered entries to the JSONL trace file and update the sidecar index.
   */
  async flush() {
    if (this.buffer.length === 0 && this.entries.length === 0) return;
    if (this.buffer.length > 0) {
      const lines = this.buffer.splice(0, this.buffer.length);
      const chunk = lines.join("\n") + "\n";
      try {
        let existing = "";
        try {
          existing = await readTextFile(this.tracePath);
        } catch {
        }
        await writeTextFile(this.tracePath, existing + chunk);
      } catch (err) {
        console.error("[DebugHarness] Failed to write trace file:", err);
        this.buffer.unshift(...lines);
      }
    }
    this.index.totalEntries = this.entries.length;
    try {
      await writeTextFile(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch (err) {
      console.error("[DebugHarness] Failed to write index file:", err);
    }
  }
  /**
   * Finalize — flush remaining, update status, stop timer.
   * Called when conversation ends (success, error, cancel, timeout).
   */
  async finalize(status) {
    this.index.status = status;
    await this.flush();
    this.dispose();
  }
  /**
   * Dispose — release resources, unblock any pending step gate.
   * Safe to call multiple times.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stepMode = false;
    if (this.stepResolve) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      resolve();
    }
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
  // ===========================================================================
  // INTERNAL
  // ===========================================================================
  /**
   * Sanitize data payload — truncate large fields, handle non-serializable values.
   */
  sanitizeData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === void 0) continue;
      if (key === "params" || key === "toolParams") {
        result[key] = truncatePayload(value, 1024);
      } else if (key === "messages" || key === "history") {
        if (Array.isArray(value)) {
          result[key] = value.map((msg) => ({
            ...msg,
            content: typeof msg.content === "string" && msg.content.length > 200 ? msg.content.substring(0, 200) + `... (${msg.content.length} chars)` : msg.content
          }));
        } else {
          result[key] = truncatePayload(value);
        }
      } else if (typeof value === "string" && value.length > 2048) {
        result[key] = value.substring(0, 2048) + `... (${value.length} chars)`;
      } else {
        result[key] = truncatePayload(value);
      }
    }
    return result;
  }
  async ensureDir() {
    try {
      const dirExists = await exists(TRACES_DIR);
      if (!dirExists) {
        await mkdir(TRACES_DIR, { recursive: true });
      }
    } catch (err) {
      console.error("[DebugHarness] Failed to create traces directory:", err);
    }
  }
};
function installDebugStub() {
  if (typeof window === "undefined") return;
  if (window.__aiosDebug) return;
  const pending = { stepMode: false };
  const notReady = () => "Debug harness not active yet. Trigger a goal first.";
  const stub = {
    _isStub: true,
    _pending: pending,
    // Step control — captured for the real harness
    step: () => {
      console.log("[DebugHarness] Not active yet. Trigger a goal first.");
    },
    setStepMode: (on) => {
      pending.stepMode = on;
      console.log(`[DebugHarness] Step mode ${on ? "enabled" : "disabled"} (will apply when goal starts)`);
    },
    get stepMode() {
      return pending.stepMode;
    },
    // Inspection — not available until harness is live
    inspectTurn: () => {
      console.log(notReady());
      return [];
    },
    inspectPhase: () => {
      console.log(notReady());
      return [];
    },
    inspect: () => {
      console.log(notReady());
      return [];
    },
    allEntries: () => {
      console.log(notReady());
      return [];
    },
    summary: () => notReady(),
    diagnose: () => notReady(),
    // Live state
    getHistory: () => [],
    getTodos: () => [],
    getDecisions: () => [],
    // File access
    getTracePath: () => "",
    getIndexPath: () => "",
    flush: async () => {
    }
  };
  window.__aiosDebug = stub;
}
function absorbPendingConfig(harness) {
  if (typeof window === "undefined") return;
  const current = window.__aiosDebug;
  if (current?._isStub && current._pending) {
    if (current._pending.stepMode) {
      harness.setStepMode(true);
    }
  }
}
function initDebugFlag() {
  if (typeof window === "undefined") return;
  const descriptor = Object.getOwnPropertyDescriptor(window, "__aiosDebugEnabled");
  if (descriptor && (descriptor.get || descriptor.set)) return;
  let _enabled = !!window.__aiosDebugEnabled;
  Object.defineProperty(window, "__aiosDebugEnabled", {
    get() {
      return _enabled;
    },
    set(val) {
      _enabled = !!val;
      if (_enabled) {
        installDebugStub();
      }
    },
    configurable: true,
    enumerable: true
  });
  if (_enabled) {
    installDebugStub();
  }
}
initDebugFlag();
var log10 = createLogger("VercelAILLMProvider");
var modelProvider = null;
var toolRegistryProvider = null;
function setModelProvider(provider) {
  modelProvider = provider;
  log10.info("Model provider set");
}
function setToolRegistryProvider(provider) {
  toolRegistryProvider = provider;
  log10.info("Tool registry provider set");
}
function toCoreMess(messages) {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        return { role: "user", content: msg.content };
      case "assistant":
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          return {
            role: "assistant",
            content: [
              ...msg.content ? [{ type: "text", text: msg.content }] : [],
              ...msg.toolCalls.map((tc) => ({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.params ?? {}
              }))
            ]
          };
        }
        return { role: "assistant", content: msg.content };
      case "tool":
        let outputObj;
        try {
          const parsedValue = JSON.parse(msg.content || "{}");
          outputObj = { type: "json", value: parsedValue };
        } catch {
          outputObj = { type: "text", value: msg.content || "" };
        }
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.toolCallId || "",
              toolName: msg.toolName || "unknown",
              output: outputObj
            }
          ]
        };
      default:
        log10.warn("Unknown message role, treating as user", { role: msg.role });
        return { role: "user", content: msg.content };
    }
  });
}
function getToolsFromRegistry(toolNames) {
  if (!toolRegistryProvider) {
    return {};
  }
  const registryTools = toolRegistryProvider.getToolsForAI({
    ids: toolNames
  });
  log10.info("Got tools from ToolRegistry", {
    count: Object.keys(registryTools).length,
    names: Object.keys(registryTools)
  });
  return registryTools;
}
function toCoreTools(tools) {
  const coreTools = {};
  for (const toolDef of tools) {
    const inputSchema = ai.jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: true
    });
    coreTools[toolDef.name] = ai.tool({
      description: toolDef.description,
      inputSchema
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    });
    log10.debug("Registered fallback tool", { name: toolDef.name });
  }
  log10.info("Converted tools for LLM (fallback)", { count: tools.length });
  return coreTools;
}
function extractToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) {
    return void 0;
  }
  return toolCalls.map((tc) => {
    const params = tc.input ?? tc.args;
    return {
      id: tc.toolCallId,
      name: tc.toolName,
      params
    };
  });
}
var VercelAILLMProvider = class _VercelAILLMProvider {
  id;
  name;
  providerType;
  modelId;
  directModel;
  constructor(config = {}) {
    this.providerType = config.providerType || "anthropic";
    this.modelId = config.modelId;
    this.directModel = config.model;
    this.id = `vercel-ai-${this.providerType}`;
    this.name = `Vercel AI (${this.providerType})`;
  }
  /**
   * Get the language model to use
   */
  getModel() {
    if (this.directModel) {
      return this.directModel;
    }
    if (modelProvider) {
      return modelProvider.getModel(this.modelId);
    }
    throw new Error(
      "No model available. Either provide a model directly, set a model provider with setModelProvider(), or use AIOS setProviders() to configure the LLM provider."
    );
  }
  /**
   * Chat completion with tool support
   */
  async chat(messages, options) {
    const model = this.getModel();
    const coreMessages = toCoreMess(messages);
    let tools;
    if (options?.tools && options.tools.length > 0) {
      const toolNames = options.tools.map((t) => t.name);
      tools = getToolsFromRegistry(toolNames);
      if (Object.keys(tools).length === 0) {
        log10.warn("No tools found in ToolRegistry, using fallback conversion");
        tools = toCoreTools(options.tools);
      }
    }
    try {
      const generateOptions = {
        model,
        messages: coreMessages,
        tools: tools && Object.keys(tools).length > 0 ? tools : void 0,
        temperature: options?.temperature,
        stopSequences: options?.stop,
        abortSignal: options?.signal,
        experimental_timeout: 18e4,
        // Enable prompt caching for Anthropic
        ...this.providerType === "anthropic" && {
          experimental_providerMetadata: {
            anthropic: {
              cacheControl: { type: "ephemeral" }
            }
          }
        },
        // Disable thinking mode for Ollama
        ...this.providerType === "ollama" && {
          providerOptions: {
            ollama: {
              options: {
                enable_thinking: false
              }
            }
          }
        }
      };
      if (options?.maxTokens) {
        generateOptions.maxTokens = options.maxTokens;
      }
      const contextSize = coreMessages.reduce((total, msg) => {
        if (typeof msg.content === "string") {
          return total + msg.content.length;
        } else if (Array.isArray(msg.content)) {
          return total + msg.content.reduce((sum, part) => {
            if (part.type === "text") return sum + (part.text?.length || 0);
            if (part.type === "tool-result") {
              const output = part.output;
              if (typeof output === "string") return sum + output.length;
              if (output?.value) return sum + JSON.stringify(output.value).length;
            }
            return sum;
          }, 0);
        }
        return total;
      }, 0);
      log10.info("Calling generateText", {
        toolCount: generateOptions.tools ? Object.keys(generateOptions.tools).length : 0,
        messageCount: coreMessages.length,
        contextSizeChars: contextSize,
        contextSizeKb: Math.round(contextSize / 1024)
      });
      const result = await ai.generateText(generateOptions);
      let finishReason = "stop";
      if (result.finishReason === "tool-calls") {
        finishReason = "tool_calls";
      } else if (result.finishReason === "length") {
        finishReason = "length";
      } else if (result.finishReason === "error") {
        finishReason = "error";
      }
      const toolCalls = extractToolCalls(result.toolCalls);
      const usage = result.usage;
      const promptTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
      const completionTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
      return {
        content: result.text || "",
        toolCalls,
        finishReason,
        usage: usage ? {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        } : void 0
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        log10.warn("LLM call aborted", { name: error.name });
        throw error;
      }
      log10.error("LLM call failed", {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Unknown"
      });
      throw new Error(`LLM chat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Streaming chat completion
   */
  async *stream(messages, options) {
    const model = this.getModel();
    const coreMessages = toCoreMess(messages);
    const tools = options?.tools ? toCoreTools(options.tools) : void 0;
    const streamOptions = {
      model,
      messages: coreMessages,
      tools,
      temperature: options?.temperature,
      stopSequences: options?.stop,
      abortSignal: options?.signal,
      ...this.providerType === "ollama" && {
        providerOptions: {
          ollama: {
            options: {
              enable_thinking: false
            }
          }
        }
      }
    };
    if (options?.maxTokens) {
      streamOptions.maxTokens = options.maxTokens;
    }
    const result = await ai.streamText(streamOptions);
    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }
  /**
   * Get provider capabilities
   */
  getCapabilities() {
    switch (this.providerType) {
      case "anthropic":
        return {
          toolCalling: true,
          vision: true,
          streaming: true,
          contextWindow: 2e5,
          maxOutputTokens: 8192
        };
      case "openai":
        return {
          toolCalling: true,
          vision: true,
          streaming: true,
          contextWindow: 128e3,
          maxOutputTokens: 16384
        };
      case "ollama":
        return {
          toolCalling: true,
          vision: false,
          streaming: true,
          contextWindow: 32e3,
          maxOutputTokens: 4096
        };
      default:
        return {
          toolCalling: true,
          vision: false,
          streaming: true,
          contextWindow: 32e3,
          maxOutputTokens: 4096
        };
    }
  }
  /**
   * Check if provider is configured
   */
  isConfigured() {
    if (this.directModel) {
      return true;
    }
    if (modelProvider) {
      return modelProvider.isConfigured();
    }
    return false;
  }
  /**
   * Create provider with a direct model instance
   */
  static withModel(model, providerType = "custom") {
    return new _VercelAILLMProvider({
      providerType,
      model
    });
  }
  /**
   * Create provider for specific model tier (requires modelProvider to be set)
   */
  static forTier(tier) {
    const modelMap = {
      haiku: { provider: "anthropic", model: "claude-3-haiku-20240307" },
      sonnet: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      opus: { provider: "anthropic", model: "claude-opus-4-5-20251101" }
    };
    const config = modelMap[tier];
    return new _VercelAILLMProvider({
      providerType: config.provider,
      modelId: config.model
    });
  }
};
function createDefaultLLMProvider() {
  return new VercelAILLMProvider();
}

// src/AIOSService.ts
var log11 = createLogger("AIOSService");
function createStubLLMProvider() {
  return {
    id: "stub",
    name: "Stub LLM",
    chat: async () => {
      throw new Error("No LLM provider configured. Please set up a provider using setProviders().");
    },
    stream: async function* () {
      throw new Error("No LLM provider configured.");
    },
    getCapabilities: () => ({
      toolCalling: false,
      vision: false,
      streaming: false,
      contextWindow: 0,
      maxOutputTokens: 0
    }),
    isConfigured: () => false
  };
}
function createStubToolProvider() {
  return {
    id: "stub-tools",
    list: () => [],
    listByCategory: () => [],
    get: () => void 0,
    has: () => false,
    count: () => 0,
    execute: async () => ({
      success: false,
      error: "No tool provider configured.",
      observation: "Error: No tool provider configured."
    })
  };
}
function createStubUserInterface() {
  return {
    ask: async (request) => {
      log11.warn("ask() called but no UI configured:", request.question);
      return "No response (stub UI)";
    },
    askMultiple: async (questions) => {
      log11.warn("askMultiple() called but no UI configured:", questions);
      return {};
    },
    confirm: async (message) => {
      log11.warn("confirm() called but no UI configured:", message);
      return false;
    },
    notify: (message, type) => {
      log11.info(`[${type || "info"}]`, message);
    },
    isPending: () => false,
    cancel: () => {
    }
  };
}
function createStubEventEmitter() {
  const handlers = /* @__PURE__ */ new Map();
  return {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, /* @__PURE__ */ new Set());
      handlers.get(event).add(handler);
      return { unsubscribe: () => handlers.get(event)?.delete(handler) };
    },
    once: (event, handler) => {
      const wrappedHandler = (...args) => {
        handlers.get(event)?.delete(wrappedHandler);
        handler(...args);
      };
      if (!handlers.has(event)) handlers.set(event, /* @__PURE__ */ new Set());
      handlers.get(event).add(wrappedHandler);
      return { unsubscribe: () => handlers.get(event)?.delete(wrappedHandler) };
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: async (event, payload) => {
      const h = handlers.get(event);
      if (h) for (const handler of h) await handler(payload);
    },
    emitSync: (event, payload) => {
      const h = handlers.get(event);
      if (h) for (const handler of h) handler(payload);
    },
    hasListeners: (event) => (handlers.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => handlers.get(event)?.size ?? 0,
    removeAllListeners: (event) => event ? handlers.delete(event) : handlers.clear()
  };
}
var currentProviders = {
  createLLMProvider: createStubLLMProvider,
  createToolProvider: createStubToolProvider,
  getUserInterface: createStubUserInterface,
  getEventEmitter: createStubEventEmitter
};
function setProviders(providers) {
  currentProviders = { ...currentProviders, ...providers };
  log11.info("Providers updated");
}
function getProviders() {
  return currentProviders;
}
var AIOSService = class {
  config;
  providers;
  // Core components
  conversationEngine = null;
  todoManager;
  taskSpawner;
  planManager;
  // Providers - toolProvider is cached, llmProvider is created fresh each time
  toolProvider;
  constructor(config = {}) {
    log11.info("AIOSService constructor starting");
    this.config = config;
    this.providers = { ...currentProviders, ...config.providers };
    if (config.toolPatterns && config.toolPatterns.length > 0 && this.providers.createFilteredToolProvider) {
      log11.info("Creating filtered tool provider", { patterns: config.toolPatterns });
      this.toolProvider = this.providers.createFilteredToolProvider(config.toolPatterns);
    } else {
      this.toolProvider = this.providers.createToolProvider();
    }
    log11.info("Getting event emitter");
    const events = this.providers.getEventEmitter();
    log11.info("Creating TodoManager");
    this.todoManager = new TodoManager(events);
    this.planManager = new PlanManager(events);
    const agentFactory = this.createAgentFactory();
    this.taskSpawner = new TaskSpawner(agentFactory, events);
    if (typeof window !== "undefined" && window.__aiosDebugEnabled) {
      installDebugStub();
    }
    log11.info("AIOSService constructor complete");
  }
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  /**
   * Execute a conversation with the given prompt
   */
  async execute(prompt, config) {
    const toolProvider = config?.toolPatterns?.length && this.providers.createFilteredToolProvider ? this.providers.createFilteredToolProvider(config.toolPatterns) : this.toolProvider;
    this.conversationEngine = this.createConversationEngine(toolProvider);
    const mergedConfig = {};
    if (this.config.systemPrompt !== void 0) {
      mergedConfig.systemPrompt = this.config.systemPrompt;
    }
    if (this.config.maxTurns !== void 0) {
      mergedConfig.maxTurns = this.config.maxTurns;
    }
    if (this.config.timeoutMs !== void 0) {
      mergedConfig.timeoutMs = this.config.timeoutMs;
    }
    if (config) {
      if (config.systemPrompt !== void 0) {
        mergedConfig.systemPrompt = config.systemPrompt;
      }
      if (config.maxTurns !== void 0) {
        mergedConfig.maxTurns = config.maxTurns;
      }
      if (config.timeoutMs !== void 0) {
        mergedConfig.timeoutMs = config.timeoutMs;
      }
      if (config.signal !== void 0) {
        mergedConfig.signal = config.signal;
      }
      if (config.maxTokensPerTurn !== void 0) {
        mergedConfig.maxTokensPerTurn = config.maxTokensPerTurn;
      }
      if (config.requireTodoWrite !== void 0) {
        mergedConfig.requireTodoWrite = config.requireTodoWrite;
      }
      if (config.goalId !== void 0) {
        mergedConfig.goalId = config.goalId;
      }
      if (config.goalName !== void 0) {
        mergedConfig.goalName = config.goalName;
      }
      if (config.saveToGoalMemory !== void 0) {
        mergedConfig.saveToGoalMemory = config.saveToGoalMemory;
      }
    }
    if (this.config.requireTodoWrite !== void 0 && mergedConfig.requireTodoWrite === void 0) {
      mergedConfig.requireTodoWrite = this.config.requireTodoWrite;
    }
    const enableMemoryContext = this.config.enableMemoryContext !== false;
    if (enableMemoryContext && this.providers.getMemoryContext && this.providers.buildEnhancedSystemPrompt) {
      try {
        log11.info("Fetching memory context for conversation");
        const memoryContext = await this.providers.getMemoryContext(
          [{ role: "user", content: prompt }],
          {
            maxMemories: this.config.maxMemories ?? 5,
            includeProfile: this.config.includeProfile !== false
          }
        );
        if (memoryContext.success) {
          const basePrompt = mergedConfig.systemPrompt || "";
          mergedConfig.systemPrompt = await this.providers.buildEnhancedSystemPrompt(
            basePrompt,
            memoryContext,
            prompt
          );
          log11.info("Enhanced system prompt built", {
            memoryCount: memoryContext.memories.length,
            hasProfile: !!memoryContext.userProfile
          });
        }
      } catch (error) {
        log11.warn("Failed to build enhanced system prompt", { error });
      }
    }
    if (typeof window !== "undefined" && window.__aiosDebugEnabled) {
      installDebugStub();
      const harness = new DebugHarness("pending", prompt, {
        maxTurns: mergedConfig.maxTurns,
        timeoutMs: mergedConfig.timeoutMs,
        requireTodoWrite: mergedConfig.requireTodoWrite,
        goalId: mergedConfig.goalId
      });
      absorbPendingConfig(harness);
      this.conversationEngine.setDebugHarness(harness);
      window.__aiosDebug = harness.getConsoleAPI();
      log11.info("Debug harness attached", { tracePath: harness.getConsoleAPI().getTracePath() });
    }
    const result = await this.conversationEngine.execute(prompt, mergedConfig);
    return result;
  }
  /**
   * Cancel the current conversation
   */
  cancel() {
    if (this.conversationEngine) {
      this.conversationEngine.cancel();
    }
    this.taskSpawner.cancelAll();
  }
  /**
   * Check if a conversation is running
   */
  isRunning() {
    return this.conversationEngine?.isRunning() ?? false;
  }
  // ===========================================================================
  // TODO MANAGEMENT
  // ===========================================================================
  getTodos() {
    return this.todoManager.getTodos();
  }
  getProgress() {
    return this.todoManager.getProgress();
  }
  onTodosChange(callback) {
    log11.info("onTodosChange called - subscribing to TodoManager");
    return this.todoManager.subscribe(callback);
  }
  // ===========================================================================
  // PLANNING MODE
  // ===========================================================================
  isPlanning() {
    return this.planManager.isPlanning();
  }
  getPlanState() {
    return this.planManager.getState();
  }
  approvePlan() {
    this.planManager.approve();
  }
  rejectPlan() {
    this.planManager.reject();
  }
  onPlanChange(callback) {
    return this.planManager.subscribe(callback);
  }
  // ===========================================================================
  // CONTRACT APPROVAL
  // ===========================================================================
  isPaused() {
    return this.conversationEngine?.isPaused() ?? false;
  }
  async resumeWithApproval(contractPath) {
    if (!this.conversationEngine) {
      throw new Error("No conversation to resume");
    }
    return this.conversationEngine.resumeWithApproval(contractPath);
  }
  async resumeWithChanges(feedback) {
    if (!this.conversationEngine) {
      throw new Error("No conversation to resume");
    }
    return this.conversationEngine.resumeWithChanges(feedback);
  }
  async rejectContract(reason) {
    if (!this.conversationEngine) {
      throw new Error("No conversation to reject");
    }
    return this.conversationEngine.rejectContract(reason);
  }
  // ===========================================================================
  // SUB-AGENTS
  // ===========================================================================
  async spawnTask(params) {
    return this.taskSpawner.spawn(params);
  }
  isTaskRunning(taskId) {
    return this.taskSpawner.isRunning(taskId);
  }
  cancelTask(taskId) {
    this.taskSpawner.cancel(taskId);
  }
  // ===========================================================================
  // PROVIDER ACCESS
  // ===========================================================================
  isConfigured() {
    const llmProvider = this.providers.createLLMProvider();
    return llmProvider.isConfigured();
  }
  getToolProvider() {
    return this.toolProvider;
  }
  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================
  createConversationEngine(toolProviderOverride) {
    const llmProvider = this.providers.createLLMProvider();
    const classifierLlm = this.providers.createClassifierLLM?.();
    const deps = {
      llm: llmProvider,
      tools: toolProviderOverride ?? this.toolProvider,
      ui: this.providers.getUserInterface(),
      events: this.providers.getEventEmitter(),
      classifierLlm
    };
    return new ConversationEngine(deps);
  }
  createAgentFactory() {
    return {
      create: (config) => {
        const type = config.type;
        const llm = type === "Explore" && this.providers.createClassifierLLM ? this.providers.createClassifierLLM() : this.providers.createLLMProvider();
        const tools = this.providers.createToolProvider();
        const classifierLlm = this.providers.createClassifierLLM?.();
        const deps = {
          llm,
          tools,
          ui: this.providers.getUserInterface(),
          events: this.providers.getEventEmitter(),
          classifierLlm
        };
        const engine = new ConversationEngine(deps);
        return {
          execute: (prompt) => engine.execute(prompt, {
            maxTurns: type === "Explore" ? 10 : 50,
            timeoutMs: type === "Explore" ? 12e4 : 6e5
          }),
          cancel: () => engine.cancel(),
          isRunning: () => engine.isRunning()
        };
      }
    };
  }
};
var defaultInstance = null;
function getAIOSService() {
  if (!defaultInstance) {
    log11.info("Creating new AIOSService singleton instance");
    defaultInstance = new AIOSService();
  }
  return defaultInstance;
}
function createAIOSService(config) {
  return new AIOSService(config);
}
function resetAIOSService() {
  if (defaultInstance) {
    defaultInstance.cancel();
    defaultInstance = null;
  }
}

exports.AIOSService = AIOSService;
exports.ContextCompressor = ContextCompressor;
exports.ConversationEngine = ConversationEngine;
exports.ConversationStore = ConversationStore;
exports.DebugHarness = DebugHarness;
exports.DecisionLogger = DecisionLogger;
exports.PlanManager = PlanManager;
exports.TODOWRITE_EXEMPT_TOOLS = TODOWRITE_EXEMPT_TOOLS;
exports.TOOL_METADATA = TOOL_METADATA;
exports.TaskSpawner = TaskSpawner;
exports.TodoManager = TodoManager;
exports.ToolRetryPolicy = ToolRetryPolicy;
exports.VercelAILLMProvider = VercelAILLMProvider;
exports.VerificationEngine = VerificationEngine;
exports.absorbPendingConfig = absorbPendingConfig;
exports.canSkipTodoWrite = canSkipTodoWrite;
exports.classifyIntent = classifyIntent;
exports.conversationStore = conversationStore;
exports.createAIOSService = createAIOSService;
exports.createDefaultLLMProvider = createDefaultLLMProvider;
exports.createLogger = createLogger;
exports.createMemoryFilesystem = createMemoryFilesystem;
exports.exists = exists;
exports.filterActionTools = filterActionTools;
exports.filterExemptTools = filterExemptTools;
exports.getAIOSService = getAIOSService;
exports.getBackend = getBackend;
exports.getFilesystem = getFilesystem;
exports.getLogLevel = getLogLevel;
exports.getProviders = getProviders;
exports.getTodoWriteGuidance = getTodoWriteGuidance;
exports.getToolMetadata = getToolMetadata;
exports.goalContextProvider = goalContextProvider;
exports.installDebugStub = installDebugStub;
exports.invoke = invoke;
exports.isToolExemptFromTodoWrite = isToolExemptFromTodoWrite;
exports.mkdir = mkdir;
exports.needsClarification = needsClarification;
exports.partitionToolCalls = partitionToolCalls;
exports.readTextFile = readTextFile;
exports.resetAIOSService = resetAIOSService;
exports.setBackend = setBackend;
exports.setFilesystem = setFilesystem;
exports.setLogLevel = setLogLevel;
exports.setModelProvider = setModelProvider;
exports.setProviders = setProviders;
exports.setToolRegistryProvider = setToolRegistryProvider;
exports.toolAllowsParallel = toolAllowsParallel;
exports.toolRequiresConfirmation = toolRequiresConfirmation;
exports.toolRequiresTodoWrite = toolRequiresTodoWrite;
exports.writeTextFile = writeTextFile;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map