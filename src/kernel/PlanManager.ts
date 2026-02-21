/**
 * PlanManager - Planning mode for AIOS
 *
 * Implements EnterPlanMode/ExitPlanMode pattern:
 * - Explicit planning mode state
 * - Plan content management
 * - Approval workflow
 */

import type { EventEmitter, PlanState, PlanApprovalStatus } from '../interfaces';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result from PlanManager operations
 */
export interface PlanResult {
  success: boolean;
  error?: string;
  warning?: string;
}

/**
 * Options for waiting for approval
 */
export interface ApprovalWaitOptions {
  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs?: number;
}

/**
 * Callback for state changes
 */
export type PlanStateCallback = (state: PlanState) => void;

// =============================================================================
// PLAN MANAGER
// =============================================================================

/**
 * PlanManager class
 *
 * Manages planning mode state and approval workflow.
 */
export class PlanManager {
  private _isPlanning: boolean = false;
  private _planContent: string | undefined = undefined;
  private _approvalStatus: PlanApprovalStatus = 'pending';

  private events: EventEmitter;
  private subscribers: Set<PlanStateCallback> = new Set();
  private approvalResolver: ((approved: boolean) => void) | null = null;

  constructor(events: EventEmitter) {
    this.events = events;
  }

  // ===========================================================================
  // PUBLIC API - STATE
  // ===========================================================================

  /**
   * Check if in planning mode
   */
  isPlanning(): boolean {
    return this._isPlanning;
  }

  /**
   * Get current state snapshot
   */
  getState(): PlanState {
    return {
      isPlanning: this._isPlanning,
      planContent: this._planContent,
      approvalStatus: this._approvalStatus,
    };
  }

  // ===========================================================================
  // PUBLIC API - PLAN MODE CONTROL
  // ===========================================================================

  /**
   * Enter planning mode
   */
  enter(): void {
    this._isPlanning = true;
    this._planContent = undefined;
    this._approvalStatus = 'pending';

    this.events.emit('plan:entered', undefined);
    this.notifySubscribers();
  }

  /**
   * Exit planning mode
   */
  exit(approved: boolean): PlanResult {
    if (!this._isPlanning) {
      return { success: false, error: 'Not in planning mode' };
    }

    const warning = !this._planContent ? 'Exiting with no plan content' : undefined;

    this._isPlanning = false;
    this._approvalStatus = approved ? 'approved' : 'rejected';

    this.events.emit('plan:exited', { approved });
    this.notifySubscribers();

    // Resolve any waiting approval promise
    if (this.approvalResolver) {
      this.approvalResolver(approved);
      this.approvalResolver = null;
    }

    return { success: true, warning };
  }

  // ===========================================================================
  // PUBLIC API - PLAN CONTENT
  // ===========================================================================

  /**
   * Set plan content
   */
  setPlanContent(content: string): PlanResult {
    if (!this._isPlanning) {
      return { success: false, error: 'Not in planning mode' };
    }

    this._planContent = content;

    this.events.emit('plan:updated', { content });
    this.notifySubscribers();

    return { success: true };
  }

  /**
   * Append to plan content
   */
  appendToPlan(content: string): PlanResult {
    if (!this._isPlanning) {
      return { success: false, error: 'Not in planning mode' };
    }

    this._planContent = (this._planContent ?? '') + content;

    this.events.emit('plan:updated', { content: this._planContent });
    this.notifySubscribers();

    return { success: true };
  }

  // ===========================================================================
  // PUBLIC API - APPROVAL
  // ===========================================================================

  /**
   * Approve the plan
   */
  approve(): PlanResult {
    if (!this._isPlanning) {
      return { success: false, error: 'Not in planning mode' };
    }

    return this.exit(true);
  }

  /**
   * Reject the plan
   */
  reject(): PlanResult {
    if (!this._isPlanning) {
      return { success: false, error: 'Not in planning mode' };
    }

    return this.exit(false);
  }

  /**
   * Wait for user approval
   */
  async waitForApproval(options?: ApprovalWaitOptions): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 0;

    return new Promise<boolean>((resolve) => {
      // Set up resolver
      this.approvalResolver = resolve;

      // Set up timeout if specified
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.approvalResolver === resolve) {
            this.approvalResolver = null;
            this._approvalStatus = 'rejected';
            this._isPlanning = false;
            this.notifySubscribers();
            resolve(false);
          }
        }, timeoutMs);
      }
    });
  }

  // ===========================================================================
  // PUBLIC API - SUBSCRIPTION
  // ===========================================================================

  /**
   * Subscribe to state changes
   */
  subscribe(callback: PlanStateCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Notify subscribers of state change
   */
  private notifySubscribers(): void {
    const state = this.getState();
    for (const callback of this.subscribers) {
      callback(state);
    }
  }
}
