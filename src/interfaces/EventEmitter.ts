/**
 * EventEmitter Interface
 *
 * Type-safe event emitter for AIOS events.
 * Enables loose coupling between components.
 */

import type { AIOSEvents } from './types';

/**
 * Event subscription handle
 */
export interface EventSubscription {
  /** Unsubscribe from the event */
  unsubscribe(): void;
}

/**
 * Event handler function
 */
export type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Type-safe event emitter interface
 */
export interface EventEmitter {
  /**
   * Subscribe to an event
   *
   * @param event - Event name
   * @param handler - Event handler
   * @returns Subscription handle
   */
  on<K extends keyof AIOSEvents>(
    event: K,
    handler: EventHandler<AIOSEvents[K]>
  ): EventSubscription;

  /**
   * Subscribe to an event once (auto-unsubscribe after first emit)
   *
   * @param event - Event name
   * @param handler - Event handler
   * @returns Subscription handle
   */
  once<K extends keyof AIOSEvents>(
    event: K,
    handler: EventHandler<AIOSEvents[K]>
  ): EventSubscription;

  /**
   * Unsubscribe from an event
   *
   * @param event - Event name
   * @param handler - Event handler to remove
   */
  off<K extends keyof AIOSEvents>(
    event: K,
    handler: EventHandler<AIOSEvents[K]>
  ): void;

  /**
   * Emit an event
   *
   * @param event - Event name
   * @param payload - Event payload
   */
  emit<K extends keyof AIOSEvents>(event: K, payload: AIOSEvents[K]): Promise<void>;

  /**
   * Emit an event synchronously (does not wait for async handlers)
   *
   * @param event - Event name
   * @param payload - Event payload
   */
  emitSync<K extends keyof AIOSEvents>(event: K, payload: AIOSEvents[K]): void;

  /**
   * Check if an event has listeners
   *
   * @param event - Event name
   * @returns Whether event has listeners
   */
  hasListeners(event: keyof AIOSEvents): boolean;

  /**
   * Get listener count for an event
   *
   * @param event - Event name
   * @returns Number of listeners
   */
  listenerCount(event: keyof AIOSEvents): number;

  /**
   * Remove all listeners
   *
   * @param event - Optional event to clear (clears all if not specified)
   */
  removeAllListeners(event?: keyof AIOSEvents): void;
}
