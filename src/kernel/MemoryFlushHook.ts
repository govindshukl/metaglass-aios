/**
 * MemoryFlushHook — Flush-Before-Discard Interface
 *
 * Interface and trigger logic for saving durable memories before context
 * compaction discards old messages. Phase 3 provides the interface and
 * no-op default; Phase 4 provides the real implementation that calls
 * memory tools and writes to memory/YYYY-MM-DD.md.
 *
 * Trigger conditions (adapted from OpenClaw):
 * - Context tokens near budget (within softThresholdTokens)
 * - Transcript exceeds forceFlushTranscriptBytes
 * - Not already flushed for this compaction cycle
 *
 * Phase 3, Step 6 of Agentic Harness Implementation.
 */

import type { Message } from '../interfaces/types';

// =============================================================================
// TYPES
// =============================================================================

export interface MemoryFlushConfig {
  /** Enable memory flush before compaction (default: true) */
  enabled: boolean;
  /** Flush when tokens are within this many of the budget (default: 4000) */
  softThresholdTokens: number;
  /** Force flush when transcript exceeds this byte count (default: 2MB) */
  forceFlushTranscriptBytes: number;
}

export const DEFAULT_MEMORY_FLUSH_CONFIG: MemoryFlushConfig = {
  enabled: true,
  softThresholdTokens: 4_000,
  forceFlushTranscriptBytes: 2 * 1024 * 1024, // 2MB
};

export interface FlushTriggerParams {
  /** Estimated tokens currently used */
  estimatedTokens: number;
  /** Token budget for the context window */
  tokenBudget: number;
  /** Estimated transcript size in bytes */
  transcriptByteEstimate: number;
  /** Number of compactions completed so far in this session */
  compactionCount: number;
}

// =============================================================================
// INTERFACE
// =============================================================================

/**
 * Hook interface for flush-before-discard pattern.
 * Implementations execute a silent agentic turn to save durable memories
 * before context compaction discards old messages.
 */
export interface MemoryFlushHook {
  /** Check if flush should run before compaction */
  shouldFlush(params: FlushTriggerParams): boolean;

  /** Execute flush — returns true if memories were saved */
  flush(params: {
    messages: Message[];
    signal: AbortSignal;
  }): Promise<boolean>;
}

// =============================================================================
// DEFAULT NO-OP IMPLEMENTATION
// =============================================================================

/**
 * No-op implementation — always returns false.
 * Phase 4 replaces this with a real implementation that calls memory tools.
 */
export class NoOpMemoryFlushHook implements MemoryFlushHook {
  private config: MemoryFlushConfig;
  private lastFlushedCompactionCount = -1;

  constructor(config?: Partial<MemoryFlushConfig>) {
    this.config = { ...DEFAULT_MEMORY_FLUSH_CONFIG, ...config };
  }

  /**
   * Check if flush should run before compaction.
   * Returns true if conditions are met (even in no-op mode, for testing the trigger logic).
   */
  shouldFlush(params: FlushTriggerParams): boolean {
    if (!this.config.enabled) return false;

    // Don't flush twice for the same compaction cycle
    if (params.compactionCount <= this.lastFlushedCompactionCount) return false;

    // Condition 1: Tokens near budget
    const tokensRemaining = params.tokenBudget - params.estimatedTokens;
    if (tokensRemaining <= this.config.softThresholdTokens) {
      return true;
    }

    // Condition 2: Transcript exceeds byte threshold
    if (params.transcriptByteEstimate >= this.config.forceFlushTranscriptBytes) {
      return true;
    }

    return false;
  }

  /**
   * No-op flush — Phase 4 provides real implementation.
   */
  async flush(_params: {
    messages: Message[];
    signal: AbortSignal;
  }): Promise<boolean> {
    // Record that we attempted flush for this cycle
    // (no-op — no actual memory saving)
    return false;
  }

  /**
   * Record that a flush was attempted for the given compaction count.
   * Prevents re-triggering for the same cycle.
   */
  recordFlush(compactionCount: number): void {
    this.lastFlushedCompactionCount = compactionCount;
  }
}
