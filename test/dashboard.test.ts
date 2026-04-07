import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMachine } from "xstate";
import { z } from "zod";
import { WorkflowEngine } from "../src/engine.js";
import { buildDashboardHtml } from "../src/dashboard.js";
import type { WorkflowDefinition } from "../src/types.js";

function makeTestWorkflow(): WorkflowDefinition {
  return {
    id: "dash-wf",
    machine: createMachine({
      id: "dashWf",
      initial: "step_a",
      states: {
        step_a: { on: { NEXT: "step_b" } },
        step_b: { type: "final" },
      },
    }),
    toolsByState: {
      step_a: [
        { name: "do_a", description: "Do A", inputSchema: z.object({}) },
      ],
      step_b: [],
    },
  };
}

describe("dashboard — buildDashboardHtml", () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(":memory:");
    engine.registerWorkflow(makeTestWorkflow());
  });

  afterEach(() => {
    engine.close();
  });

  it("renders a section for every registered workflow", () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("dash-wf");
  });

  it('shows "No active instance" when no instance is running', () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("No active instance");
  });

  it("shows the instance id and current state when an instance is active", () => {
    const instance = engine.startWorkflow("dash-wf");
    const html = buildDashboardHtml(engine);
    expect(html).toContain(instance.instanceId);
    expect(html).toContain("step_a");
  });

  it("includes a stateDiagram-v2 Mermaid block", () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("stateDiagram-v2");
  });

  it("Mermaid block contains state names and transition event", () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("step_a");
    expect(html).toContain("step_b");
    expect(html).toContain("NEXT");
  });

  it("Mermaid block contains final-state arrow for step_b", () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("step_b --> [*]");
  });

  it("shows audit log entries after an instance has activity", () => {
    engine.startWorkflow("dash-wf");
    const html = buildDashboardHtml(engine);
    expect(html).toContain("instance_created");
  });

  it('shows "No entries" in audit section before any instance is started', () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("No entries");
  });

  it("renders valid HTML with head and body tags", () => {
    const html = buildDashboardHtml(engine);
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain("</html>");
  });
});
