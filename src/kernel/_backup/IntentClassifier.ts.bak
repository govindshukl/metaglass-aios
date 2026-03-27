/**
 * Intent Classifier
 *
 * Classifies user goals by complexity to determine appropriate handling:
 * - TRIVIAL: Direct response, no tools needed
 * - SIMPLE_QUERY: One tool call, no planning needed
 * - MULTI_STEP: Needs TodoWrite for tracking
 * - COMPLEX: Needs clarification + TodoWrite + verification
 *
 * Uses a two-phase approach:
 * 1. Fast path: Regex pattern matching (instant, no LLM call)
 * 2. LLM path: Haiku classification for nuanced understanding
 *
 * Falls back to regex if LLM is unavailable or fails.
 */

import type { Message } from '../interfaces/types';
import { createLogger } from '../logger';

const log = createLogger('IntentClassifier');

// =============================================================================
// TYPES
// =============================================================================

/**
 * Task complexity levels
 */
export enum TaskComplexity {
  /** No tools needed - direct LLM response (e.g., "what is 2+2", "hello") */
  TRIVIAL = 'trivial',

  /** One tool, no planning needed (e.g., "search for X", "find notes") */
  SIMPLE_QUERY = 'simple_query',

  /** Needs todo, possibly clarification (e.g., "create a note", "plan a trip") */
  MULTI_STEP = 'multi_step',

  /** Needs clarification + todo + verification (e.g., ambiguous goals, 3+ deliverables) */
  COMPLEX = 'complex',
}

/**
 * Suggested actions based on classification
 */
export type SuggestedAction =
  | 'ask_clarification'
  | 'create_todo'
  | 'checkpoint_before_execution'
  | 'verify_output';

/**
 * Result of intent classification
 */
export interface ClassificationResult {
  /** Detected task complexity */
  complexity: TaskComplexity;

  /** Confidence score (0-1) */
  confidence: number;

  /** Suggested actions based on complexity */
  suggestedActions: SuggestedAction[];

  /** Human-readable reasoning for the classification */
  reasoning: string;
}

/**
 * Injectable LLM function for classification.
 * Accepts messages and options, returns raw text content.
 * This decouples the classifier from any specific LLM provider.
 */
export type KernelLLMClassifyFn = (
  messages: Message[],
  options?: { maxTokens?: number; temperature?: number }
) => Promise<{ content: string }>;

// =============================================================================
// PATTERNS (for regex fast-path)
// =============================================================================

/** Verbs indicating creation/building (requires planning) */
const CREATE_VERBS = /\b(create|build|make|implement|design|develop|write|generate|compose|draft|prepare|schedule|plan|organize)\b/i;

/** Verbs indicating search/query (read-only) - exclude trivial questions */
const QUERY_VERBS = /\b(find|search|look\s+up|where\s+is|show\s+me|list|get|fetch)\b/i;

/** Question patterns that are trivial (can be answered without tools) */
const TRIVIAL_QUESTION = /^(what\s+is|how\s+do|what\s+are)\s+\w+(\s+\w+)?[?!.]*$/i;

/** Words indicating ambiguity (user doesn't know exactly what they want) */
const AMBIGUITY_INDICATORS = /\b(something|stuff|things|etc|maybe|probably|perhaps|might|could\s+be|not\s+sure|somehow)\b/i;

/** Greetings and trivial inputs */
const GREETING_PATTERNS = /^(hi|hello|hey|thanks|thank\s+you|good\s+(morning|afternoon|evening)|yo|sup|bye|goodbye|ok|okay|sure|yes|no|yeah|nope|yep)[\s!.?]*$/i;

/** Subjective tasks that need user preferences (plan, guide, schedule, routine, etc.) */
const SUBJECTIVE_TASK_PATTERNS = /\b(plan|guide|schedule|routine|program|curriculum|roadmap|strategy|approach)\b/i;

// =============================================================================
// LLM CLASSIFICATION PROMPT
// =============================================================================

/**
 * System prompt for LLM-based intent classification.
 * Exported for testing and debugging.
 */
export const KERNEL_CLASSIFICATION_SYSTEM_PROMPT = `You are a task complexity classifier for an AI assistant that manages a knowledge base. Your job is to analyze a user's goal and classify its complexity level.

## Complexity Levels

1. **trivial** - No tools needed, direct conversational response.
   - Greetings: "hello", "hi", "thanks", "bye"
   - Simple factual questions: "what is 2+2", "what is a mutex"
   - Acknowledgments: "ok", "sure", "yes", "no"
   - Very short inputs (<15 chars) without action verbs

2. **simple_query** - Single read-only tool call, no planning needed.
   - Search/find patterns: "find notes about React", "search for meeting notes"
   - Show/list patterns: "show me my recent notes", "list files about ML"
   - Lookup patterns: "where is the config file", "look up API docs"

3. **multi_step** - Requires planning and multiple tool calls (creation, modification, multi-phase work).
   - Creation: "create a note about project planning", "write a summary of my research"
   - Modification: "update my study notes with new findings"
   - Planning: "plan a trip to Dubai", "build a learning roadmap"
   - Composition: "generate a weekly review from my notes"

4. **complex** - Ambiguous, has multiple deliverables (3+), requires clarification, or involves subjective decisions with unclear scope.
   - Ambiguous language: "help me with some stuff", "maybe create something about things"
   - Multiple deliverables: "create a plan, build a tracker, and write documentation"
   - Very long goals (100+ chars) with unclear scope
   - Broad/vague requests: "organize everything", "fix all my notes"

## Suggested Actions

Based on complexity, include zero or more actions:
- "ask_clarification" — goal is ambiguous, subjective (plans, guides, schedules, routines), or needs user preferences before proceeding
- "create_todo" — task has multiple steps that should be tracked
- "checkpoint_before_execution" — task is complex enough to warrant verification before executing
- "verify_output" — output should be verified against the original goal

Rules:
- trivial: no actions, confidence 0.90-0.95
- simple_query: no actions, confidence 0.85-0.95
- multi_step: always include "create_todo"; add "ask_clarification" if the goal is subjective or preference-based; confidence 0.75-0.90
- complex: include all four actions; confidence 0.50-0.75 (lower when ambiguity is present)

## Conversation Context

You may receive recent conversation history. Use it to disambiguate:
- Short follow-ups like "do it" or "yes" should be classified based on what was discussed
- Multi-turn context reveals whether a request is part of a larger task

## Response Format

Respond with ONLY a JSON object. No markdown fences, no explanation, no text before or after:
{"complexity":"<level>","confidence":<0.0-1.0>,"suggestedActions":[<actions>],"reasoning":"<brief explanation>"}`;

/**
 * Build the user prompt for LLM classification.
 * Includes recent conversation context and the current goal.
 */
export function buildKernelClassificationPrompt(
  goal: string,
  conversationHistory: Message[]
): string {
  let prompt = '';

  // Include recent conversation context (last 3 user/assistant exchanges, truncated)
  const recentHistory = conversationHistory
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-6) // Last 3 exchanges
    .map(m => `${m.role}: ${m.content.substring(0, 200)}`);

  if (recentHistory.length > 0) {
    prompt += `## Recent Conversation\n${recentHistory.join('\n')}\n\n`;
  }

  prompt += `## Current User Goal\n"${goal}"\n\nClassify this goal.`;

  return prompt;
}

// =============================================================================
// LLM RESPONSE PARSING
// =============================================================================

/** Valid complexity string values */
const VALID_COMPLEXITIES = new Set(['trivial', 'simple_query', 'multi_step', 'complex']);

/** Valid suggested action values */
const VALID_ACTIONS = new Set<SuggestedAction>([
  'ask_clarification',
  'create_todo',
  'checkpoint_before_execution',
  'verify_output',
]);

/** Map from string to TaskComplexity enum */
const COMPLEXITY_MAP: Record<string, TaskComplexity> = {
  'trivial': TaskComplexity.TRIVIAL,
  'simple_query': TaskComplexity.SIMPLE_QUERY,
  'multi_step': TaskComplexity.MULTI_STEP,
  'complex': TaskComplexity.COMPLEX,
};

/**
 * Parse and validate LLM classification response.
 * Validates all fields against expected types and values.
 * Throws on unparseable JSON (caller catches and falls back to regex).
 */
export function parseClassificationResponse(content: string): ClassificationResult {
  // Strip markdown code fences if present
  const cleaned = content
    .replace(/```json?\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Parse JSON
  const parsed = JSON.parse(cleaned);

  // Validate complexity
  if (!parsed.complexity || !VALID_COMPLEXITIES.has(parsed.complexity)) {
    throw new Error(`Invalid complexity value: "${parsed.complexity}". Expected one of: ${[...VALID_COMPLEXITIES].join(', ')}`);
  }

  // Map to enum
  const complexity = COMPLEXITY_MAP[parsed.complexity];

  // Validate and clamp confidence
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.7;

  // Validate suggestedActions — filter to only valid values
  const suggestedActions: SuggestedAction[] = Array.isArray(parsed.suggestedActions)
    ? parsed.suggestedActions.filter((a: string): a is SuggestedAction => VALID_ACTIONS.has(a as SuggestedAction))
    : [];

  // Validate reasoning
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0
    ? `LLM: ${parsed.reasoning}`
    : `LLM classified as ${parsed.complexity}`;

  return {
    complexity,
    confidence,
    suggestedActions,
    reasoning,
  };
}

// =============================================================================
// REGEX CLASSIFICATION (fast-path + fallback)
// =============================================================================

/**
 * Classify user intent using regex pattern matching only.
 * This is the fast-path classifier and fallback when LLM is unavailable.
 *
 * @param goal - User's goal/request text
 * @param conversationHistory - Previous messages (for context, currently unused by regex)
 * @returns Classification result with complexity, confidence, and suggestions
 */
export function classifyIntentRegex(
  goal: string,
  _conversationHistory: Message[]
): ClassificationResult {
  const trimmedGoal = goal.trim();
  const goalLength = trimmedGoal.length;

  // Detect patterns
  const hasCreateVerb = CREATE_VERBS.test(trimmedGoal);
  const hasQueryVerb = QUERY_VERBS.test(trimmedGoal);
  const hasAmbiguity = AMBIGUITY_INDICATORS.test(trimmedGoal);
  const isGreeting = GREETING_PATTERNS.test(trimmedGoal);
  const isTrivialQuestion = TRIVIAL_QUESTION.test(trimmedGoal);
  const isSubjectiveTask = SUBJECTIVE_TASK_PATTERNS.test(trimmedGoal);

  // Count potential deliverables (count commas and "and" separately)
  const commaCount = (trimmedGoal.match(/,/g) || []).length;
  const andCount = (trimmedGoal.match(/\band\b/gi) || []).length;
  const deliverableCount = commaCount + andCount + 1; // Base count of 1

  // Classification logic
  let complexity: TaskComplexity;
  const suggestedActions: SuggestedAction[] = [];
  let confidence = 0.85;
  let reasoning: string;

  // TRIVIAL: Greetings, very short inputs, trivial questions, or empty
  if (goalLength === 0 || isGreeting || isTrivialQuestion || (goalLength < 15 && !hasCreateVerb && !hasQueryVerb)) {
    complexity = TaskComplexity.TRIVIAL;
    reasoning = `Trivial input: ${isGreeting ? 'greeting detected' : goalLength === 0 ? 'empty input' : isTrivialQuestion ? 'trivial question' : 'very short input without action verbs'}`;
    confidence = 0.95;
  }
  // COMPLEX: Ambiguous OR 3+ deliverables OR very long
  else if (hasAmbiguity || deliverableCount >= 3 || goalLength > 100) {
    complexity = TaskComplexity.COMPLEX;
    suggestedActions.push('ask_clarification', 'create_todo', 'checkpoint_before_execution', 'verify_output');

    const reasons: string[] = [];
    if (hasAmbiguity) reasons.push('ambiguous language detected');
    if (deliverableCount >= 3) reasons.push(`${deliverableCount} potential deliverables`);
    if (goalLength > 100) reasons.push(`long goal (${goalLength} chars)`);
    reasoning = `Complex task: ${reasons.join(', ')}`;

    confidence = hasAmbiguity ? 0.6 : 0.75;
  }
  // MULTI_STEP: Has create/plan verbs
  else if (hasCreateVerb) {
    complexity = TaskComplexity.MULTI_STEP;
    suggestedActions.push('create_todo');

    // Subjective tasks (plans, guides, schedules) need clarification about user preferences
    // Even if they don't have explicit ambiguity words
    if (hasAmbiguity || isSubjectiveTask) {
      suggestedActions.unshift('ask_clarification');
      confidence = hasAmbiguity ? 0.7 : 0.8;
    }

    reasoning = `Multi-step task: detected creation verb${hasAmbiguity ? ' with ambiguity' : isSubjectiveTask ? ' (subjective/preference-based)' : ''}`;
  }
  // SIMPLE_QUERY: Has query verbs without create verbs
  else if (hasQueryVerb) {
    complexity = TaskComplexity.SIMPLE_QUERY;
    reasoning = `Simple query: detected query verb (${trimmedGoal.match(QUERY_VERBS)?.[0] || 'query'})`;
    confidence = 0.9;
  }
  // Default to SIMPLE_QUERY for medium-length inputs without clear indicators
  else if (goalLength >= 15 && goalLength <= 50) {
    complexity = TaskComplexity.SIMPLE_QUERY;
    reasoning = `Defaulting to simple query: medium-length input (${goalLength} chars) without clear action indicators`;
    confidence = 0.65;
  }
  // Longer inputs without clear indicators - treat as MULTI_STEP
  else {
    complexity = TaskComplexity.MULTI_STEP;
    suggestedActions.push('create_todo');
    reasoning = `Defaulting to multi-step: longer input (${goalLength} chars) may require planning`;
    confidence = 0.6;
  }

  return {
    complexity,
    confidence,
    suggestedActions,
    reasoning,
  };
}

// =============================================================================
// LLM CLASSIFICATION
// =============================================================================

/**
 * Classify intent using LLM (Haiku).
 * Sends the goal and conversation history to the LLM for nuanced classification.
 */
async function classifyIntentLLM(
  goal: string,
  conversationHistory: Message[],
  llmFn: KernelLLMClassifyFn
): Promise<ClassificationResult> {
  const messages: Message[] = [
    { role: 'system', content: KERNEL_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: buildKernelClassificationPrompt(goal, conversationHistory) },
  ];

  const response = await llmFn(messages, { maxTokens: 256, temperature: 0.0 });

  return parseClassificationResponse(response.content);
}

// =============================================================================
// MAIN CLASSIFICATION FUNCTION (two-phase)
// =============================================================================

/**
 * Classify user intent using a two-phase approach:
 *
 * Phase 1: Regex pre-screen (fast, no LLM call)
 *   - High-confidence TRIVIAL/SIMPLE_QUERY results skip LLM entirely
 *   - This covers greetings, empty input, clear query verbs (~30-40% of inputs)
 *
 * Phase 2: LLM classification (Haiku, ~200-500ms)
 *   - For everything else: creation tasks, ambiguous input, complex goals
 *   - Uses conversation history for richer context understanding
 *
 * Fallback: If LLM fails, returns the regex classification result.
 *
 * @param goal - User's goal/request text
 * @param conversationHistory - Previous messages for context
 * @param llmFn - Optional injectable LLM function (omit for regex-only mode)
 * @returns Classification result with complexity, confidence, and suggestions
 *
 * @example
 * ```typescript
 * // With LLM (recommended)
 * const result = await classifyIntent('plan a trip to Dubai', [], myLLMFn);
 *
 * // Without LLM (regex-only fallback)
 * const result = await classifyIntent('hello', []);
 * ```
 */
export async function classifyIntent(
  goal: string,
  conversationHistory: Message[],
  llmFn?: KernelLLMClassifyFn
): Promise<ClassificationResult> {
  // Phase 1: Fast regex pre-screen
  const regexResult = classifyIntentRegex(goal, conversationHistory);

  // Fast path: Skip LLM for high-confidence trivial/simple classifications
  // These are unambiguous: greetings (0.95), query verbs (0.9), empty input (0.95)
  if (
    regexResult.confidence >= 0.9 &&
    (regexResult.complexity === TaskComplexity.TRIVIAL ||
     regexResult.complexity === TaskComplexity.SIMPLE_QUERY)
  ) {
    log.debug('Intent classified via regex fast path', {
      complexity: regexResult.complexity,
      confidence: regexResult.confidence,
    });
    return regexResult;
  }

  // If no LLM function provided, use regex result (graceful degradation)
  if (!llmFn) {
    log.debug('No LLM function provided, using regex classification', {
      complexity: regexResult.complexity,
    });
    return regexResult;
  }

  // Phase 2: LLM classification for nuanced understanding
  try {
    log.debug('Classifying intent via LLM', { goalPreview: goal.substring(0, 80) });
    const llmResult = await classifyIntentLLM(goal, conversationHistory, llmFn);
    log.info('Intent classified via LLM', {
      complexity: llmResult.complexity,
      confidence: llmResult.confidence,
      suggestedActions: llmResult.suggestedActions,
    });
    return llmResult;
  } catch (error) {
    // Graceful fallback to regex result — system never degrades below current behavior
    log.warn('LLM classification failed, falling back to regex', {
      error: error instanceof Error ? error.message : String(error),
      regexComplexity: regexResult.complexity,
    });
    return {
      ...regexResult,
      reasoning: `${regexResult.reasoning} (LLM fallback: ${error instanceof Error ? error.message : 'unknown error'})`,
    };
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a task is simple enough to skip TodoWrite entirely.
 *
 * @param classification - Result from classifyIntent
 * @returns true if TodoWrite can be skipped
 */
export function canSkipTodoWrite(classification: ClassificationResult): boolean {
  return (
    classification.complexity === TaskComplexity.TRIVIAL ||
    classification.complexity === TaskComplexity.SIMPLE_QUERY
  );
}

/**
 * Check if a task needs clarification before proceeding.
 *
 * @param classification - Result from classifyIntent
 * @returns true if clarification should be requested
 */
export function needsClarification(classification: ClassificationResult): boolean {
  return classification.suggestedActions.includes('ask_clarification');
}
