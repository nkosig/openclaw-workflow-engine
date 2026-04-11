import { describe, expect, it } from "vitest";
import {
  resolveTemplate,
  resolveSqlTemplate,
  TemplateResolutionError,
} from "../../src/config/templates.js";

describe("config/templates", () => {
  const scope = {
    input: { id: 42, name: "alice", value: "hello" },
    context: { user_id: "u1", name: "context-name" },
    result_name: { column: "value" },
    rows: [{ column: "first" }],
  };

  it("resolves {{input.x}} from input", () => {
    expect(resolveTemplate("{{input.id}}", scope)).toBe(42);
  });

  it("resolves {{context.x}} from context", () => {
    expect(resolveTemplate("{{context.user_id}}", scope)).toBe("u1");
  });

  it("resolves nested dot paths", () => {
    expect(resolveTemplate("{{result_name.column}}", scope)).toBe("value");
  });

  it("resolves array index + dot access", () => {
    expect(resolveTemplate("{{rows[0].column}}", scope)).toBe("first");
  });

  it("resolves env vars", () => {
    process.env.WF_TEST_SECRET = "secret-value";
    expect(resolveTemplate("{{env.WF_TEST_SECRET}}", scope)).toBe(
      "secret-value",
    );
  });

  it("produces parameterized SQL tuples", () => {
    const [query, params] = resolveSqlTemplate(
      "SELECT * FROM t WHERE id = {{input.id}} AND name = {{context.name}}",
      scope,
    );
    expect(query).toBe("SELECT * FROM t WHERE id = ? AND name = ?");
    expect(params).toEqual([42, "context-name"]);
  });

  it("throws on unresolved templates with clear error", () => {
    expect(() => resolveTemplate("{{input.missing}}", scope)).toThrow(
      TemplateResolutionError,
    );
  });

  it("parameterizes SQL injection attempts safely", () => {
    const injScope = {
      input: { id: "1; DROP TABLE users; --" },
      context: {},
    };
    const [query, params] = resolveSqlTemplate(
      "SELECT * FROM users WHERE id = {{input.id}}",
      injScope,
    );
    expect(query).toBe("SELECT * FROM users WHERE id = ?");
    expect(params).toEqual(["1; DROP TABLE users; --"]);
  });
});
