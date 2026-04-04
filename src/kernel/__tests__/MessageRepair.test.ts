import { describe, it, expect } from 'vitest';
import { repairToolMessages } from '../MessageRepair';
import type { Message } from '../../interfaces';

describe('MessageRepair', () => {
  describe('repairToolMessages', () => {
    it('passes clean history through unchanged', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'search_hybrid', arguments: { query: 'test' } }],
        },
        { role: 'tool', content: 'Results: ...', toolCallId: 'tc1', toolName: 'search_hybrid' },
        { role: 'assistant', content: 'Here are the results.' },
      ];

      const result = repairToolMessages(messages);
      expect(result.length).toBe(messages.length);
    });

    it('injects synthetic result for orphaned tool call', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Search for something' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc1', name: 'search_hybrid' },
            { id: 'tc2', name: 'vault_read_note' },
          ],
        },
        // Only tc1 has a result, tc2 is orphaned
        { role: 'tool', content: 'Search results', toolCallId: 'tc1', toolName: 'search_hybrid' },
      ];

      const result = repairToolMessages(messages);

      // Should inject synthetic result for tc2
      const syntheticResults = result.filter(
        (m) => m.role === 'tool' && m.toolCallId === 'tc2'
      );
      expect(syntheticResults.length).toBe(1);
      expect(syntheticResults[0].content).toContain('unavailable');
    });

    it('wraps orphan tool result in synthetic assistant message', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        // Tool result with no preceding assistant tool_call
        { role: 'tool', content: 'Some result', toolCallId: 'orphan1', toolName: 'Bash' },
      ];

      const result = repairToolMessages(messages);

      // Should have a synthetic assistant before the tool result
      const assistantIndex = result.findIndex(
        (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'orphan1')
      );
      expect(assistantIndex).toBeGreaterThanOrEqual(0);

      const toolIndex = result.findIndex(
        (m) => m.role === 'tool' && m.toolCallId === 'orphan1'
      );
      expect(toolIndex).toBeGreaterThan(assistantIndex);
    });

    it('handles multiple orphans in one history', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Do stuff' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc1', name: 'search_hybrid' },
            { id: 'tc2', name: 'vault_read_note' },
            { id: 'tc3', name: 'Glob' },
          ],
        },
        // Only tc1 has a result
        { role: 'tool', content: 'Result 1', toolCallId: 'tc1', toolName: 'search_hybrid' },
      ];

      const result = repairToolMessages(messages);

      // Should inject synthetic results for tc2 and tc3
      const toolResults = result.filter((m) => m.role === 'tool');
      expect(toolResults.length).toBe(3); // 1 real + 2 synthetic
    });

    it('does not mutate original array', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'search_hybrid' }],
        },
        // Missing tool result
      ];

      const originalLength = messages.length;
      repairToolMessages(messages);
      expect(messages.length).toBe(originalLength);
    });

    it('handles empty history', () => {
      const result = repairToolMessages([]);
      expect(result).toEqual([]);
    });
  });
});
