/**
 * LLMProvider Interface
 *
 * Abstraction for LLM providers (Claude, OpenAI, Ollama, etc.)
 * Enables swapping providers without changing agent logic.
 */

import type { Message, ChatOptions, LLMResponse, LLMCapabilities, ModelTier } from './types';

/**
 * LLM Provider interface
 *
 * Implementations:
 * - ClaudeProvider (Anthropic API)
 * - OpenAIProvider (OpenAI API)
 * - OllamaProvider (Local models)
 */
export interface LLMProvider {
  /** Unique provider identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /**
   * Send a chat completion request
   *
   * @param messages - Conversation history
   * @param options - Chat options (max tokens, tools, etc.)
   * @returns LLM response with content and optional tool calls
   */
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;

  /**
   * Stream a chat completion response
   *
   * @param messages - Conversation history
   * @param options - Chat options
   * @yields Partial response chunks
   */
  stream?(messages: Message[], options?: ChatOptions): AsyncGenerator<string, void, unknown>;

  /**
   * Get provider capabilities
   *
   * @returns Capability information (tool calling, vision, etc.)
   */
  getCapabilities(): LLMCapabilities;

  /**
   * Check if the provider is configured and ready
   *
   * @returns Whether the provider can be used
   */
  isConfigured(): boolean;

  /**
   * Get the model ID for a given tier
   *
   * @param tier - Model tier (haiku, sonnet, opus)
   * @returns Model identifier string
   */
  getModelForTier?(tier: ModelTier): string;
}

/**
 * Factory for creating LLM providers
 */
export interface LLMProviderFactory {
  /**
   * Create a provider instance
   *
   * @param config - Provider-specific configuration
   * @returns Configured provider instance
   */
  create(config: Record<string, unknown>): LLMProvider;
}
