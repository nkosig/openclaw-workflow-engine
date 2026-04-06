import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMachine } from "xstate";
import { z } from "zod";
import { PersistenceLayer } from "../src/persistence";
import { WorkflowMachine } from "../src/machine";
import { ValidationLayer } from "../src/validation";
import type { WorkflowDefinition } from "../src/types";

function makeWorkflow(): WorkflowDefinition {
  return {
    id: "val-test",
    machine: createMachine({
      id: "val-test",
      initial: "step1",
      states: {
        step1: { on: { NEXT: "step2" } },
        step2: { on: { DONE: "finished" } },
        finished: { type: "final" },
      },
    }),
    toolsByState: {
      step1: [
        {
          name: "tool_a",
          description: "A",
          inputSchema: z.object({
            name: z.string(),
            count: z.number().int().positive(),
          }),
          idempotencyKeyTemplate: "{name}_count{count}",
        },
      ],
      step2: [
        {
          name: "tool_b",
          description: "B",
          inputSchema: z.object({ value: z.number() }),
        },
      ],
      finished: [],
    },
  };
}

let db: PersistenceLayer;
let wm: WorkflowMachine;
let vl: ValidationLayer;
let instanceId: string;

beforeEach(() => {
  db = new PersistenceLayer(":memory:");
  wm = new WorkflowMachine(db);
  vl = new ValidationLayer(wm, db);
  wm.registerDefinition(makeWorkflow());
  instanceId = wm.createInstance("val-test").instanceId;
});

afterEach(() => {
  db.close();
});

describe("ValidationLayer", () => {
  it("valid tool call in correct state passes", () => {
    const result = vl.validateToolCall(instanceId, "tool_a", {
      name: "foo",
      count: 3,
    });
    expect(result.valid).toBe(true);
    expect(result.parsedInput).toEqual({ name: "foo", count: 3 });
  });

  it("tool call in wrong state is rejected", () => {
    // tool_b is only available in step2, we are in step1
    const result = vl.validateToolCall(instanceId, "tool_b", { value: 5 });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("'tool_b'");
    expect(result.reason).toContain("step1");
  });

  it("tool call with missing field is rejected by Zod", () => {
    const result = vl.validateToolCall(instanceId, "tool_a", { name: "foo" }); // missing count
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("'tool_a'");
  });

  it("tool call with wrong type is rejected by Zod", () => {
    const result = vl.validateToolCall(instanceId, "tool_a", {
      name: "foo",
      count: "bad",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("'tool_a'");
  });

  it("all rejections appear in audit log", () => {
    vl.validateToolCall(instanceId, "tool_b", { value: 5 }); // wrong state
    vl.validateToolCall(instanceId, "tool_a", { name: "x" }); // missing field

    const log = db.getAuditLog(instanceId);
    const rejectedEvents = log.filter((e) =>
      ["tool_rejected", "validation_failed"].includes(e.eventType),
    );
    expect(rejectedEvents.length).toBe(2);
  });

  it("valid transition check passes", () => {
    const result = vl.validateTransitionPayload(instanceId, "NEXT", {});
    expect(result.valid).toBe(true);
  });

  it("invalid transition check fails", () => {
    const result = vl.validateTransitionPayload(instanceId, "DONE", {}); // DONE not valid from step1
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("'DONE'");
  });

  it("validateTransitionPayload auto-discovers schema from validationsByState", () => {
    const strictDb = new PersistenceLayer(":memory:");
    const strictWm = new WorkflowMachine(strictDb);
    const strictVl = new ValidationLayer(strictWm, strictDb);
    strictWm.registerDefinition({
      id: "strict",
      machine: createMachine({
        id: "strict",
        initial: "a",
        states: { a: { on: { GO: "b" } }, b: { type: "final" } },
      }),
      toolsByState: { a: [], b: [] },
      validationsByState: {
        a: { GO: z.object({ count: z.number().int().positive() }) },
      },
    });
    const strictId = strictWm.createInstance("strict").instanceId;

    // Invalid payload — schema rejects it
    const bad = strictVl.validateTransitionPayload(strictId, "GO", {
      count: -1,
    });
    expect(bad.valid).toBe(false);
    expect(bad.reason).toContain("'GO'");

    // Valid payload
    const good = strictVl.validateTransitionPayload(strictId, "GO", {
      count: 3,
    });
    expect(good.valid).toBe(true);
    expect(good.parsedInput).toEqual({ count: 3 });
    strictDb.close();
  });

  it("idempotency key detects duplicate", () => {
    // First call — not a duplicate
    const first = vl.checkIdempotency(
      instanceId,
      "tool_a",
      { name: "foo", count: 3 },
      "{name}_count{count}",
    );
    expect(first.duplicate).toBe(false);
    expect(first.key).toBe("foo_count3");

    // Simulate a previous successful call logged in DB
    db.logAudit(instanceId, "tool_succeeded", "tool_a", {
      idempotency_key: "foo_count3",
      result: { success: true },
    });

    // Second call — duplicate
    const second = vl.checkIdempotency(
      instanceId,
      "tool_a",
      { name: "foo", count: 3 },
      "{name}_count{count}",
    );
    expect(second.duplicate).toBe(true);
    expect(second.existingResult).toBeTruthy();
  });

  it("idempotency key allows different inputs for same tool", () => {
    db.logAudit(instanceId, "tool_succeeded", "tool_a", {
      idempotency_key: "foo_count3",
      result: { success: true },
    });

    // Different count → different key
    const result = vl.checkIdempotency(
      instanceId,
      "tool_a",
      { name: "foo", count: 5 },
      "{name}_count{count}",
    );
    expect(result.duplicate).toBe(false);
  });

  it("idempotency key is scoped to instance — same key on a different instance is not a duplicate", () => {
    // Log a successful call on instance 1
    db.logAudit(instanceId, "tool_succeeded", "tool_a", {
      idempotency_key: "foo_count3",
      result: { success: true },
    });

    // Create a second, separate instance of the same workflow
    const instance2Id = wm.createInstance("val-test").instanceId;

    // Same tool + same inputs on instance 2 must NOT be seen as a duplicate
    const result = vl.checkIdempotency(
      instance2Id,
      "tool_a",
      { name: "foo", count: 3 },
      "{name}_count{count}",
    );
    expect(result.duplicate).toBe(false);
  });
});
