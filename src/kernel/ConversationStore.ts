/**
 * ConversationStore - Persistence for conversation state
 *
 * Provides checkpoint/resume functionality for AIOS conversations.
 * Stores conversation snapshots including:
 * - Message history
 * - Todo list state
 * - Conversation metadata
 *
 * Storage backends:
 * - In-memory (default, for short-term/session storage)
 * - LocalStorage (for browser persistence)
 * - File-based (future, via Tauri commands)
 */

import type { Message, Todo, ConversationStatus } from '../interfaces';
import { createLogger } from '../logger';

const log = createLogger('ConversationStore');

// =============================================================================
// TYPES
// =============================================================================

/**
 * Snapshot of a conversation at a point in time
 */
export interface ConversationSnapshot {
  /** Unique conversation identifier */
  id: string;
  /** Message history */
  history: Message[];
  /** Current todo list */
  todos: Todo[];
  /** Conversation status */
  status: ConversationStatus;
  /** Original user goal */
  originalGoal: string;
  /** Current turn number */
  turn: number;
  /** Whether in planning mode */
  isPlanning: boolean;
  /** Unix timestamp when created */
  createdAt: number;
  /** Unix timestamp when last updated */
  updatedAt: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Conversation summary for listing
 */
export interface ConversationSummary {
  id: string;
  originalGoal: string;
  status: ConversationStatus;
  turn: number;
  createdAt: number;
  updatedAt: number;
  /** First few words of the goal for preview */
  preview: string;
}

/**
 * Storage backend interface
 */
export interface StorageBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
}

/**
 * Configuration for ConversationStore
 */
export interface ConversationStoreConfig {
  /** Storage backend to use */
  backend?: StorageBackend;
  /** Maximum snapshots to retain (default: 50) */
  maxSnapshots?: number;
  /** Auto-save interval in ms (0 to disable, default: 30000) */
  autoSaveIntervalMs?: number;
  /** Key prefix for storage (default: 'aios:conversation:') */
  keyPrefix?: string;
}

// =============================================================================
// STORAGE BACKENDS
// =============================================================================

/**
 * In-memory storage backend
 */
export class MemoryStorageBackend implements StorageBackend {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * Get localStorage if available
 */
function getLocalStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

/**
 * LocalStorage backend (browser persistence)
 */
export class LocalStorageBackend implements StorageBackend {
  async get(key: string): Promise<string | null> {
    try {
      const storage = getLocalStorage();
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const storage = getLocalStorage();
      storage?.setItem(key, value);
    } catch (error) {
      log.warn('LocalStorage write failed', { key, error });
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const storage = getLocalStorage();
      if (!storage) return false;
      const existed = storage.getItem(key) !== null;
      storage.removeItem(key);
      return existed;
    } catch {
      return false;
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    try {
      const storage = getLocalStorage();
      if (!storage) return [];
      const allKeys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key) allKeys.push(key);
      }
      if (!prefix) return allKeys;
      return allKeys.filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }

  async clear(prefix?: string): Promise<void> {
    try {
      const storage = getLocalStorage();
      if (!storage) return;
      if (!prefix) {
        storage.clear();
        return;
      }
      const keysToDelete = await this.keys(prefix);
      for (const key of keysToDelete) {
        storage.removeItem(key);
      }
    } catch {
      // Ignore errors
    }
  }
}

// =============================================================================
// CONVERSATION STORE
// =============================================================================

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<ConversationStoreConfig> = {
  backend: new MemoryStorageBackend(),
  maxSnapshots: 50,
  autoSaveIntervalMs: 30000,
  keyPrefix: 'aios:conversation:',
};

/**
 * ConversationStore class
 *
 * Manages conversation persistence with checkpoint/resume support.
 */
export class ConversationStore {
  private config: Required<ConversationStoreConfig>;
  private backend: StorageBackend;
  private indexKey: string;

  constructor(config?: ConversationStoreConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.backend = this.config.backend;
    this.indexKey = `${this.config.keyPrefix}index`;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Save a conversation snapshot
   */
  async save(snapshot: ConversationSnapshot): Promise<void> {
    const key = this.getSnapshotKey(snapshot.id);

    // Update timestamp
    snapshot.updatedAt = Date.now();

    // Serialize and save
    const serialized = JSON.stringify(snapshot);
    await this.backend.set(key, serialized);

    // Update index
    await this.updateIndex(snapshot.id, 'add');

    // Cleanup old snapshots if needed
    await this.enforceMaxSnapshots();

    log.debug('Saved conversation snapshot', { id: snapshot.id, turn: snapshot.turn });
  }

  /**
   * Load a conversation snapshot by ID
   */
  async load(conversationId: string): Promise<ConversationSnapshot | null> {
    const key = this.getSnapshotKey(conversationId);
    const serialized = await this.backend.get(key);

    if (!serialized) {
      log.debug('Conversation not found', { id: conversationId });
      return null;
    }

    try {
      const snapshot = JSON.parse(serialized) as ConversationSnapshot;
      log.debug('Loaded conversation snapshot', { id: conversationId, turn: snapshot.turn });
      return snapshot;
    } catch (error) {
      log.error('Failed to parse conversation snapshot', { id: conversationId, error });
      return null;
    }
  }

  /**
   * Delete a conversation snapshot
   */
  async delete(conversationId: string): Promise<boolean> {
    const key = this.getSnapshotKey(conversationId);
    const deleted = await this.backend.delete(key);

    if (deleted) {
      await this.updateIndex(conversationId, 'remove');
      log.debug('Deleted conversation', { id: conversationId });
    }

    return deleted;
  }

  /**
   * List all conversation summaries
   */
  async list(): Promise<ConversationSummary[]> {
    const index = await this.getIndex();
    const summaries: ConversationSummary[] = [];

    for (const id of index) {
      const snapshot = await this.load(id);
      if (snapshot) {
        summaries.push({
          id: snapshot.id,
          originalGoal: snapshot.originalGoal,
          status: snapshot.status,
          turn: snapshot.turn,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          preview: this.createPreview(snapshot.originalGoal),
        });
      }
    }

    // Sort by most recently updated
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);

    return summaries;
  }

  /**
   * Check if a conversation exists
   */
  async exists(conversationId: string): Promise<boolean> {
    const key = this.getSnapshotKey(conversationId);
    const serialized = await this.backend.get(key);
    return serialized !== null;
  }

  /**
   * Get the most recent conversation
   */
  async getLatest(): Promise<ConversationSnapshot | null> {
    const summaries = await this.list();
    if (summaries.length === 0) return null;
    return this.load(summaries[0].id);
  }

  /**
   * Clear all stored conversations
   */
  async clear(): Promise<void> {
    await this.backend.clear(this.config.keyPrefix);
    log.info('Cleared all conversations');
  }

  /**
   * Create a new snapshot from conversation state
   */
  createSnapshot(
    id: string,
    history: Message[],
    todos: Todo[],
    status: ConversationStatus,
    originalGoal: string,
    turn: number,
    isPlanning: boolean,
    metadata?: Record<string, unknown>
  ): ConversationSnapshot {
    const now = Date.now();
    return {
      id,
      history,
      todos,
      status,
      originalGoal,
      turn,
      isPlanning,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    count: number;
    oldestCreated: number | null;
    newestUpdated: number | null;
  }> {
    const summaries = await this.list();
    if (summaries.length === 0) {
      return { count: 0, oldestCreated: null, newestUpdated: null };
    }

    const oldestCreated = Math.min(...summaries.map((s) => s.createdAt));
    const newestUpdated = Math.max(...summaries.map((s) => s.updatedAt));

    return {
      count: summaries.length,
      oldestCreated,
      newestUpdated,
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Get the storage key for a conversation snapshot
   */
  private getSnapshotKey(conversationId: string): string {
    return `${this.config.keyPrefix}${conversationId}`;
  }

  /**
   * Get the conversation index
   */
  private async getIndex(): Promise<string[]> {
    const serialized = await this.backend.get(this.indexKey);
    if (!serialized) return [];

    try {
      return JSON.parse(serialized) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Update the conversation index
   */
  private async updateIndex(conversationId: string, action: 'add' | 'remove'): Promise<void> {
    let index = await this.getIndex();

    if (action === 'add') {
      // Add to front (most recent)
      index = [conversationId, ...index.filter((id) => id !== conversationId)];
    } else {
      // Remove
      index = index.filter((id) => id !== conversationId);
    }

    await this.backend.set(this.indexKey, JSON.stringify(index));
  }

  /**
   * Enforce maximum snapshot limit
   */
  private async enforceMaxSnapshots(): Promise<void> {
    const index = await this.getIndex();

    if (index.length <= this.config.maxSnapshots) return;

    // Remove oldest entries
    const toRemove = index.slice(this.config.maxSnapshots);
    for (const id of toRemove) {
      await this.delete(id);
    }

    log.debug('Cleaned up old snapshots', { removed: toRemove.length });
  }

  /**
   * Create a preview string from the goal
   */
  private createPreview(goal: string, maxLength = 50): string {
    if (goal.length <= maxLength) return goal;
    return goal.slice(0, maxLength - 3) + '...';
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ConversationStoreConfig>): void {
    if (config.backend) {
      this.backend = config.backend;
    }
    this.config = { ...this.config, ...config };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

/**
 * Default conversation store instance
 *
 * Uses localStorage in browser, memory in tests
 */
export const conversationStore = new ConversationStore({
  backend:
    typeof window !== 'undefined' && window.localStorage
      ? new LocalStorageBackend()
      : new MemoryStorageBackend(),
});
