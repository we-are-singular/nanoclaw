import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _initTestDatabase,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { buildUiServer } from './ui-server.js';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanoclaw-test-'));

  mkdirSync(join(tempDir, 'testgroup', 'logs'), { recursive: true });
  mkdirSync(join(tempDir, 'testgroup', 'node_modules'), { recursive: true });
  mkdirSync(join(tempDir, 'testgroup', 'research'), { recursive: true });

  writeFileSync(
    join(tempDir, 'testgroup', 'CLAUDE.md'),
    '# Context\nThis is the context.',
  );
  writeFileSync(
    join(tempDir, 'testgroup', 'report.md'),
    '# Report\nSome analysis.',
  );
  writeFileSync(join(tempDir, 'testgroup', 'email-meta.json'), '{}');
  writeFileSync(join(tempDir, 'testgroup', 'node_modules', 'index.js'), 'code');
  writeFileSync(
    join(tempDir, 'testgroup', 'research', 'findings.md'),
    '# Findings',
  );
  writeFileSync(
    join(tempDir, 'testgroup', 'logs', 'container-2026-02-27.log'),
    'old log\n'.repeat(10),
  );
  writeFileSync(
    join(tempDir, 'testgroup', 'logs', 'container-2026-02-28.log'),
    'new log\n'.repeat(10),
  );

  // Set different mtimes so sort order is deterministic
  const old = new Date('2026-02-27T09:00:00Z');
  const newer = new Date('2026-02-28T09:00:00Z');
  utimesSync(
    join(tempDir, 'testgroup', 'logs', 'container-2026-02-27.log'),
    old,
    old,
  );
  utimesSync(
    join(tempDir, 'testgroup', 'logs', 'container-2026-02-28.log'),
    newer,
    newer,
  );
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api/files/:folder', () => {
  it('lists .md and .log files including subdirectories', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/testgroup',
    });
    expect(res.statusCode).toBe(200);
    const files = JSON.parse(res.body) as Array<{
      path: string;
      mtime: string;
    }>;
    const paths = files.map((f) => f.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('report.md');
    expect(paths).toContain('research/findings.md');
    expect(paths).toContain('logs/container-2026-02-27.log');
    expect(paths).toContain('logs/container-2026-02-28.log');
  });

  it('excludes node_modules and email-meta.json', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/testgroup',
    });
    const files = JSON.parse(res.body) as Array<{ path: string }>;
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('email-meta.json');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('puts logs/ first and sorts them newest-first by mtime', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/testgroup',
    });
    const files = JSON.parse(res.body) as Array<{ path: string }>;
    expect(files[0].path).toBe('logs/container-2026-02-28.log');
    expect(files[1].path).toBe('logs/container-2026-02-27.log');
  });

  it('returns [] for nonexistent folder', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/nonexistent',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('rejects folder names containing ..', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/files/..' });
    // inject normalizes '..' so route may not match (404) or hook catches it (400) — both are secure
    expect([400, 404]).toContain(res.statusCode);
  });
});

describe('GET /api/file/:folder/*', () => {
  it('returns file content and truncated=false for small files', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/file/testgroup/CLAUDE.md',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toContain('# Context');
    expect(body.truncated).toBe(false);
  });

  it('returns 404 for missing file', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/file/testgroup/nope.md',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects path traversal in file path', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/file/testgroup/../../../etc/passwd',
    });
    // inject normalizes '..' so route may not match (404) or hook catches it (400) — both are secure
    expect([400, 404]).toContain(res.statusCode);
  });

  it('truncates log files to last 200 lines', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    writeFileSync(join(tempDir, 'testgroup', 'logs', 'big.log'), lines);

    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/file/testgroup/logs/big.log',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(true);
    const resultLines = body.content.split('\n');
    expect(resultLines.length).toBe(200);
    expect(resultLines[0]).toBe('line 51');
    expect(resultLines[199]).toBe('line 250');
  });

  it('returns nested file content via subdirectory path', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({
      method: 'GET',
      url: '/api/file/testgroup/research/findings.md',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toContain('# Findings');
  });
});

describe('GET /api/groups includes absolutePath', () => {
  it('returns absolutePath for each group', async () => {
    _initTestDatabase();
    setRegisteredGroup('abc@email', {
      name: 'Test',
      folder: 'testgroup',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    });
    storeChatMetadata(
      'abc@email',
      '2024-01-01T12:00:00.000Z',
      'Test',
      'email',
      true,
    );

    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/groups' });
    expect(res.statusCode).toBe(200);
    const groups = JSON.parse(res.body);
    expect(groups[0].absolutePath).toBeDefined();
    expect(groups[0].absolutePath).toContain('testgroup');
  });
});
