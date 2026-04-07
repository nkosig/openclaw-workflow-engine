/**
 * Minimal HTTP dashboard for the workflow engine.
 *
 * Renders a single-page HTML view showing active workflow instances,
 * Mermaid state-machine diagrams (rendered client-side via CDN), and
 * recent audit log entries.
 *
 * Uses only Node.js built-ins — no additional npm dependencies.
 * The dashboard is opt-in: only started when config.enableDashboard === true.
 */

import { createServer, type Server } from "node:http";
import type { AnyStateMachine } from "xstate";
import type { WorkflowEngine } from "./engine.js";

/**
 * Convert an XState v5 machine into a Mermaid `stateDiagram-v2` string.
 *
 * Uses `machine.definition` — the fully-normalised public representation of
 * the machine (equivalent to what the brief calls "machine.definition").
 * `machine.states` is the flat state map used for runtime resolution;
 * `machine.definition.states` gives us the transition structure needed here.
 *
 * In the normalised form, `on` is `Record<event, Array<{target: string[]}>>`
 * where targets are fully-qualified IDs like `"#(machine).stateName"`.  We
 * strip the `#(<id>).` prefix to recover the bare state name for the diagram.
 */
function machineToMermaid(machine: AnyStateMachine): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defStates = (machine.definition as any).states as
    | Record<string, any>
    | undefined;
  if (!defStates) return "stateDiagram-v2\n  [*] --> unknown";

  // In XState v5's normalised form, transition targets are StateNode objects
  // whose `.key` property is the local state name (e.g. "step_b").
  // When targets arrive as fully-qualified ID strings (e.g. "#(machineId).step_b")
  // we strip the prefix.  Handle both forms defensively.
  const toBareName = (node: unknown): string => {
    if (typeof node === "string") return node.replace(/^#[^.]+\./, "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (n && typeof n.key === "string") return n.key;
    if (n && typeof n.id === "string") return n.id.replace(/^[^.]+\./, "");
    return String(node);
  };

  const lines: string[] = ["stateDiagram-v2"];
  for (const [name, state] of Object.entries(defStates)) {
    if (state.type === "final") {
      lines.push(`  ${name} --> [*]`);
    }
    if (state.on && typeof state.on === "object") {
      for (const [event, transitions] of Object.entries(
        state.on as Record<string, Array<{ target: unknown[] | undefined }>>,
      )) {
        const targets: string[] = Array.isArray(transitions)
          ? transitions.flatMap((t) =>
              Array.isArray(t.target) ? t.target.map(toBareName) : [],
            )
          : [];
        for (const target of targets) {
          lines.push(`  ${name} --> ${target} : ${event}`);
        }
      }
    }
  }
  return lines.join("\n");
}

/**
 * Build the dashboard HTML page.
 * Extracted so tests can call it without starting a real HTTP server.
 */
export function buildDashboardHtml(engine: WorkflowEngine): string {
  const workflowIds = engine.getRegisteredWorkflowIds();
  const sections: string[] = [];

  for (const wfId of workflowIds) {
    const def = engine.getDefinition(wfId);
    const active = engine.getActiveWorkflow(wfId);
    const mermaid = def ? machineToMermaid(def.machine) : "";

    let stateInfo = "<p><em>No active instance</em></p>";
    let auditHtml = "<p><em>No entries</em></p>";

    if (active) {
      stateInfo =
        `<p><strong>Instance:</strong> <code>${active.instanceId}</code>` +
        ` &nbsp;|&nbsp; <strong>State:</strong> <code>${active.currentState}</code></p>`;

      const rows = engine
        .getAuditLog(active.instanceId, 10)
        .map(
          (e) =>
            `<tr><td>${e.createdAt}</td><td>${e.eventType}</td>` +
            `<td>${e.toolName ?? ""}</td>` +
            `<td><code>${JSON.stringify(e.payload)}</code></td></tr>`,
        );
      if (rows.length) {
        auditHtml =
          `<table><thead><tr><th>Time</th><th>Event</th>` +
          `<th>Tool</th><th>Payload</th></tr></thead><tbody>` +
          rows.join("") +
          `</tbody></table>`;
      }
    }

    sections.push(
      `<section>` +
        `<h2>${wfId}</h2>` +
        stateInfo +
        `<div class="cols">` +
        `<div class="diagram"><pre class="mermaid">${mermaid}</pre></div>` +
        `<div class="audit"><h3>Recent audit log</h3>${auditHtml}</div>` +
        `</div></section>`,
    );
  }

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Workflow Engine Dashboard</title><style>` +
    `body{font-family:system-ui,sans-serif;margin:0;padding:1.5rem;background:#f5f5f5;color:#333}` +
    `h1{margin-top:0}` +
    `section{background:#fff;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem;box-shadow:0 1px 4px rgba(0,0,0,.1)}` +
    `h2{margin:0 0 .75rem}h3{margin:.75rem 0 .5rem;font-size:.9rem;text-transform:uppercase;letter-spacing:.05em;color:#666}` +
    `.cols{display:flex;gap:1.5rem;flex-wrap:wrap}.diagram{flex:1;min-width:250px}.audit{flex:2;min-width:300px;overflow-x:auto}` +
    `table{border-collapse:collapse;width:100%;font-size:.82rem}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eee}` +
    `th{background:#f9f9f9;font-weight:600}code{font-size:.78rem;word-break:break-all}` +
    `pre.mermaid{background:#f9f9f9;border-radius:4px;padding:.75rem;overflow-x:auto}` +
    `</style></head><body>` +
    `<h1>&#x1F504; Workflow Engine Dashboard</h1>` +
    (sections.length
      ? sections.join("\n")
      : "<p>No workflows registered.</p>") +
    `<script type="module">` +
    `import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';` +
    `mermaid.initialize({startOnLoad:true,theme:'neutral'});` +
    `</script></body></html>`
  );
}

/**
 * Start the workflow-engine dashboard HTTP server.
 *
 * @param engine - The WorkflowEngine instance to introspect.
 * @param port   - TCP port to listen on (default 3847).
 * @returns The running http.Server so the caller can close it on shutdown.
 */
export async function startDashboard(
  engine: WorkflowEngine,
  port: number,
  options?: { silent?: boolean },
): Promise<Server> {
  const server = createServer((_req, res) => {
    const body = buildDashboardHtml(engine);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve());
    server.once("error", reject);
  });

  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;
  if (!options?.silent) {
    process.stderr.write(
      `[workflow-engine] Dashboard running at http://localhost:${boundPort}\n`,
    );
  }
  return server;
}
