import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkflowFromYaml } from "../../src/config/loader.js";

function withTempYaml(content: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wf-loader-"));
  const filePath = join(dir, "workflow.yaml");
  writeFileSync(filePath, content, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("config/loader", () => {
  it("loads valid YAML and produces an internal WorkflowDefinition", () => {
    const yaml = `
id: loader-valid
version: 1
context:
  user_id: default-user
states:
  idle:
    prompt: Start here
    tools:
      start:
        description: Start
        input:
          item_id:
            type: string
        steps:
          - return:
              ok: true
            transition: active
  active:
    prompt: Active
    tools:
      read:
        description: Read data
        input: {}
        steps:
          - return:
              done: false
            transition: done
  done:
    prompt: Done
    tools: {}
`;

    withTempYaml(yaml, (filePath) => {
      const loaded = loadWorkflowFromYaml(filePath);
      expect(loaded.definition.id).toBe("loader-valid");
      expect(Object.keys(loaded.definition.toolsByState)).toEqual([
        "idle",
        "active",
        "done",
      ]);
      expect(loaded.definition.toolsByState.idle[0].name).toBe("start");
      expect(loaded.definition.promptsByState?.idle).toBe("Start here");
    });
  });

  it("returns clear errors for invalid YAML schema", () => {
    const yaml = `
version: 1
states: {}
`;

    withTempYaml(yaml, (filePath) => {
      expect(() => loadWorkflowFromYaml(filePath)).toThrow(/validation failed/i);
    });
  });

  it("catches transition references to non-existent states", () => {
    const yaml = `
id: bad-transition
version: 1
states:
  idle:
    tools:
      start:
        description: Start
        input: {}
        steps:
          - return:
              ok: true
            transition: missing_state
  done:
    tools: {}
`;

    withTempYaml(yaml, (filePath) => {
      expect(() => loadWorkflowFromYaml(filePath)).toThrow(/does not exist/);
    });
  });

  it("detects unreachable states", () => {
    const yaml = `
id: unreachable
version: 1
states:
  idle:
    tools:
      go:
        description: Go
        input: {}
        steps:
          - return:
              ok: true
            transition: done
  done:
    tools: {}
  orphan:
    tools:
      noop:
        description: noop
        input: {}
        steps:
          - return:
              ok: true
`;

    withTempYaml(yaml, (filePath) => {
      expect(() => loadWorkflowFromYaml(filePath)).toThrow(/unreachable/);
    });
  });

  it("validates read_after_write tool references", () => {
    const yaml = `
id: raw-bad
version: 1
states:
  idle:
    tools:
      write:
        description: Write
        input: {}
        read_after_write: missing_tool
        steps:
          - return:
              ok: true
`;

    withTempYaml(yaml, (filePath) => {
      expect(() => loadWorkflowFromYaml(filePath)).toThrow(/read_after_write/);
    });
  });

  it("validates step result template references at load time", () => {
    const yaml = `
id: bad-step-result
version: 1
states:
  idle:
    tools:
      run:
        description: Run
        input: {}
        steps:
          - return:
              value: "{{missing_result.id}}"
`;

    withTempYaml(yaml, (filePath) => {
      expect(() => loadWorkflowFromYaml(filePath)).toThrow(
        /unknown step result/,
      );
    });
  });
});
