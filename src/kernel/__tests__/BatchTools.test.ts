/**
 * BatchTools Tests (TDD)
 *
 * Tests for the batch_tools meta-tool that enables models to execute
 * multiple tool calls in a single response, even when they can't
 * natively produce parallel tool calls.
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
// MOCK IMPLEMENTATIONS (reused from ConversationEngine.test.ts)
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

function createMockToolProvider(
  tools: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>>
): ToolProvider {
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
    get: (id) => toolDefs.find((t) => t.id === id),
    has: (id) => toolDefs.some((t) => t.id === id),
    execute: async (id, params, ctx) => {
      const tool = toolDefs.find((t) => t.id === id);
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
    removeAllListeners: (event) => (event ? handlers.delete(event) : handlers.clear()),
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('batch_tools', () => {
  let engine: ConversationEngine;
  let mockLLM: LLMProvider;
  let mockTools: ToolProvider;
  let mockUI: UserInterface;
  let mockEvents: EventEmitter;

  beforeEach(() => {
    mockEvents = createMockEventEmitter();
    mockUI = createMockUI();
  });

  // ===========================================================================
  // BASIC BATCH EXECUTION
  // ===========================================================================

  describe('Basic Batch Execution', () => {
    it('should execute multiple tools from a single batch_tools call', async () => {
      const tool1 = vi.fn(async () => ({
        success: true,
        data: { result: 'tool1 done' },
        observation: 'Tool 1 completed',
      }));
      const tool2 = vi.fn(async () => ({
        success: true,
        data: { result: 'tool2 done' },
        observation: 'Tool 2 completed',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Executing both tools.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  { tool: 'tool1', params: { x: 1 } },
                  { tool: 'tool2', params: { y: 2 } },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Both tools completed.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ tool1, tool2 });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Run both tools');

      expect(result.success).toBe(true);
      expect(tool1).toHaveBeenCalledWith({ x: 1 });
      expect(tool2).toHaveBeenCalledWith({ y: 2 });
      // Only 2 LLM calls: one returns batch_tools, one returns final text
      expect(mockLLM.chat).toHaveBeenCalledTimes(2);
    });

    it('should return combined results to LLM in a single tool message', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Batching.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  { tool: 'search', params: { query: 'test' } },
                  { tool: 'read', params: { path: 'readme.md' } },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        search: async () => ({
          success: true,
          data: { results: ['a', 'b'] },
          observation: 'Found 2 results',
        }),
        read: async () => ({
          success: true,
          data: { content: 'Hello world' },
          observation: 'Read readme.md',
        }),
      });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Search and read');

      expect(result.success).toBe(true);

      // The second LLM call should have received the combined tool result
      const secondCall = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls[1];
      const toolMessages = secondCall[0].filter(
        (m: { role: string }) => m.role === 'tool'
      );
      // Should have exactly 1 tool result message for batch_tools
      expect(toolMessages.length).toBe(1);
      expect(toolMessages[0].toolCallId).toBe('tc1');
      // Combined result should mention both sub-tool results
      expect(toolMessages[0].content).toContain('search');
      expect(toolMessages[0].content).toContain('read');
    });
  });

  // ===========================================================================
  // BUILT-IN TOOL HANDLING (TodoWrite, AskUserQuestion)
  // ===========================================================================

  describe('Built-in Tools in Batch', () => {
    it('should handle TodoWrite inside a batch alongside regular tools', async () => {
      const vaultTool = vi.fn(async () => ({
        success: true,
        data: { path: 'goals/test/contract.md' },
        observation: 'Note created',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Creating plan and note.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  {
                    tool: 'TodoWrite',
                    params: {
                      todos: [
                        { content: 'Create note', activeForm: 'Creating note', status: 'in_progress' },
                        { content: 'Submit contract', activeForm: 'Submitting contract', status: 'pending' },
                      ],
                    },
                  },
                  {
                    tool: 'vault_create_note',
                    params: { title: 'Contract', content: '# Contract' },
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ vault_create_note: vaultTool });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Create a contract');

      expect(result.success).toBe(true);
      expect(vaultTool).toHaveBeenCalled();
      // TodoWrite should have been executed — verify via event
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'todo:updated',
        expect.objectContaining({
          todos: expect.arrayContaining([
            expect.objectContaining({ content: 'Create note', status: 'in_progress' }),
          ]),
        })
      );
    });

    it('should handle AskUserQuestion inside a batch', async () => {
      (mockUI.askMultiple as ReturnType<typeof vi.fn>).mockResolvedValue({
        Duration: '1 week',
      });

      mockLLM = createMockLLM([
        {
          content: 'Asking questions and setting up plan.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  {
                    tool: 'TodoWrite',
                    params: {
                      todos: [
                        { content: 'Gather requirements', activeForm: 'Gathering requirements', status: 'in_progress' },
                      ],
                    },
                  },
                  {
                    tool: 'AskUserQuestion',
                    params: {
                      questions: [
                        {
                          question: 'How long is the trip?',
                          header: 'Duration',
                          options: [
                            { label: '1 week', description: 'Short trip' },
                            { label: '2 weeks', description: 'Longer trip' },
                          ],
                          multiSelect: false,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'User wants 1 week.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Plan a trip');

      expect(result.success).toBe(true);
      expect(mockUI.askMultiple).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe('Error Handling', () => {
    it('should continue batch execution when one sub-tool fails', async () => {
      const goodTool = vi.fn(async () => ({
        success: true,
        data: 'ok',
        observation: 'Good tool ran',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Running batch.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  { tool: 'unknown_tool', params: {} },
                  { tool: 'good_tool', params: {} },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'One failed, one succeeded.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ good_tool: goodTool });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Run batch with error');

      expect(result.success).toBe(true);
      expect(goodTool).toHaveBeenCalled();
      // The combined result should include both the error and success
      const secondCall = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls[1];
      const toolMsg = secondCall[0].find(
        (m: { role: string; toolCallId?: string }) =>
          m.role === 'tool' && m.toolCallId === 'tc1'
      );
      expect(toolMsg.content).toContain('not found');
      expect(toolMsg.content).toContain('Good tool ran');
    });

    it('should reject batch_tools with empty calls array', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Empty batch.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: { calls: [] },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Ok.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Empty batch');

      expect(result.success).toBe(true);
      // Verify the tool result contains an error message
      const secondCall = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls[1];
      const toolMsg = secondCall[0].find(
        (m: { role: string; toolCallId?: string }) =>
          m.role === 'tool' && m.toolCallId === 'tc1'
      );
      expect(toolMsg.content).toContain('empty');
    });

    it('should reject batch_tools with missing calls field', async () => {
      mockLLM = createMockLLM([
        {
          content: 'Bad batch.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {},
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Ok.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({});

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Bad batch');

      expect(result.success).toBe(true);
      const secondCall = (mockLLM.chat as ReturnType<typeof vi.fn>).mock.calls[1];
      const toolMsg = secondCall[0].find(
        (m: { role: string; toolCallId?: string }) =>
          m.role === 'tool' && m.toolCallId === 'tc1'
      );
      expect(toolMsg.content).toContain('calls');
    });
  });

  // ===========================================================================
  // PAUSE TOOL HANDLING (submit_contract inside batch)
  // ===========================================================================

  describe('Pause Tools in Batch', () => {
    it('should execute submit_contract last and pause conversation', async () => {
      const vaultTool = vi.fn(async () => ({
        success: true,
        data: { path: 'goals/test/contract.md' },
        observation: 'Note created',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Submitting.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  {
                    tool: 'TodoWrite',
                    params: {
                      todos: [
                        { content: 'Submit contract', activeForm: 'Submitting contract', status: 'in_progress' },
                      ],
                    },
                  },
                  {
                    tool: 'submit_contract',
                    params: { contract_path: 'goals/test/contract.md', goal_id: 'test-goal' },
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
      ]);
      mockTools = createMockToolProvider({ vault_create_note: vaultTool });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Submit contract');

      // Should pause since submit_contract was in the batch
      expect(result.status).toBe('paused');
      expect(result.pauseReason).toBe('submit_contract');
    });

    it('should execute non-pause tools before pause tools in batch', async () => {
      const executionOrder: string[] = [];

      const vaultTool = vi.fn(async () => {
        executionOrder.push('vault_create_note');
        return {
          success: true,
          data: { path: 'goals/test/contract.md' },
          observation: 'Note created',
        };
      });

      mockLLM = createMockLLM([
        {
          content: 'Creating note then submitting.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  // submit_contract listed FIRST, but should execute LAST
                  {
                    tool: 'submit_contract',
                    params: { contract_path: 'goals/test/contract.md', goal_id: 'test-goal' },
                  },
                  {
                    tool: 'vault_create_note',
                    params: { title: 'Contract', content: '# Contract' },
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
      ]);
      mockTools = createMockToolProvider({ vault_create_note: vaultTool });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Submit contract');

      expect(result.status).toBe('paused');
      // vault_create_note should have run before submit_contract paused
      expect(vaultTool).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // TODOWRITE ENFORCEMENT INTERACTION
  // ===========================================================================

  describe('TodoWrite Enforcement', () => {
    it('should count TodoWrite inside batch as plan establishment', async () => {
      const searchTool = vi.fn(async () => ({
        success: true,
        data: { results: ['a'] },
        observation: 'Found 1 result',
      }));

      mockLLM = createMockLLM([
        {
          content: 'Planning and searching.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  {
                    tool: 'TodoWrite',
                    params: {
                      todos: [
                        { content: 'Search vault', activeForm: 'Searching vault', status: 'in_progress' },
                      ],
                    },
                  },
                  { tool: 'search', params: { query: 'test' } },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Done.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({ search: searchTool });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Search for something', {
        requireTodoWrite: true,
      });

      expect(result.success).toBe(true);
      expect(searchTool).toHaveBeenCalled();
      // Search should NOT have been blocked — TodoWrite was in the same batch
    });
  });

  // ===========================================================================
  // TURN EFFICIENCY
  // ===========================================================================

  describe('Turn Efficiency', () => {
    it('should use fewer LLM calls with batch_tools vs sequential', async () => {
      // With batch_tools: 1 call returns batch, 1 final = 2 calls
      // Without: 1 call for TodoWrite, 1 for vault, 1 for submit, 1 final = 4 calls
      mockLLM = createMockLLM([
        {
          content: 'Batching everything.',
          toolCalls: [
            {
              id: 'tc1',
              name: 'batch_tools',
              params: {
                calls: [
                  {
                    tool: 'TodoWrite',
                    params: {
                      todos: [
                        { content: 'Create note', activeForm: 'Creating note', status: 'in_progress' },
                      ],
                    },
                  },
                  {
                    tool: 'vault_create_note',
                    params: { title: 'Test', content: '# Test' },
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'All done in one batch.', finishReason: 'stop' },
      ]);
      mockTools = createMockToolProvider({
        vault_create_note: async () => ({
          success: true,
          data: { path: 'test.md' },
          observation: 'Created test.md',
        }),
      });

      engine = new ConversationEngine({
        llm: mockLLM,
        tools: mockTools,
        ui: mockUI,
        events: mockEvents,
      });

      const result = await engine.execute('Create a note with plan');

      expect(result.success).toBe(true);
      expect(result.turns).toBe(2); // Only 2 turns instead of 3+
      expect(mockLLM.chat).toHaveBeenCalledTimes(2);
    });
  });
});
