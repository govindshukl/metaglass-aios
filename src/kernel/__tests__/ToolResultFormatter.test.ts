import { describe, it, expect } from 'vitest';
import { formatToolResult, truncateToolResult } from '../ToolResultFormatter';
import type { ToolResult } from '../../interfaces/types';

// =============================================================================
// TESTS
// =============================================================================

describe('formatToolResult', () => {
  // ---------------------------------------------------------------------------
  // User Answers (Priority 0)
  // ---------------------------------------------------------------------------

  it('should use observation for agent_ask_user results', () => {
    const result: ToolResult = {
      success: true,
      observation: 'User answered: Yes, proceed with the plan.',
      data: { answers: { q1: 'Yes' } },
    };
    expect(formatToolResult(result)).toBe('User answered: Yes, proceed with the plan.');
  });

  // ---------------------------------------------------------------------------
  // Structured Results (Priority 1)
  // ---------------------------------------------------------------------------

  it('should format structured result with type and summary', () => {
    const result: ToolResult = {
      success: true,
      structured: {
        type: 'search',
        summary: 'Found 5 matching notes',
        fields: { query: 'test' },
      },
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('[SEARCH]');
    expect(formatted).toContain('Found 5 matching notes');
    expect(formatted).toContain('query: test');
  });

  it('should format structured result with object arrays', () => {
    const result: ToolResult = {
      success: true,
      structured: {
        type: 'search',
        summary: 'Found results',
        fields: {
          results: [
            { id: 'note-1', title: 'First Note', score: 0.95 },
            { id: 'note-2', title: 'Second Note', score: 0.87 },
          ],
        },
      },
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('[id: "note-1"]');
    expect(formatted).toContain('First Note');
    expect(formatted).toContain('(score: 0.95)');
  });

  it('should format structured result with actions', () => {
    const result: ToolResult = {
      success: true,
      structured: {
        type: 'search',
        summary: 'Found notes',
        fields: {},
        actions: [
          { tool: 'vault_read_note', reason: 'Read the top result' },
        ],
      },
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('Suggested next steps');
    expect(formatted).toContain('vault_read_note');
  });

  it('should format structured result with metadata', () => {
    const result: ToolResult = {
      success: true,
      structured: {
        type: 'data',
        summary: 'Query completed',
        fields: {},
        metadata: { durationMs: 150, itemCount: 3, truncated: true },
      },
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('150ms');
    expect(formatted).toContain('3 items');
    expect(formatted).toContain('truncated');
  });

  // ---------------------------------------------------------------------------
  // Observation (Priority 2)
  // ---------------------------------------------------------------------------

  it('should use observation string when no structured result', () => {
    const result: ToolResult = {
      success: true,
      observation: 'File created successfully at /path/to/file.md',
    };
    expect(formatToolResult(result)).toBe('File created successfully at /path/to/file.md');
  });

  // ---------------------------------------------------------------------------
  // Data (Priority 3)
  // ---------------------------------------------------------------------------

  it('should JSON.stringify object data', () => {
    const result: ToolResult = {
      success: true,
      data: { key: 'value', count: 42 },
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('"key": "value"');
    expect(formatted).toContain('"count": 42');
  });

  it('should return string data directly', () => {
    const result: ToolResult = {
      success: true,
      data: 'Simple string result',
    };
    expect(formatToolResult(result)).toBe('Simple string result');
  });

  // ---------------------------------------------------------------------------
  // Error (Priority 4)
  // ---------------------------------------------------------------------------

  it('should format error results', () => {
    const result: ToolResult = {
      success: false,
      error: 'File not found: /path/to/missing.md',
    };
    expect(formatToolResult(result)).toBe('Error: File not found: /path/to/missing.md');
  });

  // ---------------------------------------------------------------------------
  // Success + No Data (Priority 5)
  // ---------------------------------------------------------------------------

  it('should return "Done." for success with no data', () => {
    const result: ToolResult = { success: true };
    expect(formatToolResult(result)).toBe('Done.');
  });

  // ---------------------------------------------------------------------------
  // Fallback (Priority 6)
  // ---------------------------------------------------------------------------

  it('should return "No result" as fallback', () => {
    const result: ToolResult = { success: false };
    expect(formatToolResult(result)).toBe('No result');
  });
});

// =============================================================================
// TRUNCATION
// =============================================================================

describe('truncateToolResult', () => {
  it('should not truncate content within limit', () => {
    const content = 'short content';
    expect(truncateToolResult(content, 100)).toBe(content);
  });

  it('should truncate with head/tail strategy', () => {
    const content = 'x'.repeat(10_000);
    const truncated = truncateToolResult(content, 1_000);

    expect(truncated.length).toBeLessThan(10_000);
    expect(truncated).toContain('chars omitted');
    expect(truncated).toContain('10000 total');
  });

  it('should preserve head (70%) and tail', () => {
    const content = 'H'.repeat(5000) + 'M'.repeat(90000) + 'T'.repeat(5000);
    const truncated = truncateToolResult(content, 10_000);

    // Head should start with H's
    expect(truncated.startsWith('H')).toBe(true);
    // Tail should end with T's
    expect(truncated.endsWith('T')).toBe(true);
  });
});
