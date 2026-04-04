/**
 * ToolResultFormatter — Unified Tool Result Formatting
 *
 * Single formatting pipeline for tool results used by both:
 * - ConversationEngine (kernel)
 * - SkillToolProvider (application layer)
 *
 * Extracted from ConversationEngine.formatToolResult() for reuse.
 * Priority cascade:
 * 0. User answers (agent_ask_user) → observation string
 * 1. Structured result → formatted sections with fields, actions, metadata
 * 2. Observation string → use directly
 * 3. Success + data → JSON.stringify
 * 4. Error → error string
 * 5. Success + no data → "Done."
 * 6. Fallback → "No result"
 *
 * Phase 3, Step 8 of Agentic Harness Implementation.
 */

import type { ToolResult, StructuredToolResult, ToolFollowUpAction } from '../interfaces/types';

// =============================================================================
// MAIN FORMATTER
// =============================================================================

/**
 * Format a tool result into a string suitable for LLM consumption.
 * Handles structured results, observations, raw data, and errors.
 */
export function formatToolResult(result: ToolResult): string {
  // 0. For agent_ask_user results, always prefer the observation string which
  //    contains the actual user answers.
  if (result.observation && result.observation.startsWith('User answered:')) {
    return result.observation;
  }

  // 1. Use structured result if available (provides consistent format for LLM)
  if (result.structured) {
    return formatStructuredResult(result.structured);
  }

  // 2. Fall back to observation string
  if (result.observation) {
    return result.observation;
  }

  // 3. Success with data → JSON
  if (result.success && result.data !== undefined && result.data !== null) {
    if (typeof result.data === 'string') return result.data;
    return JSON.stringify(result.data, null, 2);
  }

  // 4. Error
  if (result.error) {
    return `Error: ${result.error}`;
  }

  // 5. Success with no data
  if (result.success) {
    return 'Done.';
  }

  // 6. Fallback
  return 'No result';
}

/**
 * Truncate a formatted tool result if it exceeds maxChars.
 * Uses 70/30 head/tail strategy to preserve beginning and end context.
 */
export function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.min(4000, maxChars - headSize);
  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);
  const omitted = content.length - headSize - tailSize;

  return `${head}\n\n[... ${omitted} chars omitted (${content.length} total) ...]\n\n${tail}`;
}

// =============================================================================
// STRUCTURED RESULT FORMATTING
// =============================================================================

function formatStructuredResult(s: StructuredToolResult): string {
  const parts: string[] = [];

  // Header with type and summary
  parts.push(`[${s.type.toUpperCase()}] ${s.summary}`);

  // Key fields
  if (s.fields) {
    const scalarFields: Array<[string, unknown]> = [];
    const objectArrayFields: Array<[string, unknown[]]> = [];

    for (const [key, value] of Object.entries(s.fields)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        objectArrayFields.push([key, value as unknown[]]);
      } else if (Array.isArray(value) && value.length > 10) {
        objectArrayFields.push([key, value as unknown[]]);
      } else {
        scalarFields.push([key, value]);
      }
    }

    // Render scalar fields inline
    const fieldEntries = scalarFields
      .filter(([_key, value]) => {
        if (typeof value === 'object' && value !== null) {
          const str = JSON.stringify(value);
          if (str.length > 200) return false;
        }
        return true;
      })
      .map(([key, value]) => `  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);

    if (fieldEntries.length > 0) {
      parts.push('Fields:');
      parts.push(...fieldEntries);
    }

    // Render object arrays with structured formatting
    for (const [key, arr] of objectArrayFields) {
      parts.push(`\n${key} (${arr.length} items):`);
      arr.slice(0, 10).forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const idPart = obj.id ? `[id: "${obj.id}"] ` : '';
          const label = obj.title || obj.name || (!obj.id ? JSON.stringify(item).slice(0, 80) : '');
          const scorePart = obj.score !== undefined ? ` (score: ${Number(obj.score).toFixed(2)})` : '';
          const simPart = obj.similarity !== undefined ? ` (sim: ${Number(obj.similarity).toFixed(2)})` : '';
          parts.push(`  ${i + 1}. ${idPart}${label}${scorePart}${simPart}`);
        } else {
          parts.push(`  ${i + 1}. ${item}`);
        }
      });
      if (arr.length > 10) {
        parts.push(`  ... and ${arr.length - 10} more`);
      }
    }
  }

  // Suggested follow-up actions
  if (s.actions && s.actions.length > 0) {
    formatActions(parts, s.actions);
  }

  // Metadata (timing, counts)
  if (s.metadata) {
    formatMetadata(parts, s.metadata);
  }

  return parts.join('\n');
}

function formatActions(parts: string[], actions: ToolFollowUpAction[]): void {
  parts.push('\nSuggested next steps:');
  for (const action of actions) {
    parts.push(`  - ${action.tool}: ${action.reason}`);
  }
}

function formatMetadata(parts: string[], metadata: NonNullable<StructuredToolResult['metadata']>): void {
  const metaParts: string[] = [];
  if (metadata.durationMs) metaParts.push(`${metadata.durationMs}ms`);
  if (metadata.itemCount !== undefined) metaParts.push(`${metadata.itemCount} items`);
  if (metadata.truncated) metaParts.push('truncated');
  if (metaParts.length > 0) {
    parts.push(`\n(${metaParts.join(', ')})`);
  }
}
