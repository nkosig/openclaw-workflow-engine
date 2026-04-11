import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { WorkflowEngine } from "../../src/engine.js";

function createYamlWorkflow(dbPath: string): string {
  return `
id: yaml-workout
version: 1
db: ${dbPath}
context:
  default_user: tester
states:
  idle:
    prompt: Start the workout session.
    tools:
      start_session:
        description: Start session
        input:
          user_id:
            type: string
        steps:
          - sql: "INSERT INTO workout_sessions (user_id, status) VALUES ({{input.user_id}}, 'active')"
            as: created
          - event: session_started
            payload:
              user: "{{input.user_id}}"
          - set_context:
              session_id: "{{created.lastInsertRowid}}"
          - return:
              session_id: "{{created.lastInsertRowid}}"
            transition: session_active

  session_active:
    prompt: Log workout sets.
    tools:
      get_session:
        description: Read session
        input: {}
        steps:
          - sql: "SELECT * FROM workout_sessions WHERE id = {{context.session_id}}"
            as: session
          - return:
              data: "{{session}}"

      log_set:
        description: Log set
        idempotency: "{session_id}_{set_number}"
        read_after_write: get_session
        input:
          set_number:
            type: integer
          weight:
            type: number
        steps:
          - sql: "INSERT INTO workout_sets (session_id, set_number, weight) VALUES ({{context.session_id}}, {{input.set_number}}, {{input.weight}})"
            as: written
          - event: set_logged
            payload:
              set_number: "{{input.set_number}}"
          - return:
              changes: "{{written.changes}}"

      finish_session:
        description: Finish session
        input: {}
        steps:
          - sql: "UPDATE workout_sessions SET status = 'done' WHERE id = {{context.session_id}}"
            as: done
          - return:
              done: true
            transition: workout_completed

      cancel_session:
        description: Cancel session
        input: {}
        steps:
          - return:
              cancelled: true
            transition: cancelled

  workout_completed:
    prompt: Completed
    tools: {}

  cancelled:
    prompt: Cancelled
    tools: {}

migrations:
  - version: 1
    sql: |
      CREATE TABLE IF NOT EXISTS workout_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workout_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        set_number INTEGER NOT NULL,
        weight REAL NOT NULL
      );
`;
}

async function startSession(engine: WorkflowEngine, instanceId: string): Promise<void> {
  const start = await engine.executeTool(instanceId, "start_session", {
    user_id: "u1",
  });
  expect(start.success).toBe(true);
  expect(start.newState).toBe("session_active");
}

describe("integration/yaml-workflow", () => {
  let dir: string;
  let dbPath: string;
  let yamlPath: string;
  let engine: WorkflowEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-yaml-int-"));
    dbPath = join(dir, "workflow-data.db");
    yamlPath = join(dir, "workflow.yaml");
    writeFileSync(yamlPath, createYamlWorkflow(dbPath), "utf8");
    engine = new WorkflowEngine(":memory:");
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and registers a YAML workflow", () => {
    engine.registerWorkflowFromYaml(yamlPath);
    expect(engine.getRegisteredWorkflowIds()).toContain("yaml-workout");
    expect(engine.getDefinition("yaml-workout")).toBeTruthy();
  });

  it("starts a workflow instance in idle", () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });
    expect(instance.currentState).toBe("idle");
  });

  it("executes tools and verifies state transitions to final", async () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });

    await startSession(engine, instance.instanceId);

    const finish = await engine.executeTool(instance.instanceId, "finish_session", {});
    expect(finish.success).toBe(true);
    expect(finish.newState).toBe("workout_completed");

    const finalStatus = engine.getStatus(instance.instanceId);
    expect(finalStatus.isFinal).toBe(true);
  });

  it("executes SQL steps correctly", async () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });
    await startSession(engine, instance.instanceId);

    const log = await engine.executeTool(instance.instanceId, "log_set", {
      set_number: 1,
      weight: 100,
    });
    expect(log.success).toBe(true);

    const db = new Database(dbPath);
    const count = db
      .prepare("SELECT COUNT(*) as c FROM workout_sets")
      .get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("persists context across tool calls", async () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });
    await startSession(engine, instance.instanceId);

    const status = engine.getStatus(instance.instanceId);
    expect(status.context.session_id).toBeTypeOf("number");

    const session = await engine.executeTool(instance.instanceId, "get_session", {});
    expect(session.success).toBe(true);
  });

  it("records audit log entries for execution and events", async () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });
    await startSession(engine, instance.instanceId);

    await engine.executeTool(instance.instanceId, "log_set", {
      set_number: 1,
      weight: 100,
    });

    const audit = engine.getAuditLog(instance.instanceId, 300);
    expect(audit.some((entry) => entry.eventType === "session_started")).toBe(true);
    expect(audit.some((entry) => entry.eventType === "set_logged")).toBe(true);
    expect(audit.some((entry) => entry.eventType === "tool_succeeded")).toBe(true);
  });

  it("enforces idempotency", async () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });
    await startSession(engine, instance.instanceId);

    const first = await engine.executeTool(instance.instanceId, "log_set", {
      set_number: 1,
      weight: 100,
    });
    expect(first.success).toBe(true);

    const second = await engine.executeTool(instance.instanceId, "log_set", {
      set_number: 1,
      weight: 100,
    });
    expect(second.success).toBe(true);
    expect(second.idempotencyHit).toBe(true);

    const db = new Database(dbPath);
    const count = db
      .prepare("SELECT COUNT(*) as c FROM workout_sets")
      .get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("triggers read-after-write automatically", async () => {
    engine.registerWorkflowFromYaml(yamlPath);
    const instance = engine.startWorkflow("yaml-workout", { user_id: "u1" });
    await startSession(engine, instance.instanceId);

    const result = await engine.executeTool(instance.instanceId, "log_set", {
      set_number: 1,
      weight: 100,
    });
    expect(result.success).toBe(true);

    const audit = engine.getAuditLog(instance.instanceId, 300);
    expect(audit.some((entry) => entry.toolName === "get_session")).toBe(true);
  });
});
