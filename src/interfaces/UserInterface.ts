/**
 * UserInterface Interface
 *
 * Abstraction for user interactions during agent execution.
 * Enables asking questions, confirmations, and notifications.
 */

import type { Question, QuestionOption, NotificationType } from './types';

/**
 * Request for user interaction
 */
export interface InteractionRequest {
  /** Type of interaction */
  type: 'question' | 'confirmation' | 'choice' | 'multi-choice';
  /** Question text */
  question: string;
  /** Short header for display */
  header?: string;
  /** Available options */
  options?: QuestionOption[];
  /** Allow custom "Other" input */
  allowOther?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * User Interface abstraction
 *
 * Provides methods for agent-user interactions during execution.
 */
export interface UserInterface {
  /**
   * Ask the user a question
   *
   * @param request - Interaction request
   * @returns User's answer (string for single, array for multi)
   * @throws If user cancels or timeout
   */
  ask(request: InteractionRequest): Promise<string | string[]>;

  /**
   * Ask for confirmation
   *
   * @param message - Confirmation message
   * @returns Whether user confirmed
   */
  confirm(message: string): Promise<boolean>;

  /**
   * Show a notification to the user
   *
   * @param message - Notification message
   * @param type - Notification type (info, success, warning, error)
   */
  notify(message: string, type?: NotificationType): void;

  /**
   * Ask multiple structured questions (AskUserQuestion spec)
   *
   * @param questions - Array of questions (1-4)
   * @returns Answers keyed by header
   */
  askMultiple(questions: Question[]): Promise<Record<string, string | string[]>>;

  /**
   * Check if there's a pending interaction
   *
   * @returns Whether waiting for user input
   */
  isPending(): boolean;

  /**
   * Cancel any pending interaction
   */
  cancel(): void;
}

/**
 * User Interface factory
 */
export interface UserInterfaceFactory {
  /**
   * Create a UI instance for a specific context
   *
   * @param context - UI context (e.g., 'modal', 'inline', 'cli')
   * @returns UserInterface instance
   */
  create(context: string): UserInterface;
}
