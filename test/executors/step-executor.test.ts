import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StepExecutor } from "../../src/executors/step-executor.js";
import { SqlExecutor } from "../../src/executors/sql-executor.js";
import { HttpExecutor } from "../../src/executors/http-executor.js";
import type { WorkflowStepConfig } from "../../src/config/schema.js";

class StubHttpExecutor extends HttpExecutor {
  override async execute(): Promise<{
    error: false;
    status: number;
    data: unknown;
    headers: Record<string, string>;
  }> {
    return {
      error: false,
      status: 200,
      data: { ok: true },
      headers: {},
    };
  }
}

async function withDb(
  testFn: (dbPath: string, sql: SqlExecutor) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wf-step-"));
  const dbPath = join(dir, "step.db");
  const sql = new SqlExecutor({ defaultDbPath: dbPath });
  try {
    sql.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)");
    await testFn(dbPath, sql);
  } finally {
    sql.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("executors/step-executor", () => {
  it("executes sequential steps and exposes results via as", async () => {
    await withDb(async (dbPath, sql) => {
      const stepExecutor = new StepExecutor({
        sql,
        http: new StubHttpExecutor(),
        workflowConfig: { db: dbPath, api_base: "https://example.com" },
      });

      const steps: WorkflowStepConfig[] = [
        {
          sql: "INSERT INTO items (name, qty) VALUES ({{input.name}}, {{input.qty}})",
          as: "inserted",
        },
        {
          sql: "SELECT * FROM items WHERE name = {{input.name}}",
          as: "rows",
        },
      ];

      const result = await stepExecutor.executeSteps(steps, { name: "bench", qty: 4 }, {});
      expect(result.error).toBeUndefined();
      expect(result.returned).toBe(false);
      expect(Array.isArray(result.results.rows)).toBe(true);
    });
  });

  it("if branches execute correctly and return stops execution", async () => {
    await withDb(async (dbPath, sql) => {
      const stepExecutor = new StepExecutor({
        sql,
        http: new StubHttpExecutor(),
        workflowConfig: { db: dbPath },
      });

      const steps: WorkflowStepConfig[] = [
        { sql: "SELECT 1 as count", as: "progress" },
        {
          if: "progress[0].count >= 1",
          then: [
            {
              return: { done: true },
              transition: "completed",
            },
          ],
          else: [
            {
              sql: "INSERT INTO items (name, qty) VALUES ('x', 1)",
            },
          ],
        },
        {
          sql: "INSERT INTO items (name, qty) VALUES ('should_not_run', 1)",
        },
      ];

      const result = await stepExecutor.executeSteps(steps, {}, {});
      expect(result.returned).toBe(true);
      expect(result.transition).toBe("completed");

      const rows = sql.execute("SELECT * FROM items WHERE name = 'should_not_run'");
      expect(rows.error).toBe(false);
      if (!rows.error) expect(rows.rows).toHaveLength(0);
    });
  });

  it("set_context updates persisted context object", async () => {
    await withDb(async (dbPath, sql) => {
      const stepExecutor = new StepExecutor({
        sql,
        http: new StubHttpExecutor(),
        workflowConfig: { db: dbPath },
      });

      const context: Record<string, unknown> = {};
      const steps: WorkflowStepConfig[] = [
        {
          set_context: {
            session_id: "{{input.session_id}}",
          },
        },
      ];

      const result = await stepExecutor.executeSteps(steps, { session_id: "s1" }, context);
      expect(result.contextUpdated).toBe(true);
      expect(context.session_id).toBe("s1");
    });
  });

  it("event steps log to audit callback", async () => {
    await withDb(async (dbPath, sql) => {
      const events: Array<{ type: string; payload: unknown }> = [];
      const stepExecutor = new StepExecutor({
        sql,
        http: new StubHttpExecutor(),
        workflowConfig: { db: dbPath },
        logAudit: (eventType, payload) => {
          events.push({ type: eventType, payload });
        },
      });

      const steps: WorkflowStepConfig[] = [
        {
          event: "custom_event",
          payload: { value: "{{input.value}}" },
        },
      ];

      await stepExecutor.executeSteps(steps, { value: "ok" }, {});
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("custom_event");
      expect(events[0].payload).toEqual({ value: "ok" });
    });
  });

  it("enforces max if nesting depth", async () => {
    await withDb(async (dbPath, sql) => {
      const stepExecutor = new StepExecutor({
        sql,
        http: new StubHttpExecutor(),
        workflowConfig: { db: dbPath },
        maxIfDepth: 3,
      });

      const nested: WorkflowStepConfig[] = [
        {
          if: "input.ok",
          then: [
            {
              if: "input.ok",
              then: [
                {
                  if: "input.ok",
                  then: [
                    {
                      if: "input.ok",
                      then: [
                        {
                          return: { deep: true },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      const result = await stepExecutor.executeSteps(nested, { ok: true }, {});
      expect(result.error?.message).toMatch(/Maximum if nesting depth/);
    });
  });

  it("step failures stop execution and return error", async () => {
    await withDb(async (dbPath, sql) => {
      const stepExecutor = new StepExecutor({
        sql,
        http: new StubHttpExecutor(),
        workflowConfig: { db: dbPath },
      });

      const steps: WorkflowStepConfig[] = [
        { sql: "INSERT INTO items (name, qty) VALUES ('ok', 1)" },
        { sql: "INSERT INTO missing_table (x) VALUES (1)" },
        { sql: "INSERT INTO items (name, qty) VALUES ('later', 1)" },
      ];

      const result = await stepExecutor.executeSteps(steps, {}, {});
      expect(result.error).toBeTruthy();

      const rows = sql.execute("SELECT * FROM items WHERE name = 'later'");
      expect(rows.error).toBe(false);
      if (!rows.error) {
        expect(rows.rows).toHaveLength(0);
      }
    });
  });
});
