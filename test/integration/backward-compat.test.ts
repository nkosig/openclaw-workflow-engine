import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../src/engine.js";
import { workoutCoachWorkflow } from "../../examples/workout-coach";

describe("integration/backward-compat", () => {
  it("TypeScript workflow definitions still execute unchanged", async () => {
    const engine = new WorkflowEngine(":memory:");
    try {
      engine.registerWorkflow(workoutCoachWorkflow);
      const instance = engine.startWorkflow("workout-coach");

      const a = await engine.executeTool(instance.instanceId, "get_next_workout", {});
      expect(a.success).toBe(true);
      expect(a.newState).toBe("showing_next_workout");

      const b = await engine.executeTool(instance.instanceId, "start_workout_session", {
        template_id: "tpl-1",
        idempotency_key: "id-1",
      });
      expect(b.success).toBe(true);
      expect(b.newState).toBe("workout_started");
    } finally {
      engine.close();
    }
  });
});
