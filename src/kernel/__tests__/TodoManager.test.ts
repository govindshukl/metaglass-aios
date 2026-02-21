/**
 * TodoManager Tests (TDD)
 *
 * Tests for the TodoWrite-style task management.
 * Written FIRST per TDD approach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodoManager } from '../TodoManager';
import type { Todo, TodoStatus, EventEmitter } from '../../interfaces';

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
    once: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return { unsubscribe: () => handlers.get(event)?.delete(handler) };
    }),
    off: vi.fn((event, handler) => handlers.get(event)?.delete(handler)),
    emit: vi.fn(async (event, payload) => {
      const h = handlers.get(event);
      if (h) for (const handler of h) await handler(payload);
    }),
    emitSync: vi.fn((event, payload) => {
      const h = handlers.get(event);
      if (h) for (const handler of h) handler(payload);
    }),
    hasListeners: (event) => (handlers.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => handlers.get(event)?.size ?? 0,
    removeAllListeners: (event) => event ? handlers.delete(event) : handlers.clear(),
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('TodoManager', () => {
  let manager: TodoManager;
  let mockEvents: EventEmitter;

  beforeEach(() => {
    mockEvents = createMockEventEmitter();
    manager = new TodoManager(mockEvents);
  });

  // ===========================================================================
  // BASIC OPERATIONS
  // ===========================================================================

  describe('Basic Operations', () => {
    it('should start with empty todo list', () => {
      expect(manager.getTodos()).toEqual([]);
      expect(manager.count()).toBe(0);
    });

    it('should set todos', () => {
      const todos: Todo[] = [
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'pending' },
      ];

      manager.setTodos(todos);

      expect(manager.getTodos()).toEqual(todos);
      expect(manager.count()).toBe(2);
    });

    it('should clear todos', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
      ]);

      manager.clear();

      expect(manager.getTodos()).toEqual([]);
      expect(manager.count()).toBe(0);
    });
  });

  // ===========================================================================
  // VALIDATION RULES
  // ===========================================================================

  describe('Validation Rules', () => {
    it('should reject if more than one task is in_progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'in_progress' },
      ];

      const result = manager.setTodos(todos);

      expect(result.success).toBe(false);
      expect(result.error).toContain('one task');
    });

    it('should allow exactly one task in_progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'pending' },
      ];

      const result = manager.setTodos(todos);

      expect(result.success).toBe(true);
      expect(manager.getTodos()).toEqual(todos);
    });

    it('should allow zero tasks in_progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'completed' },
      ];

      const result = manager.setTodos(todos);

      expect(result.success).toBe(true);
    });

    it('should validate todo structure', () => {
      const invalidTodos = [
        { content: '', activeForm: 'Doing...', status: 'pending' as TodoStatus },
      ];

      const result = manager.setTodos(invalidTodos);

      expect(result.success).toBe(false);
      expect(result.error).toContain('content');
    });

    it('should validate activeForm is present', () => {
      const invalidTodos = [
        { content: 'Task', activeForm: '', status: 'pending' as TodoStatus },
      ];

      const result = manager.setTodos(invalidTodos);

      expect(result.success).toBe(false);
      expect(result.error).toContain('activeForm');
    });

    it('should validate status is valid', () => {
      const invalidTodos = [
        { content: 'Task', activeForm: 'Doing...', status: 'invalid' as TodoStatus },
      ];

      const result = manager.setTodos(invalidTodos);

      expect(result.success).toBe(false);
      expect(result.error).toContain('status');
    });
  });

  // ===========================================================================
  // STATUS HELPERS
  // ===========================================================================

  describe('Status Helpers', () => {
    beforeEach(() => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'completed' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'in_progress' },
        { content: 'Task 3', activeForm: 'Doing task 3...', status: 'pending' },
        { content: 'Task 4', activeForm: 'Doing task 4...', status: 'pending' },
      ]);
    });

    it('should get pending todos', () => {
      const pending = manager.getPending();
      expect(pending).toHaveLength(2);
      expect(pending.every(t => t.status === 'pending')).toBe(true);
    });

    it('should get in_progress todos', () => {
      const inProgress = manager.getInProgress();
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].content).toBe('Task 2');
    });

    it('should get completed todos', () => {
      const completed = manager.getCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0].content).toBe('Task 1');
    });

    it('should get current task (in_progress)', () => {
      const current = manager.getCurrentTask();
      expect(current).not.toBeNull();
      expect(current?.content).toBe('Task 2');
    });

    it('should return null for current task if none in_progress', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing...', status: 'pending' },
      ]);

      const current = manager.getCurrentTask();
      expect(current).toBeNull();
    });
  });

  // ===========================================================================
  // PROGRESS TRACKING
  // ===========================================================================

  describe('Progress Tracking', () => {
    it('should calculate progress percentage', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing...', status: 'completed' },
        { content: 'Task 2', activeForm: 'Doing...', status: 'completed' },
        { content: 'Task 3', activeForm: 'Doing...', status: 'in_progress' },
        { content: 'Task 4', activeForm: 'Doing...', status: 'pending' },
      ]);

      expect(manager.getProgress()).toBe(50); // 2/4 = 50%
    });

    it('should return 0 progress for empty list', () => {
      expect(manager.getProgress()).toBe(0);
    });

    it('should return 100 progress when all completed', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing...', status: 'completed' },
        { content: 'Task 2', activeForm: 'Doing...', status: 'completed' },
      ]);

      expect(manager.getProgress()).toBe(100);
    });
  });

  // ===========================================================================
  // EVENT EMISSION
  // ===========================================================================

  describe('Event Emission', () => {
    it('should emit todo:updated when todos change', () => {
      const todos: Todo[] = [
        { content: 'Task 1', activeForm: 'Doing...', status: 'pending' },
      ];

      manager.setTodos(todos);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'todo:updated',
        expect.objectContaining({ todos })
      );
    });

    it('should emit todo:task-started when task becomes in_progress', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
      ]);

      // Clear previous calls
      (mockEvents.emit as ReturnType<typeof vi.fn>).mockClear();

      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
      ]);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'todo:task-started',
        expect.objectContaining({ content: 'Task 1' })
      );
    });

    it('should emit todo:task-completed when task becomes completed', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
      ]);

      // Clear previous calls
      (mockEvents.emit as ReturnType<typeof vi.fn>).mockClear();

      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'completed' },
      ]);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'todo:task-completed',
        expect.objectContaining({ content: 'Task 1' })
      );
    });

    it('should not emit events on validation failure', () => {
      const invalidTodos: Todo[] = [
        { content: 'Task 1', activeForm: 'Doing...', status: 'in_progress' },
        { content: 'Task 2', activeForm: 'Doing...', status: 'in_progress' },
      ];

      (mockEvents.emit as ReturnType<typeof vi.fn>).mockClear();

      manager.setTodos(invalidTodos);

      expect(mockEvents.emit).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // SUBSCRIPTION
  // ===========================================================================

  describe('Subscription', () => {
    it('should notify subscribers on changes', () => {
      const callback = vi.fn();
      manager.subscribe(callback);

      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing...', status: 'pending' },
      ]);

      expect(callback).toHaveBeenCalledWith([
        expect.objectContaining({ content: 'Task 1' }),
      ]);
    });

    it('should allow unsubscribing', () => {
      const callback = vi.fn();
      const unsubscribe = manager.subscribe(callback);

      unsubscribe();

      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing...', status: 'pending' },
      ]);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should support multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.subscribe(callback1);
      manager.subscribe(callback2);

      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing...', status: 'pending' },
      ]);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // CONVENIENCE METHODS
  // ===========================================================================

  describe('Convenience Methods', () => {
    it('should start a task (pending -> in_progress)', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'pending' },
      ]);

      const result = manager.startTask(0);

      expect(result.success).toBe(true);
      expect(manager.getTodos()[0].status).toBe('in_progress');
    });

    it('should not start a task if another is in_progress', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'pending' },
      ]);

      const result = manager.startTask(1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already in progress');
    });

    it('should complete a task (in_progress -> completed)', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
      ]);

      const result = manager.completeTask(0);

      expect(result.success).toBe(true);
      expect(manager.getTodos()[0].status).toBe('completed');
    });

    it('should only complete in_progress tasks', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
      ]);

      const result = manager.completeTask(0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in progress');
    });

    it('should add a new task', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
      ]);

      manager.addTask('Task 2', 'Doing task 2...');

      expect(manager.count()).toBe(2);
      expect(manager.getTodos()[1]).toMatchObject({
        content: 'Task 2',
        activeForm: 'Doing task 2...',
        status: 'pending',
      });
    });

    it('should remove a task', () => {
      manager.setTodos([
        { content: 'Task 1', activeForm: 'Doing task 1...', status: 'pending' },
        { content: 'Task 2', activeForm: 'Doing task 2...', status: 'pending' },
      ]);

      manager.removeTask(0);

      expect(manager.count()).toBe(1);
      expect(manager.getTodos()[0].content).toBe('Task 2');
    });
  });
});
