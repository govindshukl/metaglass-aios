/**
 * Backend Abstraction for AIOS
 *
 * Provides an abstraction layer for backend commands that can be:
 * 1. Used with Tauri (in Metaglass)
 * 2. Used with Node.js
 * 3. Used with a custom backend
 *
 * By default, operations are no-ops. Integrators can set a custom backend.
 */

import { createLogger } from './logger';

const log = createLogger('Backend');

/**
 * Backend interface for AIOS operations
 */
export interface AIOSBackend {
  /** Invoke a backend command */
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

/**
 * No-op backend (default)
 */
const noopBackend: AIOSBackend = {
  async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    log.debug('Backend invoke (no-op)', { command, args });
    return null;
  },
};

/**
 * Current backend instance
 */
let currentBackend: AIOSBackend = noopBackend;

/**
 * Set the backend implementation
 */
export function setBackend(backend: AIOSBackend): void {
  currentBackend = backend;
  log.info('Backend set', { hasInvoke: typeof backend.invoke === 'function' });
}

/**
 * Get the current backend
 */
export function getBackend(): AIOSBackend {
  return currentBackend;
}

/**
 * Invoke a backend command
 */
export async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  return currentBackend.invoke(command, args);
}
