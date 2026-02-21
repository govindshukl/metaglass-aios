/**
 * ReflectionEngine - Evaluates goal completion before ending conversations
 *
 * This engine is called when the LLM stops making tool calls to verify
 * that the original goal has been achieved with acceptable quality.
 */

import type { LLMProvider, Todo, Message } from '../interfaces';
import { createLogger } from '../logger';

const log = createLogger('ReflectionEngine');

// =============================================================================
// TYPES
// =============================================================================

export interface ReflectionResult {
  /** Whether the goal appears to be fully achieved */
  isComplete: boolean;
  /** Quality assessment of the work done */
  quality: 'good' | 'needs_improvement' | 'failed';
  /** Explanation of the assessment */
  reasoning: string;
  /** Suggested next action if not complete */
  nextAction: string | null;
  /** Whether user input is needed to proceed */
  needsUserInput: boolean;
  /** Question to ask the user if needsUserInput is true */
  userQuestion: string | null;
}

export interface ReflectionConfig {
  /** Minimum turns before reflection kicks in (default: 1) */
  minTurnsBeforeReflection?: number;
  /** Skip reflection for simple responses (default: true) */
  skipForSimpleResponses?: boolean;
  /** Maximum length to consider a "simple" response (default: 500 chars) */
  simpleResponseMaxLength?: number;
  /** Skip reflection for read-only operations (default: true) */
  skipForReadOnlyOperations?: boolean;
}

/**
 * Tools that are considered read-only (don't modify state)
 */
const READ_ONLY_TOOLS = new Set([
  'search.fulltext',
  'search.vector',
  'search.hybrid',
  'search_fulltext',
  'search_vector',
  'search_hybrid',
  'vault.read_note',
  'vault_read_note',
  'vault.list_notes',
  'vault_list_notes',
  'memory.recall',
  'memory_recall',
  'memory.search',
  'memory_search',
  'graph.get_backlinks',
  'graph_get_backlinks',
  'graph.get_forward_links',
  'graph_get_forward_links',
  'graph.traverse',
  'graph_traverse',
]);

const DEFAULT_CONFIG: Required<ReflectionConfig> = {
  minTurnsBeforeReflection: 1,
  skipForSimpleResponses: true,
  simpleResponseMaxLength: 500,
  skipForReadOnlyOperations: true,
};

// =============================================================================
// REFLECTION ENGINE
// =============================================================================

export class ReflectionEngine {
  private llm: LLMProvider;
  private config: Required<ReflectionConfig>;

  constructor(llmProvider: LLMProvider, config?: ReflectionConfig) {
    this.llm = llmProvider;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate whether the conversation should continue or end
   *
   * @param originalGoal - The user's original request
   * @param todos - Current todo list (if any)
   * @param lastAssistantMessage - The LLM's last response content
   * @param turnCount - How many turns have occurred
   * @param history - Full conversation history for context
   */
  async shouldContinue(
    originalGoal: string,
    todos: Todo[],
    lastAssistantMessage: string,
    turnCount: number,
    history: Message[]
  ): Promise<ReflectionResult> {
    // Skip reflection for very early turns, simple responses, or read-only operations
    if (this.shouldSkipReflection(turnCount, lastAssistantMessage, todos, history)) {
      log.debug('Skipping reflection', {
        turn: turnCount,
        responseLength: lastAssistantMessage.length,
        todoCount: todos.length,
      });
      return {
        isComplete: true,
        quality: 'good',
        reasoning: 'Simple response, early turn, or read-only operation - skipping reflection',
        nextAction: null,
        needsUserInput: false,
        userQuestion: null,
      };
    }

    log.info('Running reflection', {
      turn: turnCount,
      todoCount: todos.length,
      goalLength: originalGoal.length,
    });

    try {
      const result = await this.evaluate(originalGoal, todos, lastAssistantMessage, history);
      log.info('Reflection result', {
        isComplete: result.isComplete,
        quality: result.quality,
        needsUserInput: result.needsUserInput,
      });
      return result;
    } catch (error) {
      log.error('Reflection failed', { error: String(error) });
      // On error, assume complete to avoid infinite loops
      return {
        isComplete: true,
        quality: 'good',
        reasoning: 'Reflection evaluation failed - assuming complete',
        nextAction: null,
        needsUserInput: false,
        userQuestion: null,
      };
    }
  }

  /**
   * Determine if reflection should be skipped
   */
  private shouldSkipReflection(
    turnCount: number,
    lastMessage: string,
    todos: Todo[],
    history?: Message[]
  ): boolean {
    // Skip if below minimum turns
    if (turnCount < this.config.minTurnsBeforeReflection) {
      return true;
    }

    // Skip for simple responses if configured
    if (this.config.skipForSimpleResponses) {
      const isSimple =
        lastMessage.length < this.config.simpleResponseMaxLength &&
        todos.length === 0;
      if (isSimple) {
        return true;
      }
    }

    // Skip for read-only operations if configured
    if (this.config.skipForReadOnlyOperations && history) {
      const toolsUsed = this.getToolsUsed(history);
      const isReadOnly = toolsUsed.length > 0 && toolsUsed.every(t => READ_ONLY_TOOLS.has(t));
      if (isReadOnly && todos.length === 0) {
        log.debug('Skipping reflection for read-only operations', { toolsUsed });
        return true;
      }
    }

    return false;
  }

  /**
   * Extract list of tools used from conversation history
   */
  private getToolsUsed(history: Message[]): string[] {
    const tools: string[] = [];
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          tools.push(tc.name);
        }
      }
    }
    return tools;
  }

  /**
   * Perform the actual reflection evaluation using the LLM
   */
  private async evaluate(
    originalGoal: string,
    todos: Todo[],
    lastAssistantMessage: string,
    history: Message[]
  ): Promise<ReflectionResult> {
    // Build todo status summary
    const todoSummary = todos.length > 0
      ? todos.map(t => `- [${t.status}] ${t.content}`).join('\n')
      : '(No todos were tracked)';

    // Count completed vs total
    const completedCount = todos.filter(t => t.status === 'completed').length;
    const pendingCount = todos.filter(t => t.status === 'pending').length;
    const inProgressCount = todos.filter(t => t.status === 'in_progress').length;

    // Build a summary of actions taken (tool calls from history)
    const toolCallsSummary = this.summarizeToolCalls(history);

    const reflectionPrompt = `You are evaluating whether an AI assistant has completed a user's request.

## Original User Goal
"${originalGoal}"

## Task Progress (Todos)
${todoSummary}

Summary: ${completedCount} completed, ${inProgressCount} in progress, ${pendingCount} pending

## Actions Taken
${toolCallsSummary}

## Assistant's Final Response
${lastAssistantMessage.slice(0, 2000)}${lastAssistantMessage.length > 2000 ? '...(truncated)' : ''}

## Your Task
Evaluate whether the goal has been achieved. Consider:
1. Were all required steps completed?
2. Is the output quality acceptable?
3. Are there any incomplete todos that should be finished?
4. Does the user need to provide more information?

Respond with a JSON object (and ONLY the JSON object, no markdown):
{
  "isComplete": boolean,
  "quality": "good" | "needs_improvement" | "failed",
  "reasoning": "brief explanation",
  "nextAction": "what to do next" or null,
  "needsUserInput": boolean,
  "userQuestion": "question for user" or null
}`;

    const response = await this.llm.chat([
      {
        role: 'system',
        content: 'You are a reflection assistant. Evaluate task completion objectively. Respond only with valid JSON.',
      },
      {
        role: 'user',
        content: reflectionPrompt,
      },
    ], {
      maxTokens: 500,
      temperature: 0.1, // Low temperature for consistent evaluation
    });

    // Parse the JSON response
    return this.parseReflectionResponse(response.content);
  }

  /**
   * Summarize tool calls from conversation history
   * Includes both tool calls and their results to avoid false negatives
   */
  private summarizeToolCalls(history: Message[]): string {
    const summary: string[] = [];
    let pendingToolCall: string | null = null;

    for (const msg of history) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          pendingToolCall = tc.name;
          summary.push(`- Called: ${tc.name}`);
        }
      }
      if (msg.role === 'tool' && msg.content) {
        // Include a preview of the result to show the tool executed successfully
        const resultPreview = msg.content.slice(0, 200).replace(/\n/g, ' ');
        const toolName = (msg as any).toolName || pendingToolCall || 'unknown';
        const success = !msg.content.toLowerCase().includes('error');
        summary.push(`  → ${toolName} ${success ? 'succeeded' : 'failed'}: ${resultPreview}${msg.content.length > 200 ? '...' : ''}`);
        pendingToolCall = null;
      }
    }

    if (summary.length === 0) {
      return '(No tools were called)';
    }

    return summary.join('\n');
  }

  /**
   * Parse the LLM's reflection response into a ReflectionResult
   */
  private parseReflectionResponse(content: string): ReflectionResult {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        isComplete: Boolean(parsed.isComplete),
        quality: this.validateQuality(parsed.quality),
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        nextAction: parsed.nextAction ? String(parsed.nextAction) : null,
        needsUserInput: Boolean(parsed.needsUserInput),
        userQuestion: parsed.userQuestion ? String(parsed.userQuestion) : null,
      };
    } catch (error) {
      log.warn('Failed to parse reflection response', {
        error: String(error),
        content: content.slice(0, 200),
      });

      // Default to complete on parse failure
      return {
        isComplete: true,
        quality: 'good',
        reasoning: 'Could not parse reflection response - assuming complete',
        nextAction: null,
        needsUserInput: false,
        userQuestion: null,
      };
    }
  }

  /**
   * Validate and normalize quality value
   */
  private validateQuality(value: unknown): 'good' | 'needs_improvement' | 'failed' {
    if (value === 'good' || value === 'needs_improvement' || value === 'failed') {
      return value;
    }
    return 'good';
  }
}
