/**
 * TaskSpawner Tests (TDD)
 *
 * Tests for the sub-agent spawning system (Task tool equivalent).
 * Written FIRST per TDD approach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskSpawner, type AgentFactory } from '../TaskSpawner';
import type {
  TaskParams,
  EventEmitter,
  ConversationResult,
} from '../../interfaces';

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

function createMockAgentFactory(): AgentFactory {
  return {
    create: vi.fn(() => ({
      execute: vi.fn(async (prompt: string): Promise<ConversationResult> => ({
        success: true,
        result: `Result for: ${prompt}`,
        status: 'completed',
        turns: 1,
        durationMs: 100,
        messages: [],
      })),
      cancel: vi.fn(),
      isRunning: vi.fn(() => false),
    })),
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('TaskSpawner', () => {
  let spawner: TaskSpawner;
  let mockEvents: EventEmitter;
  let mockAgentFactory: AgentFactory;

  beforeEach(() => {
    mockEvents = createMockEventEmitter();
    mockAgentFactory = createMockAgentFactory();
    spawner = new TaskSpawner(mockAgentFactory, mockEvents);
  });

  // ===========================================================================
  // BASIC SPAWNING
  // ===========================================================================

  describe('Basic Spawning', () => {
    it('should spawn a task and return result', async () => {
      const params: TaskParams = {
        description: 'Test task',
        prompt: 'Do something',
        subagentType: 'general-purpose',
      };

      const result = await spawner.spawn(params);

      expect(result.success).toBe(true);
      expect(result.taskId).toBeDefined();
      expect(result.status).toBe('completed');
    });

    it('should pass prompt to agent', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagentType: 'Explore',
      };

      await spawner.spawn(params);

      const agent = (mockAgentFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(agent.execute).toHaveBeenCalledWith('Find all TypeScript files');
    });

    it('should generate unique task IDs', async () => {
      const params: TaskParams = {
        description: 'Task',
        prompt: 'Do something',
        subagentType: 'general-purpose',
      };

      const result1 = await spawner.spawn(params);
      const result2 = await spawner.spawn(params);

      expect(result1.taskId).not.toBe(result2.taskId);
    });
  });

  // ===========================================================================
  // AGENT TYPE CONFIGURATION
  // ===========================================================================

  describe('Agent Type Configuration', () => {
    it('should use Haiku model for Explore type', async () => {
      const params: TaskParams = {
        description: 'Explore',
        prompt: 'Find files',
        subagentType: 'Explore',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'haiku' })
      );
    });

    it('should use Sonnet model for general-purpose type', async () => {
      const params: TaskParams = {
        description: 'Research',
        prompt: 'Research topic',
        subagentType: 'general-purpose',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'sonnet' })
      );
    });

    it('should use Sonnet model for Plan type', async () => {
      const params: TaskParams = {
        description: 'Plan',
        prompt: 'Design architecture',
        subagentType: 'Plan',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'sonnet' })
      );
    });

    it('should allow model override', async () => {
      const params: TaskParams = {
        description: 'Explore',
        prompt: 'Find files',
        subagentType: 'Explore',
        model: 'opus', // Override Haiku default
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'opus' })
      );
    });

    it('should provide read-only tools for Explore type', async () => {
      const params: TaskParams = {
        description: 'Explore',
        prompt: 'Find files',
        subagentType: 'Explore',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: expect.arrayContaining(['Read', 'Glob', 'Grep']),
        })
      );

      // Should NOT include edit tools
      const config = (mockAgentFactory.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.allowedTools).not.toContain('Write');
      expect(config.allowedTools).not.toContain('Edit');
    });

    it('should provide all tools for general-purpose type', async () => {
      const params: TaskParams = {
        description: 'Research',
        prompt: 'Research topic',
        subagentType: 'general-purpose',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: '*', // All tools
        })
      );
    });

    it('should provide Bash-only tools for Bash type', async () => {
      const params: TaskParams = {
        description: 'Run command',
        prompt: 'git status',
        subagentType: 'Bash',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: expect.arrayContaining(['Bash']),
        })
      );
    });
  });

  // ===========================================================================
  // BACKGROUND EXECUTION
  // ===========================================================================

  describe('Background Execution', () => {
    it('should return immediately when runInBackground is true', async () => {
      // Make agent slow
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            return {
              success: true,
              result: 'Done',
              status: 'completed' as const,
              turns: 1,
              durationMs: 500,
              messages: [],
            };
          }),
          cancel: vi.fn(),
          isRunning: vi.fn(() => true),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      const params: TaskParams = {
        description: 'Background task',
        prompt: 'Do something slowly',
        subagentType: 'general-purpose',
        runInBackground: true,
      };

      const start = Date.now();
      const result = await spawner.spawn(params);
      const elapsed = Date.now() - start;

      expect(result.status).toBe('running');
      expect(elapsed).toBeLessThan(100); // Should return immediately
    });

    it('should track background tasks', async () => {
      let running = true;
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
            running = false;
            return {
              success: true,
              result: 'Done',
              status: 'completed' as const,
              turns: 1,
              durationMs: 100,
              messages: [],
            };
          }),
          cancel: vi.fn(),
          isRunning: vi.fn(() => running),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      const params: TaskParams = {
        description: 'Background',
        prompt: 'Work',
        subagentType: 'general-purpose',
        runInBackground: true,
      };

      const result = await spawner.spawn(params);

      expect(spawner.isRunning(result.taskId)).toBe(true);

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(spawner.isRunning(result.taskId)).toBe(false);
    });

    it('should allow getting result of background task', async () => {
      let resolveTask: Function;
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => { resolveTask = resolve; });
            return {
              success: true,
              result: 'Background result',
              status: 'completed' as const,
              turns: 1,
              durationMs: 100,
              messages: [],
            };
          }),
          cancel: vi.fn(),
          isRunning: vi.fn(() => true),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      const params: TaskParams = {
        description: 'Background',
        prompt: 'Work',
        subagentType: 'general-purpose',
        runInBackground: true,
      };

      const initialResult = await spawner.spawn(params);
      expect(initialResult.status).toBe('running');

      // Complete the task
      resolveTask!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalResult = await spawner.getResult(initialResult.taskId);
      expect(finalResult?.success).toBe(true);
      expect(finalResult?.data).toBe('Background result');
    });
  });

  // ===========================================================================
  // TASK MANAGEMENT
  // ===========================================================================

  describe('Task Management', () => {
    it('should list running tasks', async () => {
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            return {
              success: true,
              result: 'Done',
              status: 'completed' as const,
              turns: 1,
              durationMs: 500,
              messages: [],
            };
          }),
          cancel: vi.fn(),
          isRunning: vi.fn(() => true),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      await spawner.spawn({
        description: 'Task 1',
        prompt: 'Work 1',
        subagentType: 'general-purpose',
        runInBackground: true,
      });

      await spawner.spawn({
        description: 'Task 2',
        prompt: 'Work 2',
        subagentType: 'Explore',
        runInBackground: true,
      });

      const running = spawner.getRunningTasks();
      expect(running).toHaveLength(2);
    });

    it('should cancel a running task', async () => {
      const cancelFn = vi.fn();
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            return {
              success: false,
              error: 'Cancelled',
              status: 'cancelled' as const,
              turns: 0,
              durationMs: 0,
              messages: [],
            };
          }),
          cancel: cancelFn,
          isRunning: vi.fn(() => true),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      const result = await spawner.spawn({
        description: 'Task',
        prompt: 'Work',
        subagentType: 'general-purpose',
        runInBackground: true,
      });

      spawner.cancel(result.taskId);

      expect(cancelFn).toHaveBeenCalled();
    });

    it('should cancel all running tasks', async () => {
      const cancelFns = [vi.fn(), vi.fn()];
      let callIndex = 0;
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            return {
              success: true,
              result: 'Done',
              status: 'completed' as const,
              turns: 1,
              durationMs: 500,
              messages: [],
            };
          }),
          cancel: cancelFns[callIndex++],
          isRunning: vi.fn(() => true),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      await spawner.spawn({
        description: 'Task 1',
        prompt: 'Work 1',
        subagentType: 'general-purpose',
        runInBackground: true,
      });

      await spawner.spawn({
        description: 'Task 2',
        prompt: 'Work 2',
        subagentType: 'general-purpose',
        runInBackground: true,
      });

      spawner.cancelAll();

      expect(cancelFns[0]).toHaveBeenCalled();
      expect(cancelFns[1]).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // RESUME CAPABILITY
  // ===========================================================================

  describe('Resume Capability', () => {
    it('should support resuming a task by ID', async () => {
      const params: TaskParams = {
        description: 'Resumed task',
        prompt: 'Continue work',
        subagentType: 'general-purpose',
        resume: 'previous-task-id',
      };

      await spawner.spawn(params);

      expect(mockAgentFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeFrom: 'previous-task-id',
        })
      );
    });
  });

  // ===========================================================================
  // EVENT EMISSION
  // ===========================================================================

  describe('Event Emission', () => {
    it('should emit task:spawned when task starts', async () => {
      const params: TaskParams = {
        description: 'Test task',
        prompt: 'Do something',
        subagentType: 'Explore',
      };

      await spawner.spawn(params);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'task:spawned',
        expect.objectContaining({
          taskId: expect.any(String),
          type: 'Explore',
        })
      );
    });

    it('should emit task:completed when task finishes', async () => {
      const params: TaskParams = {
        description: 'Test task',
        prompt: 'Do something',
        subagentType: 'general-purpose',
      };

      await spawner.spawn(params);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'task:completed',
        expect.objectContaining({
          taskId: expect.any(String),
          result: expect.objectContaining({ success: true }),
        })
      );
    });

    it('should emit task:completed for background tasks when done', async () => {
      let resolveTask: Function;
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            await new Promise(resolve => { resolveTask = resolve; });
            return {
              success: true,
              result: 'Done',
              status: 'completed' as const,
              turns: 1,
              durationMs: 100,
              messages: [],
            };
          }),
          cancel: vi.fn(),
          isRunning: vi.fn(() => true),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      await spawner.spawn({
        description: 'Background',
        prompt: 'Work',
        subagentType: 'general-purpose',
        runInBackground: true,
      });

      // task:spawned should be called
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'task:spawned',
        expect.anything()
      );

      // task:completed should NOT be called yet
      expect(mockEvents.emit).not.toHaveBeenCalledWith(
        'task:completed',
        expect.anything()
      );

      // Complete the task
      resolveTask!();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Now task:completed should be called
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'task:completed',
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe('Error Handling', () => {
    it('should handle agent execution errors', async () => {
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async () => {
            throw new Error('Agent crashed');
          }),
          cancel: vi.fn(),
          isRunning: vi.fn(() => false),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      const result = await spawner.spawn({
        description: 'Failing task',
        prompt: 'Crash',
        subagentType: 'general-purpose',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent crashed');
      expect(result.status).toBe('failed');
    });

    it('should handle agent returning failure', async () => {
      mockAgentFactory = {
        create: vi.fn(() => ({
          execute: vi.fn(async (): Promise<ConversationResult> => ({
            success: false,
            error: 'Task failed',
            status: 'failed',
            turns: 1,
            durationMs: 100,
            messages: [],
          })),
          cancel: vi.fn(),
          isRunning: vi.fn(() => false),
        })),
      };
      spawner = new TaskSpawner(mockAgentFactory, mockEvents);

      const result = await spawner.spawn({
        description: 'Failing task',
        prompt: 'Fail',
        subagentType: 'general-purpose',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task failed');
    });
  });
});
