import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/config/conditions.js";

describe("config/conditions", () => {
  const scope = {
    count: 5,
    a: true,
    b: false,
    result_name: { field: "x" },
    rows: [{ n: 2 }],
  };

  it("handles truthy/falsy checks", () => {
    expect(evaluateCondition("result_name", scope)).toBe(true);
    expect(evaluateCondition("missing", scope)).toBe(false);
  });

  it("handles numeric comparisons", () => {
    expect(evaluateCondition("count >= 4", scope)).toBe(true);
    expect(evaluateCondition("count < 4", scope)).toBe(false);
  });

  it("handles boolean AND/OR", () => {
    expect(evaluateCondition("a && b", scope)).toBe(false);
    expect(evaluateCondition("a || b", scope)).toBe(true);
  });

  it("handles negation", () => {
    expect(evaluateCondition("!b", scope)).toBe(true);
    expect(evaluateCondition("!a", scope)).toBe(false);
  });

  it("handles nested field access", () => {
    expect(evaluateCondition("result_name.field", scope)).toBe(true);
    expect(evaluateCondition("rows[0].n == 2", scope)).toBe(true);
  });

  it("rejects unsafe expressions", () => {
    expect(() => evaluateCondition("process.exit(1)", scope)).toThrow();
  });
});
