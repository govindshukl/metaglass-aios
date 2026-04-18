/**
 * ConversationEngine Tests (TDD)
 *
 * Tests for the core conversation loop that powers AIOS agents.
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

describe('ConversationEngine', () => {
  let engine: ConversationEngine;
  let mockLLM: LLMProvider;
  let mockTools: ToolProvider;
  let mockUI: UserInterface;
  let mockEvents: EventEmitter;

  beforeEach(() => {
    mockEvents = createMockEventEmitter();
  });

  // ===========================================================================
  // BASIC EXECUTION
  // ===========================================================================

  describe('Basic Execution', () => {
    it('should execute a simple conversation without tools', async () => {
      mockLLM = createMockLLM([
        { content: 'Hello! How can I help you?', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Hi there!');

      expect(result.success).toBe(true);
      expect(result.result).toBe('Hello! How can I help you?');
      expect(result.turns).toBe(1);
      expect(mockLLM.chat).toHaveBeenCalledTimes(1);
    });

    it('should pass user message to LLM', async () => {
      mockLLM = createMockLLM([
        { content: 'Response', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('What is 2+2?');

      expect(mockLLM.chat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'What is 2+2?' }),
        ]),
        expect.anything()
      );
    });

    it('should include system prompt if provided', async () => {
      mockLLM = createMockLLM([
        { content: 'Response', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Hello', { systemPrompt: 'You are a helpful assistant.' });

      expect(mockLLM.chat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system', content: 'You are a helpful assistant.' }),
        ]),
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // TOOL EXECUTION
  // ===========================================================================

  describe('Tool Execution', () => {
    it('should execute tool when LLM requests it', async () => {
      const searchTool = vi.fn(async () => ({
        success: true,
        data: { results: ['result1', 'result2'] },
        observation: 'Found 2 results',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Let me search for that.',
          toolCalls: [{ id: 'tc1', name: 'search', params: { query: 'test' } }],
          finishReason: 'tool_calls',
        },
        { content: 'I found 2 results.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ search: searchTool });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Search for test');

      expect(result.success).toBe(true);
      expect(searchTool).toHaveBeenCalledWith({ query: 'test' });
      expect(mockLLM.chat).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple tool calls in one turn', async () => {
      const tool1 = vi.fn(async () => ({ success: true, data: 'result1' }));
      const tool2 = vi.fn(async () => ({ success: true, data: 'result2' }));

      mockLLM = createMockLLM([
        {
          content: 'Running both tools.',
          toolCalls: [
            { id: 'tc1', name: 'tool1', params: {} },
            { id: 'tc2', name: 'tool2', params: {} },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Done with both.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ tool1, tool2 });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Run both tools');

      expect(result.success).toBe(true);
      expect(tool1).toHaveBeenCalled();
      expect(tool2).toHaveBeenCalled();
    });

    it('should add tool results to message history', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Searching.',
          toolCalls: [{ id: 'tc1', name: 'search', params: { q: 'test' } }],
          finishReason: 'tool_calls',
        },
        { content: 'Found it.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        search: async () => ({ success: true, data: { found: true } }),
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Search');

      // Second call should include tool result
      const secondCall = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCall[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'tool', toolCallId: 'tc1' }),
        ])
      );
    });

    it('should handle tool not found error', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Calling unknown tool.',
          toolCalls: [{ id: 'tc1', name: 'unknown_tool', params: {} }],
          finishReason: 'tool_calls',
        },
        { content: 'Tool not found, but continuing.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Call unknown tool');

      expect(result.success).toBe(true); // Engine continues despite tool error
      expect(result.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            content: expect.stringContaining('not found'),
          }),
        ])
      );
    });

    it('should handle tool execution error', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Calling failing tool.',
          toolCalls: [{ id: 'tc1', name: 'failing', params: {} }],
          finishReason: 'tool_calls',
        },
        { content: 'Tool failed, understood.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        failing: async () => { throw new Error('Tool crashed'); },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Call failing tool');

      expect(result.success).toBe(true); // Engine continues despite tool error
    });
  });

  // ===========================================================================
  // TURN LIMITS AND TIMEOUTS
  // ===========================================================================

  describe('Turn Limits and Timeouts', () => {
    it('should stop after maxTurns', async () => {
      // LLM keeps calling tools indefinitely
      mockLLM = createMockLLM([
        {
          content: 'Looping.',
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

      const result = await engine.execute('Loop forever', { maxTurns: 3 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('max turns');
      expect(result.turns).toBe(3);
    });

    it('should use default maxTurns if not specified', async () => {
      mockLLM = createMockLLM([
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Hello');

      expect(result.success).toBe(true);
      // Default maxTurns should be reasonable (e.g., 50)
    });

    it('should respect timeout', async () => {
      mockLLM = {
        id: 'slow-llm',
        name: 'Slow LLM',
        chat: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return { content: 'Slow response', finishReason: 'stop' as const };
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

      const result = await engine.execute('Slow request', { timeoutMs: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });
  });

  // ===========================================================================
  // CANCELLATION
  // ===========================================================================

  describe('Cancellation', () => {
    it('should support cancellation via AbortSignal', async () => {
      const controller = new AbortController();
      let chatCalled = false;

      mockLLM = {
        id: 'wait-llm',
        name: 'Wait LLM',
        chat: vi.fn(async (_msgs, options) => {
          chatCalled = true;
          // Simulate checking abort signal periodically
          await new Promise(resolve => setTimeout(resolve, 50));
          // After delay, check if aborted
          if (options?.signal?.aborted || controller.signal.aborted) {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            throw error;
          }
          return { content: 'Response', finishReason: 'stop' as const };
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

      // Cancel almost immediately
      setTimeout(() => controller.abort(), 10);

      const result = await engine.execute('Hello', { signal: controller.signal });

      expect(chatCalled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.status).toBe('cancelled');
    });

    it('should provide cancel method', async () => {
      let chatCalled = false;
      let abortSignal: AbortSignal | undefined;

      mockLLM = {
        id: 'wait-llm',
        name: 'Wait LLM',
        chat: vi.fn(async (_msgs, options) => {
          chatCalled = true;
          abortSignal = options?.signal;
          // Wait and check abort
          await new Promise(resolve => setTimeout(resolve, 50));
          if (abortSignal?.aborted) {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            throw error;
          }
          return { content: 'Response', finishReason: 'stop' as const };
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

      const promise = engine.execute('Hello');

      // Cancel almost immediately
      setTimeout(() => engine.cancel(), 10);

      const result = await promise;

      expect(chatCalled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.status).toBe('cancelled');
    });
  });

  // ===========================================================================
  // EVENT EMISSION
  // ===========================================================================

  describe('Event Emission', () => {
    it('should emit conversation:started event', async () => {
      mockLLM = createMockLLM([
        { content: 'Done', finishReason: 'stop' },
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

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:started',
        expect.objectContaining({ conversationId: expect.any(String) })
      );
    });

    it('should emit conversation:turn events', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Calling tool.',
          toolCalls: [{ id: 'tc1', name: 'test', params: {} }],
          finishReason: 'tool_calls',
        },
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        test: async () => ({ success: true, data: 'ok' }),
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Test');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:turn',
        expect.objectContaining({ turn: 1 })
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:turn',
        expect.objectContaining({ turn: 2 })
      );
    });

    it('should emit conversation:tool-call and conversation:tool-result events', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Calling tool.',
          toolCalls: [{ id: 'tc1', name: 'test', params: { x: 1 } }],
          finishReason: 'tool_calls',
        },
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        test: async () => ({ success: true, data: 'result' }),
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Test');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:tool-call',
        expect.objectContaining({
          toolCall: expect.objectContaining({ name: 'test' }),
        })
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:tool-result',
        expect.objectContaining({
          result: expect.objectContaining({ success: true }),
        })
      );
    });

    it('should emit conversation:completed on success', async () => {
      mockLLM = createMockLLM([
        { content: 'Done', finishReason: 'stop' },
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

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:completed',
        expect.objectContaining({
          result: expect.objectContaining({ success: true }),
        })
      );
    });

    it('should emit conversation:failed on error', async () => {
      mockLLM = {
        id: 'error-llm',
        name: 'Error LLM',
        chat: vi.fn(async () => { throw new Error('LLM error'); }),
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

      await engine.execute('Hello');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:failed',
        expect.objectContaining({ error: expect.stringContaining('LLM error') })
      );
    });
  });

  // ===========================================================================
  // STATE MANAGEMENT
  // ===========================================================================

  describe('State Management', () => {
    it('should track running state', async () => {
      mockLLM = createMockLLM([
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      expect(engine.isRunning()).toBe(false);

      const promise = engine.execute('Hello');
      // Note: This is a synchronous check right after calling execute
      // In a real scenario, we might need to check during execution

      await promise;
      expect(engine.isRunning()).toBe(false);
    });

    it('should return message history in result', async () => {
      mockLLM = createMockLLM([
        { content: 'Hello back!', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Hello');

      expect(result.messages).toHaveLength(2); // user + assistant
      expect(result.messages[0]).toMatchObject({ role: 'user', content: 'Hello' });
      expect(result.messages[1]).toMatchObject({ role: 'assistant', content: 'Hello back!' });
    });

    it('should prevent concurrent executions', async () => {
      mockLLM = {
        id: 'slow-llm',
        name: 'Slow LLM',
        chat: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
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

      const promise1 = engine.execute('First');
      const promise2 = engine.execute('Second');

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // One should succeed, one should fail (already running)
      expect(
        (result1.success && !result2.success) ||
        (!result1.success && result2.success)
      ).toBe(true);
    });
  });

  // ===========================================================================
  // SPECIAL TOOLS
  // ===========================================================================

  describe('Special Tools', () => {
    it('should handle AskUserQuestion tool', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Need to ask user.',
          toolCalls: [{
            id: 'tc1',
            name: 'AskUserQuestion',
            params: {
              questions: [{
                question: 'What color?',
                header: 'Color',
                options: [
                  { label: 'Red', description: 'The color red' },
                  { label: 'Blue', description: 'The color blue' },
                ],
                multiSelect: false,
              }],
            },
          }],
          finishReason: 'tool_calls',
        },
        { content: 'User said red.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();
      (mockUI.askMultiple as ReturnType<typeof vi.fn>).mockResolvedValue({ Color: 'Red' });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Ask about color');

      expect(mockUI.askMultiple).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ question: 'What color?' }),
        ])
      );
      expect(result.success).toBe(true);
    });

    it('should handle TodoWrite tool', async () => {
      const todoUpdates: any[] = [];
      mockEvents.on('todo:updated', (payload) => {
        todoUpdates.push(payload);
      });

      mockLLM = createMockLLM([
        {
          content: 'Creating todos.',
          toolCalls: [{
            id: 'tc1',
            name: 'TodoWrite',
            params: {
              todos: [
                { content: 'Task 1', activeForm: 'Doing task 1...', status: 'in_progress' },
                { content: 'Task 2', activeForm: 'Doing task 2...', status: 'pending' },
              ],
            },
          }],
          finishReason: 'tool_calls',
        },
        { content: 'Todos created.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Create todos');

      expect(result.success).toBe(true);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'todo:updated',
        expect.objectContaining({
          todos: expect.arrayContaining([
            expect.objectContaining({ content: 'Task 1', status: 'in_progress' }),
          ]),
        })
      );
    });
  });

  // ===========================================================================
  // CHECKPOINT/RESUME
  // ===========================================================================

  describe('Checkpoint/Resume', () => {
    it('should save checkpoint after conversation', async () => {
      mockLLM = createMockLLM([
        { content: 'I understand', finishReason: 'stop' },
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
      await engine.checkpoint();

      // Verify checkpoint event was emitted
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'conversation:checkpoint',
        expect.objectContaining({
          conversationId: expect.any(String),
          turn: expect.any(Number),
        })
      );
    });

    it('should return conversation id', async () => {
      mockLLM = createMockLLM([
        { content: 'Hello', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Hi');

      const id = engine.getConversationId();
      expect(id).toBeTruthy();
      expect(id).toMatch(/^conv_/);
    });

    it('should enable auto-checkpoint', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Using a tool',
          toolCalls: [{ id: 'tc1', name: 'test_tool', params: {} }],
          finishReason: 'tool_calls',
        },
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        test_tool: async () => ({ success: true, observation: 'Tool executed' }),
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      engine.setAutoCheckpoint(true);
      await engine.execute('Do something');

      // Checkpoint should have been called automatically after each turn
      const checkpointCalls = (mockEvents.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'conversation:checkpoint'
      );
      expect(checkpointCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should list saved checkpoints', async () => {
      mockLLM = createMockLLM([
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('First conversation');
      await engine.checkpoint();

      const checkpoints = await engine.listCheckpoints();
      expect(Array.isArray(checkpoints)).toBe(true);
    });

    it('should delete checkpoint', async () => {
      mockLLM = createMockLLM([
        { content: 'Done', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      await engine.execute('Test');
      await engine.checkpoint();

      const id = engine.getConversationId();
      const deleted = await engine.deleteCheckpoint(id);
      expect(deleted).toBe(true);
    });

    it('should not checkpoint when no conversation is running', async () => {
      mockLLM = createMockLLM([]);
      mockTools = createMockToolProvider({});
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      // Checkpoint without running execute should not emit event
      await engine.checkpoint();

      const checkpointCalls = (mockEvents.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'conversation:checkpoint'
      );
      expect(checkpointCalls.length).toBe(0);
    });
  });

  // ===========================================================================
  // PARALLEL TOOL EXECUTION
  // ===========================================================================

  describe('Parallel Tool Execution', () => {
    it('should execute parallel-safe tools concurrently', async () => {
      const executionLog: string[] = [];
      const DELAY = 50; // ms

      mockLLM = createMockLLM([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'tc1', name: 'search_fulltext', params: { query: 'a' } },
            { id: 'tc2', name: 'search_vector', params: { query: 'b' } },
            { id: 'tc3', name: 'Grep', params: { pattern: 'c' } },
          ],
        },
        { content: 'Done searching', finishReason: 'stop' },
      ]);

      mockTools = createMockToolProvider({
        search_fulltext: async () => {
          executionLog.push('search_fulltext:start');
          await new Promise(r => setTimeout(r, DELAY));
          executionLog.push('search_fulltext:end');
          return { success: true, observation: 'Results for a' };
        },
        search_vector: async () => {
          executionLog.push('search_vector:start');
          await new Promise(r => setTimeout(r, DELAY));
          executionLog.push('search_vector:end');
          return { success: true, observation: 'Results for b' };
        },
        Grep: async () => {
          executionLog.push('Grep:start');
          await new Promise(r => setTimeout(r, DELAY));
          executionLog.push('Grep:end');
          return { success: true, observation: 'Results for c' };
        },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const start = Date.now();
      const result = await engine.execute('Search for a, b, and c', {
        requireTodoWrite: false,
        parallelTools: true,
      });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(true);

      // All three should start before any ends (concurrent execution)
      const startIndices = executionLog
        .filter(e => e.endsWith(':start'))
        .map(e => executionLog.indexOf(e));
      const endIndices = executionLog
        .filter(e => e.endsWith(':end'))
        .map(e => executionLog.indexOf(e));

      // All starts should come before any end (concurrent)
      expect(Math.max(...startIndices)).toBeLessThan(Math.min(...endIndices));

      // Elapsed time should be roughly 1x delay, not 3x
      // Use generous margin to avoid flakiness
      expect(elapsed).toBeLessThan(DELAY * 2.5);
    });

    it('should keep sequential tools in order', async () => {
      const executionOrder: string[] = [];

      mockLLM = createMockLLM([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'tc1', name: 'vault_create_note', params: { title: 'Note 1' } },
            { id: 'tc2', name: 'vault_update_note', params: { id: '1' } },
          ],
        },
        { content: 'Done', finishReason: 'stop' },
      ]);

      mockTools = createMockToolProvider({
        vault_create_note: async () => {
          executionOrder.push('vault_create_note');
          return { success: true, observation: 'Created' };
        },
        vault_update_note: async () => {
          executionOrder.push('vault_update_note');
          return { success: true, observation: 'Updated' };
        },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Create and update notes', {
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(['vault_create_note', 'vault_update_note']);
    });

    it('should handle mixed parallel + sequential tool calls', async () => {
      const executionLog: string[] = [];

      mockLLM = createMockLLM([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'tc1', name: 'Read', params: { path: '/a' } },
            { id: 'tc2', name: 'Grep', params: { pattern: 'x' } },
            { id: 'tc3', name: 'vault_create_note', params: { title: 'New' } },
          ],
        },
        { content: 'Done', finishReason: 'stop' },
      ]);

      mockTools = createMockToolProvider({
        Read: async () => {
          executionLog.push('Read');
          await new Promise(r => setTimeout(r, 30));
          return { success: true, observation: 'File content' };
        },
        Grep: async () => {
          executionLog.push('Grep');
          await new Promise(r => setTimeout(r, 30));
          return { success: true, observation: 'Matches' };
        },
        vault_create_note: async () => {
          executionLog.push('vault_create_note');
          return { success: true, observation: 'Created' };
        },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Read, grep, then create', {
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);

      // vault_create_note (sequential) must come after Read and Grep (parallel)
      const createIndex = executionLog.indexOf('vault_create_note');
      expect(createIndex).toBe(2); // Last to execute

      // Verify history order matches original toolCall order
      const llmCalls = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls;
      const secondCallMessages = llmCalls[1][0] as Array<{ role: string; toolName?: string }>;
      const toolMessages = secondCallMessages.filter(m => m.role === 'tool');
      expect(toolMessages.map(m => m.toolName)).toEqual(['Read', 'Grep', 'vault_create_note']);
    });

    it('should isolate parallel tool failures', async () => {
      mockLLM = createMockLLM([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'tc1', name: 'search_fulltext', params: { query: 'fail' } },
            { id: 'tc2', name: 'Grep', params: { pattern: 'ok' } },
          ],
        },
        { content: 'Handled errors', finishReason: 'stop' },
      ]);

      mockTools = createMockToolProvider({
        search_fulltext: async () => {
          return { success: false, error: 'Search failed', observation: 'Error: Search failed' };
        },
        Grep: async () => {
          return { success: true, observation: 'Found matches' };
        },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Search and grep', {
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);

      // Both results should be in history
      const llmCalls = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls;
      const secondCallMessages = llmCalls[1][0] as Array<{ role: string; toolName?: string; content?: string }>;
      const toolMessages = secondCallMessages.filter(m => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages[0].toolName).toBe('search_fulltext');
      expect(toolMessages[1].toolName).toBe('Grep');
    });

    it('should disable parallel execution when parallelTools is false', async () => {
      const executionOrder: string[] = [];

      mockLLM = createMockLLM([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'tc1', name: 'search_fulltext', params: { query: 'a' } },
            { id: 'tc2', name: 'Grep', params: { pattern: 'b' } },
          ],
        },
        { content: 'Done', finishReason: 'stop' },
      ]);

      mockTools = createMockToolProvider({
        search_fulltext: async () => {
          executionOrder.push('search_fulltext');
          return { success: true, observation: 'Results' };
        },
        Grep: async () => {
          executionOrder.push('Grep');
          return { success: true, observation: 'Matches' };
        },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Search and grep', {
        requireTodoWrite: false,
        parallelTools: false,
      });

      expect(result.success).toBe(true);
      // Sequential execution: order is deterministic
      expect(executionOrder).toEqual(['search_fulltext', 'Grep']);
    });

    it('should skip partitioning for single tool calls', async () => {
      mockLLM = createMockLLM([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'tc1', name: 'search_fulltext', params: { query: 'a' } },
          ],
        },
        { content: 'Found it', finishReason: 'stop' },
      ]);

      mockTools = createMockToolProvider({
        search_fulltext: async () => {
          return { success: true, observation: 'Results for a' };
        },
      });
      mockUI = createMockUI();

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Search for a', {
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      expect(result.turns).toBe(2); // tool call + final response
    });
  });

  // ===========================================================================
  // SUB-AGENT TOOLS (spawn_task / task_status)
  // ===========================================================================

  describe('Sub-Agent Tools', () => {
    it('should include spawn_task in tool list when taskSpawner is provided', async () => {
      const mockTaskSpawner = {
        spawn: vi.fn(async () => ({
          taskId: 'task_123',
          success: true,
          data: 'Sub-agent result',
          status: 'completed' as const,
        })),
        isRunning: vi.fn(() => false),
        getResult: vi.fn(),
        getRunningTasks: vi.fn(() => []),
        cancel: vi.fn(),
        cancelAll: vi.fn(),
        depth: 0,
        maxDepth: 3,
        maxConcurrent: 5,
      };

      // LLM calls spawn_task, then produces final response
      const llm = createMockLLM([
        {
          content: '',
          toolCalls: [{
            id: 'tc_1',
            name: 'spawn_task',
            params: {
              description: 'Search vault',
              prompt: 'Find all notes about TypeScript',
              subagentType: 'explore',
            },
          }],
        },
        { content: 'Found results via sub-agent' },
      ]);

      const tools = createMockToolProvider({});
      const engine = new ConversationEngine({
        llm,
        tools,
        ui: createMockUI(),
        events: createMockEventEmitter(),
        taskSpawner: mockTaskSpawner as any,
      });

      const result = await engine.execute('Search for TypeScript notes', {
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      expect(mockTaskSpawner.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Search vault',
          prompt: 'Find all notes about TypeScript',
          subagentType: 'explore',
        })
      );
    });

    it('should NOT include spawn_task when no taskSpawner provided', async () => {
      const llm = createMockLLM([
        { content: 'No spawn_task available' },
      ]);

      const tools = createMockToolProvider({});

      // Capture what tools are sent to the LLM
      const originalChat = llm.chat;
      let sentToolNames: string[] = [];
      llm.chat = vi.fn(async (messages, options) => {
        if (options?.tools) {
          sentToolNames = options.tools.map((t: any) => t.name || t.id);
        }
        return originalChat(messages, options);
      });

      const engine = new ConversationEngine({
        llm,
        tools,
        ui: createMockUI(),
        events: createMockEventEmitter(),
        // No taskSpawner
      });

      await engine.execute('Simple question', { requireTodoWrite: false });

      expect(sentToolNames).not.toContain('spawn_task');
      expect(sentToolNames).not.toContain('task_status');
    });

    it('should handle spawn_task with runInBackground', async () => {
      const mockTaskSpawner = {
        spawn: vi.fn(async () => ({
          taskId: 'task_bg_1',
          success: true,
          status: 'running' as const,
        })),
        isRunning: vi.fn(() => true),
        getResult: vi.fn(async () => ({
          taskId: 'task_bg_1',
          success: true,
          data: 'Background result',
          status: 'completed' as const,
        })),
        getRunningTasks: vi.fn(() => []),
        cancel: vi.fn(),
        cancelAll: vi.fn(),
        depth: 0,
        maxDepth: 3,
        maxConcurrent: 5,
      };

      const llm = createMockLLM([
        {
          content: '',
          toolCalls: [{
            id: 'tc_1',
            name: 'spawn_task',
            params: {
              description: 'Background task',
              prompt: 'Run tests',
              subagentType: 'execute',
              runInBackground: true,
            },
          }],
        },
        { content: 'Task spawned in background' },
      ]);

      const engine = new ConversationEngine({
        llm,
        tools: createMockToolProvider({}),
        ui: createMockUI(),
        events: createMockEventEmitter(),
        taskSpawner: mockTaskSpawner as any,
      });

      const result = await engine.execute('Run tests in background', {
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      expect(mockTaskSpawner.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          runInBackground: true,
        })
      );
    });
  });

});

