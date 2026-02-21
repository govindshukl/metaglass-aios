/**
 * ContextCompressor - Manages conversation history to prevent context overflow
 *
 * Compresses older messages by summarizing them while preserving recent context.
 * This ensures long conversations can continue without hitting token limits.
 */

import type { LLMProvider, Message, CompressionConfig } from '../interfaces';
import { createLogger } from '../logger';

const log = createLogger('ContextCompressor');

// Re-export for convenience
export type { CompressionConfig } from '../interfaces';

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
}

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
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<CompressionConfig> = {
  enabled: true,
  maxTokens: 100000,
  summarizeThreshold: 10,
  preserveRecentTurns: 5,
  charsPerToken: 4,
  summaryMaxTokens: 1000,
};

const SUMMARIZATION_PROMPT = `You are summarizing a conversation between a user and an AI assistant.
Summarize the following conversation turns, preserving:
1. Key decisions and actions taken
2. Important information discovered
3. Tools called and their significant results
4. Any user preferences or clarifications

Be concise but preserve essential context. Format as a brief narrative.`;

// =============================================================================
// CONTEXT COMPRESSOR
// =============================================================================

export class ContextCompressor {
  private llm: LLMProvider;
  private config: Required<CompressionConfig>;

  constructor(llm: LLMProvider, config?: CompressionConfig) {
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
  async compress(history: Message[], systemPrompt?: string): Promise<CompressionResult> {
    if (!this.config.enabled) {
      return {
        messages: history,
        originalTokens: this.estimateTokens(history),
        compressedTokens: this.estimateTokens(history),
        summarizedTurns: 0,
        wasCompressed: false,
      };
    }

    const originalTokens = this.estimateTokens(history) +
      (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);

    // Check if compression is needed
    if (originalTokens < this.config.maxTokens * 0.7) {
      log.debug('Compression not needed', { originalTokens, threshold: this.config.maxTokens * 0.7 });
      return {
        messages: history,
        originalTokens,
        compressedTokens: originalTokens,
        summarizedTurns: 0,
        wasCompressed: false,
      };
    }

    // Parse history into turns
    const { systemMessages, userMessage, turns } = this.parseHistory(history);

    // Check if we have enough turns to compress
    if (turns.length < this.config.summarizeThreshold) {
      log.debug('Not enough turns to compress', { turns: turns.length, threshold: this.config.summarizeThreshold });
      return {
        messages: history,
        originalTokens,
        compressedTokens: originalTokens,
        summarizedTurns: 0,
        wasCompressed: false,
      };
    }

    // Determine how many turns to preserve
    const preserveCount = Math.min(this.config.preserveRecentTurns, turns.length);
    const turnsToSummarize = turns.slice(0, turns.length - preserveCount);
    const turnsToPreserve = turns.slice(-preserveCount);

    if (turnsToSummarize.length === 0) {
      return {
        messages: history,
        originalTokens,
        compressedTokens: originalTokens,
        summarizedTurns: 0,
        wasCompressed: false,
      };
    }

    log.info('Compressing context', {
      totalTurns: turns.length,
      summarizing: turnsToSummarize.length,
      preserving: preserveCount,
    });

    // Generate summary of older turns
    const summary = await this.summarizeTurns(turnsToSummarize);

    // Reconstruct compressed history
    const compressedHistory: Message[] = [
      ...systemMessages,
      ...(userMessage ? [userMessage] : []),
      {
        role: 'assistant' as const,
        content: `[Previous conversation summary: ${summary}]`,
      },
      ...turnsToPreserve.flatMap(t => t.messages),
    ];

    const compressedTokens = this.estimateTokens(compressedHistory) +
      (systemPrompt ? this.estimateMessageTokens(systemPrompt) : 0);

    log.info('Context compressed', {
      originalTokens,
      compressedTokens,
      reduction: `${Math.round((1 - compressedTokens / originalTokens) * 100)}%`,
      summarizedTurns: turnsToSummarize.length,
    });

    return {
      messages: compressedHistory,
      originalTokens,
      compressedTokens,
      summarizedTurns: turnsToSummarize.length,
      wasCompressed: true,
    };
  }

  /**
   * Parse history into system messages, initial user message, and turns
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

      // First user message is the original goal
      if (msg.role === 'user' && userMessage === null) {
        userMessage = msg;
        continue;
      }

      // Subsequent user messages (like reflections) are part of turns
      if (msg.role === 'assistant') {
        // Start new turn with assistant message
        if (currentTurn.length > 0) {
          turns.push({
            index: turnIndex++,
            messages: currentTurn,
            tokenCount: this.estimateTokens(currentTurn),
          });
        }
        currentTurn = [msg];
      } else {
        // Tool results or user follow-ups go with current turn
        currentTurn.push(msg);
      }
    }

    // Don't forget the last turn
    if (currentTurn.length > 0) {
      turns.push({
        index: turnIndex,
        messages: currentTurn,
        tokenCount: this.estimateTokens(currentTurn),
      });
    }

    return { systemMessages, userMessage, turns };
  }

  /**
   * Generate a summary of conversation turns
   */
  private async summarizeTurns(turns: ConversationTurn[]): Promise<string> {
    // Build a condensed representation of turns for summarization
    const turnTexts = turns.map(turn => {
      const parts: string[] = [];

      for (const msg of turn.messages) {
        if (msg.role === 'assistant') {
          // Include tool calls if present
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const toolNames = msg.toolCalls.map(tc => tc.name).join(', ');
            parts.push(`Assistant called tools: ${toolNames}`);
          }
          // Include a preview of the response
          if (msg.content) {
            const preview = msg.content.slice(0, 200);
            parts.push(`Assistant: ${preview}${msg.content.length > 200 ? '...' : ''}`);
          }
        } else if (msg.role === 'tool') {
          // Include tool result summary
          const preview = msg.content.slice(0, 100);
          const toolName = msg.toolName || 'tool';
          parts.push(`${toolName} result: ${preview}${msg.content.length > 100 ? '...' : ''}`);
        } else if (msg.role === 'user') {
          // User follow-up messages
          parts.push(`User: ${msg.content.slice(0, 150)}`);
        }
      }

      return `Turn ${turn.index + 1}:\n${parts.join('\n')}`;
    });

    const conversationToSummarize = turnTexts.join('\n\n');

    try {
      const response = await this.llm.chat([
        { role: 'system', content: SUMMARIZATION_PROMPT },
        { role: 'user', content: conversationToSummarize },
      ], {
        maxTokens: this.config.summaryMaxTokens,
        temperature: 0.3, // Lower temperature for consistent summaries
      });

      return response.content;
    } catch (error) {
      log.error('Failed to generate summary, using fallback', { error });
      // Fallback: just list tool calls
      const toolCalls = turns.flatMap(t =>
        t.messages
          .filter(m => m.toolCalls)
          .flatMap(m => m.toolCalls!.map(tc => tc.name))
      );
      return `Previous conversation included ${turns.length} turns with tools: ${[...new Set(toolCalls)].join(', ')}`;
    }
  }

  /**
   * Estimate token count for a list of messages
   */
  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg.content), 0);
  }

  /**
   * Estimate token count for a string
   */
  private estimateMessageTokens(content: string): number {
    // Simple character-based estimation
    // More accurate would be to use tiktoken, but this is a reasonable approximation
    return Math.ceil(content.length / this.config.charsPerToken);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<CompressionConfig> {
    return { ...this.config };
  }
}
