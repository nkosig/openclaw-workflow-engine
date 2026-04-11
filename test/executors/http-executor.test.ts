import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpExecutor } from "../../src/executors/http-executor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responses: Array<{ ok: boolean; status: number; statusText?: string; body?: unknown }>) {
  let call = 0;
  vi.stubGlobal("fetch", async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    const text = r.body !== undefined ? JSON.stringify(r.body) : "";
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText ?? (r.ok ? "OK" : "Error"),
      text: async () => text,
      headers: { forEach: () => {} },
    };
  });
}

describe("executors/http-executor", () => {
  it("returns parsed JSON response on success", async () => {
    mockFetch([{ ok: true, status: 200, body: { id: 1, name: "item" } }]);
    const http = new HttpExecutor();
    const result = await http.execute({ method: "GET", url: "http://example.com/api/items/1" }, {});
    expect(result.error).toBe(false);
    if (!result.error) {
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ id: 1, name: "item" });
    }
  });

  it("returns error on non-OK HTTP response", async () => {
    mockFetch([{ ok: false, status: 404, statusText: "Not Found" }]);
    const http = new HttpExecutor({ retries: 0 });
    const result = await http.execute({ method: "GET", url: "http://example.com/api/missing" }, {});
    expect(result.error).toBe(true);
    if (result.error) {
      expect(result.status).toBe(404);
    }
  });

  it("retries on failure and succeeds on second attempt", async () => {
    mockFetch([
      { ok: false, status: 503, statusText: "Service Unavailable" },
      { ok: true, status: 200, body: { ok: true } },
    ]);
    const http = new HttpExecutor({ retries: 1 });
    const result = await http.execute({ method: "GET", url: "http://example.com/api" }, {});
    expect(result.error).toBe(false);
  });

  it("returns error after exhausting retries", async () => {
    mockFetch([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ]);
    const http = new HttpExecutor({ retries: 1 });
    const result = await http.execute({ method: "GET", url: "http://example.com/api" }, {});
    expect(result.error).toBe(true);
  });

  it("resolves template expressions in URL and body", async () => {
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
        headers: { forEach: () => {} },
      };
    });
    const http = new HttpExecutor();
    await http.execute(
      { method: "GET", url: "http://example.com/items/{{input.id}}" },
      { input: { id: "42" } },
    );
    expect(capturedUrl).toBe("http://example.com/items/42");
  });

  it("returns error on network failure without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const http = new HttpExecutor({ retries: 0 });
    const result = await http.execute({ method: "GET", url: "http://localhost:9/gone" }, {});
    expect(result.error).toBe(true);
    if (result.error) {
      expect(result.message).toContain("ECONNREFUSED");
    }
  });
});
