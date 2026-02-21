/**
 * ToolRetryPolicy Tests (TDD)
 *
 * Tests for the retry logic with exponential backoff for tool execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRetryPolicy } from '../ToolRetryPolicy';
import type { RetryConfig } from '../../interfaces';

// =============================================================================
// TESTS
// =============================================================================

describe('ToolRetryPolicy', () => {
  let policy: ToolRetryPolicy;

  beforeEach(() => {
    vi.useFakeTimers();
    policy = new ToolRetryPolicy();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create policy with default config', () => {
      const config = policy.getConfig();
      expect(config.maxAttempts).toBe(3);
      expect(config.baseDelayMs).toBe(1000);
      expect(config.maxDelayMs).toBe(10000);
      expect(config.backoffMultiplier).toBe(2);
      expect(config.jitter).toBe(true);
    });

    it('should accept custom config', () => {
      const customConfig: RetryConfig = {
        maxAttempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        backoffMultiplier: 1.5,
        jitter: false,
      };
      const customPolicy = new ToolRetryPolicy(customConfig);
      const config = customPolicy.getConfig();
      expect(config.maxAttempts).toBe(5);
      expect(config.baseDelayMs).toBe(500);
      expect(config.maxDelayMs).toBe(5000);
      expect(config.backoffMultiplier).toBe(1.5);
      expect(config.jitter).toBe(false);
    });
  });

  describe('execute - success cases', () => {
    it('should return result on first successful attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should succeed after retrying transient errors', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('execute - failure cases', () => {
    it('should fail after max attempts exhausted', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('timeout'));

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.lastError).toBe('timeout');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('not found'));

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.lastError).toBe('not found');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry 404 errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('404 Not Found'));

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry validation errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('validation failed'));

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryable error classification', () => {
    it('should retry network errors', async () => {
      const networkErrors = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'fetch failed'];

      for (const errorMsg of networkErrors) {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error(errorMsg))
          .mockResolvedValue('ok');

        const resultPromise = policy.execute(fn);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
      }
    });

    it('should retry rate limit errors', async () => {
      const rateLimitErrors = ['rate limit exceeded', 'too many requests', '429'];

      for (const errorMsg of rateLimitErrors) {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error(errorMsg))
          .mockResolvedValue('ok');

        const resultPromise = policy.execute(fn);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
      }
    });

    it('should retry server errors', async () => {
      const serverErrors = ['502 Bad Gateway', '503 Service Unavailable', '504 Gateway Timeout'];

      for (const errorMsg of serverErrors) {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error(errorMsg))
          .mockResolvedValue('ok');

        const resultPromise = policy.execute(fn);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
      }
    });

    it('should not retry auth errors', async () => {
      const authErrors = ['unauthorized', '401', 'forbidden', '403'];

      for (const errorMsg of authErrors) {
        const fn = vi.fn().mockRejectedValue(new Error(errorMsg));

        const resultPromise = policy.execute(fn);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.attempts).toBe(1);
      }
    });
  });

  describe('custom isRetryable function', () => {
    it('should use custom isRetryable when provided', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('custom error'))
        .mockResolvedValue('ok');

      const customIsRetryable = (error: Error) => error.message.includes('custom');

      const resultPromise = policy.execute(fn, { isRetryable: customIsRetryable });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });

    it('should respect custom non-retryable classification', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('timeout')); // Normally retryable

      const customIsRetryable = () => false; // Never retry

      const resultPromise = policy.execute(fn, { isRetryable: customIsRetryable });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
    });
  });

  describe('onRetry callback', () => {
    it('should call onRetry for each retry attempt', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('ok');

      const onRetry = vi.fn();

      const resultPromise = policy.execute(fn, { onRetry });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
      expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error), expect.any(Number));
    });

    it('should pass correct delay to onRetry', async () => {
      const noJitterPolicy = new ToolRetryPolicy({
        jitter: false,
        baseDelayMs: 1000,
        backoffMultiplier: 2,
      });

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('ok');

      const onRetry = vi.fn();

      const resultPromise = noJitterPolicy.execute(fn, { onRetry });
      await vi.runAllTimersAsync();
      await resultPromise;

      // First retry should have delay of baseDelayMs (1000)
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 1000);
    });
  });

  describe('abort signal', () => {
    it('should stop retrying when aborted', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error('timeout'));

      const resultPromise = policy.execute(fn, { signal: controller.signal });

      // Abort after first attempt
      controller.abort();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.lastError).toBe('Operation cancelled');
    });

    it('should return cancelled status when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const fn = vi.fn().mockResolvedValue('success');

      const resultPromise = policy.execute(fn, { signal: controller.signal });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.lastError).toBe('Operation cancelled');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('timing', () => {
    it('should report total time spent', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('updateConfig', () => {
    it('should update config dynamically', () => {
      policy.updateConfig({ maxAttempts: 5 });
      expect(policy.getConfig().maxAttempts).toBe(5);
    });

    it('should preserve other config values when updating', () => {
      const original = policy.getConfig();
      policy.updateConfig({ maxAttempts: 5 });

      const updated = policy.getConfig();
      expect(updated.baseDelayMs).toBe(original.baseDelayMs);
      expect(updated.maxDelayMs).toBe(original.maxDelayMs);
    });
  });

  describe('forToolType factory', () => {
    it('should create network-optimized policy', () => {
      const networkPolicy = ToolRetryPolicy.forToolType('network');
      const config = networkPolicy.getConfig();
      expect(config.maxAttempts).toBe(4);
      expect(config.maxDelayMs).toBe(15000);
    });

    it('should create filesystem-optimized policy', () => {
      const fsPolicy = ToolRetryPolicy.forToolType('filesystem');
      const config = fsPolicy.getConfig();
      expect(config.maxAttempts).toBe(2);
      expect(config.maxDelayMs).toBe(2000);
    });

    it('should create compute policy with defaults', () => {
      const computePolicy = ToolRetryPolicy.forToolType('compute');
      const config = computePolicy.getConfig();
      expect(config.maxAttempts).toBe(3);
    });
  });
});
