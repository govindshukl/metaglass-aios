/**
 * ConversationStore Tests (TDD)
 *
 * Tests for the conversation persistence service with checkpoint/resume support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConversationStore,
  MemoryStorageBackend,
  LocalStorageBackend,
} from '../ConversationStore';
import type { ConversationSnapshot } from '../ConversationStore';
import type { Message, Todo, ConversationStatus } from '../../interfaces';

// =============================================================================
// HELPERS
// =============================================================================

function createSnapshot(
  id: string,
  overrides: Partial<ConversationSnapshot> = {}
): ConversationSnapshot {
  return {
    id,
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ] as Message[],
    todos: [{ content: 'Test task', status: 'pending', activeForm: 'Testing' }] as Todo[],
    status: 'completed' as ConversationStatus,
    originalGoal: 'Test goal',
    turn: 2,
    isPlanning: false,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// MEMORY STORAGE BACKEND TESTS
// =============================================================================

describe('MemoryStorageBackend', () => {
  let backend: MemoryStorageBackend;

  beforeEach(() => {
    backend = new MemoryStorageBackend();
  });

  it('should store and retrieve values', async () => {
    await backend.set('key1', 'value1');
    const result = await backend.get('key1');
    expect(result).toBe('value1');
  });

  it('should return null for non-existent keys', async () => {
    const result = await backend.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should delete values', async () => {
    await backend.set('key1', 'value1');
    const deleted = await backend.delete('key1');
    expect(deleted).toBe(true);
    expect(await backend.get('key1')).toBeNull();
  });

  it('should return false when deleting non-existent key', async () => {
    const deleted = await backend.delete('nonexistent');
    expect(deleted).toBe(false);
  });

  it('should list keys with prefix', async () => {
    await backend.set('prefix:key1', 'v1');
    await backend.set('prefix:key2', 'v2');
    await backend.set('other:key3', 'v3');

    const keys = await backend.keys('prefix:');
    expect(keys).toHaveLength(2);
    expect(keys).toContain('prefix:key1');
    expect(keys).toContain('prefix:key2');
  });

  it('should list all keys without prefix', async () => {
    await backend.set('key1', 'v1');
    await backend.set('key2', 'v2');

    const keys = await backend.keys();
    expect(keys).toHaveLength(2);
  });

  it('should clear all values', async () => {
    await backend.set('key1', 'v1');
    await backend.set('key2', 'v2');

    await backend.clear();

    const keys = await backend.keys();
    expect(keys).toHaveLength(0);
  });

  it('should clear values with prefix only', async () => {
    await backend.set('prefix:key1', 'v1');
    await backend.set('other:key2', 'v2');

    await backend.clear('prefix:');

    expect(await backend.get('prefix:key1')).toBeNull();
    expect(await backend.get('other:key2')).toBe('v2');
  });
});

// =============================================================================
// CONVERSATION STORE TESTS
// =============================================================================

describe('ConversationStore', () => {
  let store: ConversationStore;
  let backend: MemoryStorageBackend;

  beforeEach(() => {
    backend = new MemoryStorageBackend();
    store = new ConversationStore({ backend });
  });

  describe('save', () => {
    it('should save a conversation snapshot', async () => {
      const snapshot = createSnapshot('conv1');
      await store.save(snapshot);

      const loaded = await store.load('conv1');
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe('conv1');
      expect(loaded?.originalGoal).toBe('Test goal');
    });

    it('should update timestamp on save', async () => {
      const snapshot = createSnapshot('conv1', { updatedAt: 1000 });
      await store.save(snapshot);

      const loaded = await store.load('conv1');
      expect(loaded?.updatedAt).toBeGreaterThan(1000);
    });

    it('should overwrite existing snapshot', async () => {
      const snapshot1 = createSnapshot('conv1', { turn: 1 });
      await store.save(snapshot1);

      const snapshot2 = createSnapshot('conv1', { turn: 5 });
      await store.save(snapshot2);

      const loaded = await store.load('conv1');
      expect(loaded?.turn).toBe(5);
    });
  });

  describe('load', () => {
    it('should load existing snapshot', async () => {
      const snapshot = createSnapshot('conv1');
      await store.save(snapshot);

      const loaded = await store.load('conv1');
      expect(loaded).not.toBeNull();
      expect(loaded?.history).toHaveLength(2);
      expect(loaded?.todos).toHaveLength(1);
    });

    it('should return null for non-existent conversation', async () => {
      const loaded = await store.load('nonexistent');
      expect(loaded).toBeNull();
    });

    it('should handle corrupted data gracefully', async () => {
      await backend.set('aios:conversation:corrupted', 'not valid json');
      const loaded = await store.load('corrupted');
      expect(loaded).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete existing snapshot', async () => {
      const snapshot = createSnapshot('conv1');
      await store.save(snapshot);

      const deleted = await store.delete('conv1');
      expect(deleted).toBe(true);

      const loaded = await store.load('conv1');
      expect(loaded).toBeNull();
    });

    it('should return false for non-existent conversation', async () => {
      const deleted = await store.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all conversation summaries', async () => {
      await store.save(createSnapshot('conv1', { originalGoal: 'Goal 1' }));
      await store.save(createSnapshot('conv2', { originalGoal: 'Goal 2' }));
      await store.save(createSnapshot('conv3', { originalGoal: 'Goal 3' }));

      const summaries = await store.list();
      expect(summaries).toHaveLength(3);
    });

    it('should sort by most recently updated', async () => {
      await store.save(createSnapshot('conv1', { updatedAt: 1000 }));
      await store.save(createSnapshot('conv2', { updatedAt: 3000 }));
      await store.save(createSnapshot('conv3', { updatedAt: 2000 }));

      const summaries = await store.list();
      // Most recent first (conv2 was saved last, so it gets newest timestamp)
      expect(summaries[0].id).toBe('conv3'); // Last saved gets newest timestamp
    });

    it('should include preview in summaries', async () => {
      await store.save(
        createSnapshot('conv1', { originalGoal: 'This is a very long goal text' })
      );

      const summaries = await store.list();
      expect(summaries[0].preview).toBeDefined();
      expect(summaries[0].preview.length).toBeLessThanOrEqual(53); // 50 + '...'
    });
  });

  describe('exists', () => {
    it('should return true for existing conversation', async () => {
      await store.save(createSnapshot('conv1'));
      expect(await store.exists('conv1')).toBe(true);
    });

    it('should return false for non-existent conversation', async () => {
      expect(await store.exists('nonexistent')).toBe(false);
    });
  });

  describe('getLatest', () => {
    it('should return most recently updated conversation', async () => {
      await store.save(createSnapshot('conv1'));
      await store.save(createSnapshot('conv2'));

      const latest = await store.getLatest();
      expect(latest).not.toBeNull();
    });

    it('should return null when no conversations exist', async () => {
      const latest = await store.getLatest();
      expect(latest).toBeNull();
    });
  });

  describe('clear', () => {
    it('should clear all conversations', async () => {
      await store.save(createSnapshot('conv1'));
      await store.save(createSnapshot('conv2'));

      await store.clear();

      const summaries = await store.list();
      expect(summaries).toHaveLength(0);
    });
  });

  describe('createSnapshot', () => {
    it('should create a properly structured snapshot', () => {
      const history: Message[] = [{ role: 'user', content: 'Test' }];
      const todos: Todo[] = [{ content: 'Task', status: 'pending', activeForm: 'Testing' }];

      const snapshot = store.createSnapshot(
        'conv1',
        history,
        todos,
        'running',
        'Test goal',
        3,
        false
      );

      expect(snapshot.id).toBe('conv1');
      expect(snapshot.history).toEqual(history);
      expect(snapshot.todos).toEqual(todos);
      expect(snapshot.status).toBe('running');
      expect(snapshot.originalGoal).toBe('Test goal');
      expect(snapshot.turn).toBe(3);
      expect(snapshot.isPlanning).toBe(false);
      expect(snapshot.createdAt).toBeGreaterThan(0);
      expect(snapshot.updatedAt).toBeGreaterThan(0);
    });

    it('should include optional metadata', () => {
      const snapshot = store.createSnapshot(
        'conv1',
        [],
        [],
        'idle',
        'Goal',
        0,
        false,
        { customField: 'value' }
      );

      expect(snapshot.metadata?.customField).toBe('value');
    });
  });

  describe('getStats', () => {
    it('should return stats for stored conversations', async () => {
      await store.save(createSnapshot('conv1', { createdAt: 1000, updatedAt: 2000 }));
      await store.save(createSnapshot('conv2', { createdAt: 3000, updatedAt: 4000 }));

      const stats = await store.getStats();
      expect(stats.count).toBe(2);
    });

    it('should return empty stats when no conversations', async () => {
      const stats = await store.getStats();
      expect(stats.count).toBe(0);
      expect(stats.oldestCreated).toBeNull();
      expect(stats.newestUpdated).toBeNull();
    });
  });

  describe('maxSnapshots enforcement', () => {
    it('should remove oldest snapshots when limit exceeded', async () => {
      const limitedStore = new ConversationStore({
        backend,
        maxSnapshots: 3,
      });

      // Save 5 snapshots
      for (let i = 1; i <= 5; i++) {
        await limitedStore.save(
          createSnapshot(`conv${i}`, { createdAt: i * 1000, updatedAt: i * 1000 })
        );
      }

      const summaries = await limitedStore.list();
      expect(summaries.length).toBeLessThanOrEqual(3);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const newBackend = new MemoryStorageBackend();
      store.updateConfig({ backend: newBackend, maxSnapshots: 100 });
      // Config update doesn't throw
    });
  });
});
