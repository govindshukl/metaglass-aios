/**
 * GoalContextProvider - Stub implementation for AIOS
 *
 * This is a minimal stub that provides the interface expected by ConversationEngine.
 * In Metaglass, this is replaced with a full implementation that connects to the goal system.
 *
 * For standalone AIOS usage, goals are optional - this stub returns no-ops.
 */

import { createLogger } from '../logger';

const log = createLogger('GoalContextProvider');

/**
 * Goal context state
 */
interface GoalContext {
  goalId: string | null;
  goalName: string | null;
}

/**
 * GoalContextProvider class
 *
 * Provides a minimal implementation that can be overridden by integrators.
 */
class GoalContextProviderImpl {
  private context: GoalContext = {
    goalId: null,
    goalName: null,
  };

  /**
   * Set the active goal for context
   */
  setActiveGoal(goalId: string, goalName: string): void {
    this.context.goalId = goalId;
    this.context.goalName = goalName;
    log.debug('Active goal set', { goalId, goalName });
  }

  /**
   * Clear the active goal
   */
  clearActiveGoal(): void {
    this.context.goalId = null;
    this.context.goalName = null;
    log.debug('Active goal cleared');
  }

  /**
   * Check if there's an active goal
   */
  hasActiveGoal(): boolean {
    return this.context.goalId !== null;
  }

  /**
   * Get the current active goal ID
   */
  getActiveGoalId(): string | null {
    return this.context.goalId;
  }

  /**
   * Get the current active goal name
   */
  getActiveGoalName(): string | null {
    return this.context.goalName;
  }

  /**
   * Get context for the current goal (stub - returns empty)
   */
  async getGoalContext(): Promise<string> {
    if (!this.context.goalId) {
      return '';
    }
    // Stub: In full implementation, this would fetch goal details from storage
    return `Goal: ${this.context.goalName || this.context.goalId}`;
  }
}

// Export singleton instance
export const goalContextProvider = new GoalContextProviderImpl();
