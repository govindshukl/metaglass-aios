import { describe, it, expect, beforeEach } from 'vitest';
import { ContextPruner, DEFAULT_PRUNER_CONFIG } from '../ContextPruner';
import type { Message } from '../../interfaces/types';

// =============================================================================
// HELPERS
// =============================================================================

function msg(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { role, content, ...extra };
}

function bigToolResult(size: number, id: string): Message {
  return msg('tool', 'x'.repeat(size), { toolCallId: id, toolName: 'Read' });
}

function smallToolResult(size: number, id: string): Message {
  return msg('tool', 'y'.repeat(size), { toolCallId: id, toolName: 'search' });
}

// =============================================================================
// TESTS
// =============================================================================

describe('ContextPruner', () => {
  let pruner: ContextPruner;

  beforeEach(() => {
    pruner = new ContextPruner({ ttlMs: 1000 }); // 1s TTL for fast tests
  });

  // ---------------------------------------------------------------------------
  // Mode Off
  // ---------------------------------------------------------------------------

  describe('mode off', () => {
    it('should not prune when mode is off', () => {
      const offPruner = new ContextPruner({ mode: 'off' });
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        msg('assistant', 'a'),
        bigToolResult(60_000, 'tc1'),
      ];

      offPruner.trackMessages(messages);
      const result = offPruner.prune(messages, Date.now() + 999999);
      expect(result.prunedCount).toBe(0);
      expect(messages[3].content.length).toBe(60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // TTL Expiry → Soft Trim
  // ---------------------------------------------------------------------------

  describe('soft trim', () => {
    it('should soft-trim tool results older than TTL', () => {
      // Need 3+ recent assistant messages AFTER the old tool result so it's not protected
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        msg('assistant', 'old_a', { toolCalls: [{ id: 'tc_old', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc_old'),           // index 3 — should be pruned
        msg('assistant', 'recent_1'),               // protected
        msg('assistant', 'recent_2'),               // protected
        msg('assistant', 'recent_3'),               // protected
      ];

      const baseTime = Date.now();
      pruner.trackMessages(messages);

      // Prune at baseTime + 1500ms (> 1s TTL)
      const result = pruner.prune(messages, baseTime + 1500);

      expect(result.prunedCount).toBe(1);
      expect(result.charsSaved).toBeGreaterThan(0);
      // Content should be trimmed, not full 60K
      expect(messages[3].content.length).toBeLessThan(60_000);
      expect(messages[3].content).toContain('pruned');
    });

    it('should not trim results younger than TTL', () => {
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        msg('assistant', 'a1', { toolCalls: [{ id: 'tc1', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc1'),
      ];

      const baseTime = Date.now();
      pruner.trackMessages(messages);

      // Prune at baseTime + 500ms (< 1s TTL)
      const result = pruner.prune(messages, baseTime + 500);
      expect(result.prunedCount).toBe(0);
      expect(messages[3].content.length).toBe(60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Hard Clear
  // ---------------------------------------------------------------------------

  describe('hard clear', () => {
    it('should hard-clear tool results older than 2× TTL', () => {
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        msg('assistant', 'old_a', { toolCalls: [{ id: 'tc1', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc1'),
        msg('assistant', 'recent_1'),
        msg('assistant', 'recent_2'),
        msg('assistant', 'recent_3'),
      ];

      const baseTime = Date.now();
      pruner.trackMessages(messages);

      // Prune at baseTime + 2500ms (> 2× 1s TTL)
      const result = pruner.prune(messages, baseTime + 2500);

      expect(result.prunedCount).toBe(1);
      expect(messages[3].content).toBe('[Old tool result content cleared]');
    });

    it('should not hard-clear when hardClearEnabled is false', () => {
      const noClearPruner = new ContextPruner({ ttlMs: 1000, hardClearEnabled: false });
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        msg('assistant', 'old_a', { toolCalls: [{ id: 'tc1', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc1'),
        msg('assistant', 'recent_1'),
        msg('assistant', 'recent_2'),
        msg('assistant', 'recent_3'),
      ];

      const baseTime = Date.now();
      noClearPruner.trackMessages(messages);

      // Even at 2× TTL, should soft-trim not hard-clear
      const result = noClearPruner.prune(messages, baseTime + 2500);
      expect(result.prunedCount).toBe(1);
      expect(messages[3].content).toContain('pruned'); // soft-trimmed
      expect(messages[3].content).not.toBe('[Old tool result content cleared]');
    });
  });

  // ---------------------------------------------------------------------------
  // Protected Turns
  // ---------------------------------------------------------------------------

  describe('protected turns', () => {
    it('should protect last 3 assistant turns and their tool results', () => {
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        // Old turn (should be prunable)
        msg('assistant', 'old_a', { toolCalls: [{ id: 'tc_old', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc_old'),
        // Recent turn 1 (protected)
        msg('assistant', 'recent_1', { toolCalls: [{ id: 'tc1', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc1'),
        // Recent turn 2 (protected)
        msg('assistant', 'recent_2', { toolCalls: [{ id: 'tc2', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc2'),
        // Recent turn 3 (protected)
        msg('assistant', 'recent_3', { toolCalls: [{ id: 'tc3', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc3'),
      ];

      const baseTime = Date.now();
      pruner.trackMessages(messages);

      const result = pruner.prune(messages, baseTime + 1500);

      // Only old tool result should be pruned
      expect(result.prunedCount).toBe(1);
      // Protected ones should be untouched
      expect(messages[5].content.length).toBe(60_000); // tc1
      expect(messages[7].content.length).toBe(60_000); // tc2
      expect(messages[9].content.length).toBe(60_000); // tc3
    });
  });

  // ---------------------------------------------------------------------------
  // Small Messages Ignored
  // ---------------------------------------------------------------------------

  describe('minimum size threshold', () => {
    it('should not prune small tool results even if old', () => {
      const messages = [
        msg('system', 'sys'),
        msg('user', 'q'),
        msg('assistant', 'a1', { toolCalls: [{ id: 'tc1', name: 'search', params: {} }] }),
        smallToolResult(10_000, 'tc1'), // Below 50K threshold
        msg('assistant', 'a2'),
      ];

      const baseTime = Date.now();
      pruner.trackMessages(messages);

      const result = pruner.prune(messages, baseTime + 5000);
      expect(result.prunedCount).toBe(0);
      expect(messages[3].content.length).toBe(10_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  describe('reset()', () => {
    it('should clear all tracking timestamps', () => {
      const messages = [
        msg('system', 'sys'),
        msg('assistant', 'a', { toolCalls: [{ id: 'tc1', name: 'Read', params: {} }] }),
        bigToolResult(60_000, 'tc1'),
      ];

      pruner.trackMessages(messages);
      pruner.reset();

      // After reset, messages won't have timestamps so won't be pruned
      const result = pruner.prune(messages, Date.now() + 5000);
      expect(result.prunedCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------

  describe('defaults', () => {
    it('should have 5 minute TTL', () => {
      expect(DEFAULT_PRUNER_CONFIG.ttlMs).toBe(300_000);
    });

    it('should have 50K min prunable chars', () => {
      expect(DEFAULT_PRUNER_CONFIG.minPrunableChars).toBe(50_000);
    });

    it('should protect last 3 assistants', () => {
      expect(DEFAULT_PRUNER_CONFIG.keepLastAssistants).toBe(3);
    });
  });
});
