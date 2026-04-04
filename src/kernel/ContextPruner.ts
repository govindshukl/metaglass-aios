/**
 * ContextPruner — In-Memory Cache-TTL Pruning of Old Tool Results
 *
 * Proactively trims old, large tool results between LLM calls to reduce
 * context pressure before compaction is needed.
 *
 * Algorithm:
 * 1. Walk messages oldest-first, skip protected region (last N assistant turns)
 * 2. For tool result messages with content.length > minPrunableChars:
 *    - If age > TTL: soft-trim to softTrimRatio (head + tail)
 *    - If age > 2× TTL and hardClear: replace with placeholder
 * 3. Messages are mutated in-place (no new array allocation)
 *
 * Adapted from OpenClaw's context-pruning.ts with cache-TTL mode.
 *
 * Phase 3, Step 5 of Agentic Harness Implementation.
 */

import type { Message } from '../interfaces/types';

// =============================================================================
// TYPES
// =============================================================================

export interface ContextPrunerConfig {
  /** Pruning mode (default: 'cache-ttl') */
  mode: 'off' | 'cache-ttl';
  /** TTL for tool results in ms (default: 300_000 = 5 min) */
  ttlMs: number;
  /** Always protect last N assistant messages (default: 3) */
  keepLastAssistants: number;
  /** Minimum chars for a result to be prunable (default: 50_000) */
  minPrunableChars: number;
  /** Soft trim: keep this ratio of original content (default: 0.3) */
  softTrimRatio: number;
  /** Head chars to keep during soft trim (default: 1500) */
  softTrimHeadChars: number;
  /** Tail chars to keep during soft trim (default: 1500) */
  softTrimTailChars: number;
  /** Hard clear: replace with placeholder after 2× TTL (default: true) */
  hardClearEnabled: boolean;
  /** Placeholder text for hard-cleared results */
  hardClearPlaceholder: string;
}

export const DEFAULT_PRUNER_CONFIG: ContextPrunerConfig = {
  mode: 'cache-ttl',
  ttlMs: 300_000,          // 5 minutes
  keepLastAssistants: 3,
  minPrunableChars: 50_000,
  softTrimRatio: 0.3,
  softTrimHeadChars: 1_500,
  softTrimTailChars: 1_500,
  hardClearEnabled: true,
  hardClearPlaceholder: '[Old tool result content cleared]',
};

export interface PruneResult {
  /** Number of messages pruned (soft-trim or hard-clear) */
  prunedCount: number;
  /** Total characters saved */
  charsSaved: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class ContextPruner {
  private config: ContextPrunerConfig;

  /** Timestamp when each message was first seen, keyed by content hash */
  private messageTimestamps: Map<string, number> = new Map();

  constructor(config?: Partial<ContextPrunerConfig>) {
    this.config = { ...DEFAULT_PRUNER_CONFIG, ...config };
  }

  /**
   * Record the current time for messages that haven't been seen before.
   * Call this after adding messages to track their age.
   */
  trackMessages(messages: Message[]): void {
    const now = Date.now();
    for (const msg of messages) {
      const key = this.messageKey(msg);
      if (!this.messageTimestamps.has(key)) {
        this.messageTimestamps.set(key, now);
      }
    }
  }

  /**
   * Prune old, large tool results in-place.
   * Returns the number of messages pruned and characters saved.
   */
  prune(messages: Message[], now?: number): PruneResult {
    if (this.config.mode === 'off') {
      return { prunedCount: 0, charsSaved: 0 };
    }

    const currentTime = now ?? Date.now();
    let prunedCount = 0;
    let charsSaved = 0;

    // Find protected region: last N assistant messages and their tool results
    const protectedIndices = this.findProtectedIndices(messages);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip protected messages
      if (protectedIndices.has(i)) continue;

      // Only prune tool result messages that are large enough
      if (msg.role !== 'tool') continue;
      if (msg.content.length < this.config.minPrunableChars) continue;

      // Check age
      const key = this.messageKey(msg);
      const timestamp = this.messageTimestamps.get(key);
      if (!timestamp) continue;

      const age = currentTime - timestamp;

      // Hard clear: age > 2× TTL
      if (this.config.hardClearEnabled && age > this.config.ttlMs * 2) {
        const originalLength = msg.content.length;
        msg.content = this.config.hardClearPlaceholder;
        charsSaved += originalLength - msg.content.length;
        prunedCount++;
        continue;
      }

      // Soft trim: age > TTL
      if (age > this.config.ttlMs) {
        const originalLength = msg.content.length;
        msg.content = this.softTrim(msg.content, age);
        charsSaved += originalLength - msg.content.length;
        prunedCount++;
      }
    }

    return { prunedCount, charsSaved };
  }

  /**
   * Clear all tracking state.
   */
  reset(): void {
    this.messageTimestamps.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Find indices of protected messages (last N assistant turns and their tool results).
   */
  private findProtectedIndices(messages: Message[]): Set<number> {
    const indices = new Set<number>();
    let assistantCount = 0;

    // Walk backward to find last N assistant messages
    for (let i = messages.length - 1; i >= 0 && assistantCount < this.config.keepLastAssistants; i--) {
      if (messages[i].role === 'assistant') {
        indices.add(i);
        assistantCount++;
        // Also protect the tool results that follow this assistant message
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].role === 'tool') {
            indices.add(j);
          } else {
            break;
          }
        }
      }
    }

    // Always protect system and initial user messages
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') {
        indices.add(i);
      } else if (messages[i].role === 'user' && i <= 1) {
        indices.add(i);
      }
    }

    return indices;
  }

  /**
   * Soft-trim content: keep head + tail, replace middle with marker.
   */
  private softTrim(content: string, ageMs: number): string {
    const headChars = this.config.softTrimHeadChars;
    const tailChars = this.config.softTrimTailChars;

    if (content.length <= headChars + tailChars) {
      return content; // Already small enough
    }

    const head = content.slice(0, headChars);
    const tail = content.slice(-tailChars);
    const ageSeconds = Math.round(ageMs / 1000);

    return `${head}\n\n[... pruned: ${content.length} chars total, aged ${ageSeconds}s ...]\n\n${tail}`;
  }

  /**
   * Create a stable key for a message based on role + toolCallId + content prefix.
   */
  private messageKey(msg: Message): string {
    // Use toolCallId if available (unique per tool result)
    if (msg.toolCallId) {
      return `tool:${msg.toolCallId}`;
    }
    // Fallback to role + content prefix
    return `${msg.role}:${msg.content.slice(0, 100)}`;
  }
}
