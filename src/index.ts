// Public API surface for @openclaw-community/workflow-engine

export { WorkflowEngine } from "./engine.js";
export { WorkflowMachine } from "./machine.js";
export { PersistenceLayer } from "./persistence.js";
export { ValidationLayer } from "./validation.js";
export { loadWorkflowFromYaml, loadWorkflowsFromYamlDir } from "./config/loader.js";
export {
  parseWorkflowYaml,
  WorkflowYamlSchema,
  ToolConfigSchema,
  StateConfigSchema,
} from "./config/schema.js";
export {
  resolveTemplate,
  resolveSqlTemplate,
  resolveReference,
  extractTemplateExpressions,
  TemplateResolutionError,
} from "./config/templates.js";
export { evaluateCondition } from "./config/conditions.js";
export { SqlExecutor } from "./executors/sql-executor.js";
export { HttpExecutor } from "./executors/http-executor.js";
export { StepExecutor } from "./executors/step-executor.js";
export { WorkflowMCPServer } from "./mcp-server.js";
export type { WorkflowMCPServerConfig } from "./mcp-server.js";
export { loadWorkflowsFromDir } from "./mcp-server.js";

// OpenClaw Plugin API
export { default as registerOpenClawPlugin } from "./openclaw-plugin.js";
export type {
  OpenClawPluginApi,
  PluginConfig,
  ServiceInstance,
  WorkflowServiceInstance,
  PromptConstructContext,
  ToolCallContext,
  ToolRegistration,
  McpServerRegistration,
  ToolGuardResult,
} from "./openclaw-plugin.js";

// Dashboard
export { startDashboard } from "./dashboard.js";

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
  HandleToolResultOutput,
} from "./types.js";
