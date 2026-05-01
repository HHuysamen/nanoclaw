# NanoClaw Migration Guide

Generated: 2026-05-01
Base (last common ancestor): `934f063aff5c30e7b49ce58b53b41901d3472a3e` (v1.x: "update deps", 2026-04-07)
HEAD at generation: `54054ac0d6ec2a88008c19bc469976e098b209af`
Upstream HEAD: `663d9a409190bd1e79fa505fae04644dcdab2429` (v2.0.24)

## Migration Plan

This is a **v1 → v2 transition**. v2 is a major rewrite that ships breaking changes:

- Channel adapter API: `Channel` interface (v1) → `ChannelAdapter` interface (v2) with `setup`/`teardown`/`deliver`.
- Channel registration: explicit `registerChannel()` (v1) → `registerChannelAdapter()` self-registration barrel + skill-appended imports (v2).
- DB: flat key/value `getRouterState`/`setRouterState` (v1) → entity-oriented (`MessagingGroup`, `AgentGroup`, `Session`, etc.) in `src/db/`.
- `setup/` is now full TypeScript (was a thin shell wrapper).
- Container: npm → pnpm + Bun runtime; Node 22-slim base.
- Many in-tree channels (Gmail, Telegram, WhatsApp) moved to skills.

**Order of operations (worktree on `upstream/main`):**

1. Apply standard skills: `add-whatsapp`, `add-telegram`, `add-gmail-tool` (NOT `add-gmail` — there is no Gmail-as-channel skill on v2 upstream).
2. Port custom code on top of the v2-shipped channel adapters.
3. Reapply container customizations (GCal MCP).
4. Copy data/content (group CLAUDE.md).
5. Apply small config tweaks.
6. Build/test.

**Risk areas — features without a clean v2 equivalent:**

- **Multi-bot Telegram + JID→bot persistence + chunked send** (latest fix, commit `54054ac`).
  - v2's telegram skill uses a packaged adapter (`@chat-adapter/telegram`); it may not expose multi-bot wiring. The user's logic also depends on `getRouterState`/`setRouterState`, which **don't exist in v2**.
  - Two paths: (a) reimplement persistence using v2's session/entity DB, OR (b) keep a slim per-install JSON file (e.g. `data/telegram-jid-to-bot.json`) — no DB schema change.
  - This guide assumes path (b) for simplicity.

- **Gmail as an inbound channel.** v2 only ships Gmail as an MCP tool (`add-gmail-tool`), not a channel that can ingest emails as messages and route them to a group.
  - Two paths: (a) port the v1 Gmail channel implementation onto v2's `ChannelAdapter` interface (substantial work), OR (b) accept the v2 model — drop the channel, use Gmail tool only.
  - This guide documents **(a) — port to a v2 channel adapter** because the user actively uses Gmail-as-channel routing (`GMAIL_TARGET_GROUP`). If the user prefers (b), this section can be skipped at apply time.

- **WhatsApp** is currently disabled in the user's fork (session expired, 25d9492). The v2 `add-whatsapp` skill replaces the implementation entirely. Reapplying the skill restores a working WhatsApp; the disable is moot once auth is redone.

## Applied Skills

The following upstream skills should be applied on the v2 base, in order:

1. `add-whatsapp` — restores WhatsApp via Baileys. (User's session is expired — they'll need to re-authenticate after.)
2. `add-telegram` — restores Telegram. **Customizations on top required** (see Modifications section).
3. `add-gmail-tool` — Gmail MCP tool (read/search/send). Plus a custom Gmail-as-channel implementation (see Customizations).

Note: `add-gmail` (channel) is NOT an upstream v2 skill — it's a community skill in this fork's `.claude/skills/` but has no `upstream/skill/add-gmail` branch. The Gmail-as-channel logic is a user customization, not a reapplication of an upstream skill.

## Skill Interactions

None known. The three channels are independent.

## Modifications to Applied Skills

### add-whatsapp SKILL.md: dedicated-number flag note

**Intent:** Document the `--dedicated-number` flag in the SKILL.md so the next operator remembers to pass it when applicable.

**Files:** `.claude/skills/add-whatsapp/SKILL.md`

**How to apply:**

After running `/add-whatsapp`, edit the resulting `.claude/skills/add-whatsapp/SKILL.md`:

1. After the AskUserQuestion that asks "Is this a shared phone number ... or a dedicated number?" add the line:
   ```
   Remember the user's choice — if **dedicated number**, pass `--dedicated-number` to the register step below.
   ```

2. In the `npx tsx setup/index.ts --step register` block, change the last line from:
   ```bash
   --no-trigger-required  # Only for main/self-chat
   ```
   to:
   ```bash
   --no-trigger-required \  # Only for main/self-chat
   --dedicated-number       # Only if user chose dedicated number
   ```

(If v2's add-whatsapp skill SKILL.md already documents this, skip.)

## Customizations

### 1. Telegram: multi-bot support + JID→bot persistence + chunked sending

**Intent:** The user runs multiple Telegram bots from one NanoClaw install (different bots in different group chats). Each chat needs to know which bot to use. The mapping is learned from inbound messages and must persist across restarts so scheduled tasks fire with the correct bot. Also: messages over 4096 chars must be chunked.

**Reference diff:** `.nanoclaw-migrations/telegram-user-customizations.diff` (the diff between the upstream telegram channel and the user's current `src/channels/telegram.ts`).

**Files (v2 paths to confirm at apply time):**

- The v2 telegram channel implementation file (likely `src/channels/telegram.ts` after `/add-telegram` is run, but the v2 skill may install it via package import — check `.claude/skills/add-telegram/SKILL.md` after running it).
- A persistence file: `data/telegram-jid-to-bot.json` (new — replaces the v1 router_state row).

**How to apply:**

This is non-trivial because:

- v2's `getRouterState`/`setRouterState` does not exist. **Replace with file-based persistence.**
- v2's channel adapter shape (`ChannelAdapter` with `setup`/`deliver`) differs from v1's `Channel` (with `start`/`sendMessage`). The same logical features (multi-bot, JID map, chunking, fallback) need to be re-expressed against the v2 interface.
- v2 may use the packaged `@chat-adapter/telegram` — if so, the multi-bot logic may need to live in a thin wrapper module rather than directly in the adapter.

Do this:

1. After `/add-telegram` is applied, read the resulting telegram adapter source. Identify:
   - The class/function that owns the bot connection.
   - The `deliver()` (or equivalent send) entrypoint.
   - Whether it accepts a single token or an array.

2. Multi-bot tokens — in `.env`, support both:
   - `TELEGRAM_BOT_TOKEN` (primary, single)
   - `TELEGRAM_BOT_TOKENS` (comma-separated additional). Parse both, deduplicate, preserve order. Example v1 logic from the user's fork:
     ```typescript
     const primary = process.env.TELEGRAM_BOT_TOKEN?.trim();
     const additional = process.env.TELEGRAM_BOT_TOKENS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
     const tokens = [primary, ...additional].filter(Boolean) as string[];
     ```

3. Per-token bot creation — instantiate one bot per token, run polling for each.

4. JID→bot persistence — replace `getRouterState('telegram_jid_to_bot_username')` / `setRouterState(...)` with a JSON file at `data/telegram-jid-to-bot.json`:
   ```typescript
   import fs from 'fs';
   import path from 'path';
   import { DATA_DIR } from '../config.js';

   const PERSIST_PATH = path.join(DATA_DIR, 'telegram-jid-to-bot.json');

   function readPersistedJidMap(): Record<string, string> {
     try {
       return JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
     } catch { return {}; }
   }
   function writePersistedJidMap(map: Record<string, string>): void {
     try {
       fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
       fs.writeFileSync(PERSIST_PATH, JSON.stringify(map, null, 2));
     } catch (err) {
       log.debug({ err }, 'Telegram: failed to persist JID map');
     }
   }
   ```

5. `learnJidToBot(jid, bot)` — on every inbound from a chat: set in-memory map, then update persisted map keyed by chat JID → bot username. Skip the write if unchanged.

6. `restoreJidMapFromStorage()` — on startup, after all bots have been created and `botInfo.username` is populated, read the persisted map, look up each username against the live bot list, repopulate the in-memory map. Drop entries whose username no longer corresponds to any live bot. Log restored/stale counts.

7. Chunked send — split outbound text into 4096-char slices, send sequentially.

8. Fallback on "chat not found" — when delivering to a JID, try the bot the map says owns it. On error matching `/chat not found/i`, walk the remaining bots; on success, learn the new mapping. If all fail, log and surface error.

The full v1 implementation of these features is in `telegram-user-customizations.diff`. Use it as a reference, but DO NOT copy verbatim — the imports and surrounding code shape will differ on v2.

### 2. Telegram: thread_id (topics) support

**Intent:** Send messages into specific Telegram topic threads (group topics).

**Files:** v2's `src/types.ts` already includes `thread_id` on `MessageIn` (verified in v2 inspection). The v2 telegram adapter should already pass it through.

**How to apply:** Verify after `/add-telegram` that the v2 adapter's `deliver()` accepts `threadId` and passes it as `message_thread_id` in the Telegram API call. If it doesn't, port from v1:

```typescript
const options = threadId
  ? { message_thread_id: parseInt(threadId, 10) }
  : {};
await sendTelegramMessage(bot.api, numericId, text, options);
```

If it already works in v2, skip.

### 3. Telegram: reply context (reply_to_message_id, reply_to_message_content, reply_to_sender_name)

**Intent:** When a Telegram message is a reply, capture and forward the quoted-message context so the agent can see what was being replied to.

**Files:** `src/types.ts` (v2 may need extending), telegram adapter source.

**How to apply:** v2's `MessageIn` may not carry reply context. If you want this, extend `MessageIn` (or a v2 equivalent) to include:

```typescript
reply_to_message_id?: string;
reply_to_message_content?: string;
reply_to_sender_name?: string;
```

In the telegram adapter inbound handler, populate these from `ctx.message.reply_to_message` (text/caption + sender name). Pass through to inbound callback so the router/agent can consume them.

(If the v2 codebase has its own scheme for reply context, prefer that.)

### 4. Gmail: target-group routing (custom Gmail-as-channel)

**Intent:** Inbound emails should be routed to a configurable target NanoClaw group (`GMAIL_TARGET_GROUP` env var = group folder name). Falls back to main group if unset or not found.

**Reference diff:** `.nanoclaw-migrations/gmail-target-routing.diff` (full v1 user diff for `src/channels/gmail.ts`).

**Files:** Custom Gmail channel adapter (does not exist in v2 upstream — must be written).

**How to apply:**

This requires writing a v2 Gmail channel adapter from scratch. v2 ships only `add-gmail-tool` (MCP tool for the agent to call), not a channel that ingests emails as messages.

Two acceptable paths:

**Path A (recommended) — keep v1's Gmail channel logic, port to v2's `ChannelAdapter`:**

1. Implement `ChannelAdapter` interface (see `src/channels/adapter.ts` in v2):
   ```typescript
   const adapter: ChannelAdapter = {
     name: 'gmail',
     channelType: 'gmail',
     supportsThreads: false,
     async setup(config) { /* start gmail watcher / pubsub poll */ },
     async teardown() { /* stop watcher */ },
     isConnected() { /* ... */ },
     async deliver(platformId, _threadId, message) { /* send email via gmail API */ },
   };
   registerChannelAdapter('gmail', { factory: () => adapter });
   ```

2. On inbound email, resolve target group:
   ```typescript
   const targetFolder = process.env.GMAIL_TARGET_GROUP?.trim();
   let targetGroup = null;
   if (targetFolder) {
     // v2: look up agent group by folder
     targetGroup = getAgentGroupByFolder(targetFolder);
   }
   if (!targetGroup) {
     targetGroup = /* main agent group fallback */;
   }
   ```
   Use `getAgentGroupByFolder` (exported from v2's `src/db/agent-groups.ts`).

3. Convert email → `InboundMessage` and call `config.onInbound(platformId, null, message)` where `platformId` is the from-address.

4. Reuse the OAuth/Gmail API logic from the v1 fork's `src/channels/gmail.ts` — only the surrounding shell (registration, inbound dispatch, target-group resolution) needs to change.

**Path B — drop the channel, use Gmail tool only:**

1. Skip the channel implementation.
2. Run `/add-gmail-tool` instead. The agent can read/send email when triggered through other channels (WhatsApp/Telegram).
3. Lose: emails-as-triggers (an inbound email cannot start an agent session).

**Decision required from user before applying.** Default to Path A.

### 5. Google Calendar MCP server

**Reference patch:** `.nanoclaw-migrations/google-calendar-mcp.patch`

**Intent:** Expose Google Calendar as an MCP tool inside the agent container, mounted from `~/.calendar-mcp/` on the host so OAuth tokens persist.

**Files:**

- `container/agent-runner/src/index.ts` — add MCP server registration + tool allowlist entry
- `src/container-runner.ts` — add bind mount

**How to apply:**

1. In v2's `container/agent-runner/src/index.ts`, locate the MCP servers registration block (similar shape to v1). Add:
   ```typescript
   calendar: {
     command: 'npx',
     args: ['-y', '@cocal/google-calendar-mcp'],
     env: {
       GOOGLE_OAUTH_CREDENTIALS: '/home/node/.calendar-mcp/gcp-oauth.keys.json',
       GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/home/node/.calendar-mcp/tokens.json',
     },
   },
   ```

2. In the same file's tool allowlist, add: `'mcp__calendar__*',`

3. In v2's `src/container-runner.ts` (or wherever bind mounts are assembled — v2 may use `containerConfig.mounts` from skill registration instead — check first), add:
   ```typescript
   const calendarDir = path.join(homeDir, '.calendar-mcp');
   if (fs.existsSync(calendarDir)) {
     mounts.push({
       hostPath: calendarDir,
       containerPath: '/home/node/.calendar-mcp',
       readonly: false, // MCP refreshes OAuth tokens
     });
   }
   ```

If v2 uses skill-registered container mounts, prefer registering this through a small custom skill (`add-gcal-tool`) following the pattern of `add-gmail-tool` rather than editing `container-runner.ts` directly.

### 6. Container Dockerfile: npm 11.13.0 upgrade (likely obsolete on v2)

**Reference patch:** `.nanoclaw-migrations/dockerfile-npm-upgrade.patch`

**Intent:** v1 needed npm 11.13.0 to dodge a bundled-arborist bug in node:22-slim's default npm.

**v2 status:** v2 uses `bun` and `pnpm` in the container (not npm directly). **Likely obsolete.**

**How to apply:** Skip unless a build error in the v2 worktree implicates npm specifically. Verify by reading v2's `container/Dockerfile` after worktree setup.

### 7. Group CLAUDE.md content

**Intent:** Per-group agent persona, capabilities documentation, and memory system rules. This is content, not code.

**Files:**

- `groups/main/CLAUDE.md` — "MoneyPenny" persona (309 lines)
- `groups/global/CLAUDE.md` — "Agent Team" persona (131 lines)

**How to apply:** Copy verbatim from the main tree to the worktree. Do not edit.

```bash
cp -r "$PROJECT_ROOT/groups" "$WORKTREE/"
```

(`groups/` is data, not code — never modified by the migration.)

### 8. .env.example

**Intent:** Document `ASSISTANT_HAS_OWN_NUMBER` env var.

**How to apply:** Append the line `ASSISTANT_HAS_OWN_NUMBER=` to `.env.example` if not already present in the v2 version.

### 9. tsconfig.json: exclude test files from compilation

**Intent:** v1's tsconfig had `exclude: ["node_modules", "dist"]` — but the build emitted `.test.js` files into `dist/`. User added `"src/**/*.test.ts"` to the exclude list.

**v2 status:** Verify the v2 tsconfig — if it already excludes tests, skip.

**How to apply:** If v2's `tsconfig.json` has `"exclude": ["node_modules", "dist"]`, change to:
```json
"exclude": ["node_modules", "dist", "src/**/*.test.ts"]
```

### 10. Setup diagnostics: opt-out

**Intent:** User opted out of PostHog telemetry. The diagnostics file is replaced with a stub.

**Files:** `.claude/skills/setup/diagnostics.md`

**How to apply:** After v2 is installed, replace `.claude/skills/setup/diagnostics.md` content with a single line:
```
# Diagnostics — opted out
```
Same for `.claude/skills/update-nanoclaw/diagnostics.md` if it exists. (Refer to the v2 setup SKILL.md to remove its `## Diagnostics` reference if that's still relevant.)

### 11. db.ts: getMessageContentById helper (skill-merge artifact)

**Intent:** Helper added during the WhatsApp skill merges. Used by Baileys' `getMessage` callback to prevent "Waiting for this message" stalls.

**v2 status:** v2's `src/db/` is entity-oriented; there's no flat `messages` table in the same shape. The Baileys skill's `getMessage` callback may already be wired in v2's `add-whatsapp` skill — verify after applying.

**How to apply:** After `/add-whatsapp` is applied, verify Baileys has a `getMessage` callback wired. If yes, skip. If not, port the helper using v2's session-message DB shape.

### 12. CI workflows (deleted)

**Intent:** User removed `.github/workflows/bump-version.yml` and `.github/workflows/update-tokens.yml` (auto-version-bump and token-counting).

**How to apply:** After applying upstream, delete these files again if v2 introduced them (they did — v2 bumps versions automatically):
```bash
rm -f .github/workflows/bump-version.yml .github/workflows/update-tokens.yml
```

### 13. WhatsApp disabled state

**Intent:** WhatsApp is currently disabled because the session expired. The v1 `src/channels/index.ts` had the import commented out.

**v2 path:** Fixing this is out of scope for the migration — once the v2 add-whatsapp skill is applied AND the user re-authenticates, WhatsApp works again. If the user wants to keep it disabled until they have time to re-auth, comment out the WhatsApp import in v2's `src/channels/index.ts` (the skill appends the import there).

## Custom skills (preserve as-is)

The following skills are present in `.claude/skills/` but have no `upstream/skill/*` branch — they are user/community skills that should be copied verbatim from the main tree to the worktree:

- add-discord
- add-gmail (community Gmail-as-channel skill)
- add-telegram-swarm
- add-pdf-reader
- add-image-vision
- add-parallel
- add-karpathy-llm-wiki
- add-macos-statusbar
- add-reactions
- add-voice-transcription
- add-emacs
- add-slack
- claw
- qodo-pr-resolver
- get-qodo-rules
- x-integration

Most v2 upstream skills (`add-whatsapp`, `add-telegram`, `add-compact`, `channel-formatting`, `convert-to-apple-container`, `migrate-from-openclaw`, `migrate-nanoclaw`, `setup`, `debug`, `customize`, `update-nanoclaw`, `init-onecli`, `update-skills`, `use-local-whisper`, `use-native-credential-proxy`, `add-ollama-tool`) are shipped by v2 itself — copying old versions from the main tree would clobber the upstream improvements. **Don't copy upstream-shipped skills; let v2 ship its own.**

To preserve only custom/community skills:

```bash
# In worktree, copy the directories not present in upstream
for skill in add-discord add-gmail add-telegram-swarm add-pdf-reader add-image-vision \
             add-parallel add-karpathy-llm-wiki add-macos-statusbar add-reactions \
             add-voice-transcription add-emacs add-slack claw qodo-pr-resolver \
             get-qodo-rules x-integration; do
  if [ -d "$PROJECT_ROOT/.claude/skills/$skill" ] && [ ! -d "$WORKTREE/.claude/skills/$skill" ]; then
    cp -r "$PROJECT_ROOT/.claude/skills/$skill" "$WORKTREE/.claude/skills/"
  fi
done
```
