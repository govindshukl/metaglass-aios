/**
 * IntentClassifier Tests
 *
 * TDD tests for intent classification that determines task complexity.
 * This allows skipping TodoWrite for trivial/simple queries.
 *
 * Tests cover:
 * - Regex-only classification (fast path / no LLM)
 * - LLM classification with mock functions
 * - Two-phase classification flow (regex → LLM)
 * - Graceful fallback when LLM fails
 * - Response parsing and validation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TaskComplexity,
  classifyIntent,
  classifyIntentRegex,
  canSkipTodoWrite,
  needsClarification,
  parseClassificationResponse,
  buildKernelClassificationPrompt,
  type ClassificationResult,
  type KernelLLMClassifyFn,
} from '../IntentClassifier';

// =============================================================================
// REGEX CLASSIFICATION TESTS (fast path)
// =============================================================================

describe('IntentClassifier', () => {
  describe('classifyIntentRegex', () => {
    // =========================================================================
    // TRIVIAL - No tools needed, direct response
    // =========================================================================
    describe('TRIVIAL classification', () => {
      it('should classify "what is 2+2" as TRIVIAL', () => {
        const result = classifyIntentRegex('what is 2+2', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });

      it('should classify "hello" as TRIVIAL', () => {
        const result = classifyIntentRegex('hello', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });

      it('should classify "hi there" as TRIVIAL', () => {
        const result = classifyIntentRegex('hi there', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });

      it('should classify "thanks" as TRIVIAL', () => {
        const result = classifyIntentRegex('thanks', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });

      it('should classify short greetings under 15 chars as TRIVIAL', () => {
        const result = classifyIntentRegex('hey!', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });
    });

    // =========================================================================
    // SIMPLE_QUERY - One tool, no planning needed
    // =========================================================================
    describe('SIMPLE_QUERY classification', () => {
      it('should classify "search for notes about X" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('search for notes about project alpha', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "find my meeting notes" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('find my meeting notes', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "what files are in vault" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('what files are in the vault', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "show me notes from last week" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('show me notes from last week', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "look up the api docs" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('look up the api docs', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "where is the config file" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('where is the config file', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "how do I use the search" as SIMPLE_QUERY', () => {
        const result = classifyIntentRegex('how do I use the search feature', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });
    });

    // =========================================================================
    // MULTI_STEP - Needs todo, possibly clarification
    // =========================================================================
    describe('MULTI_STEP classification', () => {
      it('should classify "create a note about X" as MULTI_STEP', () => {
        const result = classifyIntentRegex('create a note about project planning', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "plan a trip to Dubai" as MULTI_STEP', () => {
        const result = classifyIntentRegex('plan a trip to Dubai', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "write a summary of my notes" as MULTI_STEP', () => {
        const result = classifyIntentRegex('write a summary of my notes', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "make a presentation" as MULTI_STEP', () => {
        const result = classifyIntentRegex('make a presentation about Q4 results', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "build a todo list" as MULTI_STEP', () => {
        const result = classifyIntentRegex('build a todo list for the project', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "implement the new feature" as MULTI_STEP', () => {
        const result = classifyIntentRegex('implement the new feature', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "design a system for X" as MULTI_STEP', () => {
        const result = classifyIntentRegex('design a system for user tracking', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "generate a report" as MULTI_STEP', () => {
        const result = classifyIntentRegex('generate a report on weekly progress', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify "schedule meetings for next week" as MULTI_STEP', () => {
        const result = classifyIntentRegex('schedule meetings for next week', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });
    });

    // =========================================================================
    // COMPLEX - Needs clarification + todo + verification
    // =========================================================================
    describe('COMPLEX classification', () => {
      it('should classify goals with 3+ deliverables (multiple "and") as COMPLEX', () => {
        const result = classifyIntentRegex(
          'create a presentation and write documentation and update the tests',
          []
        );
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify goals with multiple commas (deliverables) as COMPLEX', () => {
        const result = classifyIntentRegex(
          'I need notes, a summary, an action plan, and follow-up tasks',
          []
        );
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify ambiguous goals with "something" as COMPLEX', () => {
        const result = classifyIntentRegex('create something for the meeting', []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify ambiguous goals with "stuff" as COMPLEX', () => {
        const result = classifyIntentRegex('help me organize my stuff', []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify ambiguous goals with "things" as COMPLEX', () => {
        const result = classifyIntentRegex('can you do some things for the project', []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify goals with "etc" as COMPLEX (implies ambiguity)', () => {
        const result = classifyIntentRegex('update the docs, tests, etc', []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify goals with "maybe" as COMPLEX (uncertainty)', () => {
        const result = classifyIntentRegex('maybe create a new design for the homepage', []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should classify very long goals (100+ chars) as COMPLEX', () => {
        const longGoal =
          'I need you to help me create a comprehensive project plan that includes milestones, deliverables, resource allocation, and timeline estimates for the next quarter';
        expect(longGoal.length).toBeGreaterThan(100);
        const result = classifyIntentRegex(longGoal, []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });
    });

    // =========================================================================
    // Edge cases
    // =========================================================================
    describe('edge cases', () => {
      it('should handle empty string as TRIVIAL', () => {
        const result = classifyIntentRegex('', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });

      it('should handle very short query verbs', () => {
        // "find X" is short but has query verb
        const result = classifyIntentRegex('find notes', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should prioritize create verbs over query verbs', () => {
        // "create a search" has both create and search
        const result = classifyIntentRegex('create a search interface', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });
    });
  });

  // ===========================================================================
  // ASYNC classifyIntent TESTS (two-phase: regex + optional LLM)
  // ===========================================================================

  describe('classifyIntent (async, two-phase)', () => {
    describe('without LLM (regex-only mode)', () => {
      it('should classify "hello" as TRIVIAL via regex fast path', async () => {
        const result = await classifyIntent('hello', []);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      });

      it('should classify "search for notes" as SIMPLE_QUERY via regex fast path', async () => {
        const result = await classifyIntent('search for notes about React', []);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
      });

      it('should classify "create a note" as MULTI_STEP via regex', async () => {
        const result = await classifyIntent('create a note about planning', []);
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      });

      it('should classify ambiguous goals as COMPLEX via regex', async () => {
        const result = await classifyIntent('help me organize my stuff', []);
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      });

      it('should return all required fields', async () => {
        const result = await classifyIntent('test goal', []);
        expect(result).toHaveProperty('complexity');
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('suggestedActions');
        expect(result).toHaveProperty('reasoning');
      });
    });

    describe('with LLM', () => {
      it('should skip LLM for trivial greetings (regex fast path)', async () => {
        const mockLlm = vi.fn();
        const result = await classifyIntent('hello', [], mockLlm);
        expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
        expect(mockLlm).not.toHaveBeenCalled();
      });

      it('should skip LLM for high-confidence simple queries (regex fast path)', async () => {
        const mockLlm = vi.fn();
        const result = await classifyIntent('find my notes', [], mockLlm);
        expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
        expect(mockLlm).not.toHaveBeenCalled();
      });

      it('should call LLM for non-trivial goals', async () => {
        const mockLlm: KernelLLMClassifyFn = vi.fn().mockResolvedValue({
          content: JSON.stringify({
            complexity: 'multi_step',
            confidence: 0.85,
            suggestedActions: ['create_todo'],
            reasoning: 'Trip planning requires multiple steps',
          }),
        });

        const result = await classifyIntent('plan a trip to Dubai', [], mockLlm);
        expect(mockLlm).toHaveBeenCalledOnce();
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
        expect(result.confidence).toBe(0.85);
        expect(result.reasoning).toContain('LLM:');
      });

      it('should call LLM for complex/ambiguous goals', async () => {
        const mockLlm: KernelLLMClassifyFn = vi.fn().mockResolvedValue({
          content: JSON.stringify({
            complexity: 'complex',
            confidence: 0.6,
            suggestedActions: ['ask_clarification', 'create_todo', 'checkpoint_before_execution', 'verify_output'],
            reasoning: 'Ambiguous request with unclear scope',
          }),
        });

        const result = await classifyIntent('help me with some stuff', [], mockLlm);
        expect(mockLlm).toHaveBeenCalledOnce();
        expect(result.complexity).toBe(TaskComplexity.COMPLEX);
        expect(result.suggestedActions).toContain('ask_clarification');
      });

      it('should fall back to regex on LLM failure', async () => {
        const mockLlm: KernelLLMClassifyFn = vi.fn().mockRejectedValue(
          new Error('API rate limit exceeded')
        );

        const result = await classifyIntent('create a note about planning', [], mockLlm);
        expect(mockLlm).toHaveBeenCalledOnce();
        // Should fall back to regex result (MULTI_STEP for create verb)
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
        expect(result.reasoning).toContain('LLM fallback');
        expect(result.reasoning).toContain('API rate limit exceeded');
      });

      it('should fall back to regex on malformed LLM JSON', async () => {
        const mockLlm: KernelLLMClassifyFn = vi.fn().mockResolvedValue({
          content: 'This is not valid JSON at all',
        });

        const result = await classifyIntent('create a note about planning', [], mockLlm);
        expect(mockLlm).toHaveBeenCalledOnce();
        // Should fall back to regex result
        expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
        expect(result.reasoning).toContain('LLM fallback');
      });

      it('should pass conversation history to LLM for context', async () => {
        const mockLlm: KernelLLMClassifyFn = vi.fn().mockResolvedValue({
          content: JSON.stringify({
            complexity: 'multi_step',
            confidence: 0.8,
            suggestedActions: ['create_todo'],
            reasoning: 'Follow-up to previous conversation about note creation',
          }),
        });

        const history = [
          { role: 'user' as const, content: 'I want to create a study plan' },
          { role: 'assistant' as const, content: 'Sure, what subject?' },
        ];

        await classifyIntent('make it about machine learning', history, mockLlm);

        // Verify the LLM was called with messages that include conversation context
        expect(mockLlm).toHaveBeenCalledOnce();
        const callArgs = mockLlm.mock.calls[0];
        const messages = callArgs[0];
        expect(messages).toHaveLength(2); // system + user prompt
        expect(messages[0].role).toBe('system');
        // The user prompt should contain conversation history
        expect(messages[1].content).toContain('Recent Conversation');
        expect(messages[1].content).toContain('machine learning');
      });

      it('should pass correct options to LLM function', async () => {
        const mockLlm: KernelLLMClassifyFn = vi.fn().mockResolvedValue({
          content: JSON.stringify({
            complexity: 'multi_step',
            confidence: 0.85,
            suggestedActions: ['create_todo'],
            reasoning: 'Test',
          }),
        });

        await classifyIntent('create a note', [], mockLlm);

        const callArgs = mockLlm.mock.calls[0];
        const options = callArgs[1];
        expect(options).toEqual({ maxTokens: 256, temperature: 0.0 });
      });
    });
  });

  // ===========================================================================
  // PARSE CLASSIFICATION RESPONSE TESTS
  // ===========================================================================

  describe('parseClassificationResponse', () => {
    it('should parse valid JSON response', () => {
      const result = parseClassificationResponse(JSON.stringify({
        complexity: 'multi_step',
        confidence: 0.85,
        suggestedActions: ['create_todo'],
        reasoning: 'Requires multiple steps',
      }));

      expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      expect(result.confidence).toBe(0.85);
      expect(result.suggestedActions).toEqual(['create_todo']);
      expect(result.reasoning).toContain('Requires multiple steps');
    });

    it('should strip markdown code fences', () => {
      const result = parseClassificationResponse(
        '```json\n{"complexity":"trivial","confidence":0.95,"suggestedActions":[],"reasoning":"greeting"}\n```'
      );

      expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
      expect(result.confidence).toBe(0.95);
    });

    it('should clamp confidence to 0-1 range', () => {
      const high = parseClassificationResponse(JSON.stringify({
        complexity: 'trivial',
        confidence: 5.0,
        suggestedActions: [],
        reasoning: 'test',
      }));
      expect(high.confidence).toBe(1.0);

      const low = parseClassificationResponse(JSON.stringify({
        complexity: 'trivial',
        confidence: -0.5,
        suggestedActions: [],
        reasoning: 'test',
      }));
      expect(low.confidence).toBe(0);
    });

    it('should default confidence to 0.7 if missing', () => {
      const result = parseClassificationResponse(JSON.stringify({
        complexity: 'simple_query',
        suggestedActions: [],
        reasoning: 'test',
      }));
      expect(result.confidence).toBe(0.7);
    });

    it('should filter invalid suggestedActions', () => {
      const result = parseClassificationResponse(JSON.stringify({
        complexity: 'complex',
        confidence: 0.6,
        suggestedActions: ['ask_clarification', 'invalid_action', 'create_todo', 'bogus'],
        reasoning: 'test',
      }));

      expect(result.suggestedActions).toEqual(['ask_clarification', 'create_todo']);
    });

    it('should handle missing suggestedActions', () => {
      const result = parseClassificationResponse(JSON.stringify({
        complexity: 'trivial',
        confidence: 0.9,
        reasoning: 'test',
      }));

      expect(result.suggestedActions).toEqual([]);
    });

    it('should validate complexity enum values', () => {
      expect(() => parseClassificationResponse(JSON.stringify({
        complexity: 'invalid_level',
        confidence: 0.5,
        suggestedActions: [],
        reasoning: 'test',
      }))).toThrow('Invalid complexity value');
    });

    it('should throw on missing complexity', () => {
      expect(() => parseClassificationResponse(JSON.stringify({
        confidence: 0.5,
        suggestedActions: [],
        reasoning: 'test',
      }))).toThrow('Invalid complexity value');
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseClassificationResponse('not json')).toThrow();
    });

    it('should provide default reasoning if missing', () => {
      const result = parseClassificationResponse(JSON.stringify({
        complexity: 'multi_step',
        confidence: 0.8,
        suggestedActions: ['create_todo'],
      }));

      expect(result.reasoning).toContain('multi_step');
    });

    it('should prefix LLM reasoning for traceability', () => {
      const result = parseClassificationResponse(JSON.stringify({
        complexity: 'complex',
        confidence: 0.6,
        suggestedActions: ['ask_clarification'],
        reasoning: 'Ambiguous request',
      }));

      expect(result.reasoning).toMatch(/^LLM:/);
    });
  });

  // ===========================================================================
  // BUILD CLASSIFICATION PROMPT TESTS
  // ===========================================================================

  describe('buildKernelClassificationPrompt', () => {
    it('should include the goal in the prompt', () => {
      const prompt = buildKernelClassificationPrompt('plan a trip to Dubai', []);
      expect(prompt).toContain('plan a trip to Dubai');
      expect(prompt).toContain('Current User Goal');
    });

    it('should include conversation history when available', () => {
      const history = [
        { role: 'user' as const, content: 'I want to learn Python' },
        { role: 'assistant' as const, content: 'Great choice! What level are you?' },
      ];

      const prompt = buildKernelClassificationPrompt('create a learning plan', history);
      expect(prompt).toContain('Recent Conversation');
      expect(prompt).toContain('learn Python');
    });

    it('should truncate long history messages', () => {
      const longContent = 'a'.repeat(300);
      const history = [
        { role: 'user' as const, content: longContent },
      ];

      const prompt = buildKernelClassificationPrompt('test', history);
      // Should truncate to 200 chars
      expect(prompt).not.toContain(longContent);
      expect(prompt.length).toBeLessThan(longContent.length);
    });

    it('should include only last 3 exchanges (6 messages)', () => {
      const history = [
        { role: 'user' as const, content: 'msg1' },
        { role: 'assistant' as const, content: 'resp1' },
        { role: 'user' as const, content: 'msg2' },
        { role: 'assistant' as const, content: 'resp2' },
        { role: 'user' as const, content: 'msg3' },
        { role: 'assistant' as const, content: 'resp3' },
        { role: 'user' as const, content: 'msg4' },
        { role: 'assistant' as const, content: 'resp4' },
      ];

      const prompt = buildKernelClassificationPrompt('test', history);
      // Should NOT include msg1/resp1 (too old)
      expect(prompt).not.toContain('msg1');
      expect(prompt).not.toContain('resp1');
      // Should include msg3/resp3 and msg4/resp4
      expect(prompt).toContain('msg3');
      expect(prompt).toContain('resp4');
    });

    it('should skip non-user/assistant messages', () => {
      const history = [
        { role: 'system' as const, content: 'system prompt' },
        { role: 'user' as const, content: 'user message' },
        { role: 'tool' as const, content: 'tool result' },
      ];

      const prompt = buildKernelClassificationPrompt('test', history);
      expect(prompt).not.toContain('system prompt');
      expect(prompt).not.toContain('tool result');
      expect(prompt).toContain('user message');
    });
  });

  // ===========================================================================
  // SUGGESTED ACTIONS TESTS
  // ===========================================================================

  describe('suggestedActions', () => {
    it('should suggest ask_clarification for COMPLEX tasks', () => {
      const result = classifyIntentRegex('create something for the meeting', []);
      expect(result.suggestedActions).toContain('ask_clarification');
    });

    it('should suggest create_todo for MULTI_STEP tasks', () => {
      const result = classifyIntentRegex('create a note about X', []);
      expect(result.suggestedActions).toContain('create_todo');
    });

    it('should suggest create_todo for COMPLEX tasks', () => {
      const result = classifyIntentRegex('create something complex with many things', []);
      expect(result.suggestedActions).toContain('create_todo');
    });

    it('should suggest checkpoint_before_execution for COMPLEX tasks', () => {
      const complexResult = classifyIntentRegex(
        'build a complete system for tracking things and stuff',
        []
      );
      expect(complexResult.suggestedActions).toContain('checkpoint_before_execution');
    });

    it('should suggest verify_output for COMPLEX tasks', () => {
      const result = classifyIntentRegex('create something with stuff and things', []);
      expect(result.suggestedActions).toContain('verify_output');
    });

    it('should NOT suggest any actions for TRIVIAL tasks', () => {
      const result = classifyIntentRegex('hello', []);
      expect(result.suggestedActions).toHaveLength(0);
    });

    it('should NOT suggest actions for SIMPLE_QUERY tasks', () => {
      const result = classifyIntentRegex('search for notes', []);
      expect(result.suggestedActions).toHaveLength(0);
    });

    it('should suggest ask_clarification when ambiguity detected in MULTI_STEP', () => {
      const result = classifyIntentRegex('create something for the project', []);
      // Has create verb but also "something" which is ambiguous
      expect(result.suggestedActions).toContain('ask_clarification');
    });
  });

  // ===========================================================================
  // CONFIDENCE SCORING TESTS
  // ===========================================================================

  describe('confidence scoring', () => {
    it('should return lower confidence for ambiguous goals', () => {
      const ambiguous = classifyIntentRegex('create something for the meeting', []);
      const clear = classifyIntentRegex('create a note titled Meeting Notes', []);

      expect(ambiguous.confidence).toBeLessThan(clear.confidence);
    });

    it('should return higher confidence for clear goals', () => {
      const result = classifyIntentRegex('search for notes about project alpha', []);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should return lower confidence when "maybe" or "probably" is used', () => {
      const uncertain = classifyIntentRegex('maybe create a new document', []);
      const certain = classifyIntentRegex('create a new document', []);

      expect(uncertain.confidence).toBeLessThan(certain.confidence);
    });

    it('confidence should be between 0 and 1', () => {
      const result = classifyIntentRegex('any random goal text here', []);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ===========================================================================
  // RESULT STRUCTURE TESTS
  // ===========================================================================

  describe('ClassificationResult structure', () => {
    it('should return all required fields from regex', () => {
      const result = classifyIntentRegex('test goal', []);

      expect(result).toHaveProperty('complexity');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('suggestedActions');
      expect(result).toHaveProperty('reasoning');
    });

    it('should have valid complexity enum value', () => {
      const result = classifyIntentRegex('test goal', []);
      expect(Object.values(TaskComplexity)).toContain(result.complexity);
    });

    it('should have array for suggestedActions', () => {
      const result = classifyIntentRegex('test goal', []);
      expect(Array.isArray(result.suggestedActions)).toBe(true);
    });

    it('should have non-empty reasoning string', () => {
      const result = classifyIntentRegex('create a note', []);
      expect(typeof result.reasoning).toBe('string');
      expect(result.reasoning.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // HELPER FUNCTION TESTS
  // ===========================================================================

  describe('canSkipTodoWrite', () => {
    it('should return true for TRIVIAL', () => {
      expect(canSkipTodoWrite({ complexity: TaskComplexity.TRIVIAL, confidence: 0.9, suggestedActions: [], reasoning: '' })).toBe(true);
    });

    it('should return true for SIMPLE_QUERY', () => {
      expect(canSkipTodoWrite({ complexity: TaskComplexity.SIMPLE_QUERY, confidence: 0.9, suggestedActions: [], reasoning: '' })).toBe(true);
    });

    it('should return false for MULTI_STEP', () => {
      expect(canSkipTodoWrite({ complexity: TaskComplexity.MULTI_STEP, confidence: 0.8, suggestedActions: ['create_todo'], reasoning: '' })).toBe(false);
    });

    it('should return false for COMPLEX', () => {
      expect(canSkipTodoWrite({ complexity: TaskComplexity.COMPLEX, confidence: 0.6, suggestedActions: ['ask_clarification'], reasoning: '' })).toBe(false);
    });
  });

  describe('needsClarification', () => {
    it('should return true when ask_clarification is in suggestedActions', () => {
      expect(needsClarification({ complexity: TaskComplexity.COMPLEX, confidence: 0.6, suggestedActions: ['ask_clarification', 'create_todo'], reasoning: '' })).toBe(true);
    });

    it('should return false when ask_clarification is not in suggestedActions', () => {
      expect(needsClarification({ complexity: TaskComplexity.MULTI_STEP, confidence: 0.8, suggestedActions: ['create_todo'], reasoning: '' })).toBe(false);
    });
  });

  // ===========================================================================
  // REAL-WORLD SCENARIO TESTS
  // ===========================================================================

  describe('real-world scenarios', () => {
    it('trip planning should be MULTI_STEP (clear create verb)', () => {
      const result = classifyIntentRegex('plan a trip to Dubai', []);
      expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
      expect(result.suggestedActions).toContain('create_todo');
    });

    it('vague trip planning should be COMPLEX', () => {
      const result = classifyIntentRegex('plan something for my vacation maybe', []);
      expect(result.complexity).toBe(TaskComplexity.COMPLEX);
      expect(result.suggestedActions).toContain('ask_clarification');
    });

    it('simple note search should be SIMPLE_QUERY', () => {
      const result = classifyIntentRegex('find my notes about the meeting', []);
      expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
    });

    it('creating a note with clear title should be MULTI_STEP', () => {
      const result = classifyIntentRegex('create a note called Project Ideas', []);
      expect(result.complexity).toBe(TaskComplexity.MULTI_STEP);
    });

    it('casual greeting should be TRIVIAL', () => {
      const result = classifyIntentRegex('good morning!', []);
      expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
    });

    it('async classifyIntent should match regex for greetings', async () => {
      const result = await classifyIntent('good morning!', []);
      expect(result.complexity).toBe(TaskComplexity.TRIVIAL);
    });

    it('async classifyIntent should match regex for searches', async () => {
      const result = await classifyIntent('find my notes about React', []);
      expect(result.complexity).toBe(TaskComplexity.SIMPLE_QUERY);
    });
  });
});
