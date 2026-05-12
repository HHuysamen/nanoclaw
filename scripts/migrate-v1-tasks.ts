/**
 * One-shot v1 → v2 scheduled-task migrator.
 *
 * Reads `store/messages.db.scheduled_tasks` (v1), maps each task's
 * `group_folder` to a v2 agent group + session, and inserts an equivalent
 * `kind='task'` row into the session's `inbound.db` (`messages_in`).
 *
 * Skips paused/completed tasks and unknown folders. Idempotent: skips a task
 * whose id already exists in the target session's inbound.
 */
import path from 'path';
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR } from '../src/config.js';
import { TIMEZONE } from '../src/config.js';

const V1_DB = path.resolve(process.cwd(), 'store/messages.db');
const V2_DB = path.join(DATA_DIR, 'v2.db');

// v1 group_folder → v2 agent_groups.folder
const FOLDER_MAP: Record<string, string> = {
  telegram_moneypenny: 'moneypenny',
  moneypenny: 'moneypenny',
  lova: 'lova',
  linus: 'linus',
  telegram_main: 'dm-with-henry',
  main: 'dm-with-henry',
};

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  script: string | null;
}

interface AgentGroupRow {
  id: string;
  folder: string;
}

interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string;
}

interface MessagingGroupRow {
  id: string;
  channel_type: string;
  platform_id: string;
}

function nextEvenSeq(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(seq) AS max_seq FROM messages_in').get() as { max_seq: number | null };
  const max = row.max_seq ?? -2;
  return max % 2 === 0 ? max + 2 : max + 1;
}

function main(): void {
  const v1 = new Database(V1_DB, { readonly: true, fileMustExist: true });
  const v2 = new Database(V2_DB, { fileMustExist: true });

  const tasks = v1
    .prepare(
      "SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, script FROM scheduled_tasks WHERE status = 'active' AND schedule_type = 'cron'",
    )
    .all() as V1Task[];

  const groups = v2.prepare('SELECT id, folder FROM agent_groups').all() as AgentGroupRow[];
  const groupByFolder = new Map(groups.map((g) => [g.folder, g]));

  let migrated = 0;
  let skipped = 0;
  for (const task of tasks) {
    const v2Folder = FOLDER_MAP[task.group_folder] ?? task.group_folder;
    const ag = groupByFolder.get(v2Folder);
    if (!ag) {
      console.log(`SKIP ${task.id} — no v2 agent group for folder '${task.group_folder}' (mapped to '${v2Folder}')`);
      skipped++;
      continue;
    }

    const sess = v2
      .prepare("SELECT id, agent_group_id, messaging_group_id FROM sessions WHERE agent_group_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(ag.id) as SessionRow | undefined;
    if (!sess) {
      console.log(`SKIP ${task.id} — agent group '${ag.folder}' has no session yet`);
      skipped++;
      continue;
    }

    const mg = v2.prepare('SELECT id, channel_type, platform_id FROM messaging_groups WHERE id = ?').get(sess.messaging_group_id) as MessagingGroupRow | undefined;
    if (!mg) {
      console.log(`SKIP ${task.id} — session has no messaging group`);
      skipped++;
      continue;
    }

    const inboundPath = path.join(DATA_DIR, 'v2-sessions', ag.id, sess.id, 'inbound.db');
    const inDb = new Database(inboundPath, { fileMustExist: true });

    // Idempotency: skip if id already present
    const existing = inDb.prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'task'").get(task.id);
    if (existing) {
      console.log(`SKIP ${task.id} — already present in ${inboundPath}`);
      inDb.close();
      skipped++;
      continue;
    }

    let nextRunIso: string;
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      nextRunIso = interval.next().toDate().toISOString();
    } catch (err) {
      console.log(`SKIP ${task.id} — invalid cron '${task.schedule_value}': ${err instanceof Error ? err.message : err}`);
      inDb.close();
      skipped++;
      continue;
    }

    const content = JSON.stringify({ prompt: task.prompt, script: task.script ?? null });
    const seq = nextEvenSeq(inDb);
    inDb
      .prepare(
        `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, tries, process_after, recurrence, series_id, trigger, platform_id, channel_type, thread_id, content)
         VALUES (@id, @seq, 'task', datetime('now'), 'pending', 0, @process_after, @recurrence, @id, 1, @platform_id, @channel_type, NULL, @content)`,
      )
      .run({
        id: task.id,
        seq,
        process_after: nextRunIso,
        recurrence: task.schedule_value,
        platform_id: mg.platform_id,
        channel_type: mg.channel_type,
        content,
      });
    inDb.close();

    console.log(`MIGRATED ${task.id} → ${ag.folder} (next: ${nextRunIso}, recur: ${task.schedule_value})`);
    migrated++;
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} total=${tasks.length}`);
  v1.close();
  v2.close();
}

main();
