/**
 * Vercel AI SDK LLM Provider
 *
 * Implements LLMProvider interface using Vercel AI SDK.
 * This is a standalone implementation that can be configured with any
 * Vercel AI SDK compatible model.
 */

import { generateText, streamText, tool, jsonSchema } from 'ai';
import type {
  ChatOptions,
  LLMResponse,
  LLMCapabilities,
  Message,
  ToolCall,
  ToolDefinition,
} from '../interfaces';
import { createLogger } from '../logger';

const log = createLogger('VercelAILLMProvider');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreTool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanguageModel = any;

// =============================================================================
// MODEL PROVIDER INTERFACE
// =============================================================================

/**
 * Interface for providing language models
 */
export interface ModelProvider {
  /** Get a language model */
  getModel(modelId?: string): LanguageModel;
  /** Check if provider is configured */
  isConfigured(): boolean;
}

/**
 * Tool registry interface for getting tools with Zod schemas
 */
export interface ToolRegistryProvider {
  /** Get tools for AI with proper schemas */
  getToolsForAI(options?: { ids?: string[] }): Record<string, CoreTool>;
}

// =============================================================================
// PLUGGABLE PROVIDERS (can be set by integrator)
// =============================================================================

let modelProvider: ModelProvider | null = null;
let toolRegistryProvider: ToolRegistryProvider | null = null;

/**
 * Set the model provider
 */
export function setModelProvider(provider: ModelProvider): void {
  modelProvider = provider;
  log.info('Model provider set');
}

/**
 * Set the tool registry provider (optional)
 */
export function setToolRegistryProvider(provider: ToolRegistryProvider): void {
  toolRegistryProvider = provider;
  log.info('Tool registry provider set');
}

// =============================================================================
// TYPE CONVERSIONS
// =============================================================================

/**
 * Convert AIOS Message to Vercel AI SDK CoreMessage
 */
function toCoreMess(messages: Message[]): CoreMessage[] {
  return messages.map((msg): CoreMessage => {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };
      case 'user':
        return { role: 'user', content: msg.content };
      case 'assistant':
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          return {
            role: 'assistant' as const,
            content: [
              ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
              ...msg.toolCalls.map((tc) => ({
                type: 'tool-call' as const,
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.params ?? {},
              })),
            ],
          };
        }
        return { role: 'assistant', content: msg.content };
      case 'tool':
        let outputObj: { type: 'text'; value: string } | { type: 'json'; value: unknown };
        try {
          const parsedValue = JSON.parse(msg.content || '{}');
          outputObj = { type: 'json', value: parsedValue };
        } catch {
          outputObj = { type: 'text', value: msg.content || '' };
        }

        return {
          role: 'tool' as const,
          content: [
            {
              type: 'tool-result' as const,
              toolCallId: msg.toolCallId || '',
              toolName: msg.toolName || 'unknown',
              output: outputObj,
            },
          ],
        };
      default:
        log.warn('Unknown message role, treating as user', { role: msg.role });
        return { role: 'user', content: msg.content };
    }
  });
}

/**
 * Get tools from the tool registry if available
 */
function getToolsFromRegistry(toolNames?: string[]): Record<string, CoreTool> {
  if (!toolRegistryProvider) {
    return {};
  }

  const registryTools = toolRegistryProvider.getToolsForAI({
    ids: toolNames,
  });

  log.info('Got tools from ToolRegistry', {
    count: Object.keys(registryTools).length,
    names: Object.keys(registryTools),
  });

  return registryTools;
}

/**
 * Convert AIOS ToolDefinition to Vercel AI SDK CoreTool (fallback)
 */
function toCoreTools(tools: ToolDefinition[]): Record<string, CoreTool> {
  const coreTools: Record<string, CoreTool> = {};

  for (const toolDef of tools) {
    const inputSchema = jsonSchema({
      type: 'object',
      properties: {},
      additionalProperties: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coreTools[toolDef.name] = tool({
      description: toolDef.description,
      inputSchema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as any;

    log.debug('Registered fallback tool', { name: toolDef.name });
  }

  log.info('Converted tools for LLM (fallback)', { count: tools.length });
  return coreTools;
}

/**
 * Extract tool calls from Vercel AI SDK response
 */
function extractToolCalls(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolCalls: Array<{ toolCallId: string; toolName: string; args?: any; input?: any }> | undefined
): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((tc) => {
    const params = tc.input ?? tc.args;
    return {
      id: tc.toolCallId,
      name: tc.toolName,
      params: params as Record<string, unknown>,
    };
  });
}

// =============================================================================
// PROVIDER IMPLEMENTATION
// =============================================================================

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'custom';

/**
 * Configuration for VercelAILLMProvider
 */
export interface VercelAILLMProviderConfig {
  /** Provider type */
  providerType?: ProviderType;
  /** Specific model ID to use */
  modelId?: string;
  /** Direct model instance (bypasses registry) */
  model?: LanguageModel;
}

/**
 * LLM Provider implementation using Vercel AI SDK
 */
export class VercelAILLMProvider {
  readonly id: string;
  readonly name: string;

  private providerType: ProviderType;
  private modelId?: string;
  private directModel?: LanguageModel;

  constructor(config: VercelAILLMProviderConfig = {}) {
    this.providerType = config.providerType || 'anthropic';
    this.modelId = config.modelId;
    this.directModel = config.model;

    this.id = `vercel-ai-${this.providerType}`;
    this.name = `Vercel AI (${this.providerType})`;
  }

  /**
   * Get the language model to use
   */
  private getModel(): LanguageModel {
    // Use direct model if provided
    if (this.directModel) {
      return this.directModel;
    }

    // Use model provider if available
    if (modelProvider) {
      return modelProvider.getModel(this.modelId);
    }

    throw new Error(
      'No model available. Either provide a model directly, set a model provider with setModelProvider(), ' +
        'or use AIOS setProviders() to configure the LLM provider.'
    );
  }

  /**
   * Chat completion with tool support
   */
  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = this.getModel();
    const coreMessages = toCoreMess(messages);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: Record<string, any> | undefined;

    if (options?.tools && options.tools.length > 0) {
      // Try to use tool registry if available
      const toolNames = options.tools.map((t) => t.name);
      tools = getToolsFromRegistry(toolNames);

      // Fall back to manual conversion if registry doesn't have tools
      if (Object.keys(tools).length === 0) {
        log.warn('No tools found in ToolRegistry, using fallback conversion');
        tools = toCoreTools(options.tools);
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateOptions: any = {
        model,
        messages: coreMessages,
        tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
        temperature: options?.temperature,
        stopSequences: options?.stop,
        abortSignal: options?.signal,
        experimental_timeout: 180000,
        // Enable prompt caching for Anthropic
        ...(this.providerType === 'anthropic' && {
          experimental_providerMetadata: {
            anthropic: {
              cacheControl: { type: 'ephemeral' },
            },
          },
        }),
        // Disable thinking mode for Ollama
        ...(this.providerType === 'ollama' && {
          providerOptions: {
            ollama: {
              options: {
                enable_thinking: false,
              },
            },
          },
        }),
      };

      if (options?.maxTokens) {
        generateOptions.maxTokens = options.maxTokens;
      }

      const contextSize = coreMessages.reduce((total: number, msg: CoreMessage) => {
        if (typeof msg.content === 'string') {
          return total + msg.content.length;
        } else if (Array.isArray(msg.content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (
            total +
            msg.content.reduce((sum: number, part: any) => {
              if (part.type === 'text') return sum + (part.text?.length || 0);
              if (part.type === 'tool-result') {
                const output = part.output;
                if (typeof output === 'string') return sum + output.length;
                if (output?.value) return sum + JSON.stringify(output.value).length;
              }
              return sum;
            }, 0)
          );
        }
        return total;
      }, 0);

      log.info('Calling generateText', {
        toolCount: generateOptions.tools ? Object.keys(generateOptions.tools).length : 0,
        messageCount: coreMessages.length,
        contextSizeChars: contextSize,
        contextSizeKb: Math.round(contextSize / 1024),
      });

      const result = await generateText(generateOptions);

      // Determine finish reason
      let finishReason: LLMResponse['finishReason'] = 'stop';
      if (result.finishReason === 'tool-calls') {
        finishReason = 'tool_calls';
      } else if (result.finishReason === 'length') {
        finishReason = 'length';
      } else if (result.finishReason === 'error') {
        finishReason = 'error';
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolCalls = extractToolCalls(result.toolCalls as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usage = result.usage as any;
      const promptTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
      const completionTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;

      return {
        content: result.text || '',
        toolCalls,
        finishReason,
        usage: usage
          ? {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('LLM call aborted', { name: error.name });
        throw error;
      }

      log.error('LLM call failed', {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Unknown',
      });

      throw new Error(`LLM chat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Streaming chat completion
   */
  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<string> {
    const model = this.getModel();
    const coreMessages = toCoreMess(messages);
    const tools = options?.tools ? toCoreTools(options.tools) : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamOptions: any = {
      model,
      messages: coreMessages,
      tools,
      temperature: options?.temperature,
      stopSequences: options?.stop,
      abortSignal: options?.signal,
      ...(this.providerType === 'ollama' && {
        providerOptions: {
          ollama: {
            options: {
              enable_thinking: false,
            },
          },
        },
      }),
    };

    if (options?.maxTokens) {
      streamOptions.maxTokens = options.maxTokens;
    }

    const result = await streamText(streamOptions);

    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): LLMCapabilities {
    switch (this.providerType) {
      case 'anthropic':
        return {
          toolCalling: true,
          vision: true,
          streaming: true,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        };
      case 'openai':
        return {
          toolCalling: true,
          vision: true,
          streaming: true,
          contextWindow: 128000,
          maxOutputTokens: 16384,
        };
      case 'ollama':
        return {
          toolCalling: true,
          vision: false,
          streaming: true,
          contextWindow: 32000,
          maxOutputTokens: 4096,
        };
      default:
        return {
          toolCalling: true,
          vision: false,
          streaming: true,
          contextWindow: 32000,
          maxOutputTokens: 4096,
        };
    }
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    if (this.directModel) {
      return true;
    }
    if (modelProvider) {
      return modelProvider.isConfigured();
    }
    return false;
  }

  /**
   * Create provider with a direct model instance
   */
  static withModel(model: LanguageModel, providerType: ProviderType = 'custom'): VercelAILLMProvider {
    return new VercelAILLMProvider({
      providerType,
      model,
    });
  }

  /**
   * Create provider for specific model tier (requires modelProvider to be set)
   */
  static forTier(tier: 'haiku' | 'sonnet' | 'opus'): VercelAILLMProvider {
    const modelMap: Record<string, { provider: ProviderType; model: string }> = {
      haiku: { provider: 'anthropic', model: 'claude-3-haiku-20240307' },
      sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      opus: { provider: 'anthropic', model: 'claude-opus-4-5-20251101' },
    };

    const config = modelMap[tier];
    return new VercelAILLMProvider({
      providerType: config.provider,
      modelId: config.model,
    });
  }
}

/**
 * Create default LLM provider using current settings
 */
export function createDefaultLLMProvider(): VercelAILLMProvider {
  return new VercelAILLMProvider();
}
