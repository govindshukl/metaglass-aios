/**
 * TodoManager - Task management for AIOS
 *
 * Implements TodoWrite-style task tracking with:
 * - Only one task in_progress at a time
 * - Immediate completion updates
 * - Event emission for UI reactivity
 */

import type { Todo, TodoStatus, EventEmitter } from '../interfaces';
import { createLogger } from '../logger';

const log = createLogger('TodoManager');

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result from TodoManager operations
 */
export interface TodoResult {
  success: boolean;
  error?: string;
}

/**
 * Callback for todo changes
 */
export type TodoChangeCallback = (todos: Todo[]) => void;

// =============================================================================
// VALIDATION
// =============================================================================

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];

function validateTodo(todo: Todo): string | null {
  if (!todo.content || todo.content.trim() === '') {
    return 'Todo content cannot be empty';
  }
  if (!todo.activeForm || todo.activeForm.trim() === '') {
    return 'Todo activeForm cannot be empty';
  }
  if (!VALID_STATUSES.includes(todo.status)) {
    return `Invalid status: ${todo.status}. Must be one of: ${VALID_STATUSES.join(', ')}`;
  }
  return null;
}

// =============================================================================
// TODO MANAGER
// =============================================================================

/**
 * TodoManager class
 *
 * Manages a list of todos with validation and events.
 */
export class TodoManager {
  private todos: Todo[] = [];
  private subscribers: Set<TodoChangeCallback> = new Set();
  private events: EventEmitter;
  private isProcessingEvent: boolean = false;

  constructor(events: EventEmitter) {
    this.events = events;

    log.info('TodoManager constructor - subscribing to todo:updated events');

    // Subscribe to todo:updated events from ConversationEngine
    // This allows external updates (from LLM tool calls) to sync with this manager
    this.events.on('todo:updated', (payload) => {
      log.info('TodoManager received todo:updated event', {
        isProcessingEvent: this.isProcessingEvent,
        payload,
      });

      // Prevent infinite loop - don't process events we emitted
      if (this.isProcessingEvent) {
        log.debug('Ignoring event - self-emitted');
        return;
      }

      const todos = (payload as { todos: Todo[] }).todos;
      this.handleExternalUpdate(todos);
    });

    log.info('TodoManager constructor complete - subscription active');
  }

  /**
   * Handle external todo updates (from ConversationEngine)
   * Updates internal state and notifies subscribers without re-emitting events
   */
  private handleExternalUpdate(todos: Todo[]): void {
    log.info('handleExternalUpdate called', { todoCount: todos.length, todos });

    // Validate all todos
    for (const todo of todos) {
      const error = validateTodo(todo);
      if (error) {
        log.warn('Invalid todo from external update', { error, todo });
        return;
      }
    }

    // Validate: only one in_progress
    const inProgress = todos.filter(t => t.status === 'in_progress');
    if (inProgress.length > 1) {
      log.warn('External update has multiple in_progress tasks');
      return;
    }

    // Update internal state
    this.todos = todos.map(t => ({ ...t }));
    log.info('Internal todos updated', { todoCount: this.todos.length });

    // Notify subscribers (UI updates)
    log.info('Notifying subscribers', { subscriberCount: this.subscribers.size });
    this.notifySubscribers();
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Get all todos
   */
  getTodos(): Todo[] {
    return [...this.todos];
  }

  /**
   * Get count of todos
   */
  count(): number {
    return this.todos.length;
  }

  /**
   * Set the entire todo list (replaces existing)
   */
  setTodos(todos: Todo[]): TodoResult {
    // Validate all todos
    for (const todo of todos) {
      const error = validateTodo(todo);
      if (error) {
        return { success: false, error };
      }
    }

    // Validate: only one in_progress
    const inProgress = todos.filter(t => t.status === 'in_progress');
    if (inProgress.length > 1) {
      return {
        success: false,
        error: 'Only one task can be in_progress at a time',
      };
    }

    // Detect status changes for events
    const previousTodos = this.todos;
    this.todos = todos.map(t => ({ ...t })); // Deep copy

    // Emit events for status changes
    this.emitStatusChangeEvents(previousTodos, this.todos);

    // Emit updated event (with guard to prevent infinite loop)
    this.isProcessingEvent = true;
    try {
      this.events.emit('todo:updated', { todos: this.getTodos() });
    } finally {
      this.isProcessingEvent = false;
    }

    // Notify subscribers
    this.notifySubscribers();

    return { success: true };
  }

  /**
   * Clear all todos
   */
  clear(): void {
    this.todos = [];
    this.isProcessingEvent = true;
    try {
      this.events.emit('todo:updated', { todos: [] });
    } finally {
      this.isProcessingEvent = false;
    }
    this.notifySubscribers();
  }

  // ===========================================================================
  // STATUS HELPERS
  // ===========================================================================

  /**
   * Get pending todos
   */
  getPending(): Todo[] {
    return this.todos.filter(t => t.status === 'pending');
  }

  /**
   * Get in_progress todos
   */
  getInProgress(): Todo[] {
    return this.todos.filter(t => t.status === 'in_progress');
  }

  /**
   * Get completed todos
   */
  getCompleted(): Todo[] {
    return this.todos.filter(t => t.status === 'completed');
  }

  /**
   * Get the current task (in_progress)
   */
  getCurrentTask(): Todo | null {
    const inProgress = this.getInProgress();
    return inProgress.length > 0 ? inProgress[0] : null;
  }

  // ===========================================================================
  // PROGRESS
  // ===========================================================================

  /**
   * Get progress percentage (0-100)
   */
  getProgress(): number {
    if (this.todos.length === 0) return 0;
    const completed = this.getCompleted().length;
    return Math.round((completed / this.todos.length) * 100);
  }

  // ===========================================================================
  // CONVENIENCE METHODS
  // ===========================================================================

  /**
   * Start a task (pending -> in_progress)
   */
  startTask(index: number): TodoResult {
    if (index < 0 || index >= this.todos.length) {
      return { success: false, error: 'Invalid task index' };
    }

    // Check if another task is already in progress
    const current = this.getCurrentTask();
    if (current) {
      return { success: false, error: 'Another task is already in progress' };
    }

    const newTodos = [...this.todos];
    newTodos[index] = { ...newTodos[index], status: 'in_progress' };

    return this.setTodos(newTodos);
  }

  /**
   * Complete a task (in_progress -> completed)
   */
  completeTask(index: number): TodoResult {
    if (index < 0 || index >= this.todos.length) {
      return { success: false, error: 'Invalid task index' };
    }

    if (this.todos[index].status !== 'in_progress') {
      return { success: false, error: 'Task is not in progress' };
    }

    const newTodos = [...this.todos];
    newTodos[index] = { ...newTodos[index], status: 'completed' };

    return this.setTodos(newTodos);
  }

  /**
   * Add a new task
   */
  addTask(content: string, activeForm: string): TodoResult {
    const newTodo: Todo = {
      content,
      activeForm,
      status: 'pending',
    };

    return this.setTodos([...this.todos, newTodo]);
  }

  /**
   * Remove a task
   */
  removeTask(index: number): TodoResult {
    if (index < 0 || index >= this.todos.length) {
      return { success: false, error: 'Invalid task index' };
    }

    const newTodos = this.todos.filter((_, i) => i !== index);
    return this.setTodos(newTodos);
  }

  // ===========================================================================
  // SUBSCRIPTION
  // ===========================================================================

  /**
   * Subscribe to todo changes
   */
  subscribe(callback: TodoChangeCallback): () => void {
    this.subscribers.add(callback);
    log.info('Subscriber added to TodoManager', { subscriberCount: this.subscribers.size });
    return () => {
      this.subscribers.delete(callback);
      log.info('Subscriber removed from TodoManager', { subscriberCount: this.subscribers.size });
    };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Notify subscribers of changes
   */
  private notifySubscribers(): void {
    const todos = this.getTodos();
    for (const callback of this.subscribers) {
      callback(todos);
    }
  }

  /**
   * Emit events for status changes
   */
  private emitStatusChangeEvents(previous: Todo[], current: Todo[]): void {
    // Create maps for comparison
    const prevByContent = new Map(previous.map(t => [t.content, t.status]));

    for (const todo of current) {
      const prevStatus = prevByContent.get(todo.content);

      // Check if status changed to in_progress
      if (todo.status === 'in_progress' && prevStatus !== 'in_progress') {
        this.events.emit('todo:task-started', { content: todo.content });
      }

      // Check if status changed to completed
      if (todo.status === 'completed' && prevStatus !== 'completed') {
        this.events.emit('todo:task-completed', { content: todo.content });
      }
    }
  }
}
