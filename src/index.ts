/**
 * @metaglass/aios
 *
 * Agentic AI Operating System - Multi-turn conversation engine
 * with reflection, planning, and tool orchestration.
 */

// =============================================================================
// KERNEL - Core conversation engine
// =============================================================================

export { ConversationEngine } from './kernel/ConversationEngine';
export type {
  ConversationConfig,
  ConversationEngineDeps,
} from './kernel/ConversationEngine';

export { TodoManager } from './kernel/TodoManager';
export type { TodoResult, TodoChangeCallback } from './kernel/TodoManager';

export { TaskSpawner } from './kernel/TaskSpawner';
export type { AgentFactory, Agent, AgentConfig } from './kernel/TaskSpawner';

export { PlanManager } from './kernel/PlanManager';

export { ContextCompressor } from './kernel/ContextCompressor';
export { ConversationStore, conversationStore } from './kernel/ConversationStore';
export { ToolRetryPolicy } from './kernel/ToolRetryPolicy';
export type { RetryResult, RetryOptions } from './kernel/ToolRetryPolicy';

export { DecisionLogger } from './kernel/DecisionLogger';
export type { DecisionLog, DecisionType } from './kernel/DecisionLogger';

export { VerificationEngine } from './kernel/VerificationEngine';

export {
  getToolMetadata,
  toolRequiresTodoWrite,
  toolRequiresConfirmation,
  toolAllowsParallel,
  partitionToolCalls,
  TOOL_METADATA,
} from './kernel/ToolMetadataRegistry';
export type { ToolMetadata, MetadataCategory, SideEffects, CostLevel } from './kernel/ToolMetadataRegistry';

export {
  filterExemptTools,
  filterActionTools,
  isToolExemptFromTodoWrite,
  TODOWRITE_EXEMPT_TOOLS,
} from './kernel/ToolExemptions';

export {
  DebugHarness,
  installDebugStub,
  absorbPendingConfig,
} from './kernel/DebugHarness';
export type {
  TracePhase,
  TraceEntry,
  TraceIndex,
  DebugConsoleAPI,
} from './kernel/DebugHarness';

export { NoOpMemoryFlushHook } from './kernel/MemoryFlushHook';
export type { MemoryFlushHook, MemoryFlushConfig, FlushTriggerParams } from './kernel/MemoryFlushHook';

// =============================================================================
// INTERFACES - Provider abstractions
// =============================================================================

// Re-export all interfaces
export * from './interfaces';

// =============================================================================
// PROVIDERS - Default implementations
// =============================================================================

export {
  VercelAILLMProvider,
  createDefaultLLMProvider,
  setModelProvider,
  setToolRegistryProvider,
} from './providers/VercelAILLMProvider';
export type {
  VercelAILLMProviderConfig,
  ModelProvider,
  ToolRegistryProvider,
  ProviderType,
} from './providers/VercelAILLMProvider';

// =============================================================================
// SERVICE - High-level orchestration
// =============================================================================

export {
  AIOSService,
  createAIOSService,
  getAIOSService,
  resetAIOSService,
  setProviders,
  getProviders,
} from './AIOSService';
export type { AIOSConfig, AIOSProviders, MemoryContext } from './AIOSService';

// =============================================================================
// UTILITIES
// =============================================================================

export { createLogger, setLogLevel, getLogLevel } from './logger';
export type { Logger, LogLevel } from './logger';

export { invoke, setBackend, getBackend } from './backend';
export type { AIOSBackend } from './backend';

export {
  writeTextFile,
  readTextFile,
  mkdir,
  exists,
  setFilesystem,
  getFilesystem,
  createMemoryFilesystem,
} from './fs';
export type { AIOSFilesystem } from './fs';
