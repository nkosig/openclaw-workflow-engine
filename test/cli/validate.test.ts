import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliPath = join(projectRoot, "dist", "cli.js");

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

function runCli(args: string[], cwd?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const out = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd ?? projectRoot,
    encoding: "utf8",
  });

  return {
    status: out.status,
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

describe("cli/validate", () => {
  beforeAll(() => {
    if (!existsSync(cliPath)) {
      execFileSync("npm", ["run", "build"], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    }
  });

  it("valid YAML passes validation via CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-cli-valid-"));
    const filePath = join(dir, "workflow.yaml");
    const dbPath = join(dir, "workflow.db");
    writeFileSync(filePath, validYaml(dbPath), "utf8");

    try {
      const result = runCli(["validate", filePath]);
      expect(result.status).toBe(0);

      const payload = JSON.parse(result.stdout) as {
        valid: boolean;
        workflowId: string;
      };
      expect(payload.valid).toBe(true);
      expect(payload.workflowId).toBe("cli-validate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalid YAML returns non-zero and error output via CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-cli-invalid-"));
    const filePath = join(dir, "workflow.yaml");
    writeFileSync(
      filePath,
      `id: bad\nversion: 1\nstates:\n  idle:\n    tools:\n      x:\n        description: X\n        input: {}\n        steps:\n          - return:\n              ok: true\n            transition: missing\n`,
      "utf8",
    );

    try {
      const result = runCli(["validate", filePath]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error:");
      expect(result.stderr).toContain("does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run executes tool without creating active workflow state", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-cli-dry-"));
    const filePath = join(dir, "workflow.yaml");
    const dbPath = join(dir, "workflow.db");
    const stateDbPath = join(dir, "state.db");
    writeFileSync(filePath, validYaml(dbPath), "utf8");

    try {
      const dryRun = runCli([
        "dry-run",
        filePath,
        "--tool",
        "run",
        "--input",
        '{"x":5}',
        "--db",
        stateDbPath,
      ]);

      expect(dryRun.status).toBe(0);
      const dryRunPayload = JSON.parse(dryRun.stdout) as {
        success: boolean;
      };
      expect(dryRunPayload.success).toBe(true);

      const list = runCli([
        "list",
        "--workflows",
        dir,
        "--db",
        stateDbPath,
      ]);
      expect(list.status).toBe(0);
      const listPayload = JSON.parse(list.stdout) as Array<{
        workflowId: string;
        instanceId: string | null;
      }>;
      expect(listPayload).toHaveLength(1);
      expect(listPayload[0].workflowId).toBe("cli-validate");
      expect(listPayload[0].instanceId).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
