/**
 * Tests for the loadWorkflowsFromDir utility exported from mcp-server.ts.
 *
 * The function dynamically imports compiled .js files from a directory and
 * returns any exports that match the WorkflowDefinition shape.  These tests
 * exercise the happy-path and all skip/warning branches without needing the
 * full CLI command infrastructure.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkflowsFromDir } from "../src/mcp-server.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** Minimal valid WorkflowDefinition serialised as a plain ESM .js module.
 *  No package imports — the shape check only requires `id` (string) and
 *  `machine` (any non-undefined value), so a plain object is sufficient.
 */
function validWorkflowJs(id: string): string {
  return `export default {
  id: "${id}",
  machine: { id: "${id}", initialState: { value: "idle" } },
  toolsByState: { idle: [], done: [] },
};\n`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("loadWorkflowsFromDir", () => {
  it("returns an empty array for a non-existent directory (with stderr warning)", async () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const result = await loadWorkflowsFromDir("/tmp/__nonexistent_dir_xyz__");
      expect(result).toEqual([]);
      const output = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("Warning:");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns an empty array for an empty directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-test-empty-"));
    try {
      const result = await loadWorkflowsFromDir(dir);
      expect(result).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips non-.js files (e.g. .ts, .json, .txt)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-test-skip-"));
    writeFileSync(join(dir, "workflow.ts"), "export default {}");
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "README.txt"), "hello");
    try {
      const result = await loadWorkflowsFromDir(dir);
      expect(result).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a valid workflow .js file and returns its definition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-test-load-"));
    writeFileSync(join(dir, "my-workflow.js"), validWorkflowJs("test-wf"));
    try {
      const result = await loadWorkflowsFromDir(dir);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("test-wf");
      expect(result[0].machine).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips .js files that do not export a valid WorkflowDefinition shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-test-invalid-"));
    // file exports something that doesn't have `id` + `machine`
    writeFileSync(
      join(dir, "not-a-workflow.js"),
      `export default { name: "nope", value: 42 };`,
    );
    try {
      const result = await loadWorkflowsFromDir(dir);
      expect(result).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a warning and continues when a .js file throws on import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-test-throw-"));
    writeFileSync(join(dir, "broken.js"), `throw new Error("bad module");`);

    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const result = await loadWorkflowsFromDir(dir);
      expect(result).toEqual([]);
      const output = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("Warning:");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
