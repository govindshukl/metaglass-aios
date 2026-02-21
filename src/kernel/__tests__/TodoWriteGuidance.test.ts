/**
 * TodoWriteGuidance Tests
 *
 * TDD tests for gradient TodoWrite guidance that varies by:
 * - Task complexity level
 * - Current turn number
 * - Whether output has been produced
 */

import { describe, it, expect } from 'vitest';
import {
  getTodoWriteGuidance,
  TodoWriteGuidanceLevel,
  type TodoWriteGuidanceResult,
} from '../TodoWriteGuidance';
import { TaskComplexity } from '../IntentClassifier';

describe('TodoWriteGuidance', () => {
  // ===========================================================================
  // TRIVIAL TASKS - Never require TodoWrite
  // ===========================================================================

  describe('TRIVIAL tasks', () => {
    it('should return "none" for TRIVIAL tasks on any turn', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.TRIVIAL,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('none');
      expect(result.message).toBeNull();
    });

    it('should return "none" for TRIVIAL tasks even on later turns', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.TRIVIAL,
        turnNumber: 5,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('none');
    });
  });

  // ===========================================================================
  // SIMPLE_QUERY - Never require TodoWrite
  // ===========================================================================

  describe('SIMPLE_QUERY tasks', () => {
    it('should return "none" for SIMPLE_QUERY tasks', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.SIMPLE_QUERY,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('none');
      expect(result.message).toBeNull();
    });

    it('should return "none" for SIMPLE_QUERY even with output', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.SIMPLE_QUERY,
        turnNumber: 3,
        hasProducedOutput: true,
      });

      expect(result.level).toBe('none');
    });
  });

  // ===========================================================================
  // MULTI_STEP - Soft guidance on early turns
  // ===========================================================================

  describe('MULTI_STEP tasks', () => {
    it('should return "soft" for MULTI_STEP on turn 1', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.MULTI_STEP,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('soft');
      expect(result.message).toBeTruthy();
    });

    it('should return "soft" for MULTI_STEP on turn 2', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.MULTI_STEP,
        turnNumber: 2,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('soft');
    });

    it('should return "none" for MULTI_STEP after turn 2', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.MULTI_STEP,
        turnNumber: 3,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('none');
    });

    it('should return "none" for MULTI_STEP after output is produced', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.MULTI_STEP,
        turnNumber: 1,
        hasProducedOutput: true,
      });

      expect(result.level).toBe('none');
    });

    it('should include helpful message for soft guidance', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.MULTI_STEP,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.message).toContain('TodoWrite');
      expect(result.message).toContain('progress');
    });
  });

  // ===========================================================================
  // COMPLEX - Strong guidance on turn 1
  // ===========================================================================

  describe('COMPLEX tasks', () => {
    it('should return "strong" for COMPLEX on turn 1', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.COMPLEX,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('strong');
      expect(result.message).toBeTruthy();
    });

    it('should return "soft" for COMPLEX on turn 2', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.COMPLEX,
        turnNumber: 2,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('soft');
    });

    it('should return "none" for COMPLEX after turn 3', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.COMPLEX,
        turnNumber: 4,
        hasProducedOutput: false,
      });

      expect(result.level).toBe('none');
    });

    it('should return "none" for COMPLEX after output is produced', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.COMPLEX,
        turnNumber: 1,
        hasProducedOutput: true,
      });

      expect(result.level).toBe('none');
    });

    it('should include emphatic message for strong guidance', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.COMPLEX,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.message).toContain('TodoWrite');
      // Strong message should be more emphatic
      expect(result.message!.toLowerCase()).toMatch(/please|must|should/);
    });
  });

  // ===========================================================================
  // GUIDANCE LEVELS
  // ===========================================================================

  describe('guidance levels', () => {
    it('should have correct ordering: none < soft < strong', () => {
      const levels: TodoWriteGuidanceLevel[] = ['none', 'soft', 'strong'];
      expect(levels.indexOf('none')).toBeLessThan(levels.indexOf('soft'));
      expect(levels.indexOf('soft')).toBeLessThan(levels.indexOf('strong'));
    });

    it('should never return "required" level (hard blocking removed)', () => {
      // We no longer hard-block, only provide guidance
      const testCases = [
        { complexity: TaskComplexity.COMPLEX, turnNumber: 1, hasProducedOutput: false },
        { complexity: TaskComplexity.MULTI_STEP, turnNumber: 1, hasProducedOutput: false },
      ];

      for (const tc of testCases) {
        const result = getTodoWriteGuidance(tc);
        expect(result.level).not.toBe('required');
      }
    });
  });

  // ===========================================================================
  // MESSAGE FORMAT
  // ===========================================================================

  describe('message format', () => {
    it('should return null message for "none" level', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.TRIVIAL,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result.message).toBeNull();
    });

    it('should return string message for non-none levels', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.COMPLEX,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(typeof result.message).toBe('string');
      expect(result.message!.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // RESULT STRUCTURE
  // ===========================================================================

  describe('result structure', () => {
    it('should return object with level and message', () => {
      const result = getTodoWriteGuidance({
        complexity: TaskComplexity.MULTI_STEP,
        turnNumber: 1,
        hasProducedOutput: false,
      });

      expect(result).toHaveProperty('level');
      expect(result).toHaveProperty('message');
    });
  });
});
