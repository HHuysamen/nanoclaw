/**
 * Adaptive-memory vault.
 *
 * Shared SQLite file mounted at /vault/vault.db. All four agent groups
 * read and write it from inside their own containers. Per-group scoping
 * is enforced at the query layer via agent_group_id.
 *
 * Why this design and not "host-side daemon with TCP":
 *   - Claude Agent SDK spawns MCP servers as child processes inside the
 *     container. No IPC tunnel to the host.
 *   - SQLite cross-process locking via flock works for our load (a few
 *     writes/turn, four containers max).
 *
 * Cross-mount visibility:
 *   - journal_mode=DELETE is load-bearing — see
 *     container/agent-runner/src/db/connection.ts for the full story.
 *   - mmap_size=0 keeps readers from caching page reads that another
 *     container has invalidated.
 *
 * bun:sqlite gotcha: named params use $name in BOTH SQL and JS keys.
 * Positional ? works normally.
 */
import { Database } from 'bun:sqlite';

const VAULT_PATH = process.env.NANOCLAW_VAULT_PATH || '/vault/vault.db';

let _db: Database | null = null;

export function getVault(): Database {
  if (_db) return _db;
  const db = new Database(VAULT_PATH);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  db.exec('PRAGMA foreign_keys = ON');
  bootstrapSchema(db);
  _db = db;
  return db;
}

export function closeVault(): void {
  _db?.close();
  _db = null;
}

/**
 * Idempotent schema bootstrap. Runs on first open. Cheap to re-run —
 * uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 *
 * Schema mirrors the original adaptive-memory plan §3.1.
 */
function bootstrapSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      agent_group_id  TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      channel         TEXT,
      platform_id     TEXT,
      thread_id       TEXT,
      summary         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(agent_group_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions(agent_group_id, ended_at) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS turns (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id),
      agent_group_id  TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      tool_calls      INTEGER NOT NULL DEFAULT 0,
      tool_names      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_turns_group ON turns(agent_group_id, ts DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      content,
      agent_group_id UNINDEXED,
      session_id UNINDEXED,
      content='turns',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content, agent_group_id, session_id)
      VALUES (new.rowid, new.content, new.agent_group_id, new.session_id);
    END;

    CREATE TRIGGER IF NOT EXISTS turns_fts_delete AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content, agent_group_id, session_id)
      VALUES ('delete', old.rowid, old.content, old.agent_group_id, old.session_id);
    END;

    CREATE TRIGGER IF NOT EXISTS turns_fts_update AFTER UPDATE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content, agent_group_id, session_id)
      VALUES ('delete', old.rowid, old.content, old.agent_group_id, old.session_id);
      INSERT INTO turns_fts(rowid, content, agent_group_id, session_id)
      VALUES (new.rowid, new.content, new.agent_group_id, new.session_id);
    END;

    CREATE TABLE IF NOT EXISTS skill_invocations (
      id              TEXT PRIMARY KEY,
      agent_group_id  TEXT NOT NULL,
      skill_name      TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      tool_calls      INTEGER NOT NULL,
      success         INTEGER,
      user_feedback   TEXT,
      notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_skill_inv ON skill_invocations(agent_group_id, skill_name, ts DESC);

    CREATE TABLE IF NOT EXISTS skill_state (
      agent_group_id        TEXT NOT NULL,
      skill_name            TEXT NOT NULL,
      invocations_since_ref INTEGER NOT NULL DEFAULT 0,
      last_reflected_at     INTEGER,
      PRIMARY KEY (agent_group_id, skill_name)
    );
  `);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  agent_group_id: string;
  started_at: number;
  ended_at: number | null;
  channel: string | null;
  platform_id: string | null;
  thread_id: string | null;
  summary: string | null;
}

/**
 * Find an open session for this group + channel + thread, or open a new one.
 * "Open" = ended_at IS NULL and last activity within idle window. If
 * `idleMs` has elapsed since the last turn, the previous session is auto-closed
 * and a new one is opened.
 */
export function getOrCreateSession(input: {
  agentGroupId: string;
  channel: string | null;
  platformId: string | null;
  threadId: string | null;
  idleMs: number;
  nowMs: number;
  newSessionId: () => string;
}): SessionRow {
  const db = getVault();
  const cutoff = input.nowMs - input.idleMs;

  // Try to reuse the open session if its last turn is within the idle window.
  const candidate = db
    .prepare(
      `SELECT s.*, COALESCE((SELECT MAX(ts) FROM turns WHERE session_id = s.id), s.started_at) AS last_ts
       FROM sessions s
       WHERE s.agent_group_id = $agentGroupId
         AND s.ended_at IS NULL
         AND s.channel IS $channel
         AND s.platform_id IS $platformId
         AND s.thread_id IS $threadId
       ORDER BY s.started_at DESC
       LIMIT 1`,
    )
    .get({
      $agentGroupId: input.agentGroupId,
      $channel: input.channel,
      $platformId: input.platformId,
      $threadId: input.threadId,
    }) as (SessionRow & { last_ts: number }) | undefined;

  if (candidate && candidate.last_ts >= cutoff) {
    return candidate;
  }

  // Auto-close the stale candidate before opening a new one.
  if (candidate) {
    db.prepare(`UPDATE sessions SET ended_at = $endedAt WHERE id = $id`).run({
      $endedAt: input.nowMs,
      $id: candidate.id,
    });
  }

  const id = input.newSessionId();
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, started_at, channel, platform_id, thread_id)
     VALUES ($id, $agentGroupId, $startedAt, $channel, $platformId, $threadId)`,
  ).run({
    $id: id,
    $agentGroupId: input.agentGroupId,
    $startedAt: input.nowMs,
    $channel: input.channel,
    $platformId: input.platformId,
    $threadId: input.threadId,
  });

  return {
    id,
    agent_group_id: input.agentGroupId,
    started_at: input.nowMs,
    ended_at: null,
    channel: input.channel,
    platform_id: input.platformId,
    thread_id: input.threadId,
    summary: null,
  };
}

export function getSession(id: string): SessionRow | null {
  return (getVault().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | null) ?? null;
}

export function listRecentSessions(agentGroupId: string, limit: number): SessionRow[] {
  return getVault()
    .prepare(
      `SELECT * FROM sessions
       WHERE agent_group_id = ?
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(agentGroupId, Math.max(1, Math.min(100, limit))) as SessionRow[];
}

export function updateSessionSummary(id: string, summary: string): void {
  getVault().prepare(`UPDATE sessions SET summary = ? WHERE id = ?`).run(summary, id);
}

export function closeSession(id: string, endedAt: number): void {
  getVault().prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(endedAt, id);
}

// ─── Turns ───────────────────────────────────────────────────────────────────

export interface TurnRow {
  id: string;
  session_id: string;
  agent_group_id: string;
  ts: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: number;
  tool_names: string | null;
}

export function insertTurn(turn: TurnRow): void {
  getVault()
    .prepare(
      `INSERT INTO turns (id, session_id, agent_group_id, ts, role, content, tool_calls, tool_names)
       VALUES ($id, $sessionId, $agentGroupId, $ts, $role, $content, $toolCalls, $toolNames)`,
    )
    .run({
      $id: turn.id,
      $sessionId: turn.session_id,
      $agentGroupId: turn.agent_group_id,
      $ts: turn.ts,
      $role: turn.role,
      $content: turn.content,
      $toolCalls: turn.tool_calls,
      $toolNames: turn.tool_names,
    });
}

export interface SearchHit {
  rowid: number;
  session_id: string;
  agent_group_id: string;
  ts: number;
  role: string;
  snippet: string;
}

/**
 * FTS5 search over turn content. `scope` defaults to 'group' — restrict to
 * the calling agent's history. Pass 'all' for cross-group queries (opt-in,
 * mention only in user-explicit recall scenarios).
 */
export function searchTurns(input: {
  query: string;
  agentGroupId: string;
  scope: 'group' | 'all';
  limit: number;
}): SearchHit[] {
  const db = getVault();
  const limit = Math.max(1, Math.min(50, input.limit));
  if (input.scope === 'all') {
    return db
      .prepare(
        `SELECT t.rowid AS rowid, t.session_id, t.agent_group_id, t.ts, t.role,
                snippet(turns_fts, 0, '«', '»', '…', 16) AS snippet
         FROM turns_fts JOIN turns t ON t.rowid = turns_fts.rowid
         WHERE turns_fts MATCH $query
         ORDER BY rank
         LIMIT $limit`,
      )
      .all({ $query: input.query, $limit: limit }) as SearchHit[];
  }
  return db
    .prepare(
      `SELECT t.rowid AS rowid, t.session_id, t.agent_group_id, t.ts, t.role,
              snippet(turns_fts, 0, '«', '»', '…', 16) AS snippet
       FROM turns_fts JOIN turns t ON t.rowid = turns_fts.rowid
       WHERE turns_fts MATCH $query AND t.agent_group_id = $agentGroupId
       ORDER BY rank
       LIMIT $limit`,
    )
    .all({ $query: input.query, $agentGroupId: input.agentGroupId, $limit: limit }) as SearchHit[];
}

/**
 * Return the chronological turn contents for a given session. Used by the
 * summarisation job. Capped to prevent runaway memory for very long sessions.
 */
export function getSessionTurns(sessionId: string, limit = 200): TurnRow[] {
  return getVault()
    .prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY ts ASC LIMIT ?`)
    .all(sessionId, limit) as TurnRow[];
}

// ─── Skill telemetry ─────────────────────────────────────────────────────────

export function logSkillInvocation(input: {
  id: string;
  agentGroupId: string;
  skillName: string;
  sessionId: string;
  ts: number;
  toolCalls: number;
  success: 0 | 1 | null;
  userFeedback: string | null;
  notes: string | null;
}): void {
  const db = getVault();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO skill_invocations
         (id, agent_group_id, skill_name, session_id, ts, tool_calls, success, user_feedback, notes)
       VALUES ($id, $agentGroupId, $skillName, $sessionId, $ts, $toolCalls, $success, $userFeedback, $notes)`,
    ).run({
      $id: input.id,
      $agentGroupId: input.agentGroupId,
      $skillName: input.skillName,
      $sessionId: input.sessionId,
      $ts: input.ts,
      $toolCalls: input.toolCalls,
      $success: input.success,
      $userFeedback: input.userFeedback,
      $notes: input.notes,
    });
    db.prepare(
      `INSERT INTO skill_state (agent_group_id, skill_name, invocations_since_ref)
       VALUES ($agentGroupId, $skillName, 1)
       ON CONFLICT (agent_group_id, skill_name) DO UPDATE SET
         invocations_since_ref = invocations_since_ref + 1`,
    ).run({ $agentGroupId: input.agentGroupId, $skillName: input.skillName });
  })();
}

export interface SkillStateRow {
  agent_group_id: string;
  skill_name: string;
  invocations_since_ref: number;
  last_reflected_at: number | null;
}

export function listSkillsDueForReflection(agentGroupId: string, threshold: number): SkillStateRow[] {
  return getVault()
    .prepare(
      `SELECT * FROM skill_state
       WHERE agent_group_id = ? AND invocations_since_ref >= ?`,
    )
    .all(agentGroupId, threshold) as SkillStateRow[];
}
