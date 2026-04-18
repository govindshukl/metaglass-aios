/**
 * Loop Detection Tests
 *
 * Tests for detecting and breaking out of repetitive tool call loops
 * and stale todo scenarios in ConversationEngine.
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
// MOCK IMPLEMENTATIONS (shared with ConversationEngine tests)
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
// TESTS
// =============================================================================

describe('Loop Detection', () => {
  let tools: ToolProvider;
  let ui: UserInterface;
  let events: EventEmitter;

  beforeEach(() => {
    tools = createMockToolProvider({
      search: async () => ({ success: true, data: 'Found 3 results' }),
      read_note: async () => ({ success: true, data: 'Note content here' }),
      TodoWrite: async () => ({ success: true, data: 'Updated todos' }),
    });
    ui = createMockUI();
    events = createMockEventEmitter();
  });

  describe('Exact tool repetition detection', () => {
    it('should force-stop when the same tool+params are called 4 turns in a row', async () => {
      // Simulate: LLM calls search with same params every turn (the looping bug)
      const repeatingSearchResponse: LLMResponse = {
        content: 'Let me search again...',
        toolCalls: [{
          id: 'call_1',
          name: 'search',
          params: { query: 'vault', limit: 20 },
        }],
        finishReason: 'tool_calls',
      };

      // 4 identical search calls, then a normal stop (should never reach stop)
      const llm = createMockLLM([
        repeatingSearchResponse,
        repeatingSearchResponse,
        repeatingSearchResponse,
        repeatingSearchResponse,
        { content: 'Done!', finishReason: 'stop' },
      ]);

      const engine = new ConversationEngine({ llm, tools, ui, events });
      const result = await engine.execute('search the vault', {
        maxTurns: 20,
        requireTodoWrite: false,
      });

      // Should have stopped early due to loop detection (at turn 4)
      expect(result.success).toBe(true);
      expect(result.result).toContain('repeated actions detected');
      // LLM should NOT have been called 5 times — stopped at 4
      expect((llm.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(4);
    });
  });

  describe('Stale todo detection', () => {
    it('should inject a nudge after 3 turns with unchanged active todos', async () => {
      // Turn 1: TodoWrite to set up plan (establishes hasPlan)
      // Turn 2-4: Same tool calls, todos never updated → stale
      // Turn 5: Should get a nudge injected

      const todoWriteResponse: LLMResponse = {
        content: 'Setting up plan',
        toolCalls: [{
          id: 'call_todo',
          name: 'TodoWrite',
          params: {
            todos: [
              { content: 'Read all notes', status: 'in_progress', activeForm: 'Reading all notes' },
              { content: 'Summarize findings', status: 'pending', activeForm: 'Summarizing findings' },
            ],
          },
        }],
        finishReason: 'tool_calls',
      };

      const searchResponse: LLMResponse = {
        content: 'Let me continue working on the tasks',
        toolCalls: [{
          id: 'call_search',
          name: 'search',
          params: { query: 'notes' },
        }],
        finishReason: 'tool_calls',
      };

      // After nudge, LLM should stop
      const stopResponse: LLMResponse = {
        content: 'Here are my findings',
        finishReason: 'stop',
      };

      const llm = createMockLLM([
        todoWriteResponse,  // Turn 1: sets up todos
        searchResponse,     // Turn 2: search (stale turn 1)
        searchResponse,     // Turn 3: search (stale turn 2)
        searchResponse,     // Turn 4: search (stale turn 3 → nudge)
        stopResponse,       // Turn 5: responds after nudge
      ]);

      const engine = new ConversationEngine({ llm, tools, ui, events });
      const result = await engine.execute('explore the vault', {
        maxTurns: 20,
        requireTodoWrite: false,
      });

      // The conversation should have completed (nudge helped it stop)
      expect(result.success).toBe(true);

      // Check that the nudge message was injected by examining LLM calls
      const chatCalls = (llm.chat as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallMessages = chatCalls[chatCalls.length - 1][0] as Array<{ role: string; content: string }>;
      const nudgeMessage = lastCallMessages.find(
        m => m.role === 'user' && m.content.includes('repeating the same actions')
      );
      expect(nudgeMessage).toBeDefined();
    });

    it('should force-stop after 6 turns with unchanged active todos', async () => {
      const todoWriteResponse: LLMResponse = {
        content: 'Setting up plan',
        toolCalls: [{
          id: 'call_todo',
          name: 'TodoWrite',
          params: {
            todos: [
              { content: 'Explore vault', status: 'in_progress', activeForm: 'Exploring vault' },
            ],
          },
        }],
        finishReason: 'tool_calls',
      };

      // Different search params each time (so exact-match detection doesn't trigger)
      let searchIdx = 0;
      const makeSearch = (): LLMResponse => ({
        content: 'Continuing...',
        toolCalls: [{
          id: `call_${searchIdx++}`,
          name: 'search',
          params: { query: `variation_${searchIdx}` },
        }],
        finishReason: 'tool_calls',
      });

      const llm = createMockLLM([
        todoWriteResponse,
        makeSearch(), // stale 1
        makeSearch(), // stale 2
        makeSearch(), // stale 3 → nudge
        makeSearch(), // stale 4
        makeSearch(), // stale 5
        makeSearch(), // stale 6 → force-stop
        { content: 'Should never reach here', finishReason: 'stop' },
      ]);

      const engine = new ConversationEngine({ llm, tools, ui, events });
      const result = await engine.execute('explore the vault', {
        maxTurns: 20,
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      expect(result.result).toContain('repeated actions detected');
      // Should have stopped before turn 8
      expect((llm.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(7);
    });
  });

  describe('No false positives', () => {
    it('should NOT trigger loop detection when todos are being updated', async () => {
      // Normal flow: TodoWrite → search → TodoWrite (update) → search → done
      const responses: LLMResponse[] = [
        {
          content: 'Planning...',
          toolCalls: [{
            id: 'call_1',
            name: 'TodoWrite',
            params: {
              todos: [
                { content: 'Search notes', status: 'in_progress', activeForm: 'Searching' },
                { content: 'Summarize', status: 'pending', activeForm: 'Summarizing' },
              ],
            },
          }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Searching...',
          toolCalls: [{
            id: 'call_2',
            name: 'search',
            params: { query: 'notes' },
          }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Updating progress...',
          toolCalls: [{
            id: 'call_3',
            name: 'TodoWrite',
            params: {
              todos: [
                { content: 'Search notes', status: 'completed', activeForm: 'Searching' },
                { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
              ],
            },
          }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Searching more...',
          toolCalls: [{
            id: 'call_4',
            name: 'search',
            params: { query: 'more notes' },
          }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Here are the results!',
          finishReason: 'stop',
        },
      ];

      const llm = createMockLLM(responses);
      const engine = new ConversationEngine({ llm, tools, ui, events });
      const result = await engine.execute('search and summarize vault notes', {
        maxTurns: 20,
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      // Should NOT contain loop detection message
      expect(result.result).not.toContain('repeated actions detected');
      // Should complete normally
      expect(result.result).toBe('Here are the results!');
    });

    it('should NOT trigger when different tools are called each turn', async () => {
      const responses: LLMResponse[] = [
        {
          content: 'Step 1',
          toolCalls: [{ id: 'c1', name: 'search', params: { query: 'a' } }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Step 2',
          toolCalls: [{ id: 'c2', name: 'read_note', params: { id: '123' } }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Step 3',
          toolCalls: [{ id: 'c3', name: 'search', params: { query: 'b' } }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Step 4',
          toolCalls: [{ id: 'c4', name: 'read_note', params: { id: '456' } }],
          finishReason: 'tool_calls',
        },
        {
          content: 'Done!',
          finishReason: 'stop',
        },
      ];

      const llm = createMockLLM(responses);
      const engine = new ConversationEngine({ llm, tools, ui, events });
      const result = await engine.execute('explore vault', {
        maxTurns: 20,
        requireTodoWrite: false,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe('Done!');
      expect(result.result).not.toContain('repeated actions detected');
    });
  });
});
