import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

import { GROUPS_DIR } from '../config.js';

const MAIN_GROUP_FOLDER = 'main';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// Filename written to each task thread's folder for restart recovery
const META_FILENAME = 'email-meta.json';

// Fixed JID for the main admin thread — all @mainPrefix emails share this context
const MAIN_EMAIL_JID = 'email-main@email';

export interface EmailConfig {
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
    mailbox: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
  };
  mainPrefix: string; // e.g. "@clawd" → shared admin thread (folder: main)
  taskPrefix: string; // e.g. "@task" → isolated per-thread group
  senderWhitelist: string[]; // if non-empty, only these senders trigger the agent
  delivery: 'idle' | 'poll';
  pollIntervalMs: number;
}

interface ThreadMeta {
  rootMessageId: string; // Message-ID of the first email in the thread
  from: string; // Sender address (replies go here)
  subject: string; // Subject with prefix stripped
  references: string; // Space-separated chain for In-Reply-To / References headers
}

export interface EmailChannelOpts extends ChannelOpts {
  config: EmailConfig;
}

function messageIdToJid(messageId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(messageId)
    .digest('hex')
    .slice(0, 16);
  return `email-${hash}@email`;
}

function stripPrefix(subject: string, prefix: string): string {
  if (!prefix) return subject;
  return subject
    .replace(new RegExp(`^${escapeRegex(prefix)}\\s*`, 'i'), '')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class EmailChannel implements Channel {
  name = 'email';

  private cfg: EmailConfig;
  private opts: EmailChannelOpts;
  private connected = false;
  private currentImap: ImapFlow | null = null;
  private transport: nodemailer.Transporter | null = null;
  // Maps thread JID → metadata needed to send SMTP replies
  private threadMeta = new Map<string, ThreadMeta>();

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
    this.cfg = opts.config;
  }

  async connect(): Promise<void> {
    // Restore task thread metadata from previous runs
    this.loadThreadMetaFromDisk();

    // Register the main email group at startup (idempotent)
    this.opts.onNewThread(MAIN_EMAIL_JID, {
      name: 'Email (main)',
      folder: MAIN_GROUP_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
    // Initialise main thread meta as empty — updated on each incoming @mainPrefix email
    if (!this.threadMeta.has(MAIN_EMAIL_JID)) {
      this.threadMeta.set(MAIN_EMAIL_JID, {
        rootMessageId: '',
        from: '',
        subject: '',
        references: '',
      });
    }

    // Set up SMTP transport
    this.transport = nodemailer.createTransport({
      host: this.cfg.smtp.host,
      port: this.cfg.smtp.port,
      secure: this.cfg.smtp.tls,
      auth: { user: this.cfg.smtp.user, pass: this.cfg.smtp.password },
    });

    try {
      await this.transport.verify();
      logger.info('Email SMTP ready');
    } catch (err) {
      logger.error(
        { err },
        'SMTP verification failed — outbound email may not work',
      );
    }

    this.connected = true;
    logger.info(
      {
        delivery: this.cfg.delivery,
        mainPrefix: this.cfg.mainPrefix,
        taskPrefix: this.cfg.taskPrefix,
        whitelist: this.cfg.senderWhitelist,
        mailbox: this.cfg.imap.mailbox,
      },
      'Email channel connecting',
    );

    if (this.cfg.delivery === 'idle') {
      this.startIdleLoop().catch((err) =>
        logger.error({ err }, 'IMAP IDLE loop crashed'),
      );
    } else {
      this.startPollLoop().catch((err) =>
        logger.error({ err }, 'Email poll loop crashed'),
      );
    }
  }

  // Scan groups/ for email-meta.json files written by previous runs (task threads + main)
  private loadThreadMetaFromDisk(): void {
    try {
      if (!fs.existsSync(GROUPS_DIR)) return;
      const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const isTaskThread = entry.name.startsWith('email-');
        const isMainFolder = entry.name === MAIN_GROUP_FOLDER;
        if (!isTaskThread && !isMainFolder) continue;

        const metaPath = path.join(GROUPS_DIR, entry.name, META_FILENAME);
        if (!fs.existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(
            fs.readFileSync(metaPath, 'utf-8'),
          ) as ThreadMeta;
          const jid = isMainFolder ? MAIN_EMAIL_JID : `${entry.name}@email`;
          this.threadMeta.set(jid, meta);
          count++;
        } catch (err) {
          logger.warn(
            { err, folder: entry.name },
            'Failed to load email thread metadata',
          );
        }
      }
      if (count > 0)
        logger.info({ count }, 'Email thread metadata restored from disk');
    } catch (err) {
      logger.debug({ err }, 'Could not scan for email thread metadata');
    }
  }

  private createImapClient(): ImapFlow {
    const imap = new ImapFlow({
      host: this.cfg.imap.host,
      port: this.cfg.imap.port,
      secure: this.cfg.imap.tls,
      auth: { user: this.cfg.imap.user, pass: this.cfg.imap.password },
      logger: false,
      socketTimeout: 60000,
    });
    // Prevent socket errors (e.g. ETIMEOUT) from becoming uncaught exceptions
    imap.on('error', (err) => {
      logger.debug({ err }, 'IMAP socket error (suppressed)');
    });
    return imap;
  }

  // IDLE mode: keep one long-lived IMAP connection; server pushes notifications.
  private async startIdleLoop(): Promise<void> {
    while (this.connected) {
      const imap = this.createImapClient();
      this.currentImap = imap;
      try {
        await imap.connect();
        logger.info('IMAP connected (IDLE mode)');
        await imap.mailboxOpen(this.cfg.imap.mailbox);
        const initial = await this.fetchUnseen(imap);
        for (const { uid, source } of initial) {
          await this.processEmail(uid, source).catch((err) =>
            logger.error({ err, uid }, 'Failed to process email'),
          );
        }

        while (this.connected) {
          await imap.idle(); // blocks until server notification or ~28 min timeout
          if (!this.connected) break;
          const batch = await this.fetchUnseen(imap);
          for (const { uid, source } of batch) {
            await this.processEmail(uid, source).catch((err) =>
              logger.error({ err, uid }, 'Failed to process email'),
            );
          }
        }

        try {
          await imap.logout();
        } catch {}
      } catch (err) {
        if (!this.connected) break;
        logger.error({ err }, 'IMAP IDLE error, reconnecting in 15s');
        try {
          await imap.logout();
        } catch {}
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  }

  // Poll mode: connect → fetch unseen → mark seen → disconnect → process → wait → repeat.
  private async startPollLoop(): Promise<void> {
    while (this.connected) {
      let emails: Array<{ uid: number; source: Buffer }> = [];
      const imap = this.createImapClient();
      this.currentImap = imap;
      try {
        await imap.connect();
        await imap.mailboxOpen(this.cfg.imap.mailbox);
        emails = await this.fetchUnseen(imap);
        await imap.logout();
      } catch (err) {
        logger.error({ err }, 'Email poll error');
        try {
          await imap.logout();
        } catch {}
      }

      // Process outside the IMAP connection — it's already closed
      for (const { uid, source } of emails) {
        try {
          await this.processEmail(uid, source);
        } catch (err) {
          logger.error({ err, uid }, 'Failed to process email');
        }
      }

      if (!this.connected) break;
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  // Fetch all unseen emails and mark them as seen, keeping the IMAP session short.
  private async fetchUnseen(
    imap: ImapFlow,
  ): Promise<Array<{ uid: number; source: Buffer }>> {
    const uids = await imap.search({ seen: false }, { uid: true });
    logger.debug({ count: uids ? uids.length : 0 }, 'Email poll');
    if (!uids || uids.length === 0) return [];

    logger.info({ count: uids.length }, 'Fetching unseen emails');

    // Collect all messages first — don't issue any other commands while FETCH is in progress
    const emails: Array<{ uid: number; source: Buffer }> = [];
    for await (const msg of imap.fetch(
      uids as number[],
      { uid: true, source: true },
      { uid: true },
    )) {
      emails.push({ uid: msg.uid, source: msg.source as Buffer });
    }

    // Mark all as seen after FETCH completes
    if (emails.length > 0) {
      await imap.messageFlagsAdd(
        emails.map((e) => e.uid) as unknown as number[],
        ['\\Seen'],
        { uid: true },
      );
    }

    return emails;
  }

  private async processEmail(uid: number, source: Buffer): Promise<void> {
    const parsed = await simpleParser(source);

    const from = parsed.from?.value[0]?.address || '';
    const fromName = parsed.from?.value[0]?.name || from;
    const subject = parsed.subject || '';
    const messageId = parsed.messageId || `uid-${uid}@${this.cfg.imap.host}`;
    const inReplyTo = parsed.inReplyTo;
    const rawRefs = parsed.references;
    const references = rawRefs
      ? Array.isArray(rawRefs)
        ? rawRefs.join(' ')
        : rawRefs
      : '';
    const text = (parsed.text || htmlToText(parsed.html || '')).trim();
    const timestamp = (parsed.date || new Date()).toISOString();

    // Sender whitelist check
    if (!this.senderAllowed(from)) {
      logger.debug({ from, uid }, 'Email filtered — sender not in whitelist');
      return;
    }

    // 1. References-based thread match (most reliable)
    const existingJid = this.findExistingThread(inReplyTo, references);
    if (existingJid === MAIN_EMAIL_JID) {
      this.routeToMain(from, fromName, subject, messageId, text, timestamp);
      return;
    }
    if (existingJid) {
      this.routeToTask(
        from,
        fromName,
        subject,
        messageId,
        inReplyTo,
        references,
        text,
        timestamp,
        existingJid,
      );
      return;
    }

    // 2. Subject-tag fallback — used when client truncates the References chain.
    //    Clawd embeds [shortId] in its reply subjects so we can still identify the thread.
    const taggedJid = this.findThreadBySubjectTag(subject);
    if (taggedJid) {
      this.routeToTask(
        from,
        fromName,
        subject,
        messageId,
        inReplyTo,
        references,
        text,
        timestamp,
        taggedJid,
      );
      return;
    }

    // 3. New email — route by subject prefix
    const subjectLower = subject.toLowerCase();
    if (subjectLower.startsWith(this.cfg.mainPrefix.toLowerCase())) {
      this.routeToMain(from, fromName, subject, messageId, text, timestamp);
    } else if (subjectLower.startsWith(this.cfg.taskPrefix.toLowerCase())) {
      this.routeToTask(
        from,
        fromName,
        subject,
        messageId,
        inReplyTo,
        references,
        text,
        timestamp,
      );
    } else {
      logger.debug(
        { from, subject, uid },
        'Email filtered — no prefix match and not a known thread reply',
      );
    }
  }

  // Find an existing thread whose known message IDs overlap with this email's references.
  private findExistingThread(
    inReplyTo?: string,
    references?: string,
  ): string | null {
    const refIds = new Set<string>();
    if (inReplyTo) refIds.add(inReplyTo.trim());
    if (references) {
      for (const ref of references.split(/\s+/)) {
        if (ref) refIds.add(ref);
      }
    }
    if (refIds.size === 0) return null;

    for (const [jid, meta] of this.threadMeta) {
      for (const knownRef of meta.references.split(/\s+/)) {
        if (knownRef && refIds.has(knownRef)) return jid;
      }
    }
    return null;
  }

  // Find a task thread by the [shortId] tag Clawd embeds in reply subjects.
  private findThreadBySubjectTag(subject: string): string | null {
    const m = subject.match(/\[([0-9a-f]{8,16})\]/i);
    if (!m) return null;
    const tag = m[1].toLowerCase();
    for (const jid of this.threadMeta.keys()) {
      if (
        jid !== MAIN_EMAIL_JID &&
        jid.replace('@email', '').replace('email-', '').startsWith(tag)
      ) {
        return jid;
      }
    }
    return null;
  }

  // Route to the shared admin thread. All @mainPrefix emails share one conversation.
  // ThreadMeta is updated to the latest sender so replies go to whoever just wrote.
  private routeToMain(
    from: string,
    fromName: string,
    subject: string,
    messageId: string,
    text: string,
    timestamp: string,
  ): void {
    const displaySubject = stripPrefix(subject, this.cfg.mainPrefix);

    // Update reply target; accumulate known message IDs for future reply recognition
    const existing = this.threadMeta.get(MAIN_EMAIL_JID);
    const knownRefs = new Set(
      [...(existing?.references?.split(/\s+/) ?? []), messageId].filter(
        Boolean,
      ),
    );
    const meta: ThreadMeta = {
      rootMessageId: messageId,
      from,
      subject: displaySubject || subject,
      references: [...knownRefs].join(' '),
    };
    this.threadMeta.set(MAIN_EMAIL_JID, meta);

    // Persist so reply recognition survives restarts
    try {
      const mainDir = path.join(GROUPS_DIR, MAIN_GROUP_FOLDER);
      fs.mkdirSync(mainDir, { recursive: true });
      fs.writeFileSync(
        path.join(mainDir, META_FILENAME),
        JSON.stringify(meta, null, 2),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to persist main thread metadata');
    }

    this.opts.onChatMetadata(
      MAIN_EMAIL_JID,
      timestamp,
      undefined,
      'email',
      false,
    );
    this.opts.onMessage(MAIN_EMAIL_JID, {
      id: messageId,
      chat_jid: MAIN_EMAIL_JID,
      sender: from,
      sender_name: fromName,
      content: `Subject: ${displaySubject || subject}\n\n${text}`,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    logger.info({ from, subject }, 'Email routed to main thread');
  }

  // Route to an isolated per-thread group. Each new email chain gets its own folder.
  // Pass forceJid when the thread was already identified (e.g. via subject tag) to skip re-derivation.
  private routeToTask(
    from: string,
    fromName: string,
    subject: string,
    messageId: string,
    inReplyTo: string | undefined,
    references: string,
    text: string,
    timestamp: string,
    forceJid?: string,
  ): void {
    const threadJid =
      forceJid ??
      this.getOrCreateTaskThreadJid(messageId, inReplyTo, references);
    const folder = threadJid.replace('@email', '');
    const groups = this.opts.registeredGroups();

    if (!groups[threadJid]) {
      const displaySubject = stripPrefix(subject, this.cfg.taskPrefix);
      const meta: ThreadMeta = {
        rootMessageId: messageId,
        from,
        subject: displaySubject || subject,
        references: messageId,
      };
      this.threadMeta.set(threadJid, meta);

      // Write metadata to disk for restart recovery
      const groupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, META_FILENAME),
        JSON.stringify(meta, null, 2),
      );

      this.opts.onNewThread(threadJid, {
        name: `Task: ${stripPrefix(subject, this.cfg.taskPrefix) || from}`,
        folder,
        trigger: '',
        added_at: timestamp,
        requiresTrigger: false,
      });
      logger.info({ threadJid, from, subject }, 'New task thread registered');
    } else {
      const meta = this.threadMeta.get(threadJid);
      if (meta && !meta.references.includes(messageId)) {
        meta.references = `${meta.references} ${messageId}`.trim();
      }
    }

    const displaySubject = stripPrefix(subject, this.cfg.taskPrefix);
    this.opts.onChatMetadata(threadJid, timestamp, undefined, 'email', false);
    this.opts.onMessage(threadJid, {
      id: messageId,
      chat_jid: threadJid,
      sender: from,
      sender_name: fromName,
      content: `Subject: ${displaySubject || subject}\n\n${text}`,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private senderAllowed(from: string): boolean {
    if (this.cfg.senderWhitelist.length === 0) return true;
    const fromLower = from.toLowerCase();
    return this.cfg.senderWhitelist.some((w) => fromLower === w.toLowerCase());
  }

  private getOrCreateTaskThreadJid(
    messageId: string,
    inReplyTo?: string,
    references?: string,
  ): string {
    const refIds = new Set<string>();
    if (inReplyTo) refIds.add(inReplyTo.trim());
    if (references) {
      for (const ref of references.split(/\s+/)) {
        if (ref) refIds.add(ref);
      }
    }

    // Check if this is a reply to a known task thread
    for (const [jid, meta] of this.threadMeta) {
      if (jid !== MAIN_EMAIL_JID && refIds.has(meta.rootMessageId)) {
        return jid;
      }
    }

    return messageIdToJid(messageId);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.transport) {
      logger.error({ jid }, 'SMTP transport not initialized');
      return;
    }

    const meta = this.threadMeta.get(jid);
    if (!meta || !meta.from) {
      logger.error({ jid }, 'No thread metadata — cannot send email reply');
      return;
    }

    const baseSubject = /^re:/i.test(meta.subject)
      ? meta.subject
      : `Re: ${meta.subject}`;
    // Embed a short thread ID tag for task threads so replies are recognized even when
    // the email client truncates the References chain (e.g. Mailspring).
    let replySubject = baseSubject;
    if (jid !== MAIN_EMAIL_JID) {
      const shortId = jid
        .replace('@email', '')
        .replace('email-', '')
        .slice(0, 8);
      if (!/\[[0-9a-f]{8,16}\]/i.test(baseSubject)) {
        replySubject = baseSubject.replace(/^(re:\s*)/i, `$1[${shortId}] `);
      }
    }

    try {
      const info = await this.transport.sendMail({
        from: this.cfg.smtp.user,
        to: meta.from,
        subject: replySubject,
        text,
        inReplyTo: meta.rootMessageId,
        references: meta.references,
      });
      logger.info({ to: meta.from, subject: replySubject }, 'Email reply sent');
      // Persist sent Message-ID so future replies to this email are recognized
      // even when the user's client truncates the References chain.
      if (info.messageId) {
        meta.references = `${meta.references} ${info.messageId}`.trim();
        const isMain = jid === MAIN_EMAIL_JID;
        const folder = isMain ? MAIN_GROUP_FOLDER : jid.replace('@email', '');
        try {
          fs.writeFileSync(
            path.join(GROUPS_DIR, folder, META_FILENAME),
            JSON.stringify(meta, null, 2),
          );
        } catch (writeErr) {
          logger.warn(
            { err: writeErr },
            'Failed to persist sent message ID to thread meta',
          );
        }
      }
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send email reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@email');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.currentImap?.logout();
    } catch {}
    this.transport?.close();
  }
}

/**
 * Build EmailConfig from .env / process.env.
 * Returns null if EMAIL_IMAP_HOST is not set (channel disabled).
 *
 * Required:
 *   EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS
 *
 * Optional (with defaults):
 *   EMAIL_SMTP_HOST            (defaults to EMAIL_IMAP_HOST)
 *   EMAIL_SMTP_USER            (defaults to EMAIL_IMAP_USER)
 *   EMAIL_SMTP_PASS            (defaults to EMAIL_IMAP_PASS)
 *   EMAIL_IMAP_PORT            (993 if TLS, else 143)
 *   EMAIL_IMAP_TLS             (true)
 *   EMAIL_IMAP_MAILBOX         (INBOX)
 *   EMAIL_SMTP_PORT            (465 if TLS, else 587)
 *   EMAIL_SMTP_TLS             (true)
 *   EMAIL_SUBJECT_PREFIX_MAIN  (@clawd)  — shared admin thread
 *   EMAIL_SUBJECT_PREFIX_TASK  (@task)   — isolated per-thread
 *   EMAIL_SENDER_WHITELIST     (comma-separated; empty = allow all)
 *   EMAIL_DELIVERY             (idle | poll; default: idle)
 *   EMAIL_POLL_INTERVAL        (seconds; default: 60)
 */
function buildEmailConfigFromEnv(): EmailConfig | null {
  const env = readEnvFile([
    'EMAIL_IMAP_HOST',
    'EMAIL_IMAP_PORT',
    'EMAIL_IMAP_USER',
    'EMAIL_IMAP_PASS',
    'EMAIL_IMAP_TLS',
    'EMAIL_IMAP_MAILBOX',
    'EMAIL_SMTP_HOST',
    'EMAIL_SMTP_PORT',
    'EMAIL_SMTP_USER',
    'EMAIL_SMTP_PASS',
    'EMAIL_SMTP_TLS',
    'EMAIL_SUBJECT_PREFIX_MAIN',
    'EMAIL_SUBJECT_PREFIX_TASK',
    'EMAIL_SENDER_WHITELIST',
    'EMAIL_DELIVERY',
    'EMAIL_POLL_INTERVAL',
  ]);

  const get = (key: string, fallback = '') =>
    process.env[key] ?? env[key] ?? fallback;

  const imapHost = get('EMAIL_IMAP_HOST');
  if (!imapHost) return null;

  const imapTls = get('EMAIL_IMAP_TLS', 'true') !== 'false';
  const smtpTls = get('EMAIL_SMTP_TLS', 'true') !== 'false';

  const whitelist = get('EMAIL_SENDER_WHITELIST')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const pollSecs = parseInt(get('EMAIL_POLL_INTERVAL', '60'), 10);

  return {
    imap: {
      host: imapHost,
      port: parseInt(get('EMAIL_IMAP_PORT', imapTls ? '993' : '143'), 10),
      user: get('EMAIL_IMAP_USER'),
      password: get('EMAIL_IMAP_PASS'),
      tls: imapTls,
      mailbox: get('EMAIL_IMAP_MAILBOX', 'INBOX'),
    },
    smtp: {
      host: get('EMAIL_SMTP_HOST', imapHost),
      port: parseInt(get('EMAIL_SMTP_PORT', smtpTls ? '465' : '587'), 10),
      user: get('EMAIL_SMTP_USER', get('EMAIL_IMAP_USER')),
      password: get('EMAIL_SMTP_PASS', get('EMAIL_IMAP_PASS')),
      tls: smtpTls,
    },
    mainPrefix: get('EMAIL_SUBJECT_PREFIX_MAIN', '@clawd'),
    taskPrefix: get('EMAIL_SUBJECT_PREFIX_TASK', '@task'),
    senderWhitelist: whitelist,
    delivery: get('EMAIL_DELIVERY', 'idle') === 'poll' ? 'poll' : 'idle',
    pollIntervalMs: (isNaN(pollSecs) || pollSecs < 10 ? 60 : pollSecs) * 1000,
  };
}

registerChannel('email', (opts) => {
  const config = buildEmailConfigFromEnv();
  if (!config) return null;
  return new EmailChannel({ ...opts, config });
});
