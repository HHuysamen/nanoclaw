import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const JID_BOT_MAP_KEY = 'telegram_jid_to_bot_username';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots: Bot[] = [];
  private opts: TelegramChannelOpts;
  private tokens: string[];
  // Maps chat JID → Bot instance (learned from inbound messages,
  // restored at startup from a persisted JID → bot username table)
  private jidToBot: Map<string, Bot> = new Map();

  private readPersistedJidMap(): Record<string, string> {
    let raw: string | undefined;
    try {
      raw = getRouterState(JID_BOT_MAP_KEY);
    } catch (err) {
      logger.debug({ err }, 'Telegram: persisted JID map unavailable');
      return {};
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writePersistedJidMap(map: Record<string, string>): void {
    try {
      setRouterState(JID_BOT_MAP_KEY, JSON.stringify(map));
    } catch (err) {
      logger.debug({ err }, 'Telegram: failed to persist JID map');
    }
  }

  // Tasks fire before any inbound message arrives after a restart, so the
  // in-memory map is empty and sendMessage falls back to bots[0] — which is
  // typically not a member of group chats served by other bots and Telegram
  // returns 400 chat not found. Persisting the mapping prevents that.
  private learnJidToBot(jid: string, bot: Bot): void {
    const existing = this.jidToBot.get(jid);
    this.jidToBot.set(jid, bot);
    const username = bot.botInfo?.username;
    if (!username) return;
    if (existing === bot) return;
    const stored = this.readPersistedJidMap();
    if (stored[jid] === username) return;
    stored[jid] = username;
    this.writePersistedJidMap(stored);
  }

  private restoreJidMapFromStorage(): void {
    const stored = this.readPersistedJidMap();
    const byUsername = new Map<string, Bot>();
    for (const bot of this.bots) {
      const username = bot.botInfo?.username;
      if (username) byUsername.set(username, bot);
    }
    let restored = 0;
    let stale = 0;
    for (const [jid, username] of Object.entries(stored)) {
      const bot = byUsername.get(username);
      if (bot) {
        this.jidToBot.set(jid, bot);
        restored++;
      } else {
        stale++;
      }
    }
    logger.info(
      { restored, stale, totalBots: this.bots.length },
      'Telegram: restored JID-to-bot mappings',
    );
  }

  constructor(tokens: string[], opts: TelegramChannelOpts) {
    this.tokens = tokens;
    this.opts = opts;
  }

  private setupBot(bot: Bot): void {
    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;

      // Learn which bot handles this JID
      this.learnJidToBot(chatJid, bot);

      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;

      // Learn which bot handles this JID
      this.learnJidToBot(chatJid, bot);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });
  }

  async connect(): Promise<void> {
    for (const token of this.tokens) {
      const bot = new Bot(token, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });

      this.setupBot(bot);

      // Start polling — returns a Promise that resolves when started
      await new Promise<void>((resolve) => {
        bot.start({
          onStart: (botInfo) => {
            logger.info(
              { username: botInfo.username, id: botInfo.id },
              'Telegram bot connected',
            );
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(
              `  Send /chatid to the bot to get a chat's registration ID\n`,
            );
            resolve();
          },
        });
      });

      this.bots.push(bot);
    }

    this.restoreJidMapFromStorage();
  }

  /**
   * Get the bot for a JID. Uses the learned mapping from inbound messages,
   * falling back to the first bot if the JID hasn't been seen yet.
   */
  private getBotForJid(jid: string): Bot | null {
    return this.jidToBot.get(jid) || this.bots[0] || null;
  }

  private isChatNotFoundError(err: unknown): boolean {
    const msg =
      err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    return /chat not found/i.test(msg);
  }

  private async sendChunked(
    bot: Bot,
    numericId: string,
    text: string,
    options: { message_thread_id?: number },
  ): Promise<void> {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(bot.api, numericId, text, options);
      return;
    }
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      await sendTelegramMessage(
        bot.api,
        numericId,
        text.slice(i, i + MAX_LENGTH),
        options,
      );
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    const primary = this.getBotForJid(jid);
    if (!primary) {
      logger.warn('No Telegram bot available');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const options = threadId
      ? { message_thread_id: parseInt(threadId, 10) }
      : {};

    // Try the bot we believe owns the chat. If Telegram says "chat not found",
    // the mapping is wrong (e.g. JID never seen + persistence empty), so try
    // the other bots and learn whichever succeeds.
    const candidates = [primary, ...this.bots.filter((b) => b !== primary)];

    let lastError: unknown = null;
    for (let i = 0; i < candidates.length; i++) {
      const bot = candidates[i];
      try {
        await this.sendChunked(bot, numericId, text, options);
        if (bot !== primary) {
          this.learnJidToBot(jid, bot);
        }
        logger.info(
          { jid, length: text.length, threadId },
          'Telegram message sent',
        );
        return;
      } catch (err) {
        lastError = err;
        if (!this.isChatNotFoundError(err) || i === candidates.length - 1) {
          break;
        }
        logger.warn(
          { jid, attemptedBot: bot.botInfo?.username },
          'Telegram chat not found via this bot, trying next',
        );
      }
    }

    logger.error({ jid, err: lastError }, 'Failed to send Telegram message');
  }

  isConnected(): boolean {
    return this.bots.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const bot of this.bots) {
      bot.stop();
    }
    const count = this.bots.length;
    this.bots = [];
    this.jidToBot.clear();
    logger.info({ count }, 'Telegram bots stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const bot = this.getBotForJid(jid);
    if (!bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKENS']);

  // Collect all tokens: primary + additional (comma-separated)
  const tokens: string[] = [];
  const primary =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (primary) tokens.push(primary);

  const additional =
    process.env.TELEGRAM_BOT_TOKENS || envVars.TELEGRAM_BOT_TOKENS || '';
  if (additional) {
    for (const t of additional.split(',')) {
      const trimmed = t.trim();
      if (trimmed && !tokens.includes(trimmed)) tokens.push(trimmed);
    }
  }

  if (tokens.length === 0) {
    logger.warn('Telegram: no bot tokens configured');
    return null;
  }

  logger.info({ count: tokens.length }, 'Telegram: initializing bots');
  return new TelegramChannel(tokens, opts);
});
