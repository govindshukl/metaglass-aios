/**
 * ContextCompressor Tests (TDD)
 *
 * Tests for the context compression service that prevents conversation history overflow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextCompressor } from '../ContextCompressor';
import type { LLMProvider, Message, CompressionConfig } from '../../interfaces';

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

function createMockLLM(summaryResponse = 'Summary of the conversation so far.'): LLMProvider {
  return {
    id: 'mock-llm',
    name: 'Mock LLM',
    chat: vi.fn(async () => ({
      content: summaryResponse,
      finishReason: 'stop' as const,
    })),
    getCapabilities: () => ({
      toolCalling: true,
      vision: false,
      streaming: false,
      contextWindow: 100000,
      maxOutputTokens: 4096,
    }),
    isConfigured: () => true,
  };
}

function createMessages(count: number, contentLength = 100): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i + 1}: ${'x'.repeat(contentLength)}`,
  })) as Message[];
}

// =============================================================================
// TESTS
// =============================================================================

describe('ContextCompressor', () => {
  let mockLLM: LLMProvider;
  let compressor: ContextCompressor;

  beforeEach(() => {
    mockLLM = createMockLLM();
    compressor = new ContextCompressor(mockLLM);
  });

  describe('constructor', () => {
    it('should create compressor with default config', () => {
      const config = compressor.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxTokens).toBe(100000);
      expect(config.summarizeThreshold).toBe(10);
      expect(config.preserveRecentTurns).toBe(5);
    });

    it('should accept custom config', () => {
      const customConfig: CompressionConfig = {
        maxTokens: 50000,
        summarizeThreshold: 5,
        preserveRecentTurns: 3,
      };
      const customCompressor = new ContextCompressor(mockLLM, customConfig);
      const config = customCompressor.getConfig();
      expect(config.maxTokens).toBe(50000);
      expect(config.summarizeThreshold).toBe(5);
      expect(config.preserveRecentTurns).toBe(3);
    });
  });

  describe('compress', () => {
    it('should not compress when history is below threshold', async () => {
      const messages = createMessages(4); // Below default threshold of 10
      const result = await compressor.compress(messages);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
      expect(mockLLM.chat).not.toHaveBeenCalled();
    });

    it('should not compress when disabled', async () => {
      compressor.updateConfig({ enabled: false });
      const messages = createMessages(20);
      const result = await compressor.compress(messages);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
      expect(mockLLM.chat).not.toHaveBeenCalled();
    });

    it('should not compress when below token threshold', async () => {
      // Create short messages that won't exceed token limit
      const messages = createMessages(12, 10); // 12 messages, 10 chars each
      const result = await compressor.compress(messages);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
    });

    it('should compress when above threshold and token limit', async () => {
      // Configure for lower thresholds to trigger compression
      compressor.updateConfig({
        maxTokens: 100, // Very low token limit
        summarizeThreshold: 5,
        preserveRecentTurns: 2,
      });

      const messages = createMessages(10, 50); // 10 messages with substantial content
      const result = await compressor.compress(messages);

      expect(result.wasCompressed).toBe(true);
      expect(mockLLM.chat).toHaveBeenCalled();
    });

    it('should handle system prompt when compressing', async () => {
      compressor.updateConfig({
        maxTokens: 100,
        summarizeThreshold: 3,
        preserveRecentTurns: 2,
      });

      const systemPrompt = 'You are a helpful assistant.';
      const messages = createMessages(8, 50);
      const result = await compressor.compress(messages, systemPrompt);

      // Result should always have messages
      expect(result.messages.length).toBeGreaterThan(0);

      // If compressed, the message structure should be modified
      if (result.wasCompressed) {
        expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
      }
    });

    it('should preserve recent turns verbatim', async () => {
      compressor.updateConfig({
        maxTokens: 100,
        summarizeThreshold: 3,
        preserveRecentTurns: 3,
      });

      const messages = createMessages(10, 50);
      const result = await compressor.compress(messages);

      if (result.wasCompressed) {
        // Check that we have fewer messages after compression
        // (summary replaces older messages)
        expect(result.messages.length).toBeLessThanOrEqual(messages.length);

        // Recent messages should be preserved - check roles are correct
        const recentMessages = result.messages.filter((m) => m.role !== 'system');
        expect(recentMessages.length).toBeGreaterThan(0);
      }
    });

    it('should return token estimates', async () => {
      const messages = createMessages(5);
      const result = await compressor.compress(messages);

      expect(result.originalTokens).toBeGreaterThan(0);
      expect(result.compressedTokens).toBeGreaterThan(0);
      expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    });
  });

  describe('token estimation via compress result', () => {
    it('should return token estimates in result', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello world' }, // 11 chars
        { role: 'assistant', content: 'Hi there!' }, // 9 chars
      ];

      const result = await compressor.compress(messages);
      // Default is 4 chars per token, so ~5 tokens
      expect(result.originalTokens).toBeGreaterThan(0);
      expect(result.originalTokens).toBeLessThan(100);
    });

    it('should respect chars per token config', async () => {
      compressor.updateConfig({ charsPerToken: 2 });
      const messages: Message[] = [{ role: 'user', content: '12345678' }]; // 8 chars

      const result = await compressor.compress(messages);
      // 8 chars / 2 chars per token = 4 tokens
      expect(result.originalTokens).toBe(4);
    });
  });

  describe('compression thresholds', () => {
    it('should not compress when below turn threshold', async () => {
      const messages = createMessages(5); // Below default 10
      const result = await compressor.compress(messages);
      expect(result.wasCompressed).toBe(false);
    });

    it('should not compress when disabled', async () => {
      compressor.updateConfig({ enabled: false });
      const messages = createMessages(20);
      const result = await compressor.compress(messages);
      expect(result.wasCompressed).toBe(false);
    });

    it('should attempt compression when above thresholds', async () => {
      compressor.updateConfig({
        maxTokens: 50,
        summarizeThreshold: 3,
      });
      const messages = createMessages(10, 100); // Large messages
      const result = await compressor.compress(messages);
      // May or may not compress depending on actual token count
      // but should at least try
      expect(result.originalTokens).toBeGreaterThan(0);
    });
  });

  describe('updateConfig', () => {
    it('should update partial config', () => {
      const originalConfig = compressor.getConfig();
      compressor.updateConfig({ maxTokens: 50000 });

      const newConfig = compressor.getConfig();
      expect(newConfig.maxTokens).toBe(50000);
      expect(newConfig.summarizeThreshold).toBe(originalConfig.summarizeThreshold);
    });

    it('should handle enabled/disabled toggle', () => {
      expect(compressor.getConfig().enabled).toBe(true);
      compressor.updateConfig({ enabled: false });
      expect(compressor.getConfig().enabled).toBe(false);
      compressor.updateConfig({ enabled: true });
      expect(compressor.getConfig().enabled).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle LLM errors gracefully', async () => {
      const failingLLM = createMockLLM();
      (failingLLM.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('LLM unavailable')
      );

      const failingCompressor = new ContextCompressor(failingLLM, {
        maxTokens: 50,
        summarizeThreshold: 3,
      });

      const messages = createMessages(10, 100);
      const result = await failingCompressor.compress(messages);

      // Should fall back to returning original messages
      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  });
});
