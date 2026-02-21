/**
 * Filesystem Abstraction for AIOS
 *
 * Provides a platform-agnostic filesystem interface that can be:
 * 1. Used with Tauri (in Metaglass)
 * 2. Used with Node.js
 * 3. No-op for browser environments without filesystem access
 *
 * By default, operations are no-ops. Integrators can set a custom filesystem.
 */

import { createLogger } from './logger';

const log = createLogger('Filesystem');

/**
 * Filesystem interface for AIOS operations
 */
export interface AIOSFilesystem {
  /** Write text to a file */
  writeTextFile(path: string, content: string): Promise<void>;
  /** Read text from a file */
  readTextFile(path: string): Promise<string>;
  /** Create a directory */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Check if a path exists */
  exists(path: string): Promise<boolean>;
}

/**
 * No-op filesystem (default)
 */
const noopFilesystem: AIOSFilesystem = {
  async writeTextFile(path: string, _content: string): Promise<void> {
    log.debug('writeTextFile (no-op)', { path });
  },
  async readTextFile(path: string): Promise<string> {
    log.debug('readTextFile (no-op)', { path });
    return '';
  },
  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    log.debug('mkdir (no-op)', { path });
  },
  async exists(path: string): Promise<boolean> {
    log.debug('exists (no-op)', { path });
    return false;
  },
};

/**
 * In-memory filesystem for testing
 */
export function createMemoryFilesystem(): AIOSFilesystem {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  return {
    async writeTextFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async readTextFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
      dirs.add(path);
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path) || dirs.has(path);
    },
  };
}

/**
 * Current filesystem instance
 */
let currentFilesystem: AIOSFilesystem = noopFilesystem;

/**
 * Set the filesystem implementation
 */
export function setFilesystem(fs: AIOSFilesystem): void {
  currentFilesystem = fs;
  log.info('Filesystem set');
}

/**
 * Get the current filesystem
 */
export function getFilesystem(): AIOSFilesystem {
  return currentFilesystem;
}

// Export functions that delegate to current filesystem
export async function writeTextFile(path: string, content: string): Promise<void> {
  return currentFilesystem.writeTextFile(path, content);
}

export async function readTextFile(path: string): Promise<string> {
  return currentFilesystem.readTextFile(path);
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  return currentFilesystem.mkdir(path, options);
}

export async function exists(path: string): Promise<boolean> {
  return currentFilesystem.exists(path);
}
