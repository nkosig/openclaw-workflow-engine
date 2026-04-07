/**
 * OpenClaw Plugin — Workflow Engine integration.
 *
 * Registers the workflow engine as a first-class OpenClaw plugin with:
 *   - Five control tools  (workflow_list, workflow_start, workflow_status,
 *                          workflow_reset, workflow_audit)
 *   - Three lifecycle hooks (beforePromptConstruct, beforeToolCall, afterToolCall)
 *   - An optional HTTP dashboard
 *   - An MCP server side-car for portable external access
 *
 * Because `@openclaw/sdk` is not yet published on npm, the plugin API types are
 * defined locally in this file (see the "OpenClaw SDK type mirrors" section).
 * When OpenClaw v2026.4.x ships a published package these interfaces should be
 * replaced with the real imports.  To verify behaviour on a live instance, follow
 * the manual-verification checklist in README.md § Testing on OpenClaw.
 */

import { WorkflowEngine } from "./engine.js";
import { loadWorkflowsFromDir } from "./mcp-server.js";
import { startDashboard } from "./dashboard.js";

// ─── OpenClaw SDK type mirrors ────────────────────────────────────────────────
// These interfaces mirror the @openclaw/sdk shape documented in
// atlas-workflow-plugin-research.md.  Keep them in sync with the real SDK when
// OpenClaw releases a published package.

/** Plugin configuration values declared in openclaw.plugin.json */
export interface PluginConfig {
  workflowsDir?: string;
  dbPath?: string;
  enableDashboard?: boolean;
  dashboardPort?: number;
}

/** A long-running background service managed by OpenClaw */
export interface ServiceInstance {
  /** Called by OpenClaw when the plugin is activated */
  start(): Promise<void>;
  /** Called by OpenClaw on shutdown or plugin disable */
  stop(): Promise<void>;
}

/** A service instance that also exposes the engine for tests / advanced callers */
export interface WorkflowServiceInstance extends ServiceInstance {
  /** Direct access to the engine — used in tests to register workflow definitions */
  readonly engine: WorkflowEngine; /** The HTTP dashboard server when running, or null. Exposed for tests and health checks. */
  readonly dashboardServer: import("node:http").Server | null;
}

/** Context passed to a beforePromptConstruct hook */
export interface PromptConstructContext {
  systemPrompt: string;
  /** Optional workflowId hint supplied by the conversation context */
  workflowId?: string;
  [key: string]: unknown;
}

/** Context passed to beforeToolCall / afterToolCall hooks */
export interface ToolCallContext {
  name: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

/** Registration options for a control tool */
export interface ToolRegistration {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/** Registration options for an MCP server side-car */
export interface McpServerRegistration {
  name: string;
  transport: "stdio" | "sse" | "http";
  command: string;
  args: string[];
}

/** Return type for the beforeToolCall hook */
export interface ToolGuardResult {
  blocked: boolean;
  reason?: string;
}

/** OpenClaw Plugin API — mirrors @openclaw/sdk.OpenClawPluginApi */
export interface OpenClawPluginApi {
  /** Configuration values from openclaw.plugin.json under `configuration` */
  config: PluginConfig;
  /** Register a long-running background service */
  registerService(name: string, service: ServiceInstance): void;
  /** Register a tool that appears in the agent's tool list */
  registerTool(name: string, options: ToolRegistration): void;
  /** Register a beforePromptConstruct hook */
  registerHook(
    event: "beforePromptConstruct",
    handler: (ctx: PromptConstructContext) => Promise<PromptConstructContext>,
  ): void;
  /** Register a beforeToolCall hook */
  registerHook(
    event: "beforeToolCall",
    handler: (ctx: ToolCallContext) => Promise<ToolGuardResult>,
  ): void;
  /** Register an afterToolCall hook */
  registerHook(
    event: "afterToolCall",
    handler: (ctx: ToolCallContext, result: unknown) => Promise<unknown>,
  ): void;
  /** Register an MCP server side-car process */
  registerMcpServer(options: McpServerRegistration): void;
}

// ─── Internal resolved config ─────────────────────────────────────────────────

interface ResolvedPluginConfig {
  workflowsDir: string;
  dbPath: string;
  enableDashboard: boolean;
  dashboardPort: number;
}

function resolveConfig(raw: PluginConfig): ResolvedPluginConfig {
  return {
    workflowsDir: raw.workflowsDir ?? ".openclaw/workflows",
    dbPath: raw.dbPath ?? ".openclaw/workflow.db",
    enableDashboard: raw.enableDashboard ?? false,
    dashboardPort: raw.dashboardPort ?? 3847,
  };
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

/**
 * Register the workflow-engine plugin with OpenClaw.
 *
 * Called automatically by OpenClaw's plugin loader at startup when this plugin
 * is enabled.  The `api` object is provided by OpenClaw; configuration values
 * come from the user's `openclaw.json` under `plugins.workflow-engine`.
 *
 * @example
 * ```ts
 * // OpenClaw calls this for you — you never need to call it directly.
 * import register from '@openclaw-community/workflow-engine/openclaw-plugin';
 * register(api);
 * ```
 */
export default function register(api: OpenClawPluginApi): void {
  const config = resolveConfig(api.config ?? {});
  const engine = new WorkflowEngine(config.dbPath);

  // ── 1. Background service ──────────────────────────────────────────────────
  //
  // OpenClaw calls service.start() after all plugins have registered, giving
  // async I/O (disk scan, DB connection) a safe place to run without blocking
  // the synchronous plugin registration phase.
  // Dashboard server handle — retained so stop() can close it cleanly.
  let dashboardServer: import("node:http").Server | null = null;

  const service: WorkflowServiceInstance = {
    engine,
    get dashboardServer() {
      return dashboardServer;
    },

    async start(): Promise<void> {
      // Load compiled .js workflow definitions from the configured directory.
      // silent: true suppresses the missing-dir warning (the directory may not
      // exist yet on first run — the user creates it when they add workflows).
      const defs = await loadWorkflowsFromDir(config.workflowsDir, {
        silent: true,
      });
      for (const def of defs) {
        engine.registerWorkflow(def);
        process.stderr.write(`[workflow-engine] Loaded workflow: ${def.id}\n`);
      }

      // Guard against double-start: close any prior dashboard listener first.
      if (dashboardServer) {
        await new Promise<void>((resolve) =>
          dashboardServer!.close(() => resolve()),
        );
        dashboardServer = null;
      }

      if (config.enableDashboard) {
        dashboardServer = await startDashboard(engine, config.dashboardPort);
      }
    },

    async stop(): Promise<void> {
      // Close the HTTP dashboard before the DB so in-flight requests can finish.
      if (dashboardServer) {
        await new Promise<void>((resolve) =>
          dashboardServer!.close(() => resolve()),
        );
        dashboardServer = null;
      }
      engine.close();
    },
  };

  api.registerService("workflow-engine", service);

  // ── 2. Control tools ───────────────────────────────────────────────────────

  api.registerTool("workflow_list", {
    description: "List all registered workflows and their current status",
    inputSchema: {},
    async handler() {
      return engine.getRegisteredWorkflowIds().map((workflowId) => {
        const active = engine.getActiveWorkflow(workflowId);
        let status = null;
        if (active) {
          try {
            const s = engine.getStatus(active.instanceId);
            status = {
              currentState: s.currentState,
              isFinal: s.isFinal,
              availableTools: s.availableTools.map((t) => t.name),
            };
          } catch {
            // instance may have been reset between calls
          }
        }
        return { workflowId, instanceId: active?.instanceId ?? null, status };
      });
    },
  });

  api.registerTool("workflow_start", {
    description: "Start a new workflow instance",
    inputSchema: {
      workflowId: {
        type: "string",
        description: "ID of the workflow to start",
      },
      context: {
        type: "object",
        description: "Optional initial context",
        additionalProperties: true,
      },
    },
    async handler(input) {
      const { workflowId, context } = input as {
        workflowId: string;
        context?: Record<string, unknown>;
      };
      return engine.startWorkflow(workflowId, context ?? {});
    },
  });

  api.registerTool("workflow_status", {
    description:
      "Get the current state, available tools, and progress of a workflow instance",
    inputSchema: {
      instanceId: { type: "string", description: "Workflow instance ID" },
    },
    async handler(input) {
      const { instanceId } = input as { instanceId: string };
      return engine.getStatus(instanceId);
    },
  });

  api.registerTool("workflow_reset", {
    description: "Cancel a workflow instance and start a fresh one",
    inputSchema: {
      instanceId: {
        type: "string",
        description: "Workflow instance ID to reset",
      },
    },
    async handler(input) {
      const { instanceId } = input as { instanceId: string };
      const status = engine.getStatus(instanceId);
      engine.resetWorkflow(instanceId);
      const newInstance = engine.startWorkflow(status.workflowId);
      return {
        reset: true,
        cancelledInstanceId: instanceId,
        newInstanceId: newInstance.instanceId,
      };
    },
  });

  api.registerTool("workflow_audit", {
    description: "Retrieve the audit log for a workflow instance",
    inputSchema: {
      instanceId: { type: "string", description: "Workflow instance ID" },
      limit: {
        type: "number",
        description: "Maximum number of entries to return (default 100)",
      },
    },
    async handler(input) {
      const { instanceId, limit } = input as {
        instanceId: string;
        limit?: number;
      };
      return engine.getAuditLog(instanceId, limit ?? 100);
    },
  });

  // ── 3. Hooks ───────────────────────────────────────────────────────────────

  /**
   * beforePromptConstruct — inject state-specific system prompt fragments.
   *
   * Appends the current state's `promptsByState` entry to the system prompt so
   * the model always operates under state-appropriate instructions without the
   * full workflow context being loaded for every turn (StateFlow pattern —
   * see atlas-workflow-plugin-research.md for the 4-6x cost-reduction reference).
   */
  api.registerHook(
    "beforePromptConstruct",
    async (ctx: PromptConstructContext) => {
      // Prefer a workflowId hint from the conversation context; otherwise scan
      // all registered workflows for active instances.
      const candidates: Array<ReturnType<WorkflowEngine["getActiveWorkflow"]>> =
        ctx.workflowId
          ? [engine.getActiveWorkflow(ctx.workflowId)]
          : engine
              .getRegisteredWorkflowIds()
              .map((id) => engine.getActiveWorkflow(id));

      for (const active of candidates) {
        if (!active) continue;
        const prompt = engine.getStatePrompt(active.instanceId);
        if (prompt) {
          ctx.systemPrompt +=
            `\n\n## Active Workflow: ${active.workflowId}\n` +
            `Current state: ${active.currentState}\n\n${prompt}`;
        }
      }

      return ctx;
    },
  );

  /**
   * beforeToolCall — enforce per-state tool scoping.
   *
   * For every registered workflow that has an active instance, check whether
   * the called tool is defined *anywhere* in that workflow's toolsByState map.
   * If so, validate it against the CURRENT state.  This catches out-of-state
   * calls (e.g. calling a step_b tool while in step_a) even when the LLM has a
   * stale tool list — the tool is simply not permitted at this point in the
   * workflow.  Invalid calls are blocked with a human-readable reason
   * (enforcement layer 3 of 4).
   */
  api.registerHook("beforeToolCall", async (ctx: ToolCallContext) => {
    for (const workflowId of engine.getRegisteredWorkflowIds()) {
      const active = engine.getActiveWorkflow(workflowId);
      if (!active) continue;
      const def = engine.getDefinition(workflowId);
      if (!def) continue;
      // Check if this tool name appears in any state of the workflow
      const toolBelongsToWorkflow = Object.values(def.toolsByState)
        .flat()
        .some((t) => t.name === ctx.name);
      if (!toolBelongsToWorkflow) continue;

      // Route: validate against the current state (rejects if not in current state)
      const validation = engine.validateToolCall(
        active.instanceId,
        ctx.name,
        ctx.input,
      );
      return validation.valid
        ? { blocked: false }
        : { blocked: true, reason: validation.reason };
    }
    return { blocked: false };
  });

  /**
   * afterToolCall — run output validation, advance state machine, and execute
   * read-after-write for external tool calls.
   *
   * Uses the same first-match iteration order as beforeToolCall so that both
   * hooks always route to the same workflow instance, even when tool names
   * overlap across multiple active workflows.
   */
  api.registerHook(
    "afterToolCall",
    async (ctx: ToolCallContext, result: unknown) => {
      for (const workflowId of engine.getRegisteredWorkflowIds()) {
        const active = engine.getActiveWorkflow(workflowId);
        if (!active) continue;
        const def = engine.getDefinition(workflowId);
        if (!def) continue;
        const toolBelongsToWorkflow = Object.values(def.toolsByState)
          .flat()
          .some((t) => t.name === ctx.name);
        if (!toolBelongsToWorkflow) continue;

        // Route to the same instance beforeToolCall validated against
        const handled = await engine.handleToolResult(
          active.instanceId,
          ctx.name,
          result,
        );
        // Surface read-after-write result to the caller when available
        return handled.readResult !== undefined ? handled.readResult : result;
      }
      return result;
    },
  );

  // ── 4. MCP server side-car ─────────────────────────────────────────────────
  //
  // Registers an MCP server that exposes the same workflow tools over a
  // portable protocol, enabling access from any MCP-compatible client (Claude
  // Code, Cursor, etc.) independently of OpenClaw's hook system.
  api.registerMcpServer({
    name: "workflow-engine",
    transport: "stdio",
    command: "npx",
    args: [
      "workflow-engine",
      "serve",
      "--workflows",
      config.workflowsDir,
      "--db",
      config.dbPath,
    ],
  });
}
