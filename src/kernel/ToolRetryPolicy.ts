/**
 * ToolRetryPolicy - Retry logic with exponential backoff for tool execution
 *
 * Provides automatic retry for transient failures with configurable:
 * - Maximum attempts
 * - Exponential backoff with jitter
 * - Retryable error classification
 * - Abort signal support
 */

import { createLogger } from '../logger';

const log = createLogger('ToolRetryPolicy');

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Add random jitter to delays (default: true) */
  jitter?: boolean;
  /** Error message patterns that are retryable */
  retryableErrors?: string[];
}

/**
 * Result from a retry operation
 */
export interface RetryResult<T> {
  /** Whether the operation eventually succeeded */
  success: boolean;
  /** The result if successful */
  result?: T;
  /** Total number of attempts made */
  attempts: number;
  /** Last error message if failed */
  lastError?: string;
  /** Total time spent in ms */
  totalTimeMs: number;
}

/**
 * Options for a single retry execution
 */
export interface RetryOptions {
  /** Custom function to determine if an error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Callback on each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitter: true,
  retryableErrors: [
    // Network errors
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'network',
    'timeout',
    'fetch failed',
    // Rate limiting
    'rate limit',
    'too many requests',
    '429',
    // Temporary server errors
    '502',
    '503',
    '504',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    // Generic transient
    'temporarily unavailable',
    'try again',
    'EAGAIN',
  ],
};

/**
 * Errors that should never be retried
 */
const NON_RETRYABLE_ERRORS = [
  'not found',
  '404',
  'unauthorized',
  '401',
  'forbidden',
  '403',
  'invalid',
  'validation',
  'permission denied',
  'access denied',
  'already exists',
  'conflict',
  'bad request',
  '400',
];

// =============================================================================
// TOOL RETRY POLICY
// =============================================================================

export class ToolRetryPolicy {
  private config: Required<RetryConfig>;

  constructor(config?: RetryConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with retry logic
   *
   * @param fn - The async function to execute
   * @param options - Retry options
   * @returns Result with success status and attempt count
   */
  async execute<T>(
    fn: () => Promise<T>,
    options?: RetryOptions
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < this.config.maxAttempts) {
      attempt++;

      // Check for cancellation
      if (options?.signal?.aborted) {
        return {
          success: false,
          attempts: attempt,
          lastError: 'Operation cancelled',
          totalTimeMs: Date.now() - startTime,
        };
      }

      try {
        const result = await fn();
        log.debug('Retry operation succeeded', { attempt, totalAttempts: this.config.maxAttempts });
        return {
          success: true,
          result,
          attempts: attempt,
          totalTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if we should retry
        const isRetryable = this.shouldRetry(lastError, options?.isRetryable);
        const isLastAttempt = attempt >= this.config.maxAttempts;

        if (!isRetryable || isLastAttempt) {
          log.debug('Retry operation failed permanently', {
            attempt,
            maxAttempts: this.config.maxAttempts,
            isRetryable,
            error: lastError.message,
          });
          break;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt);

        log.info('Retrying after error', {
          attempt,
          maxAttempts: this.config.maxAttempts,
          error: lastError.message,
          delayMs: delay,
        });

        // Notify callback
        if (options?.onRetry) {
          options.onRetry(attempt, lastError, delay);
        }

        // Wait before retry
        await this.sleep(delay, options?.signal);
      }
    }

    return {
      success: false,
      attempts: attempt,
      lastError: lastError?.message,
      totalTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Determine if an error should trigger a retry
   */
  private shouldRetry(error: Error, customIsRetryable?: (error: Error) => boolean): boolean {
    // Use custom function if provided
    if (customIsRetryable) {
      return customIsRetryable(error);
    }

    const errorMessage = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();

    // Check for non-retryable errors first
    for (const pattern of NON_RETRYABLE_ERRORS) {
      if (errorMessage.includes(pattern) || errorName.includes(pattern)) {
        return false;
      }
    }

    // Check for retryable error patterns
    for (const pattern of this.config.retryableErrors) {
      if (errorMessage.includes(pattern.toLowerCase()) ||
          errorName.includes(pattern.toLowerCase())) {
        return true;
      }
    }

    // Default: don't retry unknown errors
    return false;
  }

  /**
   * Calculate delay for the current attempt with exponential backoff and optional jitter
   */
  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * (multiplier ^ (attempt - 1))
    let delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);

    // Cap at max delay
    delay = Math.min(delay, this.config.maxDelayMs);

    // Add jitter (±25%)
    if (this.config.jitter) {
      const jitterRange = delay * 0.25;
      delay = delay + (Math.random() * jitterRange * 2) - jitterRange;
    }

    return Math.round(delay);
  }

  /**
   * Sleep for specified duration, respecting abort signal
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new Error('Operation cancelled'));
        }, { once: true });
      }
    });
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<RetryConfig> {
    return { ...this.config };
  }

  /**
   * Create a retry policy for specific tool characteristics
   */
  static forToolType(toolType: 'network' | 'filesystem' | 'compute'): ToolRetryPolicy {
    switch (toolType) {
      case 'network':
        // More retries for network operations
        return new ToolRetryPolicy({
          maxAttempts: 4,
          baseDelayMs: 1000,
          maxDelayMs: 15000,
        });
      case 'filesystem':
        // Fewer retries for local operations
        return new ToolRetryPolicy({
          maxAttempts: 2,
          baseDelayMs: 500,
          maxDelayMs: 2000,
        });
      case 'compute':
        // Standard retries
        return new ToolRetryPolicy();
      default:
        return new ToolRetryPolicy();
    }
  }
}
