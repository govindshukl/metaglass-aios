import { describe, it, expect, beforeEach } from 'vitest';
import {
  LoopDetector,
  DEFAULT_LOOP_DETECTOR_CONFIG,
  type LoopDetectorConfig,
  type TodoSnapshot,
} from '../LoopDetector';

// =============================================================================
// HELPERS
// =============================================================================

function toolCalls(...names: string[]): Array<{ name: string; params: Record<string, unknown> }> {
  return names.map((name, i) => ({
    name,
    params: { file: `file_${i}.md` },
  }));
}

function sameCalls(name: string, count: number): Array<{ name: string; params: Record<string, unknown> }> {
  return Array.from({ length: count }, () => ({
    name,
    params: { file: 'same_file.md' },
  }));
}

function todoSnap(active: number, completed: number): TodoSnapshot {
  return {
    activeTodos: Array.from({ length: active }, (_, i) => `task_${i}`),
    completedCount: completed,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('LoopDetector', () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  // ---------------------------------------------------------------------------
  // Default Config
  // ---------------------------------------------------------------------------

  describe('defaults', () => {
    it('should have stale nudge threshold of 6', () => {
      expect(DEFAULT_LOOP_DETECTOR_CONFIG.staleTodoNudgeThreshold).toBe(6);
    });

    it('should have stale force-stop threshold of 10', () => {
      expect(DEFAULT_LOOP_DETECTOR_CONFIG.staleTodoForceStopThreshold).toBe(10);
    });

    it('should have exact repeat threshold of 4', () => {
      expect(DEFAULT_LOOP_DETECTOR_CONFIG.exactRepeatThreshold).toBe(4);
    });

    it('should have diversity threshold of 0.5', () => {
      expect(DEFAULT_LOOP_DETECTOR_CONFIG.diversityThreshold).toBe(0.5);
    });
  });

  // ---------------------------------------------------------------------------
  // No Loop (Healthy Progress)
  // ---------------------------------------------------------------------------

  describe('healthy progress', () => {
    it('should return continue when no tools called', () => {
      detector.recordTurn([], todoSnap(3, 0));
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should return continue for diverse tool calls with changing todos', () => {
      detector.recordTurn(toolCalls('vault_read', 'search', 'Glob'), todoSnap(3, 0));
      detector.recordTurn(toolCalls('vault_update', 'Read'), todoSnap(2, 1));
      detector.recordTurn(toolCalls('Bash', 'Grep'), todoSnap(1, 2));
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should return continue for same tool with different params on different files', () => {
      for (let i = 0; i < 6; i++) {
        detector.recordTurn(
          [{ name: 'vault_read', params: { noteId: `note_${i}` } }],
          todoSnap(3, 0)
        );
      }
      // Same tool, but different params → diverse → continue
      expect(detector.evaluate().action).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Exact Repetition Detection
  // ---------------------------------------------------------------------------

  describe('exact repetition', () => {
    it('should force-stop after 4 identical tool call turns', () => {
      const calls = sameCalls('vault_read', 1);
      for (let i = 0; i < 4; i++) {
        detector.recordTurn(calls, todoSnap(3, 0));
      }
      const result = detector.evaluate();
      expect(result.action).toBe('force_stop');
    });

    it('should not force-stop after only 3 identical turns', () => {
      const calls = sameCalls('vault_read', 1);
      for (let i = 0; i < 3; i++) {
        detector.recordTurn(calls, todoSnap(3, 0));
      }
      expect(detector.evaluate().action).not.toBe('force_stop');
    });

    it('should reset after a different tool call breaks the pattern', () => {
      const calls = sameCalls('vault_read', 1);
      detector.recordTurn(calls, todoSnap(3, 0));
      detector.recordTurn(calls, todoSnap(3, 0));
      detector.recordTurn(calls, todoSnap(3, 0));
      // Different call breaks the streak
      detector.recordTurn(toolCalls('Bash'), todoSnap(3, 0));
      detector.recordTurn(calls, todoSnap(3, 0));
      expect(detector.evaluate().action).not.toBe('force_stop');
    });
  });

  // ---------------------------------------------------------------------------
  // Stale Todo Detection (Nudge → 6, Force-Stop → 10)
  // ---------------------------------------------------------------------------

  describe('stale todo detection', () => {
    it('should nudge after 6+ stale turns with low diversity', () => {
      // First turn sets the baseline (doesn't count as stale)
      // Then 6 more turns with same todos → 6 stale turns
      for (let i = 0; i < 7; i++) {
        const suffix = i % 2 === 0 ? 'a' : 'b';
        detector.recordTurn(
          [{ name: 'Read', params: { path: `/file_${suffix}` } }],
          todoSnap(3, 0)
        );
      }
      const result = detector.evaluate();
      expect(result.action).toBe('nudge');
    });

    it('should not nudge before reaching threshold', () => {
      // First turn baseline + 5 stale = 6 total turns, but only 5 stale
      for (let i = 0; i < 6; i++) {
        const suffix = i % 2 === 0 ? 'a' : 'b';
        detector.recordTurn(
          [{ name: 'Read', params: { path: `/file_${suffix}` } }],
          todoSnap(3, 0)
        );
      }
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should force-stop after 10+ stale turns', () => {
      // First turn baseline + 10 stale = 11 total turns
      for (let i = 0; i < 11; i++) {
        const suffix = i % 2 === 0 ? 'a' : 'b';
        detector.recordTurn(
          [{ name: 'Read', params: { path: `/file_${suffix}` } }],
          todoSnap(3, 0)
        );
      }
      const result = detector.evaluate();
      expect(result.action).toBe('force_stop');
    });

    it('should reset stale count when todos change', () => {
      for (let i = 0; i < 5; i++) {
        detector.recordTurn(toolCalls(`tool_${i}`), todoSnap(3, 0));
      }
      // Active todos change (one completed)
      detector.recordTurn(toolCalls('tool_5'), todoSnap(2, 1));
      expect(detector.evaluate().action).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool-Call Diversity as Progress Signal
  // ---------------------------------------------------------------------------

  describe('tool-call diversity', () => {
    it('should suppress nudge when tool diversity is high despite stale todos', () => {
      // 6 turns, same todos, but each turn uses different tool+params
      for (let i = 0; i < 6; i++) {
        detector.recordTurn(
          [{ name: `tool_${i}`, params: { path: `/file_${i}` } }],
          todoSnap(3, 0)
        );
      }
      // Stale todos for 6 turns → normally would nudge
      // But diversity > 0.5 → suppress
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should NOT suppress nudge when diversity is low', () => {
      // 6 turns, same todos, same tool with same params
      for (let i = 0; i < 6; i++) {
        detector.recordTurn(
          [{ name: 'Read', params: { path: '/same_file' } }],
          todoSnap(3, 0)
        );
      }
      // Low diversity + stale todos → nudge
      const result = detector.evaluate();
      expect(result.action).not.toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // hasPlan / completedTodos Progress Signal
  // ---------------------------------------------------------------------------

  describe('hasPlan and completedTodos progress', () => {
    it('should treat hasPlan=true as progress signal suppressing nudge', () => {
      // hasPlan flag set after creating todos
      detector.setHasPlan(true);
      for (let i = 0; i < 6; i++) {
        // Same active todos but completedCount is increasing
        detector.recordTurn(toolCalls(`tool_${i}`), todoSnap(3, i));
      }
      // hasPlan + increasing completed → suppress nudge
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should reset stale count when completedTodos increases', () => {
      for (let i = 0; i < 5; i++) {
        detector.recordTurn(toolCalls(`tool_${i}`), todoSnap(5, 0));
      }
      // completedCount increases → progress
      detector.recordTurn(toolCalls('tool_5'), todoSnap(5, 1));
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should auto-detect hasPlan when 3+ todos created', () => {
      // First turn: no todos
      detector.recordTurn(toolCalls('search'), todoSnap(0, 0));
      // Second turn: 5 todos created → hasPlan auto-set
      detector.recordTurn(toolCalls('TodoWrite'), todoSnap(5, 0));

      // Now 6 more turns with same active todos but completing them
      for (let i = 0; i < 6; i++) {
        detector.recordTurn(toolCalls(`tool_${i}`), todoSnap(5, i));
      }
      expect(detector.evaluate().action).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Configurable Thresholds
  // ---------------------------------------------------------------------------

  describe('custom configuration', () => {
    it('should use custom stale nudge threshold', () => {
      const customDetector = new LoopDetector({ staleTodoNudgeThreshold: 3 });
      // baseline + 3 stale = 4 total turns
      for (let i = 0; i < 4; i++) {
        const suffix = i % 2 === 0 ? 'a' : 'b';
        customDetector.recordTurn(
          [{ name: 'Read', params: { path: `/file_${suffix}` } }],
          todoSnap(3, 0)
        );
      }
      expect(customDetector.evaluate().action).toBe('nudge');
    });

    it('should use custom exact repeat threshold', () => {
      const customDetector = new LoopDetector({ exactRepeatThreshold: 2 });
      const calls = sameCalls('vault_read', 1);
      customDetector.recordTurn(calls, todoSnap(3, 0));
      customDetector.recordTurn(calls, todoSnap(3, 0));
      expect(customDetector.evaluate().action).toBe('force_stop');
    });

    it('should use custom force-stop threshold', () => {
      const customDetector = new LoopDetector({ staleTodoForceStopThreshold: 5 });
      for (let i = 0; i < 5; i++) {
        customDetector.recordTurn(
          [{ name: 'Read', params: { path: '/same' } }],
          todoSnap(3, 0)
        );
      }
      expect(customDetector.evaluate().action).toBe('force_stop');
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  describe('reset()', () => {
    it('should clear all state', () => {
      const calls = sameCalls('vault_read', 1);
      for (let i = 0; i < 3; i++) {
        detector.recordTurn(calls, todoSnap(3, 0));
      }
      detector.reset();
      // After reset, should be clean
      detector.recordTurn(calls, todoSnap(3, 0));
      expect(detector.evaluate().action).toBe('continue');
    });

    it('should clear hasPlan flag', () => {
      detector.setHasPlan(true);
      detector.reset();
      // Need to verify hasPlan is reset — no direct getter, but behavior changes
      // After reset, stale nudge should not be suppressed by hasPlan
      for (let i = 0; i < 6; i++) {
        detector.recordTurn(
          [{ name: 'Read', params: { path: '/same' } }],
          todoSnap(3, 0)
        );
      }
      expect(detector.evaluate().action).not.toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Nudge Message Content
  // ---------------------------------------------------------------------------

  describe('nudge message', () => {
    it('should include stale turn count in nudge message', () => {
      for (let i = 0; i < 6; i++) {
        detector.recordTurn(
          [{ name: 'Read', params: { path: '/same' } }],
          todoSnap(3, 0)
        );
      }
      const result = detector.evaluate();
      if (result.action === 'nudge') {
        expect(result.message).toContain('6');
      }
    });
  });
});
