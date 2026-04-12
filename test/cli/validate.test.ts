import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkflowFromYaml } from "../../src/config/loader.js";
import { WorkflowEngine } from "../../src/engine.js";

async function withTempWorkflow(
  content: string,
  fn: (filePath: string, dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wf-cli-"));
  const filePath = join(dir, "workflow.yaml");
  writeFileSync(filePath, content, "utf8");
  try {
    await fn(filePath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validYaml(dbPath: string): string {
  return `
id: cli-validate
version: 1
db: ${dbPath}
states:
  idle:
    tools:
      run:
        description: Run
        input:
          x:
            type: integer
        steps:
          - sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, x INTEGER)"
          - sql: "INSERT INTO t (x) VALUES ({{input.x}})"
            as: inserted
          - return:
              inserted: "{{inserted.lastInsertRowid}}"
`;
}

describe("cli/validate", () => {
  it("valid YAML passes validation", () =>
    withTempWorkflow(validYaml("/tmp/unused.db"), (filePath) => {
      const loaded = loadWorkflowFromYaml(filePath);
      expect(loaded.definition.id).toBe("cli-validate");
      expect(loaded.warnings).toHaveLength(0);
    }));

  it("invalid YAML (missing transition target) throws with clear error", () =>
    withTempWorkflow(
      `id: bad\nversion: 1\nstates:\n  idle:\n    tools:\n      x:\n        description: X\n        input: {}\n        steps:\n          - return:\n              ok: true\n            transition: missing\n`,
      (filePath) => {
        expect(() => loadWorkflowFromYaml(filePath)).toThrow(/does not exist/);
      },
    ));

  it("dry-run executes tool without creating a persisted workflow instance", () =>
    withTempWorkflow(validYaml(""), async (_filePath, dir) => {
      const dbPath = join(dir, "state.db");
      const workflowDbPath = join(dir, "workflow.db");

      const engine = new WorkflowEngine(dbPath);
      try {
        // Replace placeholder db path with real temp path
        const yamlWithDb = validYaml(workflowDbPath);
        const yamlPath = join(dir, "real.yaml");
        writeFileSync(yamlPath, yamlWithDb, "utf8");

        const result = await engine.dryRunYamlTool(yamlPath, "run", { x: 5 });
        expect(result.success).toBe(true);

        // dry-run must not create a persisted workflow instance
        engine.registerWorkflowFromYaml(yamlPath);
        const active = engine.getActiveWorkflow("cli-validate");
        expect(active?.instanceId ?? null).toBeNull();
      } finally {
        engine.close();
      }
    }));
});
