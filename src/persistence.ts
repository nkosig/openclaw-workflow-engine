import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { InstanceRow, AuditEntry } from './types.js'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_instances (
  instance_id   TEXT    PRIMARY KEY,
  workflow_id   TEXT    NOT NULL,
  current_state TEXT    NOT NULL,
  xstate_snapshot TEXT  NOT NULL,
  context       TEXT,
  is_final      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_transitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id      TEXT    NOT NULL REFERENCES workflow_instances(instance_id),
  from_state       TEXT    NOT NULL,
  to_state         TEXT    NOT NULL,
  event            TEXT    NOT NULL,
  payload          TEXT,
  valid            INTEGER NOT NULL DEFAULT 1,
  rejection_reason TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id  TEXT,
  event_type   TEXT NOT NULL,
  tool_name    TEXT,
  payload      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_migrations (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_audit_idempotency
ON workflow_audit_log (instance_id, tool_name, json_extract(payload, '$.idempotency_key'));
`

/**
 * SQLite persistence layer for workflow instances, transitions, and audit log.
 * Uses better-sqlite3 for synchronous access.
 */
export class PersistenceLayer {
  private db: Database.Database

  constructor(dbPath: string = './workflow.db') {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA_SQL)
  }

  /**
   * Create or update a workflow instance snapshot.
   * Provide workflowId only on first creation. Subsequent calls omit it; if the instance
   * does not exist and workflowId is missing, an error is thrown.
   */
  saveSnapshot(
    instanceId: string,
    snapshot: object,
    state: string,
    context: Record<string, unknown>,
    isFinal: boolean = false,
    workflowId?: string,
  ): void {
    const snapshotJson = JSON.stringify(snapshot)
    const contextJson = JSON.stringify(context)

    if (workflowId) {
      // First creation path: UPSERT — INSERT new row or update mutable fields on conflict.
      // workflow_id and created_at are intentionally excluded from the UPDATE clause.
      this.db
        .prepare(`
          INSERT INTO workflow_instances
            (instance_id, workflow_id, current_state, xstate_snapshot, context, is_final)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(instance_id) DO UPDATE SET
            current_state   = excluded.current_state,
            xstate_snapshot = excluded.xstate_snapshot,
            context         = excluded.context,
            is_final        = excluded.is_final,
            updated_at      = datetime('now')
        `)
        .run(instanceId, workflowId, state, snapshotJson, contextJson, isFinal ? 1 : 0)
    } else {
      // Update-only path: no SELECT needed — throw only if nothing was updated.
      const result = this.db
        .prepare(`
          UPDATE workflow_instances
          SET current_state = ?, xstate_snapshot = ?, context = ?, is_final = ?,
              updated_at = datetime('now')
          WHERE instance_id = ?
        `)
        .run(state, snapshotJson, contextJson, isFinal ? 1 : 0, instanceId)
      if (result.changes === 0) {
        throw new Error(
          `workflowId is required when creating a new instance (instanceId: ${instanceId})`,
        )
      }
    }
  }

  /**
   * Load a persisted instance snapshot by instance ID.
   * Returns null if no instance exists with the given ID.
   */
  loadSnapshot(instanceId: string): InstanceRow | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_instances WHERE instance_id = ?')
      .get(instanceId) as InstanceRow | undefined
    return row ?? null
  }

  /**
   * Find the first non-final instance for a given workflow ID.
   * Returns null if all instances for the workflow are in final states.
   */
  getActiveInstance(workflowId: string): InstanceRow | null {
    const row = this.db
      .prepare(`
        SELECT * FROM workflow_instances
        WHERE workflow_id = ? AND is_final = 0
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(workflowId) as InstanceRow | undefined
    return row ?? null
  }

  /**
   * Retrieve transition log entries for an instance, newest first.
   */
  getTransitions(
    instanceId: string,
    limit: number = 100,
  ): Array<{
    id: number
    fromState: string
    toState: string
    event: string
    payload: unknown
    valid: boolean
    rejectionReason: string | null
    createdAt: string
  }> {
    const rows = this.db
      .prepare(`
        SELECT * FROM workflow_transitions
        WHERE instance_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(instanceId, limit) as Array<{
        id: number
        from_state: string
        to_state: string
        event: string
        payload: string | null
        valid: number
        rejection_reason: string | null
        created_at: string
      }>

    return rows.map((r) => ({
      id: r.id,
      fromState: r.from_state,
      toState: r.to_state,
      event: r.event,
      payload: r.payload != null ? JSON.parse(r.payload) : null,
      valid: r.valid === 1,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
    }))
  }

  /**
   * Log a state transition attempt (valid or rejected).
   */
  logTransition(
    instanceId: string,
    from: string,
    to: string,
    event: string,
    payload: unknown,
    valid: boolean,
    reason?: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO workflow_transitions
          (instance_id, from_state, to_state, event, payload, valid, rejection_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        instanceId,
        from,
        to,
        event,
        payload != null ? JSON.stringify(payload) : null,
        valid ? 1 : 0,
        reason ?? null,
      )
  }

  /**
   * Log an audit event. Returns the inserted row ID.
   */
  logAudit(
    instanceId: string | null,
    eventType: string,
    toolName?: string,
    payload?: unknown,
  ): number {
    const result = this.db
      .prepare(`
        INSERT INTO workflow_audit_log (instance_id, event_type, tool_name, payload)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        instanceId,
        eventType,
        toolName ?? null,
        payload != null ? JSON.stringify(payload) : null,
      )
    return Number(result.lastInsertRowid)
  }

  /**
   * Retrieve audit log entries for an instance, newest first.
   */
  getAuditLog(instanceId: string, limit: number = 100): AuditEntry[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM workflow_audit_log
        WHERE instance_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(instanceId, limit) as Array<{
        id: number
        instance_id: string | null
        event_type: string
        tool_name: string | null
        payload: string | null
        created_at: string
      }>

    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      eventType: r.event_type,
      toolName: r.tool_name,
      payload: r.payload != null ? JSON.parse(r.payload) : null,
      createdAt: r.created_at,
    }))
  }

  /**
   * Find all audit log entries matching a tool name and idempotency key in the payload.
   */
  findByIdempotencyKey(
    instanceId: string,
    toolName: string,
    key: string,
  ): Array<{ id: number; payload: string }> {
    return this.db
      .prepare(`
        SELECT id, payload FROM workflow_audit_log
        WHERE instance_id = ?
          AND tool_name = ?
          AND event_type = 'tool_succeeded'
          AND payload IS NOT NULL
          AND json_extract(payload, '$.idempotency_key') = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .all(instanceId, toolName, key) as Array<{ id: number; payload: string }>
  }

  /**
   * Persist only the context JSON for an existing workflow instance.
   */
  updateContext(instanceId: string, context: Record<string, unknown>): void {
    const result = this.db
      .prepare(`
        UPDATE workflow_instances
        SET context = ?, updated_at = datetime('now')
        WHERE instance_id = ?
      `)
      .run(JSON.stringify(context), instanceId)

    if (result.changes === 0) {
      throw new Error(`Instance '${instanceId}' not found`)
    }
  }

  /**
   * Return migration versions already applied for a workflow.
   */
  getAppliedMigrations(workflowId: string): number[] {
    return this.db
      .prepare(`
        SELECT version
        FROM workflow_migrations
        WHERE workflow_id = ?
        ORDER BY version ASC
      `)
      .all(workflowId)
      .map((r) => (r as { version: number }).version)
  }

  /**
   * Record one applied migration version.
   */
  markMigrationApplied(workflowId: string, version: number): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO workflow_migrations (workflow_id, version)
        VALUES (?, ?)
      `)
      .run(workflowId, version)
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }
}
