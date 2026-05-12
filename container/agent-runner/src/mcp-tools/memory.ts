/**
 * Adaptive-memory MCP tools.
 *
 * Six v1 tools — bounded curated memory (MEMORY.md, USER.md) + cross-session
 * recall (FTS5 over `turns`). The "skill reflection" trio
 * (`skill_log_invocation`, `skill_due_for_reflection`) ships in a later step
 * once turn logging is in place.
 *
 * agent_group_id is resolved once at module load from
 * /workspace/agent/container.json, which the host re-writes at every spawn.
 * Per-tool calls don't take it — scoping is implicit, which is the entire
 * privacy story for opt-in cross-group search.
 */
import fs from 'fs';
import path from 'path';

import {
  closeSession,
  getOrCreateSession,
  getSession,
  insertTurn,
  listRecentSessions,
  searchTurns,
  type SearchHit,
} from '../db/vault.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const GROUP_DIR = '/workspace/agent';
const MEMORY_FILE = path.join(GROUP_DIR, 'MEMORY.md');
const USER_FILE = path.join(GROUP_DIR, 'USER.md');

const MEMORY_CHAR_CAP = readEnvInt('NANOCLAW_MEMORY_CHAR_CAP', 2200);
const USER_PROFILE_CHAR_CAP = readEnvInt('NANOCLAW_USER_PROFILE_CHAR_CAP', 1375);

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function log(msg: string): void {
  console.error(`[mcp-memory] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

let _agentGroupId: string | null = null;

function agentGroupId(): string {
  if (_agentGroupId) return _agentGroupId;
  try {
    const raw = fs.readFileSync(path.join(GROUP_DIR, 'container.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { agentGroupId?: string };
    if (!parsed.agentGroupId) {
      throw new Error('container.json has no agentGroupId field');
    }
    _agentGroupId = parsed.agentGroupId;
    return _agentGroupId;
  } catch (e) {
    log(`fatal: could not resolve agent_group_id: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

function readMemoryFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Atomic write inside the bind-mounted group dir. Same caveat as vault.db —
 * `rename` across virtiofs has historically been flaky for huge files; this
 * is a 2KB file so we're well clear of that range. Temp file lives next to
 * target so rename is intra-mount.
 */
function writeMemoryFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function clampWithCap(
  target: 'memory' | 'user',
  content: string,
): { ok: true; content: string } | { ok: false; cap: number; length: number } {
  const cap = target === 'memory' ? MEMORY_CHAR_CAP : USER_PROFILE_CHAR_CAP;
  if (content.length <= cap) return { ok: true, content };
  return { ok: false, cap, length: content.length };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const memoryRead: McpToolDefinition = {
  tool: {
    name: 'memory_read',
    description:
      'Read your persistent curated memory. Returns both `memory` (your agent notes) and `user` (the user profile) — both Markdown, both size-capped. Call this at the start of every session before responding to the first message.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const memory = readMemoryFile(MEMORY_FILE);
    const user = readMemoryFile(USER_FILE);
    const body = [
      `# MEMORY.md (${memory.length}/${MEMORY_CHAR_CAP} chars)`,
      memory || '(empty)',
      '',
      `# USER.md (${user.length}/${USER_PROFILE_CHAR_CAP} chars)`,
      user || '(empty)',
    ].join('\n');
    return ok(body);
  },
};

const memoryWrite: McpToolDefinition = {
  tool: {
    name: 'memory_write',
    description:
      'Replace MEMORY.md or USER.md with a curated body. If the new content exceeds the cap, returns `needs_curation` with the over-cap length and you must re-condense and call again. Bounded memory forces prioritisation — that\'s the point.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', enum: ['memory', 'user'], description: '`memory` or `user`' },
        content: { type: 'string', description: 'New full body of the file (Markdown)' },
      },
      required: ['target', 'content'],
    },
  },
  async handler(args) {
    const target = String(args.target ?? '') as 'memory' | 'user';
    const content = String(args.content ?? '');
    if (target !== 'memory' && target !== 'user') {
      return err('target must be "memory" or "user"');
    }
    const check = clampWithCap(target, content);
    if (!check.ok) {
      return err(
        `needs_curation: content is ${check.length} chars, cap is ${check.cap}. Re-condense and call again.`,
      );
    }
    const filePath = target === 'memory' ? MEMORY_FILE : USER_FILE;
    writeMemoryFileAtomic(filePath, check.content);
    return ok(`wrote ${target}: ${check.content.length} chars`);
  },
};

const memoryAppendNote: McpToolDefinition = {
  tool: {
    name: 'memory_append_note',
    description:
      'Append a single bullet to MEMORY.md. If the file would exceed the cap, the OLDEST lines are dropped until it fits (FIFO). Use this for incremental learning during a session; periodically re-curate the whole file with memory_write when entries become redundant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        note: { type: 'string', description: 'One bullet (without the leading `- `). Will be timestamped.' },
      },
      required: ['note'],
    },
  },
  async handler(args) {
    const note = String(args.note ?? '').trim();
    if (!note) return err('note is empty');
    const date = new Date().toISOString().slice(0, 10);
    const newLine = `- (${date}) ${note}`;
    let body = readMemoryFile(MEMORY_FILE);
    body = body ? `${body.replace(/\n+$/, '')}\n${newLine}\n` : `${newLine}\n`;
    // FIFO trim until under cap. Drop oldest lines (top of file).
    if (body.length > MEMORY_CHAR_CAP) {
      const lines = body.split('\n');
      while (lines.length > 1 && lines.join('\n').length > MEMORY_CHAR_CAP) {
        lines.shift();
      }
      body = lines.join('\n');
    }
    writeMemoryFileAtomic(MEMORY_FILE, body);
    return ok(`appended; MEMORY.md now ${body.length}/${MEMORY_CHAR_CAP} chars`);
  },
};

const sessionSearch: McpToolDefinition = {
  tool: {
    name: 'session_search',
    description:
      'Full-text search over past conversation turns (FTS5). Returns ranked snippets with session ids. Scope defaults to "group" — only this agent\'s history. Pass scope:"all" ONLY when the user has explicitly asked for cross-agent recall.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'FTS5 MATCH query (supports prefix `foo*`, AND/OR, etc.)' },
        scope: {
          type: 'string',
          enum: ['group', 'all'],
          description: 'group (default) | all (opt-in cross-agent)',
        },
        limit: { type: 'number', description: 'Max hits to return (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return err('query is empty');
    const scope = args.scope === 'all' ? 'all' : 'group';
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    let hits: SearchHit[];
    try {
      hits = searchTurns({ query, agentGroupId: agentGroupId(), scope, limit });
    } catch (e) {
      return err(`FTS query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (hits.length === 0) return ok('No matches.');
    const lines = hits.map((h) => {
      const when = new Date(h.ts).toISOString().slice(0, 19).replace('T', ' ');
      const tag = scope === 'all' ? ` [${h.agent_group_id}]` : '';
      return `- ${when}${tag} (session ${h.session_id.slice(-8)}) [${h.role}]: ${h.snippet}`;
    });
    return ok(lines.join('\n'));
  },
};

const sessionSummaryGet: McpToolDefinition = {
  tool: {
    name: 'session_summary_get',
    description: 'Fetch the stored summary for a given session id (returned by session_search or session_recent).',
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  async handler(args) {
    const id = String(args.session_id ?? '').trim();
    if (!id) return err('session_id is empty');
    const row = getSession(id);
    if (!row) return err(`session ${id} not found`);
    if (row.agent_group_id !== agentGroupId()) {
      return err('session belongs to another agent group');
    }
    if (!row.summary) {
      return ok('(session has no summary yet — either still active or summarisation hasn\'t run)');
    }
    return ok(row.summary);
  },
};

const sessionRecent: McpToolDefinition = {
  tool: {
    name: 'session_recent',
    description:
      'List the last N sessions for this agent with their summaries (newest first). Use for "what did we work on yesterday" recall.',
    inputSchema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Default 5, max 20.' } },
    },
  },
  async handler(args) {
    const limit = Math.max(1, Math.min(20, typeof args.limit === 'number' ? args.limit : 5));
    const rows = listRecentSessions(agentGroupId(), limit);
    if (rows.length === 0) return ok('No prior sessions.');
    const lines = rows.map((r) => {
      const when = new Date(r.started_at).toISOString().slice(0, 19).replace('T', ' ');
      const state = r.ended_at ? '' : ' [active]';
      const summary = r.summary || '(no summary yet)';
      return `- ${when}${state} (${r.id.slice(-8)}): ${summary}`;
    });
    return ok(lines.join('\n'));
  },
};

// ─── Registration ────────────────────────────────────────────────────────────

registerTools([memoryRead, memoryWrite, memoryAppendNote, sessionSearch, sessionSummaryGet, sessionRecent]);

// Re-export low-level helpers for poll-loop's turn logger (Step 2). They live
// in vault.ts; this barrel just makes sure the MCP server gets the schema
// bootstrapped when any one of the agent's MCP processes opens the vault.
export { closeSession, getOrCreateSession, insertTurn };
