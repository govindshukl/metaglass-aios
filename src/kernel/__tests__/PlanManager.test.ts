/**
 * PlanManager Tests (TDD)
 *
 * Tests for the planning mode system (EnterPlanMode/ExitPlanMode equivalent).
 * Written FIRST per TDD approach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanManager } from '../PlanManager';
import type { EventEmitter } from '../../interfaces';

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

function createMockEventEmitter(): EventEmitter {
  const handlers = new Map<string, Set<Function>>();
  return {
    on: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return { unsubscribe: () => handlers.get(event)?.delete(handler) };
    }),
    once: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(async () => {}),
    emitSync: vi.fn(),
    hasListeners: () => false,
    listenerCount: () => 0,
    removeAllListeners: vi.fn(),
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('PlanManager', () => {
  let manager: PlanManager;
  let mockEvents: EventEmitter;

  beforeEach(() => {
    mockEvents = createMockEventEmitter();
    manager = new PlanManager(mockEvents);
  });

  // ===========================================================================
  // INITIAL STATE
  // ===========================================================================

  describe('Initial State', () => {
    it('should start not in planning mode', () => {
      expect(manager.isPlanning()).toBe(false);
    });

    it('should have pending approval status initially', () => {
      const state = manager.getState();
      expect(state.approvalStatus).toBe('pending');
    });

    it('should have no plan content initially', () => {
      const state = manager.getState();
      expect(state.planContent).toBeUndefined();
    });
  });

  // ===========================================================================
  // ENTER PLAN MODE
  // ===========================================================================

  describe('Enter Plan Mode', () => {
    it('should enter planning mode', () => {
      manager.enter();
      expect(manager.isPlanning()).toBe(true);
    });

    it('should emit plan:entered event', () => {
      manager.enter();
      expect(mockEvents.emit).toHaveBeenCalledWith('plan:entered', undefined);
    });

    it('should reset approval status when entering', () => {
      // Simulate previous approval
      manager.enter();
      manager.setPlanContent('Previous plan');

      // Re-enter
      manager.enter();

      const state = manager.getState();
      expect(state.approvalStatus).toBe('pending');
    });

    it('should clear previous plan content when entering', () => {
      manager.enter();
      manager.setPlanContent('Previous plan');
      manager.enter();

      const state = manager.getState();
      expect(state.planContent).toBeUndefined();
    });
  });

  // ===========================================================================
  // PLAN CONTENT
  // ===========================================================================

  describe('Plan Content', () => {
    beforeEach(() => {
      manager.enter();
    });

    it('should set plan content', () => {
      manager.setPlanContent('# My Plan\n\n1. Step one\n2. Step two');

      const state = manager.getState();
      expect(state.planContent).toBe('# My Plan\n\n1. Step one\n2. Step two');
    });

    it('should emit plan:updated event when content changes', () => {
      manager.setPlanContent('New plan');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'plan:updated',
        expect.objectContaining({ content: 'New plan' })
      );
    });

    it('should append to plan content', () => {
      manager.setPlanContent('Step 1');
      manager.appendToPlan('\nStep 2');

      const state = manager.getState();
      expect(state.planContent).toBe('Step 1\nStep 2');
    });

    it('should not allow setting content when not in planning mode', () => {
      manager.exit(false); // Exit planning mode

      const result = manager.setPlanContent('Invalid');

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain('not in planning mode');
    });
  });

  // ===========================================================================
  // EXIT PLAN MODE
  // ===========================================================================

  describe('Exit Plan Mode', () => {
    beforeEach(() => {
      manager.enter();
      manager.setPlanContent('My plan');
    });

    it('should exit planning mode', () => {
      manager.exit(true);
      expect(manager.isPlanning()).toBe(false);
    });

    it('should set approval status to approved when exiting with approval', () => {
      manager.exit(true);

      const state = manager.getState();
      expect(state.approvalStatus).toBe('approved');
    });

    it('should set approval status to rejected when exiting without approval', () => {
      manager.exit(false);

      const state = manager.getState();
      expect(state.approvalStatus).toBe('rejected');
    });

    it('should emit plan:exited event with approval status', () => {
      manager.exit(true);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'plan:exited',
        expect.objectContaining({ approved: true })
      );
    });

    it('should preserve plan content after exit', () => {
      manager.setPlanContent('My final plan');
      manager.exit(true);

      const state = manager.getState();
      expect(state.planContent).toBe('My final plan');
    });
  });

  // ===========================================================================
  // APPROVAL FLOW
  // ===========================================================================

  describe('Approval Flow', () => {
    it('should support async approval wait', async () => {
      manager.enter();
      manager.setPlanContent('Plan for approval');

      // Start waiting for approval
      const approvalPromise = manager.waitForApproval();

      // Simulate user approval after delay
      setTimeout(() => manager.approve(), 50);

      const approved = await approvalPromise;

      expect(approved).toBe(true);
      expect(manager.getState().approvalStatus).toBe('approved');
    });

    it('should support async rejection wait', async () => {
      manager.enter();
      manager.setPlanContent('Plan for rejection');

      const approvalPromise = manager.waitForApproval();

      setTimeout(() => manager.reject(), 50);

      const approved = await approvalPromise;

      expect(approved).toBe(false);
      expect(manager.getState().approvalStatus).toBe('rejected');
    });

    it('should timeout approval if specified', async () => {
      manager.enter();
      manager.setPlanContent('Plan');

      const approvalPromise = manager.waitForApproval({ timeoutMs: 50 });

      const approved = await approvalPromise;

      expect(approved).toBe(false);
      expect(manager.getState().approvalStatus).toBe('rejected');
    });

    it('should support approval via method call', () => {
      manager.enter();
      manager.setPlanContent('Plan');

      manager.approve();

      expect(manager.getState().approvalStatus).toBe('approved');
      expect(manager.isPlanning()).toBe(false);
    });

    it('should support rejection via method call', () => {
      manager.enter();
      manager.setPlanContent('Plan');

      manager.reject();

      expect(manager.getState().approvalStatus).toBe('rejected');
      expect(manager.isPlanning()).toBe(false);
    });
  });

  // ===========================================================================
  // SUBSCRIPTION
  // ===========================================================================

  describe('Subscription', () => {
    it('should notify subscribers on state change', () => {
      const callback = vi.fn();
      manager.subscribe(callback);

      manager.enter();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ isPlanning: true })
      );
    });

    it('should notify on plan content change', () => {
      const callback = vi.fn();
      manager.subscribe(callback);

      manager.enter();
      callback.mockClear();

      manager.setPlanContent('New plan');

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ planContent: 'New plan' })
      );
    });

    it('should notify on approval status change', () => {
      const callback = vi.fn();
      manager.subscribe(callback);

      manager.enter();
      manager.setPlanContent('Plan');
      callback.mockClear();

      manager.approve();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ approvalStatus: 'approved' })
      );
    });

    it('should allow unsubscribing', () => {
      const callback = vi.fn();
      const unsubscribe = manager.subscribe(callback);

      unsubscribe();
      manager.enter();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // VALIDATION
  // ===========================================================================

  describe('Validation', () => {
    it('should not allow approval when not in planning mode', () => {
      const result = manager.approve();

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain('not in planning mode');
    });

    it('should not allow rejection when not in planning mode', () => {
      const result = manager.reject();

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain('not in planning mode');
    });

    it('should not allow exit when not in planning mode', () => {
      const result = manager.exit(true);

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain('not in planning mode');
    });

    it('should warn if exiting without plan content', () => {
      manager.enter();

      const result = manager.exit(true);

      expect(result.success).toBe(true);
      expect(result.warning).toContain('no plan content');
    });
  });

  // ===========================================================================
  // STATE SNAPSHOT
  // ===========================================================================

  describe('State Snapshot', () => {
    it('should return complete state', () => {
      manager.enter();
      manager.setPlanContent('My plan');

      const state = manager.getState();

      expect(state).toEqual({
        isPlanning: true,
        planContent: 'My plan',
        approvalStatus: 'pending',
      });
    });

    it('should return immutable state snapshot', () => {
      manager.enter();
      const state1 = manager.getState();

      manager.setPlanContent('Changed');
      const state2 = manager.getState();

      expect(state1.planContent).toBeUndefined();
      expect(state2.planContent).toBe('Changed');
    });
  });
});
