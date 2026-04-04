import { describe, it, expect, beforeEach } from 'vitest';
import {
  NoOpMemoryFlushHook,
  DEFAULT_MEMORY_FLUSH_CONFIG,
  type FlushTriggerParams,
} from '../MemoryFlushHook';

// =============================================================================
// HELPERS
// =============================================================================

function triggerParams(overrides: Partial<FlushTriggerParams> = {}): FlushTriggerParams {
  return {
    estimatedTokens: 50_000,
    tokenBudget: 128_000,
    transcriptByteEstimate: 500_000,
    compactionCount: 0,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('NoOpMemoryFlushHook', () => {
  let hook: NoOpMemoryFlushHook;

  beforeEach(() => {
    hook = new NoOpMemoryFlushHook();
  });

  // ---------------------------------------------------------------------------
  // shouldFlush — Budget Proximity
  // ---------------------------------------------------------------------------

  describe('shouldFlush — token proximity', () => {
    it('should trigger when tokens near budget (within softThreshold)', () => {
      const result = hook.shouldFlush(triggerParams({
        estimatedTokens: 125_000,  // 128K - 125K = 3K remaining < 4K threshold
        tokenBudget: 128_000,
      }));
      expect(result).toBe(true);
    });

    it('should trigger when tokens exactly at budget', () => {
      const result = hook.shouldFlush(triggerParams({
        estimatedTokens: 128_000,
        tokenBudget: 128_000,
      }));
      expect(result).toBe(true);
    });

    it('should not trigger when tokens well below budget', () => {
      const result = hook.shouldFlush(triggerParams({
        estimatedTokens: 50_000,
        tokenBudget: 128_000,
      }));
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldFlush — Transcript Size
  // ---------------------------------------------------------------------------

  describe('shouldFlush — transcript size', () => {
    it('should trigger when transcript exceeds byte threshold', () => {
      const result = hook.shouldFlush(triggerParams({
        transcriptByteEstimate: 3_000_000, // 3MB > 2MB threshold
      }));
      expect(result).toBe(true);
    });

    it('should not trigger when transcript below threshold', () => {
      const result = hook.shouldFlush(triggerParams({
        transcriptByteEstimate: 500_000, // 500KB < 2MB
      }));
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldFlush — Compaction Count Guard
  // ---------------------------------------------------------------------------

  describe('shouldFlush — compaction count guard', () => {
    it('should not trigger twice for the same compaction cycle', () => {
      // First trigger — should pass
      const first = hook.shouldFlush(triggerParams({
        estimatedTokens: 125_000,
        tokenBudget: 128_000,
        compactionCount: 1,
      }));
      expect(first).toBe(true);

      // Record the flush
      hook.recordFlush(1);

      // Same compaction count — should be blocked
      const second = hook.shouldFlush(triggerParams({
        estimatedTokens: 125_000,
        tokenBudget: 128_000,
        compactionCount: 1,
      }));
      expect(second).toBe(false);
    });

    it('should trigger for a new compaction cycle', () => {
      hook.recordFlush(1);

      const result = hook.shouldFlush(triggerParams({
        estimatedTokens: 125_000,
        tokenBudget: 128_000,
        compactionCount: 2, // New cycle
      }));
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldFlush — Disabled
  // ---------------------------------------------------------------------------

  describe('shouldFlush — disabled', () => {
    it('should return false when disabled', () => {
      const disabled = new NoOpMemoryFlushHook({ enabled: false });
      const result = disabled.shouldFlush(triggerParams({
        estimatedTokens: 128_000,
        tokenBudget: 128_000,
      }));
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // flush — No-Op
  // ---------------------------------------------------------------------------

  describe('flush', () => {
    it('should return false (no-op)', async () => {
      const controller = new AbortController();
      const result = await hook.flush({
        messages: [],
        signal: controller.signal,
      });
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------

  describe('defaults', () => {
    it('should have 4000 token soft threshold', () => {
      expect(DEFAULT_MEMORY_FLUSH_CONFIG.softThresholdTokens).toBe(4_000);
    });

    it('should have 2MB force flush byte threshold', () => {
      expect(DEFAULT_MEMORY_FLUSH_CONFIG.forceFlushTranscriptBytes).toBe(2 * 1024 * 1024);
    });

    it('should be enabled by default', () => {
      expect(DEFAULT_MEMORY_FLUSH_CONFIG.enabled).toBe(true);
    });
  });
});
