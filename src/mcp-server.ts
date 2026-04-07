/**
 * MCP Server wrapper for the WorkflowEngine.
 *
 * Exposes workflow control tools (always available) and dynamically
 * registers per-state workflow tools.  State transitions trigger
 * `tools/list_changed` notifications so the client always sees exactly
 * the tools valid in the current state.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { WorkflowEngine } from "./engine.js";
import type { WorkflowDefinition } from "./types.js";

/** Handle returned by McpServer.tool() — only the subset we need */
interface RegisteredHandle {
  remove(): void;
}

/** Configuration for WorkflowMCPServer */
export interface WorkflowMCPServerConfig {
  /** Path to the SQLite database (default: './workflow.db'; ':memory:' for tests) */
  dbPath?: string;
  /**
   * Directory to scan for compiled workflow `.js` files on the first `connect()` call.
   *
   * Defaults to `"./workflows"` (relative to the process working directory).
   * Pass an explicit value to override, or pass `null` to disable auto-loading
   * entirely (useful in tests or when registering definitions manually via
   * `registerWorkflow()`).
   *
   * Only compiled `.js` files are recognised — TypeScript source files (`.ts`)
   * must be built first (e.g. `tsc` or `vite build`) before they can be
   * auto-loaded.
   */
  workflowsDir?: string | null;
}

/**
 * Wraps a WorkflowEngine as an MCP server.
 *
 * Exposes five control tools (workflow_list, workflow_start, workflow_status,
 * workflow_reset, workflow_audit) plus dynamic tools for the active instance's
 * current state, prefixed with `{workflowId}_`.
 */
export class WorkflowMCPServer {
  /** The underlying WorkflowEngine — accessible for direct use in tests */
  readonly engine: WorkflowEngine;
  /** The underlying McpServer — accessible for transport-level operations in tests */
  readonly mcp: McpServer;

  /** workflowId → instanceId for currently tracked active instances */
  private readonly activeInstances = new Map<string, string>();
  /** prefixedName → RegisteredHandle (for removal on state change) */
  private readonly dynamicTools = new Map<string, RegisteredHandle>();
  /** workflowId → WorkflowDefinition (for prompt / progress resources) */
  private readonly definitions = new Map<string, WorkflowDefinition>();
  /** Resolved directory to scan for workflow definitions on first connect (null = disabled) */
  private readonly workflowsDir: string | null;
  /** True when workflowsDir was explicitly supplied by the caller (enables missing-dir warning) */
  private readonly workflowsDirExplicit: boolean;

  constructor(config: WorkflowMCPServerConfig = {}) {
    this.workflowsDirExplicit = config.workflowsDir !== undefined;
    // null opts out; undefined falls back to the "./workflows" default
    this.workflowsDir =
      config.workflowsDir === null
        ? null
        : (config.workflowsDir ?? "./workflows");
    this.engine = new WorkflowEngine(config.dbPath);
    this.mcp = new McpServer(
      { name: "workflow-engine", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true }, resources: {} } },
    );
    this._registerControlTools();
    this._registerResources();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a workflow definition with the engine.
   * Also restores any existing active instance from the database.
   */
  registerWorkflow(definition: WorkflowDefinition): void {
    this.engine.registerWorkflow(definition);
    this.definitions.set(definition.id, definition);
    // Restore existing active (non-final) instance if present
    const existing = this.engine.getActiveWorkflow(definition.id);
    if (existing) {
      this.activeInstances.set(definition.id, existing.instanceId);
      this._syncDynamicTools(definition.id, existing.instanceId);
    }
  }

  /**
   * Connect to the given MCP transport (stdio or SSE).
   * Auto-loads workflow definitions from `workflowsDir` (default `"./workflows"`)
   * on the first call if no definitions have been registered yet.
   * Set `workflowsDir: null` in the config to disable this behaviour.
   */
  async connect(transport: Transport): Promise<void> {
    if (this.workflowsDir !== null && this.definitions.size === 0) {
      const defs = await loadWorkflowsFromDir(this.workflowsDir, {
        silent: !this.workflowsDirExplicit,
      });
      for (const def of defs) {
        this.registerWorkflow(def);
        if (this.workflowsDirExplicit) {
          process.stderr.write(
            `[workflow-engine] Loaded workflow: ${def.id}\n`,
          );
        }
      }
    }
    await this.mcp.connect(transport);
  }

  /** Gracefully disconnect and close the database. */
  async close(): Promise<void> {
    await this.mcp.close();
    this.engine.close();
  }

  // ─── Control tools (always available) ─────────────────────────────────────

  private _registerControlTools(): void {
    // ── workflow_list ──────────────────────────────────────────────────────
    this.mcp.tool(
      "workflow_list",
      "List all registered workflows and their current status",
      {},
      async () => {
        // Sync in-memory activeInstances from DB before responding.
        // In SSE mode each connection has its own server instance, so an
        // instance started by a different connection won't be in this server's
        // activeInstances map until we re-check the DB here.
        this._refreshActiveInstances();
        const result = [...this.definitions.keys()].map((id) => {
          const instanceId = this.activeInstances.get(id) ?? null;
          let status: unknown = null;
          if (instanceId) {
            try {
              const s = this.engine.getStatus(instanceId);
              status = {
                currentState: s.currentState,
                isFinal: s.isFinal,
                availableTools: s.availableTools.map((t) => t.name),
              };
            } catch {
              // instance may have been reset
            }
          }
          return { workflowId: id, instanceId, status };
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    );

    // ── workflow_start ─────────────────────────────────────────────────────
    this.mcp.tool(
      "workflow_start",
      "Start a new workflow instance",
      {
        workflowId: z.string().describe("ID of the workflow to start"),
        context: z
          .record(z.unknown())
          .optional()
          .describe("Initial context to pass to the workflow"),
      },
      async ({ workflowId, context }) => {
        try {
          const instance = this.engine.startWorkflow(workflowId, context ?? {});
          this.activeInstances.set(workflowId, instance.instanceId);
          this._syncDynamicTools(workflowId, instance.instanceId);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(instance, null, 2),
              },
            ],
          };
        } catch (err) {
          return _errorContent(err);
        }
      },
    );

    // ── workflow_status ────────────────────────────────────────────────────
    this.mcp.tool(
      "workflow_status",
      "Get current state, available tools, and progress of a workflow instance",
      { instanceId: z.string().describe("The workflow instance ID") },
      async ({ instanceId }) => {
        try {
          const s = this.engine.getStatus(instanceId);
          const out = {
            instanceId: s.instanceId,
            workflowId: s.workflowId,
            currentState: s.currentState,
            isFinal: s.isFinal,
            availableTools: s.availableTools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
            context: s.context,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(out, null, 2) },
            ],
          };
        } catch (err) {
          return _errorContent(err);
        }
      },
    );

    // ── workflow_reset ─────────────────────────────────────────────────────
    this.mcp.tool(
      "workflow_reset",
      "Cancel the current workflow instance and immediately start a fresh one",
      { instanceId: z.string().describe("The workflow instance ID to cancel") },
      async ({ instanceId }) => {
        try {
          // getStatus throws if the instance doesn't exist, providing validation.
          // Capture context so the fresh instance inherits the same initial data.
          const { workflowId, context } = this.engine.getStatus(instanceId);
          this.engine.resetWorkflow(instanceId);
          this.activeInstances.delete(workflowId);
          this._removeDynamicToolsForWorkflow(workflowId);
          // Immediately start a fresh replacement instance, preserving context.
          const fresh = this.engine.startWorkflow(workflowId, context);
          this.activeInstances.set(workflowId, fresh.instanceId);
          // _syncDynamicTools registers new-state tools and emits tools/list_changed
          this._syncDynamicTools(workflowId, fresh.instanceId);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    reset: true,
                    cancelledInstanceId: instanceId,
                    newInstanceId: fresh.instanceId,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return _errorContent(err);
        }
      },
    );

    // ── workflow_audit ─────────────────────────────────────────────────────
    this.mcp.tool(
      "workflow_audit",
      "Retrieve the audit log for a workflow instance",
      {
        instanceId: z.string().describe("The workflow instance ID"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of entries to return (default 100)"),
      },
      async ({ instanceId, limit }) => {
        try {
          // Validate that the instance exists (getStatus throws if not found)
          this.engine.getStatus(instanceId);
          const log = this.engine.getAuditLog(instanceId, limit);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(log, null, 2) },
            ],
          };
        } catch (err) {
          return _errorContent(err);
        }
      },
    );
  }

  // ─── Resources ─────────────────────────────────────────────────────────────

  private _registerResources(): void {
    // workflow://{instanceId}/state   — current state + context
    // workflow://{instanceId}/prompt  — state prompt fragment
    // workflow://{instanceId}/progress — completion percentage
    const template = new ResourceTemplate("workflow://{instanceId}/{aspect}", {
      list: undefined,
    });

    this.mcp.resource("workflow-resource", template, async (uri, variables) => {
      const instanceId = String(variables["instanceId"]);
      const aspect = String(variables["aspect"]);
      try {
        const s = this.engine.getStatus(instanceId);
        let text: string;

        if (aspect === "state") {
          text = JSON.stringify(
            { state: s.currentState, context: s.context },
            null,
            2,
          );
        } else if (aspect === "prompt") {
          const def = this.definitions.get(s.workflowId);
          const prompt = def?.promptsByState?.[s.currentState] ?? "";
          text = JSON.stringify({ state: s.currentState, prompt }, null, 2);
        } else if (aspect === "progress") {
          const def = this.definitions.get(s.workflowId);
          // Use machine.states (public XState v5 API) so final/no-tool states
          // are counted. Prefer machine.states over machine.config.states to
          // avoid relying on the internal config shape.
          const allStates = def ? Object.keys(def.machine.states ?? {}) : [];
          const totalTransitions = Math.max(0, allStates.length - 1);
          const audit = this.engine.getAuditLog(instanceId, 1000);
          // Count unique destination states to avoid inflating the count when
          // states are revisited in cyclic workflows (e.g. exercise_active ↔ set_logged)
          const statesReached = new Set(
            audit
              .filter((e) => e.eventType === "state_changed")
              .map((e) => (e.payload as Record<string, string> | null)?.toState)
              .filter(Boolean),
          );
          const completedTransitions = statesReached.size;
          const pct =
            totalTransitions > 0
              ? Math.min(
                  100,
                  Math.round((completedTransitions / totalTransitions) * 100),
                )
              : 0;
          const remaining = Math.max(
            0,
            totalTransitions - completedTransitions,
          );
          text = JSON.stringify(
            {
              currentState: s.currentState,
              completedTransitions,
              remainingTransitions: remaining,
              estimatedTotal: totalTransitions,
              percentage: pct,
            },
            null,
            2,
          );
        } else {
          text = JSON.stringify({
            error: `Unknown resource aspect: ${aspect}`,
          });
        }

        return {
          contents: [
            { uri: uri.toString(), mimeType: "application/json", text },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ error: String(err) }),
            },
          ],
        };
      }
    });
  }

  // ─── Dynamic tool management ───────────────────────────────────────────────

  /**
   * Remove all dynamic tools for a workflow, then register the tools available
   * in the instance's current state. Emits `tools/list_changed`.
   */
  private _syncDynamicTools(workflowId: string, instanceId: string): void {
    this._removeDynamicToolsForWorkflow(workflowId);

    const availableTools = this.engine.getAvailableTools(instanceId);
    for (const toolDef of availableTools) {
      const prefixedName = `${workflowId}_${toolDef.name}`;
      const shape = _zodObjectShape(toolDef.inputSchema);

      // Capture vars needed inside the closure
      const capturedToolName = toolDef.name;
      const capturedWorkflowId = workflowId;
      const capturedInstanceId = instanceId;

      const registered = this.mcp.registerTool(
        prefixedName,
        {
          description: `[${workflowId}] ${toolDef.description}`,
          inputSchema: shape,
        },
        async (args) => {
          try {
            let prevState: string | undefined;
            try {
              prevState =
                this.engine.getStatus(capturedInstanceId).currentState;
            } catch {
              // instance may not exist yet
            }

            const result = await this.engine.executeTool(
              capturedInstanceId,
              capturedToolName,
              args as Record<string, unknown>,
            );

            // If state changed, update dynamic tools (emits tools/list_changed)
            if (
              result.success &&
              result.newState !== undefined &&
              result.newState !== prevState
            ) {
              this._syncDynamicTools(capturedWorkflowId, capturedInstanceId);
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (err) {
            return _errorContent(err);
          }
        },
      );

      this.dynamicTools.set(prefixedName, registered);
    }

    this.mcp.sendToolListChanged();
  }

  /**
   * Sync in-memory activeInstances against the database for every registered
   * workflow definition.  Called by workflow_list to bridge the SSE
   * per-connection isolation gap: each SSE client owns a separate
   * WorkflowMCPServer instance so actions taken by client A (e.g. starting a
   * workflow) won't automatically appear in client B's in-memory state.
   * Re-checking the DB here makes the state eventually consistent on the next
   * workflow_list call.
   *
   * Note on concurrent SSE connections: SQLite serialises writes (WAL mode
   * gives readers snapshot isolation), so each individual DB read here is
   * atomic.  However, two clients calling workflow_list at the same instant
   * may each observe slightly stale in-memory state before their respective
   * refreshes complete — this is an inherent characteristic of the
   * per-connection architecture and is acceptable for this informational call.
   * Mutation operations (workflow_start, tool calls) go through the engine
   * layer which always reads from the DB, so they are never affected.
   */
  private _refreshActiveInstances(): void {
    for (const [workflowId] of this.definitions) {
      const current = this.engine.getActiveWorkflow(workflowId);
      const tracked = this.activeInstances.get(workflowId);
      if (current && current.instanceId !== tracked) {
        // A new or different active instance appeared in the DB
        this.activeInstances.set(workflowId, current.instanceId);
        this._syncDynamicTools(workflowId, current.instanceId);
      } else if (!current && tracked) {
        // The previously tracked instance was reset by another client
        this.activeInstances.delete(workflowId);
        this._removeDynamicToolsForWorkflow(workflowId);
        this.mcp.sendToolListChanged();
      }
    }
  }

  /** Remove all dynamic tools whose name starts with `{workflowId}_`. */
  private _removeDynamicToolsForWorkflow(workflowId: string): void {
    const prefix = `${workflowId}_`;
    for (const [key, handle] of this.dynamicTools) {
      if (key.startsWith(prefix)) {
        try {
          handle.remove();
        } catch {
          // ignore errors when removing — may have already been removed
        }
        this.dynamicTools.delete(key);
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Dynamically import all compiled `.js` files from `dir` and return every
 * export that matches the WorkflowDefinition shape (`id: string` + `machine`).
 *
 * **Why `.js` only?**  Node's `import()` cannot execute TypeScript source
 * files directly.  Workflow definitions written in `.ts` must first be
 * compiled to JavaScript (e.g. `tsc --outDir dist/`, `vite build`, or run
 * via a TS runtime shim such as `tsx`) before this loader can discover them.
 * The `examples/workout-coach.ts` file in this repo is imported directly in
 * tests (where Vitest handles transpilation); for production CLI use, compile
 * it to a `.js` file in your `--workflows` directory.
 *
 * Exports are resolved in priority order:
 *   1. `export default`
 *   2. `export const workflowDefinition`
 *   3. `export const workflow`
 *   4. Any other named export whose shape matches
 *
 * Files that fail to import or do not export a valid definition are skipped
 * with a stderr warning.
 *
 * Pass `{ silent: true }` to suppress the "directory not found" warning — used
 * internally when scanning the default `"./workflows"` path (which is
 * legitimately absent in many environments).
 */
export async function loadWorkflowsFromDir(
  dir: string,
  options: { silent?: boolean } = {},
): Promise<WorkflowDefinition[]> {
  const absDir = resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    if (!options.silent) {
      process.stderr.write(
        `[workflow-engine] Warning: workflows directory not found: ${absDir}\n`,
      );
    }
    return [];
  }

  const definitions: WorkflowDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const filePath = resolve(absDir, entry);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const candidates = [
        mod.default,
        mod.workflowDefinition,
        mod.workflow,
        ...Object.values(mod).filter(
          (v) =>
            v !== null &&
            typeof v === "object" &&
            typeof (v as WorkflowDefinition).id === "string" &&
            (v as WorkflowDefinition).machine !== undefined,
        ),
      ];
      for (const candidate of candidates) {
        if (
          candidate !== null &&
          candidate !== undefined &&
          typeof candidate === "object" &&
          typeof (candidate as WorkflowDefinition).id === "string" &&
          (candidate as WorkflowDefinition).machine !== undefined
        ) {
          definitions.push(candidate as WorkflowDefinition);
          break;
        }
      }
    } catch (err) {
      process.stderr.write(
        `[workflow-engine] Warning: failed to load ${filePath}: ${err}\n`,
      );
    }
  }
  return definitions;
}

/**
 * Safely extracts the field shape from a ZodObject so it can be passed to
 * McpServer.registerTool() as the inputSchema. Returns an empty shape for any
 * schema that is not a ZodObject (matching the engine's z.object({}) convention).
 */
function _zodObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  if (schema instanceof z.ZodObject) {
    return schema.shape as Record<string, z.ZodTypeAny>;
  }
  return {};
}

function _errorContent(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: String(err) }) },
    ],
    isError: true as const,
  };
}
