/**
 * ConversationEngine Goal Session Tests (TDD)
 *
 * Tests for goal session lifecycle hooks: onSessionStart, onSessionComplete.
 * These hooks enable memory management during goal-scoped conversations.
 *
 * Written FIRST per TDD approach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEngine } from '../ConversationEngine';
import type {
  LLMProvider,
  ToolProvider,
  UserInterface,
  EventEmitter,
  LLMResponse,
  ToolResult,
  Tool,
} from '../../interfaces';

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

function createMockLLM(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    id: 'mock-llm',
    name: 'Mock LLM',
    chat: vi.fn(async () => {
      const response = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return response;
    }),
    getCapabilities: () => ({
      toolCalling: true,
      vision: false,
      streaming: false,
      contextWindow: 100000,
      maxOutputTokens: 4096,
    }),
    isConfigured: () => true,
  };
}

function createMockToolProvider(tools: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>>): ToolProvider {
  const toolDefs: Tool[] = Object.entries(tools).map(([id, execute]) => ({
    id,
    name: id,
    description: `Mock tool: ${id}`,
    parameters: { type: 'object' as const, properties: {} },
    execute: async (params, _ctx) => execute(params),
  }));

  return {
    id: 'mock-tools',
    list: () => toolDefs,
    listByCategory: () => toolDefs,
    get: (id) => toolDefs.find(t => t.id === id),
    has: (id) => toolDefs.some(t => t.id === id),
    execute: async (id, params, ctx) => {
      const tool = toolDefs.find(t => t.id === id);
      if (!tool) return { success: false, error: `Tool not found: ${id}` };
      return tool.execute(params, ctx);
    },
    count: () => toolDefs.length,
  };
}

function createMockUI(): UserInterface {
  return {
    ask: vi.fn(async () => 'user response'),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    askMultiple: vi.fn(async () => ({})),
    isPending: vi.fn(() => false),
    cancel: vi.fn(),
  };
}

function createMockEventEmitter(): EventEmitter {
  const handlers = new Map<string, Set<Function>>();
  return {
    on: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return { unsubscribe: () => handlers.get(event)?.delete(handler) };
    }),
    once: vi.fn((event, handler) => {
      const wrapped = (payload: unknown) => {
        handler(payload);
        handlers.get(event)?.delete(wrapped);
      };
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(wrapped);
      return { unsubscribe: () => handlers.get(event)?.delete(wrapped) };
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

describe('ConversationEngine Goal Session Lifecycle', () => {
  let engine: ConversationEngine;
  let mockLLM: LLMProvider;
  let mockTools: ToolProvider;
  let mockUI: UserInterface;
  let mockEvents: EventEmitter;

  beforeEach(() => {
    mockEvents = createMockEventEmitter();
  });

  // ===========================================================================
  // SESSION START
  // ===========================================================================

  describe('Session Start', () => {
    it('should emit goal:session-started event when conversation starts with goalId', async () => {
      mockLLM = createMockLLM([
        { content: 'Starting goal session.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Help me with my goal', {
        goalId: 'goal-session-start',
        goalName: 'Session Start Test',
      });

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'goal:session-started',
        expect.objectContaining({
          goalId: 'goal-session-start',
          goalName: 'Session Start Test',
          conversationId: expect.any(String),
          timestamp: expect.any(Number),
        })
      );
    });

    it('should not emit goal:session-started when no goalId is provided', async () => {
      mockLLM = createMockLLM([
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Hello');

      const sessionStartCalls = (mockEvents.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event === 'goal:session-started'
      );
      expect(sessionStartCalls.length).toBe(0);
    });

    it('should emit goal:session-started before first LLM call', async () => {
      const emitOrder: string[] = [];
      let llmCalled = false;

      mockEvents = {
        ...createMockEventEmitter(),
        emit: vi.fn(async (event: string) => {
          emitOrder.push(event);
        }),
      } as unknown as EventEmitter;

      mockLLM = {
        id: 'order-llm',
        name: 'Order LLM',
        chat: vi.fn(async () => {
          llmCalled = true;
          return { content: 'Done', finishReason: 'stop' as const };
        }),
        getCapabilities: () => ({
          toolCalling: true,
          vision: false,
          streaming: false,
          contextWindow: 100000,
          maxOutputTokens: 4096,
        }),
        isConfigured: () => true,
      };
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Start goal', {
        goalId: 'goal-order',
        goalName: 'Order Test',
      });

      const sessionStartIndex = emitOrder.indexOf('goal:session-started');
      const turnIndex = emitOrder.indexOf('conversation:turn');

      expect(sessionStartIndex).toBeGreaterThan(-1);
      expect(turnIndex).toBeGreaterThan(-1);
      expect(sessionStartIndex).toBeLessThan(turnIndex);
    });
  });

  // ===========================================================================
  // SESSION COMPLETE
  // ===========================================================================

  describe('Session Complete', () => {
    it('should emit goal:session-completed event when goal conversation completes successfully', async () => {
      mockLLM = createMockLLM([
        { content: 'Task completed.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Complete my task', {
        goalId: 'goal-complete',
        goalName: 'Completion Test',
      });

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'goal:session-completed',
        expect.objectContaining({
          goalId: 'goal-complete',
          goalName: 'Completion Test',
          conversationId: expect.any(String),
          success: true,
          turns: expect.any(Number),
          durationMs: expect.any(Number),
        })
      );
    });

    it('should include session summary in goal:session-completed event', async () => {
      const searchTool = vi.fn(async () => ({
        success: true,
        data: { results: ['result1'] },
        observation: 'Found 1 result',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Searching...',
          toolCalls: [{ id: 'tc1', name: 'search', params: { query: 'test' } }],
          finishReason: 'tool_calls',
        },
        { content: 'Done with search.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ search: searchTool });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Search for something', {
        goalId: 'goal-summary',
        goalName: 'Summary Test',
        requireTodoWrite: false, // Disable to allow tool execution
      });

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'goal:session-completed',
        expect.objectContaining({
          summary: expect.objectContaining({
            toolsExecuted: expect.arrayContaining(['search']),
            outputPaths: expect.any(Array),
          }),
        })
      );
    });

    it('should emit goal:session-completed with success: false on conversation failure', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Looping...',
          toolCalls: [{ id: 'tc1', name: 'loop', params: {} }],
          finishReason: 'tool_calls',
        },
      ]);
      mockTools = createMockToolProvider({
        loop: async () => ({ success: true, data: 'loop' }),
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Loop forever', {
        maxTurns: 2,
        goalId: 'goal-fail',
        goalName: 'Failure Test',
      });

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'goal:session-completed',
        expect.objectContaining({
          goalId: 'goal-fail',
          success: false,
        })
      );
    });

    it('should emit goal:session-completed on cancellation', async () => {
      // Use a promise-based abort check that polls the signal
      mockLLM = {
        id: 'slow-llm',
        name: 'Slow LLM',
        chat: vi.fn(async (_msgs, options) => {
          // Poll the signal during the wait
          for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            if (options?.signal?.aborted) {
              const error = new Error('Aborted');
              error.name = 'AbortError';
              throw error;
            }
          }
          return { content: 'Done', finishReason: 'stop' as const };
        }),
        getCapabilities: () => ({
          toolCalling: true,
          vision: false,
          streaming: false,
          contextWindow: 100000,
          maxOutputTokens: 4096,
        }),
        isConfigured: () => true,
      };
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      // Use engine.cancel() method which triggers the internal abort controller
      setTimeout(() => engine.cancel(), 30);

      await engine.execute('Slow task', {
        goalId: 'goal-cancel',
        goalName: 'Cancel Test',
      });

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'goal:session-completed',
        expect.objectContaining({
          goalId: 'goal-cancel',
          success: false,
          cancelled: true,
        })
      );
    });

    it('should not emit goal:session-completed when no goalId is provided', async () => {
      mockLLM = createMockLLM([
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Hello');

      const sessionCompleteCalls = (mockEvents.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event === 'goal:session-completed'
      );
      expect(sessionCompleteCalls.length).toBe(0);
    });
  });

  // ===========================================================================
  // SESSION HOOKS INTEGRATION
  // ===========================================================================

  describe('Session Hooks Integration', () => {
    it('should call onSessionStart callback if provided', async () => {
      const onSessionStart = vi.fn();

      mockLLM = createMockLLM([
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Start', {
        goalId: 'goal-hook-start',
        goalName: 'Hook Start Test',
        onSessionStart,
      });

      expect(onSessionStart).toHaveBeenCalledWith(
        expect.objectContaining({
          goalId: 'goal-hook-start',
          conversationId: expect.any(String),
        })
      );
    });

    it('should call onSessionComplete callback with result', async () => {
      const onSessionComplete = vi.fn();

      mockLLM = createMockLLM([
        { content: 'Completed.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Complete', {
        goalId: 'goal-hook-complete',
        goalName: 'Hook Complete Test',
        onSessionComplete,
      });

      expect(onSessionComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          goalId: 'goal-hook-complete',
          success: true,
          result: expect.any(String),
        })
      );
    });

    it('should handle errors in onSessionStart callback gracefully', async () => {
      const onSessionStart = vi.fn(() => {
        throw new Error('Hook error');
      });

      mockLLM = createMockLLM([
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      // Should not throw
      const result = await engine.execute('Start', {
        goalId: 'goal-error',
        goalName: 'Error Test',
        onSessionStart,
      });

      expect(result.success).toBe(true);
    });

    it('should handle errors in onSessionComplete callback gracefully', async () => {
      const onSessionComplete = vi.fn(() => {
        throw new Error('Hook error');
      });

      mockLLM = createMockLLM([
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      // Should not throw
      const result = await engine.execute('Complete', {
        goalId: 'goal-error-complete',
        goalName: 'Error Complete Test',
        onSessionComplete,
      });

      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // WORKING MEMORY UPDATES
  // ===========================================================================

  describe('Working Memory Updates', () => {
    it('should include working memory content in goal:session-completed summary', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Creating todos.',
          toolCalls: [{
            id: 'tc1',
            name: 'TodoWrite',
            params: {
              todos: [
                { content: 'Task 1', activeForm: 'Working on task 1', status: 'completed' },
                { content: 'Task 2', activeForm: 'Working on task 2', status: 'pending' },
              ],
            },
          }],
          finishReason: 'tool_calls',
        },
        { content: 'Tasks tracked.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Track tasks', {
        goalId: 'goal-tasks',
        goalName: 'Tasks Test',
      });

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'goal:session-completed',
        expect.objectContaining({
          summary: expect.objectContaining({
            tasksCreated: 2,
            tasksCompleted: 1,
          }),
        })
      );
    });
  });
});
