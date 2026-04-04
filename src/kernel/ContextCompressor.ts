/**
 * ContextCompressor - Rolling summarization for conversation history
 *
 * Instead of cliff compression at 70% capacity, this uses incremental
 * summarization: every N turns, the oldest unsummarized block is compressed
 * into structured bullet points. This prevents the "compress everything at
 * once" cliff and preserves temporal ordering across multiple summaries.
 *
 * Phase 3 enhancements:
 * - Iterative summary updates (Hermes pattern): previous summary fed into next compression
 * - Structured summary template: Goal/Progress/Decisions/Files/Next Steps/Critical Context
 * - Token-budget tail protection: dynamic tail size based on budget, not fixed message count
 * - 3-level fallback chain: full → partial (exclude oversized) → metadata-only
 * - Identifier preservation instructions
 * - Configurable interval + budget-pressure trigger
 * - CompactReason tracking for telemetry
 *
 * History shape after compression:
 *   [system] + [user] + [summary_1] + [summary_2] + ... + [last N tokens verbatim]
 */

import type { LLMProvider, Message, CompressionConfig } from '../interfaces';
import { createLogger } from '../logger';

const log = createLogger('ContextCompressor');

// Re-export for convenience
export type { CompressionConfig } from '../interfaces';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result from compression operation
 */
export interface CompressionResult {
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
  /** Why compaction did/didn't happen */
  reason?: CompactReason;
  /** The summary text produced (for systemPromptAddition injection) */
  summary?: string;
}

export type CompactReason =
  | 'interval'
  | 'budget_pressure'
  | 'force'
  | 'fallback_partial'
  | 'fallback_metadata'
  | 'skipped_below_threshold'
  | 'skipped_disabled';

/**
 * Internal representation of a conversation turn
 */
interface ConversationTurn {
  /** Turn index (0-based) */
  index: number;
  /** Messages in this turn (assistant + tool results) */
  messages: Message[];
  /** Estimated token count */
  tokenCount: number;
  /** Whether this turn is already a summary from a previous compression */
  isSummary: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<CompressionConfig> = {
  enabled: true,
  maxTokens: 100000,
  summarizeThreshold: 5,   // Compress every 5 turns (rolling, not cliff)
  preserveRecentTurns: 5,  // Fallback: keep last 5 turns if token-budget tail is not configured
  charsPerToken: 4,
  summaryMaxTokens: 500,   // Each rolling summary is concise
};

/** Max tokens to protect at the tail (dynamic, overrides preserveRecentTurns) */
const DEFAULT_TAIL_BUDGET_TOKENS = 20_000;

/** Max ratio of message window for tail protection */
const TAIL_BUDGET_RATIO = 0.3;

const IDENTIFIER_PRESERVATION_INSTRUCTION =
  'Preserve all identifiers exactly as written: UUIDs, hashes, commit SHAs, file paths, URLs, port numbers, API endpoints, variable names. Do not abbreviate or reconstruct them.';

const STRUCTURED_SUMMARY_PROMPT = `Summarize the conversation into these sections. Be concise — use bullet points, not prose.

## Goal
What the user is trying to accomplish.

## Progress
What has been completed so far (with specific file paths, tool outputs).

## Key Decisions
Decisions made, approaches chosen, things explicitly rejected.

## Files & Artifacts
All file paths, note titles, URLs, identifiers mentioned.

## Next Steps
What remains to be done based on the conversation.

## Critical Context
Any constraints, warnings, errors, or user preferences that must not be forgotten.

${IDENTIFIER_PRESERVATION_INSTRUCTION}`;

// =============================================================================
// CONTEXT COMPRESSOR (Rolling Summarization)
// =============================================================================

export class ContextCompressor {
  private llm: LLMProvider;
  private config: Required<CompressionConfig>;

  /** Previous compaction summary for iterative updates (Hermes pattern) */
  private previousSummary: string | null = null;

  /** Optional token budget for tail protection (from TokenBudgetResolver) */
  private tailBudgetTokens: number | null = null;

  constructor(llm: LLMProvider, config?: CompressionConfig) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the tail budget from TokenBudgetResolver.
   * When set, overrides preserveRecentTurns with dynamic token-based protection.
   */
  setTailBudget(messageWindowBudget: number): void {
    this.tailBudgetTokens = Math.min(DEFAULT_TAIL_BUDGET_TOKENS, Math.floor(messageWindowBudget * TAIL_BUDGET_RATIO));
  }

  /**
   * Compress conversation history using rolling summarization.
   *
   * Checks two conditions:
   * 1. Have N new turns accumulated since last compression? → Summarize them
   * 2. Are we over the token budget? → Force-compress oldest unsummarized block
   */
  async compress(history: Message[], systemPrompt?: string): Promise<CompressionResult> {
    if (!this.config.enabled) {
      return { ...this.noCompression(history), reason: 'skipped_disabled' };
    }

    const originalTokens = this.estimateTokens(history) +
      (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);

    // Parse history into structure
    const { systemMessages, userMessage, turns } = this.parseHistory(history);

    // Count unsummarized turns
    const unsummarizedTurns = turns.filter(t => !t.isSummary);
    const summaryTurns = turns.filter(t => t.isSummary);

    // Determine tail protection: token-budget or fixed count
    const turnsToPreserve = this.selectTailTurns(unsummarizedTurns);
    const preserveCount = turnsToPreserve.length;
    const turnsToMaybeSummarize = unsummarizedTurns.slice(0, unsummarizedTurns.length - preserveCount);

    // Determine trigger reason
    const intervalTriggered = turnsToMaybeSummarize.length >= this.config.summarizeThreshold;
    const budgetTriggered = originalTokens >= this.config.maxTokens * 0.7;
    const shouldCompress = intervalTriggered || budgetTriggered;
    const triggerReason: CompactReason = budgetTriggered ? 'budget_pressure' : 'interval';

    if (!shouldCompress || turnsToMaybeSummarize.length === 0) {
      return { ...this.noCompression(history), reason: 'skipped_below_threshold' };
    }

    log.info('Rolling compression triggered', {
      reason: triggerReason,
      totalTurns: turns.length,
      unsummarized: unsummarizedTurns.length,
      summarizing: turnsToMaybeSummarize.length,
      preserving: preserveCount,
      existingSummaries: summaryTurns.length,
      originalTokens,
    });

    // Generate summary with fallback chain
    const { summary, reason } = await this.summarizeWithFallback(turnsToMaybeSummarize, triggerReason);

    // Store for iterative updates (Hermes pattern)
    this.previousSummary = summary;

    // Reconstruct history
    const compressedHistory: Message[] = [
      ...systemMessages,
      ...(userMessage ? [userMessage] : []),
      ...summaryTurns.flatMap(t => t.messages),
      {
        role: 'assistant' as const,
        content: `[Summary of turns ${turnsToMaybeSummarize[0].index + 1}-${turnsToMaybeSummarize[turnsToMaybeSummarize.length - 1].index + 1}]\n${summary}`,
      },
      ...turnsToPreserve.flatMap(t => t.messages),
    ];

    const compressedTokens = this.estimateTokens(compressedHistory) +
      (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);

    log.info('Rolling compression complete', {
      reason,
      originalTokens,
      compressedTokens,
      reduction: `${Math.round((1 - compressedTokens / originalTokens) * 100)}%`,
      summarizedTurns: turnsToMaybeSummarize.length,
      totalSummaries: summaryTurns.length + 1,
    });

    return {
      messages: compressedHistory,
      originalTokens,
      compressedTokens,
      summarizedTurns: turnsToMaybeSummarize.length,
      wasCompressed: true,
      reason,
      summary,
    };
  }

  /**
   * Get the last compaction summary (for systemPromptAddition injection).
   */
  getLastSummary(): string | null {
    return this.previousSummary;
  }

  // ---------------------------------------------------------------------------
  // Tail Protection
  // ---------------------------------------------------------------------------

  /**
   * Select tail turns to preserve.
   * Uses token-budget approach (Hermes pattern) when tailBudgetTokens is set,
   * otherwise falls back to fixed turn count.
   */
  private selectTailTurns(unsummarizedTurns: ConversationTurn[]): ConversationTurn[] {
    if (this.tailBudgetTokens !== null) {
      // Token-budget tail: walk backward accumulating tokens
      const result: ConversationTurn[] = [];
      let accumulated = 0;

      for (let i = unsummarizedTurns.length - 1; i >= 0; i--) {
        const turn = unsummarizedTurns[i];
        if (accumulated + turn.tokenCount > this.tailBudgetTokens && result.length > 0) {
          break;
        }
        result.unshift(turn);
        accumulated += turn.tokenCount;
      }

      return result;
    }

    // Fallback: fixed turn count
    const preserveCount = Math.min(this.config.preserveRecentTurns, unsummarizedTurns.length);
    return unsummarizedTurns.slice(-preserveCount);
  }

  // ---------------------------------------------------------------------------
  // Summarization with Fallback Chain
  // ---------------------------------------------------------------------------

  /**
   * Summarize turns with 3-level fallback chain:
   * 1. Full: Structured summary of all turns (with previous summary for continuity)
   * 2. Partial: Exclude oversized turns (>50% of budget)
   * 3. Metadata-only: Basic metadata about what happened
   */
  private async summarizeWithFallback(
    turns: ConversationTurn[],
    triggerReason: CompactReason
  ): Promise<{ summary: string; reason: CompactReason }> {
    // Strategy 1: Full summarization
    try {
      const summary = await this.summarizeTurns(turns);
      return { summary, reason: triggerReason };
    } catch (error) {
      log.warn('Full summarization failed, trying partial', { error });
    }

    // Strategy 2: Partial — exclude oversized turns
    try {
      const totalTokens = turns.reduce((sum, t) => sum + t.tokenCount, 0);
      const threshold = totalTokens * 0.5;
      const normalTurns = turns.filter(t => t.tokenCount <= threshold);
      const oversizedTurns = turns.filter(t => t.tokenCount > threshold);

      if (normalTurns.length > 0) {
        let summary = await this.summarizeTurns(normalTurns);
        if (oversizedTurns.length > 0) {
          const omittedNotes = oversizedTurns.map(t => {
            const firstMsg = t.messages[0];
            const preview = firstMsg.content.slice(0, 100);
            return `[Large message omitted from summary — ${firstMsg.role}: ${preview}...]`;
          });
          summary += '\n\n' + omittedNotes.join('\n');
        }
        return { summary, reason: 'fallback_partial' };
      }
    } catch (error) {
      log.warn('Partial summarization failed, using metadata fallback', { error });
    }

    // Strategy 3: Metadata-only (no LLM call)
    const summary = this.metadataFallback(turns);
    return { summary, reason: 'fallback_metadata' };
  }

  /**
   * Generate structured summary of conversation turns.
   * Uses Hermes iterative pattern: previous summary fed into prompt for continuity.
   */
  private async summarizeTurns(turns: ConversationTurn[]): Promise<string> {
    const turnTexts = turns.map(turn => {
      const parts: string[] = [];
      for (const msg of turn.messages) {
        if (msg.role === 'assistant') {
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            // Include tool names AND argument previews (up to 3000 chars per message)
            const toolDetails = msg.toolCalls.map(tc => {
              const paramsPreview = JSON.stringify(tc.params).slice(0, 200);
              return `${tc.name}(${paramsPreview})`;
            }).join(', ');
            parts.push(`Called: ${toolDetails}`);
          }
          if (msg.content) {
            parts.push(`Said: ${msg.content.slice(0, 150)}${msg.content.length > 150 ? '...' : ''}`);
          }
        } else if (msg.role === 'tool') {
          const preview = msg.content.slice(0, 80);
          parts.push(`${msg.toolName || 'tool'}: ${preview}${msg.content.length > 80 ? '...' : ''}`);
        } else if (msg.role === 'user') {
          parts.push(`User: ${msg.content.slice(0, 100)}`);
        }
      }
      return `Turn ${turn.index + 1}: ${parts.join(' | ')}`;
    });

    const conversationToSummarize = turnTexts.join('\n');

    // Build prompt with iterative summary (Hermes pattern)
    let userContent = '';
    if (this.previousSummary) {
      userContent += `Previous conversation summary:\n${this.previousSummary}\n\nNew messages to incorporate:\n`;
    }
    userContent += conversationToSummarize;

    const response = await this.llm.chat([
      { role: 'system', content: STRUCTURED_SUMMARY_PROMPT },
      { role: 'user', content: userContent },
    ], {
      maxTokens: this.config.summaryMaxTokens,
      temperature: 0.2,
    });

    return response.content;
  }

  /**
   * Metadata-only fallback when LLM summarization fails entirely.
   */
  private metadataFallback(turns: ConversationTurn[]): string {
    const toolCalls = turns.flatMap(t =>
      t.messages
        .filter(m => m.toolCalls)
        .flatMap(m => m.toolCalls!.map(tc => tc.name))
    );
    const uniqueTools = [...new Set(toolCalls)];

    const firstTurnIndex = turns[0]?.index ?? 0;
    const lastTurnIndex = turns[turns.length - 1]?.index ?? 0;
    const lastUserMsg = turns.flatMap(t => t.messages).filter(m => m.role === 'user').pop();
    const lastTopic = lastUserMsg ? lastUserMsg.content.slice(0, 80) : 'unknown';

    return [
      `[Conversation history: ${turns.length} turns (${firstTurnIndex + 1}-${lastTurnIndex + 1})]`,
      `- Tools used: ${uniqueTools.join(', ') || 'none'}`,
      `- Last topic: ${lastTopic}`,
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // History Parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse history into system messages, initial user message, and turns.
   */
  private parseHistory(history: Message[]): {
    systemMessages: Message[];
    userMessage: Message | null;
    turns: ConversationTurn[];
  } {
    const systemMessages: Message[] = [];
    let userMessage: Message | null = null;
    const turns: ConversationTurn[] = [];
    let currentTurn: Message[] = [];
    let turnIndex = 0;

    for (const msg of history) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
        continue;
      }

      if (msg.role === 'user' && userMessage === null) {
        userMessage = msg;
        continue;
      }

      if (msg.role === 'assistant') {
        if (currentTurn.length > 0) {
          const isSummary = currentTurn[0].content?.startsWith('[Summary of turns') ||
                           currentTurn[0].content?.startsWith('[Previous conversation summary') ||
                           currentTurn[0].content?.startsWith('[Conversation history:');
          turns.push({
            index: turnIndex++,
            messages: currentTurn,
            tokenCount: this.estimateTokens(currentTurn),
            isSummary,
          });
        }
        currentTurn = [msg];
      } else {
        currentTurn.push(msg);
      }
    }

    if (currentTurn.length > 0) {
      const isSummary = currentTurn[0].content?.startsWith('[Summary of turns') ||
                       currentTurn[0].content?.startsWith('[Previous conversation summary') ||
                       currentTurn[0].content?.startsWith('[Conversation history:');
      turns.push({
        index: turnIndex,
        messages: currentTurn,
        tokenCount: this.estimateTokens(currentTurn),
        isSummary,
      });
    }

    return { systemMessages, userMessage, turns };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private noCompression(history: Message[]): CompressionResult {
    const tokens = this.estimateTokens(history);
    return {
      messages: history,
      originalTokens: tokens,
      compressedTokens: tokens,
      summarizedTurns: 0,
      wasCompressed: false,
    };
  }

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg.content), 0);
  }

  private estimateMessageTokens(content: string): number {
    return Math.ceil(content.length / this.config.charsPerToken);
  }

  updateConfig(config: Partial<CompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): Required<CompressionConfig> {
    return { ...this.config };
  }
}
