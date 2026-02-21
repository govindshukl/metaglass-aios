/**
 * Simple Logger for AIOS
 *
 * Provides structured logging with configurable levels.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// Global log level (can be configured)
let globalLogLevel: LogLevel = 'info';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Create a logger with a specific prefix
 */
export function createLogger(prefix: string): Logger {
  const shouldLog = (level: LogLevel): boolean => {
    return LOG_LEVELS[level] >= LOG_LEVELS[globalLogLevel];
  };

  return {
    debug(message: string, ...args: unknown[]): void {
      if (shouldLog('debug')) {
        console.debug(`[${prefix}]`, message, ...args);
      }
    },
    info(message: string, ...args: unknown[]): void {
      if (shouldLog('info')) {
        console.info(`[${prefix}]`, message, ...args);
      }
    },
    warn(message: string, ...args: unknown[]): void {
      if (shouldLog('warn')) {
        console.warn(`[${prefix}]`, message, ...args);
      }
    },
    error(message: string, ...args: unknown[]): void {
      if (shouldLog('error')) {
        console.error(`[${prefix}]`, message, ...args);
      }
    },
  };
}

/**
 * Set the global log level
 */
export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return globalLogLevel;
}
