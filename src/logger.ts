import { readFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';

function getLogLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    const m = raw.match(/^LOG_LEVEL\s*=\s*(\S+)/m);
    if (m) return m[1];
  } catch {}
  return 'info';
}

export const logger = pino({
  level: getLogLevel(),
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
