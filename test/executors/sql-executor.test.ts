import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqlExecutor } from "../../src/executors/sql-executor.js";

describe("executors/sql-executor", () => {
  function withDb(testFn: (dbPath: string, sql: SqlExecutor) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "wf-sql-"));
    const dbPath = join(dir, "test.db");
    const sql = new SqlExecutor({ defaultDbPath: dbPath });
    try {
      sql.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)");
      testFn(dbPath, sql);
    } finally {
      sql.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("SELECT returns rows", () => {
    withDb((_dbPath, sql) => {
      sql.execute("INSERT INTO items (name, qty) VALUES (?, ?)", ["a", 1]);
      const out = sql.execute("SELECT * FROM items");
      expect(out.error).toBe(false);
      if (!out.error) {
        expect(out.rows).toHaveLength(1);
      }
    });
  });

  it("INSERT returns lastInsertRowid", () => {
    withDb((_dbPath, sql) => {
      const out = sql.execute("INSERT INTO items (name, qty) VALUES (?, ?)", ["a", 1]);
      expect(out.error).toBe(false);
      if (!out.error) {
        expect(out.lastInsertRowid).toBeTypeOf("number");
      }
    });
  });

  it("UPDATE/DELETE returns changes count", () => {
    withDb((_dbPath, sql) => {
      sql.execute("INSERT INTO items (name, qty) VALUES (?, ?)", ["a", 1]);
      const update = sql.execute("UPDATE items SET qty = ? WHERE name = ?", [2, "a"]);
      const del = sql.execute("DELETE FROM items WHERE name = ?", ["a"]);
      expect(update.error).toBe(false);
      expect(del.error).toBe(false);
      if (!update.error) expect(update.changes).toBe(1);
      if (!del.error) expect(del.changes).toBe(1);
    });
  });

  it("parameterized queries prevent injection", () => {
    withDb((_dbPath, sql) => {
      const malicious = "x'); DROP TABLE items; --";
      sql.execute("INSERT INTO items (name, qty) VALUES (?, ?)", [malicious, 1]);
      const select = sql.execute("SELECT * FROM items WHERE name = ?", [malicious]);
      expect(select.error).toBe(false);
      if (!select.error) expect(select.rows).toHaveLength(1);

      const stillThere = sql.execute("SELECT * FROM items");
      expect(stillThere.error).toBe(false);
    });
  });

  it("timeout handling returns an error result", () => {
    const sql = new SqlExecutor({ timeoutMs: -1, defaultDbPath: ":memory:" });
    const out = sql.execute("SELECT 1 as x");
    expect(out.error).toBe(true);
    sql.closeAll();
  });

  it("reuses connections for same db path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-sql-reuse-"));
    const dbPath = join(dir, "reuse.db");
    const a = new SqlExecutor({ defaultDbPath: dbPath });
    const b = new SqlExecutor({ defaultDbPath: dbPath });
    try {
      a.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      a.execute("INSERT INTO t (v) VALUES (?)", ["one"]);
      const read = b.execute("SELECT * FROM t");
      expect(read.error).toBe(false);
      if (!read.error) expect(read.rows).toHaveLength(1);
    } finally {
      a.closeAll();
      b.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns errors instead of throwing", () => {
    const sql = new SqlExecutor({ defaultDbPath: ":memory:" });
    const out = sql.execute("SELECT FROM broken");
    expect(out.error).toBe(true);
    sql.closeAll();
  });
});
