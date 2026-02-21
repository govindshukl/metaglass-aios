/**
 * StateStore Interface
 *
 * Abstraction for state management within AIOS.
 * Enables reactive state updates and subscriptions.
 */

/**
 * State change callback
 */
export type StateChangeCallback<T> = (value: T, previousValue: T | undefined) => void;

/**
 * State subscription handle
 */
export interface StateSubscription {
  /** Unsubscribe from state changes */
  unsubscribe(): void;
}

/**
 * State Store interface
 *
 * Provides reactive state management for AIOS components.
 */
export interface StateStore {
  /**
   * Get a value from the store
   *
   * @param key - State key
   * @returns Value if exists, undefined otherwise
   */
  get<T>(key: string): T | undefined;

  /**
   * Set a value in the store
   *
   * @param key - State key
   * @param value - Value to store
   */
  set<T>(key: string, value: T): void;

  /**
   * Delete a value from the store
   *
   * @param key - State key
   * @returns Whether value was deleted
   */
  delete(key: string): boolean;

  /**
   * Check if a key exists
   *
   * @param key - State key
   * @returns Whether key exists
   */
  has(key: string): boolean;

  /**
   * Get all keys in the store
   *
   * @returns Array of keys
   */
  keys(): string[];

  /**
   * Clear all values from the store
   */
  clear(): void;

  /**
   * Subscribe to changes for a specific key
   *
   * @param key - State key to watch
   * @param callback - Callback on change
   * @returns Subscription handle
   */
  subscribe<T>(key: string, callback: StateChangeCallback<T>): StateSubscription;

  /**
   * Subscribe to all changes in the store
   *
   * @param callback - Callback with key and new value
   * @returns Subscription handle
   */
  subscribeAll(
    callback: (key: string, value: unknown, previousValue: unknown) => void
  ): StateSubscription;

  /**
   * Get a snapshot of the entire store
   *
   * @returns Record of all key-value pairs
   */
  snapshot(): Record<string, unknown>;

  /**
   * Restore store from a snapshot
   *
   * @param snapshot - Snapshot to restore
   */
  restore(snapshot: Record<string, unknown>): void;
}

/**
 * Namespaced state store for component isolation
 */
export interface NamespacedStateStore extends StateStore {
  /** Namespace for this store */
  readonly namespace: string;

  /**
   * Create a child namespace
   *
   * @param name - Child namespace name
   * @returns Namespaced store
   */
  createChild(name: string): NamespacedStateStore;
}
