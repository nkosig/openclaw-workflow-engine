import Database from "better-sqlite3";

export interface SqlExecutorOptions {
  defaultDbPath?: string;
  timeoutMs?: number;
}

export type SqlExecutorResult =
  | { error: false; rows: Array<Record<string, unknown>>; changes?: number; lastInsertRowid?: number }
  | { error: false; changes: number; lastInsertRowid?: number; rows?: Array<Record<string, unknown>> }
  | { error: true; message: string; sql_state?: string };

/**
 * SQLite step executor with pooled better-sqlite3 connections.
 */
export class SqlExecutor {
  private static readonly pool = new Map<string, Database.Database>();
  private readonly timeoutMs: number;
  private readonly defaultDbPath?: string;

  constructor(options: SqlExecutorOptions = {}) {
    this.defaultDbPath = options.defaultDbPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * Execute a parameterized SQL statement.
   */
  execute(
    query: string,
    params: unknown[] = [],
    dbPath?: string,
  ): SqlExecutorResult {
    try {
      const db = this.getConnection(dbPath);
      const started = Date.now();
      const stmt = db.prepare(query);
      const sqlVerb = query.trim().split(/\s+/)[0]?.toUpperCase() ?? "";

      if (sqlVerb === "SELECT" || sqlVerb === "WITH" || sqlVerb === "PRAGMA") {
        const rows = stmt.all(...params) as Array<Record<string, unknown>>;
        if (Date.now() - started > this.timeoutMs) {
          return { error: true, message: `SQL execution exceeded timeout (${this.timeoutMs}ms)` };
        }
        return { error: false, rows };
      }

      const runResult = stmt.run(...params);
      if (Date.now() - started > this.timeoutMs) {
        return { error: true, message: `SQL execution exceeded timeout (${this.timeoutMs}ms)` };
      }

      return {
        error: false,
        changes: runResult.changes,
        lastInsertRowid:
          runResult.lastInsertRowid !== undefined
            ? Number(runResult.lastInsertRowid)
            : undefined,
      };
    } catch (error) {
      return {
        error: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a SQL script containing one or more statements.
   */
  executeScript(sql: string, dbPath?: string): SqlExecutorResult {
    try {
      const db = this.getConnection(dbPath);
      db.exec(sql);
      return { error: false, changes: 0 };
    } catch (error) {
      return {
        error: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a callback within a DB transaction.
   */
  runInTransaction<T>(fn: () => T, dbPath?: string): T {
    const db = this.getConnection(dbPath);
    const txn = db.transaction(fn);
    return txn();
  }

  /**
   * Close pooled connections used by this process.
   */
  closeAll(): void {
    for (const [, db] of SqlExecutor.pool) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    SqlExecutor.pool.clear();
  }

  private getConnection(dbPath?: string): Database.Database {
    const path = dbPath ?? this.defaultDbPath;
    if (!path) {
      throw new Error("No SQLite db path configured for SQL execution");
    }

    const existing = SqlExecutor.pool.get(path);
    if (existing) return existing;

    const db = new Database(path);
    db.pragma(`busy_timeout = ${this.timeoutMs}`);
    SqlExecutor.pool.set(path, db);
    return db;
  }
}
