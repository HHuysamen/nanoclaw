/**
 * Host-side vault.db reader/writer.
 *
 * Same SQLite file as `container/agent-runner/src/db/vault.ts` — the host
 * just opens it via better-sqlite3 instead of bun:sqlite. Used by
 * host-sweep to close stale sessions and (later) drive summary jobs.
 *
 * Cross-mount notes:
 *   - journal_mode=DELETE — must match the container side, else WAL files
 *     appear that the container readers cannot see through virtiofs.
 *   - Writes use IMMEDIATE so we don't compete with a container reader
 *     mid-statement.
 */
import fs from 'fs';
import path from 'path';

import BetterSqlite3 from 'better-sqlite3';

import { MEMORY_VAULT_DIR, MEMORY_VAULT_PATH } from '../../config.js';
import { log } from '../../log.js';

let _db: BetterSqlite3.Database | null = null;

function openVault(): BetterSqlite3.Database {
  if (!fs.existsSync(MEMORY_VAULT_DIR)) {
    fs.mkdirSync(MEMORY_VAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(MEMORY_VAULT_PATH)) {
    // Touch so the file exists; container will bootstrap the schema on first
    // open. Host calls into this lazily, so first invocation may see an
    // empty file and find no rows — that's fine.
    fs.closeSync(fs.openSync(MEMORY_VAULT_PATH, 'w'));
  }
  const db = new BetterSqlite3(MEMORY_VAULT_PATH);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

export function getHostVault(): BetterSqlite3.Database {
  if (!_db) _db = openVault();
  return _db;
}

export function closeHostVault(): void {
  _db?.close();
  _db = null;
}

export interface OpenSession {
  id: string;
  agent_group_id: string;
  started_at: number;
  last_ts: number;
}

/**
 * Find sessions that are still `ended_at IS NULL` and whose most recent turn
 * is older than `idleMs`. Returns up to `limit` rows.
 *
 * Robust against the case where the schema isn't bootstrapped yet (no
 * containers have spawned since the install): returns [] silently.
 */
export function findStaleOpenSessions(idleMs: number, nowMs: number, limit = 50): OpenSession[] {
  const db = getHostVault();
  try {
    return db
      .prepare(
        `SELECT s.id, s.agent_group_id, s.started_at,
                COALESCE((SELECT MAX(ts) FROM turns WHERE session_id = s.id), s.started_at) AS last_ts
         FROM sessions s
         WHERE s.ended_at IS NULL
         ORDER BY s.started_at DESC
         LIMIT ?`,
      )
      .all(limit)
      .map((r) => r as OpenSession)
      .filter((r) => r.last_ts < nowMs - idleMs);
  } catch (err) {
    // sessions table may not exist yet — first run before any container has
    // bootstrapped the schema. Treat as "nothing to sweep".
    if (err instanceof Error && /no such table/i.test(err.message)) return [];
    log.warn('vault: findStaleOpenSessions failed', { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export function closeSessionAt(sessionId: string, endedAtMs: number): void {
  const db = getHostVault();
  try {
    db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(endedAtMs, sessionId);
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return;
    throw err;
  }
}
