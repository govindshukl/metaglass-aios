/**
 * MessageRepair — Fix Orphaned Tool Messages
 *
 * Ensures message history is valid before LLM calls:
 * 1. Assistant messages with tool_calls must have corresponding tool results
 * 2. Tool result messages must have a preceding assistant with matching tool_call
 *
 * Inspired by Hermes agent's _fix_orphaned_tool_messages() pattern.
 */

import { createLogger } from '../logger';
import type { Message } from '../interfaces';

const log = createLogger('MessageRepair');

/**
 * Repair orphaned tool messages in conversation history.
 * Call before every LLM completion to ensure valid message format.
 *
 * Fixes:
 * 1. Assistant messages with tool_calls but missing tool results →
 *    Inject synthetic result: "[Tool result unavailable]"
 * 2. Tool result messages with no preceding assistant tool_call →
 *    Wrap in synthetic assistant message with tool_calls stub
 *
 * @returns Repaired message array (new array, original not mutated)
 */
export function repairToolMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let repairCount = 0;

  // Collect all tool result IDs for quick lookup
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      toolResultIds.add(msg.toolCallId);
    }
  }

  // Collect all tool call IDs from assistant messages
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallIds.add(tc.id);
      }
    }
  }

  for (const msg of messages) {
    // Fix 1: Assistant with tool_calls missing results
    if (msg.role === 'assistant' && msg.toolCalls) {
      result.push(msg);

      for (const tc of msg.toolCalls) {
        if (!toolResultIds.has(tc.id)) {
          // Inject synthetic tool result
          result.push({
            role: 'tool',
            content: '[Tool result unavailable — execution was interrupted]',
            toolCallId: tc.id,
            toolName: tc.name,
          });
          repairCount++;
          log.warn('Injected synthetic tool result for orphaned call', {
            toolCallId: tc.id,
            toolName: tc.name,
          });
        }
      }
      continue;
    }

    // Fix 2: Tool result with no matching assistant tool_call
    if (msg.role === 'tool' && msg.toolCallId && !toolCallIds.has(msg.toolCallId)) {
      // Wrap in synthetic assistant message
      result.push({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: msg.toolCallId,
          name: msg.toolName ?? 'unknown_tool',
        }],
      });
      result.push(msg);
      repairCount++;
      log.warn('Wrapped orphan tool result in synthetic assistant message', {
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
      });
      continue;
    }

    result.push(msg);
  }

  if (repairCount > 0) {
    log.info('Repaired tool message history', { repairs: repairCount });
  }

  return result;
}
