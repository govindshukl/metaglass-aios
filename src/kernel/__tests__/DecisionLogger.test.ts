/**
 * DecisionLogger Tests
 *
 * TDD tests for decision logging that enables observability and debugging
 * of agent decisions during conversation execution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DecisionLogger,
  type DecisionLog,
} from '../DecisionLogger';

describe('DecisionLogger', () => {
  let logger: DecisionLogger;

  beforeEach(() => {
    logger = new DecisionLogger();
  });

  // ===========================================================================
  // BASIC LOGGING TESTS
  // ===========================================================================

  describe('log()', () => {
    it('should log a decision with all required fields', () => {
      logger.log({
        turn: 1,
        decision: 'skipped-todowrite-requirement',
        reason: 'tool agent_ask_user is exempt from TodoWrite',
        inputs: { toolName: 'agent_ask_user' },
        outcome: 'allowed',
      });

      const decisions = logger.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].turn).toBe(1);
      expect(decisions[0].decision).toBe('skipped-todowrite-requirement');
      expect(decisions[0].reason).toBe('tool agent_ask_user is exempt from TodoWrite');
      expect(decisions[0].inputs).toEqual({ toolName: 'agent_ask_user' });
      expect(decisions[0].outcome).toBe('allowed');
    });

    it('should include timestamp automatically', () => {
      const before = new Date();

      logger.log({
        turn: 1,
        decision: 'test-decision',
        reason: 'test reason',
        inputs: {},
        outcome: 'test outcome',
      });

      const after = new Date();
      const decisions = logger.getDecisions();

      expect(decisions[0].timestamp).toBeInstanceOf(Date);
      expect(decisions[0].timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(decisions[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should log multiple decisions in order', () => {
      logger.log({
        turn: 1,
        decision: 'first-decision',
        reason: 'first reason',
        inputs: {},
        outcome: 'first outcome',
      });

      logger.log({
        turn: 2,
        decision: 'second-decision',
        reason: 'second reason',
        inputs: {},
        outcome: 'second outcome',
      });

      logger.log({
        turn: 3,
        decision: 'third-decision',
        reason: 'third reason',
        inputs: {},
        outcome: 'third outcome',
      });

      const decisions = logger.getDecisions();
      expect(decisions).toHaveLength(3);
      expect(decisions[0].decision).toBe('first-decision');
      expect(decisions[1].decision).toBe('second-decision');
      expect(decisions[2].decision).toBe('third-decision');
    });
  });

  // ===========================================================================
  // RETRIEVAL TESTS
  // ===========================================================================

  describe('getDecisions()', () => {
    it('should return empty array when no decisions logged', () => {
      const decisions = logger.getDecisions();
      expect(decisions).toEqual([]);
    });

    it('should return a copy of decisions (not the original array)', () => {
      logger.log({
        turn: 1,
        decision: 'test',
        reason: 'test',
        inputs: {},
        outcome: 'test',
      });

      const decisions1 = logger.getDecisions();
      const decisions2 = logger.getDecisions();

      expect(decisions1).not.toBe(decisions2);
      expect(decisions1).toEqual(decisions2);
    });
  });

  // ===========================================================================
  // SUMMARY TESTS
  // ===========================================================================

  describe('getDecisionsSummary()', () => {
    it('should return empty string for empty log', () => {
      const summary = logger.getDecisionsSummary();
      expect(summary).toBe('');
    });

    it('should generate formatted summary string', () => {
      logger.log({
        turn: 1,
        decision: 'classified-intent',
        reason: 'detected query verb',
        inputs: { goal: 'search for notes' },
        outcome: 'complexity=SIMPLE_QUERY',
      });

      const summary = logger.getDecisionsSummary();
      expect(summary).toContain('[Turn 1]');
      expect(summary).toContain('classified-intent');
      expect(summary).toContain('detected query verb');
      expect(summary).toContain('complexity=SIMPLE_QUERY');
    });

    it('should include all decisions in summary', () => {
      logger.log({
        turn: 1,
        decision: 'decision-one',
        reason: 'reason one',
        inputs: {},
        outcome: 'outcome one',
      });

      logger.log({
        turn: 2,
        decision: 'decision-two',
        reason: 'reason two',
        inputs: {},
        outcome: 'outcome two',
      });

      const summary = logger.getDecisionsSummary();
      expect(summary).toContain('[Turn 1]');
      expect(summary).toContain('[Turn 2]');
      expect(summary).toContain('decision-one');
      expect(summary).toContain('decision-two');
    });

    it('should separate decisions with newlines', () => {
      logger.log({
        turn: 1,
        decision: 'first',
        reason: 'r1',
        inputs: {},
        outcome: 'o1',
      });

      logger.log({
        turn: 2,
        decision: 'second',
        reason: 'r2',
        inputs: {},
        outcome: 'o2',
      });

      const summary = logger.getDecisionsSummary();
      const lines = summary.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // FILTERING TESTS
  // ===========================================================================

  describe('getDecisionsByTurn()', () => {
    it('should return only decisions for the specified turn', () => {
      logger.log({ turn: 1, decision: 'd1', reason: 'r1', inputs: {}, outcome: 'o1' });
      logger.log({ turn: 2, decision: 'd2', reason: 'r2', inputs: {}, outcome: 'o2' });
      logger.log({ turn: 1, decision: 'd3', reason: 'r3', inputs: {}, outcome: 'o3' });
      logger.log({ turn: 3, decision: 'd4', reason: 'r4', inputs: {}, outcome: 'o4' });

      const turn1Decisions = logger.getDecisionsByTurn(1);
      expect(turn1Decisions).toHaveLength(2);
      expect(turn1Decisions[0].decision).toBe('d1');
      expect(turn1Decisions[1].decision).toBe('d3');
    });

    it('should return empty array for turn with no decisions', () => {
      logger.log({ turn: 1, decision: 'd1', reason: 'r1', inputs: {}, outcome: 'o1' });

      const turn5Decisions = logger.getDecisionsByTurn(5);
      expect(turn5Decisions).toEqual([]);
    });
  });

  describe('getDecisionsByType()', () => {
    it('should return only decisions of the specified type', () => {
      logger.log({ turn: 1, decision: 'classified-intent', reason: 'r1', inputs: {}, outcome: 'o1' });
      logger.log({ turn: 1, decision: 'tool-exemption', reason: 'r2', inputs: {}, outcome: 'o2' });
      logger.log({ turn: 2, decision: 'classified-intent', reason: 'r3', inputs: {}, outcome: 'o3' });

      const intentDecisions = logger.getDecisionsByType('classified-intent');
      expect(intentDecisions).toHaveLength(2);
      expect(intentDecisions.every(d => d.decision === 'classified-intent')).toBe(true);
    });
  });

  // ===========================================================================
  // CLEAR TESTS
  // ===========================================================================

  describe('clear()', () => {
    it('should remove all logged decisions', () => {
      logger.log({ turn: 1, decision: 'd1', reason: 'r1', inputs: {}, outcome: 'o1' });
      logger.log({ turn: 2, decision: 'd2', reason: 'r2', inputs: {}, outcome: 'o2' });

      expect(logger.getDecisions()).toHaveLength(2);

      logger.clear();

      expect(logger.getDecisions()).toHaveLength(0);
      expect(logger.getDecisionsSummary()).toBe('');
    });
  });

  // ===========================================================================
  // REAL-WORLD SCENARIO TESTS
  // ===========================================================================

  describe('real-world scenarios', () => {
    it('should log a complete conversation flow', () => {
      // Turn 1: Intent classification
      logger.log({
        turn: 1,
        decision: 'classified-intent',
        reason: 'detected "create" verb and multiple deliverables',
        inputs: { goal: 'create a trip plan to Hawaii', goalLength: 28 },
        outcome: 'complexity=MULTI_STEP, suggestedActions=[create_todo]',
      });

      // Turn 1: Tool exemption check
      logger.log({
        turn: 1,
        decision: 'tool-exemption-check',
        reason: 'agent_ask_user has requiresTodoWrite=false in metadata',
        inputs: { toolName: 'agent_ask_user' },
        outcome: 'allowed without plan',
      });

      // Turn 2: Checkpoint trigger
      logger.log({
        turn: 2,
        decision: 'triggered-checkpoint',
        reason: 'plan has 4 steps, exceeds minSteps threshold of 3',
        inputs: { todoCount: 4, trigger: 'after-planning' },
        outcome: 'awaiting-user-confirmation',
      });

      const decisions = logger.getDecisions();
      expect(decisions).toHaveLength(3);

      const summary = logger.getDecisionsSummary();
      expect(summary).toContain('classified-intent');
      expect(summary).toContain('tool-exemption-check');
      expect(summary).toContain('triggered-checkpoint');
    });
  });
});
