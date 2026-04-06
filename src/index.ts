// Public API surface for @openclaw-community/workflow-engine

export { WorkflowEngine } from "./engine.js";
export { WorkflowMachine } from "./machine.js";
export { PersistenceLayer } from "./persistence.js";
export { ValidationLayer } from "./validation.js";
export { WorkflowMCPServer } from "./mcp-server.js";
export type { WorkflowMCPServerConfig } from "./mcp-server.js";
export { loadWorkflowsFromDir } from "./mcp-server.js";

export type {
  WorkflowDefinition,
  ToolDefinition,
  WorkflowInstance,
  ToolResult,
  WorkflowStatus,
  AuditEntry,
  TransitionResult,
  ValidationResult,
  IdempotencyResult,
  InstanceRow,
} from "./types.js";
