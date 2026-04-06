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
import { program } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WorkflowMCPServer, loadWorkflowsFromDir } from "./mcp-server.js";
import { WorkflowEngine } from "./engine.js";

// ─── CLI definition ────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { version?: string; name?: string };

program
  .name("workflow-engine")
  .version(pkg.version ?? "0.0.0")
  .description("OpenClaw Workflow Engine — MCP server & CLI tools");

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
    const definitions = await loadWorkflowsFromDir(opts.workflows);

    const result = [];
    for (const def of definitions) {
      engine.registerWorkflow(def);
      const active = engine.getActiveWorkflow(def.id);
      result.push({
        workflowId: def.id,
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
      const definitions = await loadWorkflowsFromDir(opts.workflows);
      for (const def of definitions) engine.registerWorkflow(def);

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
      const definitions = await loadWorkflowsFromDir(opts.workflows);
      for (const def of definitions) engine.registerWorkflow(def);

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

program.parse();
