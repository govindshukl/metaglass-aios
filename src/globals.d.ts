/**
 * Browser global type declarations
 *
 * These allow AIOS to reference browser globals while remaining
 * compatible with Node.js environments (where they don't exist).
 */

// LocalStorage interface (subset of Web Storage API)
interface Storage {
  readonly length: number;
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

// Window interface (minimal for AIOS usage)
interface Window {
  localStorage: Storage;
  __aiosDebug?: import('./kernel/DebugHarness').DebugConsoleAPI;
  __aiosDebugEnabled?: boolean;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

// Global declarations
declare var localStorage: Storage | undefined;
declare var window: Window | undefined;
