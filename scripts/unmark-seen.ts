/**
 * One-off script: fetch headers for a UID and optionally unmark it as \Seen
 * Usage: npx tsx scripts/unmark-seen.ts <uid> [--unmark]
 */
import { ImapFlow } from 'imapflow';
import { readEnvFile } from '../src/env.js';

const uid = process.argv[2];
const doUnmark = process.argv.includes('--unmark');

if (!uid) {
  console.error('Usage: npx tsx scripts/unmark-seen.ts <uid> [--unmark]');
  process.exit(1);
}

const env = readEnvFile([
  'EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS',
  'EMAIL_IMAP_PORT', 'EMAIL_IMAP_TLS',
]);

const client = new ImapFlow({
  host: env.EMAIL_IMAP_HOST!,
  port: parseInt(env.EMAIL_IMAP_PORT ?? '993'),
  secure: env.EMAIL_IMAP_TLS !== 'false',
  auth: { user: env.EMAIL_IMAP_USER!, pass: env.EMAIL_IMAP_PASS! },
  logger: false,
});

await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  // Fetch headers
  const msg = await client.fetchOne(uid, { uid: true, envelope: true, headers: true }, { uid: true });
  if (!msg) {
    console.log('Message not found');
  } else {
    const headers = msg.headers ? Buffer.from(msg.headers).toString() : '';
    const inReplyTo = headers.match(/^in-reply-to:\s*(.+)$/im)?.[1]?.trim();
    const references = headers.match(/^references:\s*([\s\S]*?)(?=^\S)/im)?.[1]?.trim().replace(/\s+/g, ' ');
    console.log('Subject:    ', msg.envelope?.subject);
    console.log('From:       ', msg.envelope?.from?.[0]?.address);
    console.log('In-Reply-To:', inReplyTo ?? '(none)');
    console.log('References: ', references ?? '(none)');
  }

  if (doUnmark) {
    await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
    console.log(`\nUID ${uid} unmarked as \\Seen`);
  }
} finally {
  lock.release();
  await client.logout();
}
