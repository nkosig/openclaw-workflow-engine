#!/usr/bin/env node
/**
 * CLI entry point for @openclaw-community/workflow-engine.
 *
 * Usage:
 *   npx workflow-engine serve                              # stdio MCP server
 *   npx workflow-engine serve --transport sse --port 3847  # SSE MCP server
 *   npx workflow-engine serve --workflows ./my-workflows/ --db ./data.db
 *   npx workflow-engine list [--workflows dir] [--db path]
 *   npx workflow-engine status <instanceId> [--db path]
 *   npx workflow-engine audit <instanceId> [--db path] [--limit n]
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { program } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WorkflowMCPServer, loadWorkflowsFromDir } from "./mcp-server.js";
import { WorkflowEngine } from "./engine.js";
import { loadWorkflowFromYaml } from "./config/loader.js";

// ─── CLI definition ────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { version?: string; name?: string };

program
  .name("workflow-engine")
  .version(pkg.version ?? "0.0.0")
  .description("OpenClaw Workflow Engine — MCP server & CLI tools");

async function registerWorkflowsFromDir(
  engine: WorkflowEngine,
  workflowsDir: string,
): Promise<void> {
  const absDir = resolve(workflowsDir);
  try {
    const entries = readdirSync(absDir);
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      engine.registerWorkflowFromYaml(resolve(absDir, entry));
    }
  } catch {
    // handled by JS loader warning path
  }

  const definitions = await loadWorkflowsFromDir(workflowsDir, { silent: true });
  for (const def of definitions) {
    engine.registerWorkflow(def);
  }
}

// ── serve ─────────────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the MCP server")
  .option("-t, --transport <type>", "Transport type: stdio or sse", "stdio")
  .option("-p, --port <number>", "Port for SSE transport", "3847")
  .option(
    "-w, --workflows <dir>",
    "Directory of workflow definitions",
    "./workflows",
  )
  .option("-d, --db <path>", "SQLite database path", "./workflow.db")
  .action(
    async (opts: {
      transport: string;
      port: string;
      workflows: string;
      db: string;
    }) => {
      if (opts.transport === "sse") {
        // SSE mode — start an HTTP server that handles SSE connections.
        //
        // Each SSE connection gets its own WorkflowMCPServer instance for
        // session isolation. Workflows are auto-loaded from workflowsDir on
        // connect(). The underlying SQLite database is the shared source of
        // truth, so all connections see and modify the same workflow instances.
        const port = parseInt(opts.port, 10);
        const transports = new Map<string, SSEServerTransport>();

        const httpServer = createServer(async (req, res) => {
          let url: URL;
          try {
            url = new URL(req.url ?? "/", `http://localhost:${port}`);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Malformed request URL" }));
            return;
          }

          if (req.method === "GET" && url.pathname === "/sse") {
            const transport = new SSEServerTransport("/messages", res);
            transports.set(transport.sessionId, transport);
            const connServer = new WorkflowMCPServer({
              dbPath: opts.db,
              workflowsDir: opts.workflows,
            });
            // Close connServer on disconnect to release DB handles
            transport.onclose = () => {
              transports.delete(transport.sessionId);
              connServer.close().catch((err) => {
                process.stderr.write(
                  `[workflow-engine] Warning: error closing connection server: ${err}\n`,
                );
              });
            };
            // connect() auto-loads workflows from workflowsDir before handshake
            await connServer.connect(transport);
            return;
          }

          if (req.method === "POST" && url.pathname === "/messages") {
            const sessionId = url.searchParams.get("sessionId") ?? "";
            const transport = transports.get(sessionId);
            if (!transport) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Session not found" }));
              return;
            }
            await transport.handlePostMessage(req, res);
            return;
          }

          res.writeHead(404);
          res.end();
        });

        httpServer.listen(port, () => {
          process.stderr.write(
            `[workflow-engine] MCP server listening on http://localhost:${port}/sse\n`,
          );
        });
      } else {
        // stdio mode (default) — connect() auto-loads workflows from workflowsDir
        const server = new WorkflowMCPServer({
          dbPath: opts.db,
          workflowsDir: opts.workflows,
        });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        process.stderr.write("[workflow-engine] MCP server running on stdio\n");
      }
    },
  );

// ── list ──────────────────────────────────────────────────────────────────
program
  .command("list")
  .description("List registered workflows and active instances")
  .option(
    "-w, --workflows <dir>",
    "Directory of workflow definitions",
    "./workflows",
  )
  .option("-d, --db <path>", "SQLite database path", "./workflow.db")
  .action(async (opts: { workflows: string; db: string }) => {
    const engine = new WorkflowEngine(opts.db);
    await registerWorkflowsFromDir(engine, opts.workflows);

    const result = [];
    for (const workflowId of engine.getRegisteredWorkflowIds()) {
      const active = engine.getActiveWorkflow(workflowId);
      result.push({
        workflowId,
        instanceId: active?.instanceId ?? null,
        currentState: active?.currentState ?? null,
      });
    }

    engine.close();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  });

// ── status ────────────────────────────────────────────────────────────────
program
  .command("status <instanceId>")
  .description("Print current state of a workflow instance")
  .option(
    "-w, --workflows <dir>",
    "Directory of workflow definitions",
    "./workflows",
  )
  .option("-d, --db <path>", "SQLite database path", "./workflow.db")
  .action(
    async (instanceId: string, opts: { workflows: string; db: string }) => {
      const engine = new WorkflowEngine(opts.db);
      await registerWorkflowsFromDir(engine, opts.workflows);

      try {
        const status = engine.getStatus(instanceId);
        const out = {
          instanceId: status.instanceId,
          workflowId: status.workflowId,
          currentState: status.currentState,
          isFinal: status.isFinal,
          availableTools: status.availableTools.map((t) => t.name),
          context: status.context,
        };
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } catch (err) {
        process.stderr.write(`Error: ${err}\n`);
        process.exitCode = 1;
      } finally {
        engine.close();
      }
    },
  );

// ── audit ─────────────────────────────────────────────────────────────────
program
  .command("audit <instanceId>")
  .description("Print audit log for a workflow instance")
  .option(
    "-w, --workflows <dir>",
    "Directory of workflow definitions",
    "./workflows",
  )
  .option("-d, --db <path>", "SQLite database path", "./workflow.db")
  .option("-n, --limit <number>", "Maximum number of entries", "100")
  .action(
    async (
      instanceId: string,
      opts: { workflows: string; db: string; limit: string },
    ) => {
      const engine = new WorkflowEngine(opts.db);
      await registerWorkflowsFromDir(engine, opts.workflows);

      try {
        const log = engine.getAuditLog(instanceId, parseInt(opts.limit, 10));
        process.stdout.write(JSON.stringify(log, null, 2) + "\n");
      } catch (err) {
        process.stderr.write(`Error: ${err}\n`);
        process.exitCode = 1;
      } finally {
        engine.close();
      }
    },
  );

// ── validate ──────────────────────────────────────────────────────────────
program
  .command("validate <file>")
  .description("Parse and validate a YAML workflow file")
  .action((file: string) => {
    try {
      const loaded = loadWorkflowFromYaml(file);
      const out = {
        valid: true,
        workflowId: loaded.definition.id,
        states: Object.keys(loaded.config.states),
        warnings: loaded.warnings,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } catch (err) {
      process.stderr.write(`Error: ${err}\n`);
      process.exitCode = 1;
    }
  });

// ── migrate ───────────────────────────────────────────────────────────────
program
  .command("migrate <file>")
  .description("Run pending migrations for a YAML workflow")
  .option("-d, --db <path>", "SQLite database path", "./workflow.db")
  .action((file: string, opts: { db: string }) => {
    const engine = new WorkflowEngine(opts.db);
    try {
      const result = engine.runMigrationsForYaml(file);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (err) {
      process.stderr.write(`Error: ${err}\n`);
      process.exitCode = 1;
    } finally {
      engine.close();
    }
  });

// ── dry-run ───────────────────────────────────────────────────────────────
program
  .command("dry-run <file>")
  .description("Execute a YAML workflow tool without state transitions")
  .requiredOption("--tool <name>", "Tool name to execute")
  .requiredOption("--input <json>", "JSON input object")
  .option("-d, --db <path>", "SQLite database path", "./workflow.db")
  .action(
    async (
      file: string,
      opts: { tool: string; input: string; db: string },
    ) => {
      const engine = new WorkflowEngine(opts.db);
      try {
        const input = JSON.parse(opts.input) as Record<string, unknown>;
        const result = await engine.dryRunYamlTool(file, opts.tool, input);
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } catch (err) {
        process.stderr.write(`Error: ${err}\n`);
        process.exitCode = 1;
      } finally {
        engine.close();
      }
    },
  );

program.parse();
