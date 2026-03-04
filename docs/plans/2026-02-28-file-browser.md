# Thread File Browser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a two-pane email-reader-style file browser to the Threads tab — clicking a thread opens a right panel showing the group folder's files (`.md`, `.log`, etc.) with rendered markdown and a VS Code link.

**Architecture:** Two new Fastify routes (`GET /api/files/:folder`, `GET /api/file/:folder/*`) serve file listings and content from `groups/{folder}/`. The HTML in `src/ui-server.ts` is updated to show a split-pane layout when a thread is selected: left pane keeps the thread list, right pane shows a file tree and file content. `buildUiServer` gains an optional `groupsDir` parameter for testability. Markdown rendered via `marked` CDN.

**Tech Stack:** Node.js `fs`, `path`, Fastify wildcard routes, `marked` from jsDelivr CDN, vanilla JS, vitest for tests.

---

### Task 1: Add file API routes

**Files:**
- Modify: `src/ui-server.ts`
- Create: `src/ui-server-files.test.ts`

**Step 1: Write failing tests — create `src/ui-server-files.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _initTestDatabase, setRegisteredGroup, storeChatMetadata } from './db.js';
import { buildUiServer } from './ui-server.js';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanoclaw-test-'));

  mkdirSync(join(tempDir, 'testgroup', 'logs'), { recursive: true });
  mkdirSync(join(tempDir, 'testgroup', 'node_modules'), { recursive: true });
  mkdirSync(join(tempDir, 'testgroup', 'research'), { recursive: true });

  writeFileSync(join(tempDir, 'testgroup', 'CLAUDE.md'), '# Context\nThis is the context.');
  writeFileSync(join(tempDir, 'testgroup', 'report.md'), '# Report\nSome analysis.');
  writeFileSync(join(tempDir, 'testgroup', 'email-meta.json'), '{}');
  writeFileSync(join(tempDir, 'testgroup', 'node_modules', 'index.js'), 'code');
  writeFileSync(join(tempDir, 'testgroup', 'research', 'findings.md'), '# Findings');
  writeFileSync(join(tempDir, 'testgroup', 'logs', 'container-2026-02-27.log'), 'old log\n'.repeat(10));
  writeFileSync(join(tempDir, 'testgroup', 'logs', 'container-2026-02-28.log'), 'new log\n'.repeat(10));

  // Set different mtimes so sort order is deterministic
  const old = new Date('2026-02-27T09:00:00Z');
  const newer = new Date('2026-02-28T09:00:00Z');
  utimesSync(join(tempDir, 'testgroup', 'logs', 'container-2026-02-27.log'), old, old);
  utimesSync(join(tempDir, 'testgroup', 'logs', 'container-2026-02-28.log'), newer, newer);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api/files/:folder', () => {
  it('lists .md and .log files including subdirectories', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/files/testgroup' });
    expect(res.statusCode).toBe(200);
    const files = JSON.parse(res.body) as Array<{ path: string; mtime: string }>;
    const paths = files.map(f => f.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('report.md');
    expect(paths).toContain('research/findings.md');
    expect(paths).toContain('logs/container-2026-02-27.log');
    expect(paths).toContain('logs/container-2026-02-28.log');
  });

  it('excludes node_modules and email-meta.json', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/files/testgroup' });
    const files = JSON.parse(res.body) as Array<{ path: string }>;
    const paths = files.map(f => f.path);
    expect(paths).not.toContain('email-meta.json');
    expect(paths.some(p => p.includes('node_modules'))).toBe(false);
  });

  it('puts logs/ first and sorts them newest-first by mtime', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/files/testgroup' });
    const files = JSON.parse(res.body) as Array<{ path: string }>;
    expect(files[0].path).toBe('logs/container-2026-02-28.log');
    expect(files[1].path).toBe('logs/container-2026-02-27.log');
  });

  it('returns [] for nonexistent folder', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/files/nonexistent' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('rejects folder names containing ..', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/files/..' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/file/:folder/*', () => {
  it('returns file content and truncated=false for small files', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/file/testgroup/CLAUDE.md' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toContain('# Context');
    expect(body.truncated).toBe(false);
  });

  it('returns 404 for missing file', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/file/testgroup/nope.md' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects path traversal in file path', async () => {
    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/file/testgroup/../../../etc/passwd' });
    expect(res.statusCode).toBe(400);
  });

  it('truncates log files to last 200 lines', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(join(tempDir, 'testgroup', 'logs', 'big.log'), lines);

    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/file/testgroup/logs/big.log' });
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
    const res = await app.inject({ method: 'GET', url: '/api/file/testgroup/research/findings.md' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toContain('# Findings');
  });
});

describe('GET /api/groups includes absolutePath', () => {
  it('returns absolutePath for each group', async () => {
    _initTestDatabase();
    setRegisteredGroup('abc@email', { name: 'Test', folder: 'testgroup', trigger: '@bot', added_at: new Date().toISOString() });
    storeChatMetadata('abc@email', '2024-01-01T12:00:00.000Z', 'Test', 'email', true);

    const app = buildUiServer(tempDir);
    const res = await app.inject({ method: 'GET', url: '/api/groups' });
    expect(res.statusCode).toBe(200);
    const groups = JSON.parse(res.body);
    expect(groups[0].absolutePath).toBeDefined();
    expect(groups[0].absolutePath).toContain('testgroup');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /Users/abathur/work/nanoclaw && npm test -- --reporter=verbose src/ui-server-files.test.ts
```

Expected: failures — `buildUiServer` doesn't accept `groupsDir`, file routes don't exist.

**Step 3: Implement the routes in `src/ui-server.ts`**

Add `fs` and `path` imports, and `GROUPS_DIR` to the config import, at the top:

```typescript
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, UI_PORT } from './config.js';
```

Change `buildUiServer` signature:

```typescript
export function buildUiServer(groupsDir: string = GROUPS_DIR): FastifyInstance {
```

Update the `/api/groups` route to include `absolutePath` (replace the existing route body):

```typescript
  app.get('/api/groups', async () => {
    const groups = getAllRegisteredGroups();
    const chats = getAllChats();
    const chatMap = new Map(chats.map((c) => [c.jid, c]));

    return Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      absolutePath: path.join(groupsDir, g.folder),
      channel: chatMap.get(jid)?.channel ?? null,
      last_activity: chatMap.get(jid)?.last_message_time ?? null,
    })).sort((a, b) => {
      if (!a.last_activity) return 1;
      if (!b.last_activity) return -1;
      return b.last_activity.localeCompare(a.last_activity);
    });
  });
```

Add these two new routes before `return app` (after the existing `/api/messages/:jid` route):

```typescript
  const EXCLUDED_NAMES = new Set(['.DS_Store', 'email-meta.json', 'package-lock.json', 'package.json']);
  const EXCLUDED_DIRS = new Set(['node_modules', '.git']);
  const ALLOWED_EXTS = new Set(['.md', '.log', '.js', '.ts', '.json', '.txt', '.py']);

  app.get<{ Params: { folder: string } }>('/api/files/:folder', async (req, reply) => {
    const folder = req.params.folder;
    if (!folder || folder.includes('..') || folder.includes('\0')) {
      return reply.code(400).send({ error: 'Invalid folder name' });
    }
    const groupDir = path.resolve(groupsDir, folder);
    if (!groupDir.startsWith(path.resolve(groupsDir) + path.sep)) {
      return reply.code(400).send({ error: 'Invalid folder name' });
    }
    if (!fs.existsSync(groupDir)) return [];

    const files: Array<{ path: string; mtime: string }> = [];

    function walk(dir: string, prefix: string) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (EXCLUDED_NAMES.has(entry.name)) continue;
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
          if (!ALLOWED_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
          try {
            const stat = fs.statSync(path.join(dir, entry.name));
            files.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, mtime: stat.mtime.toISOString() });
          } catch { /* skip unreadable */ }
        }
      }
    }

    walk(groupDir, '');
    files.sort((a, b) => {
      const aLog = a.path.startsWith('logs/');
      const bLog = b.path.startsWith('logs/');
      if (aLog && bLog) return b.mtime.localeCompare(a.mtime) || b.path.localeCompare(a.path);
      if (aLog) return -1;
      if (bLog) return 1;
      return a.path.localeCompare(b.path);
    });
    return files;
  });

  app.get<{ Params: { folder: string; '*': string } }>('/api/file/:folder/*', async (req, reply) => {
    const folder = req.params.folder;
    const filePath = req.params['*'];
    if (!folder || folder.includes('..') || folder.includes('\0')) {
      return reply.code(400).send({ error: 'Invalid folder name' });
    }
    const groupDir = path.resolve(groupsDir, folder);
    if (!groupDir.startsWith(path.resolve(groupsDir) + path.sep)) {
      return reply.code(400).send({ error: 'Invalid folder name' });
    }
    const fullPath = path.resolve(groupDir, filePath);
    if (!fullPath.startsWith(groupDir + path.sep) && fullPath !== groupDir) {
      return reply.code(400).send({ error: 'Invalid path' });
    }
    if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'File not found' });

    const MAX_BYTES = 500 * 1024;
    let content: string;
    let truncated = false;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_BYTES) {
        const buf = Buffer.alloc(MAX_BYTES);
        const fd = fs.openSync(fullPath, 'r');
        fs.readSync(fd, buf, 0, MAX_BYTES, stat.size - MAX_BYTES);
        fs.closeSync(fd);
        content = buf.toString('utf-8');
        const nl = content.indexOf('\n');
        if (nl > 0) content = content.slice(nl + 1);
        truncated = true;
      } else {
        content = fs.readFileSync(fullPath, 'utf-8');
      }
    } catch { return reply.code(500).send({ error: 'Could not read file' }); }

    if (filePath.endsWith('.log')) {
      const lines = content.split('\n');
      if (lines.length > 200) {
        content = lines.slice(-200).join('\n');
        truncated = true;
      }
    }
    return { content, truncated };
  });
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/abathur/work/nanoclaw && npm test -- --reporter=verbose src/ui-server-files.test.ts
```

Expected: all tests pass.

**Step 5: Run full test suite**

```bash
cd /Users/abathur/work/nanoclaw && npm test
```

Expected: all 362+ tests pass.

**Step 6: Commit**

```bash
cd /Users/abathur/work/nanoclaw && git add src/ui-server.ts src/ui-server-files.test.ts
git commit -m "feat: add file listing and content API routes"
```

---

### Task 2: Update HTML for two-pane file browser

**Files:**
- Modify: `src/ui-server.ts` (HTML string only)

This task replaces the entire `const HTML = \`...\`` string in `src/ui-server.ts`. The new HTML adds the `marked` CDN, restructures the Threads view into a split-pane layout, and replaces the old messages panel with a file browser.

**Step 1: Replace the entire HTML constant**

Find the line `const HTML = \`<!DOCTYPE html>` and replace everything up to the closing backtick (just before `export function buildUiServer`) with:

```typescript
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; font-size: 13px; }
    header { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid #30363d; }
    header h1 { font-size: 14px; color: #8b949e; }
    nav { display: flex; gap: 4px; }
    button { background: none; border: 1px solid #30363d; color: #8b949e; padding: 4px 12px; cursor: pointer; border-radius: 4px; font-family: monospace; font-size: 12px; }
    button.active { border-color: #58a6ff; color: #58a6ff; }
    #status { margin-left: auto; color: #484f58; font-size: 11px; }
    main { padding: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; color: #484f58; font-weight: normal; padding: 6px 8px; border-bottom: 1px solid #21262d; }
    td { padding: 6px 8px; border-bottom: 1px solid #161b22; vertical-align: top; }
    tr:hover td { background: #161b22; cursor: pointer; }
    tr.row-selected td { background: #1c2128; }
    .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
    .tag-active { background: #1a3a1a; color: #3fb950; border: 1px solid #238636; }
    .tag-paused { background: #2d1a1a; color: #f85149; border: 1px solid #da3633; }
    .tag-completed { background: #1a1a2d; color: #8b949e; border: 1px solid #30363d; }
    .prompt { color: #8b949e; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .prompt.expanded { white-space: pre-wrap; color: #c9d1d9; overflow: visible; }
    .hidden { display: none; }
    /* Two-pane layout */
    #view-threads { display: flex; gap: 0; }
    #threads-left { flex: 1; min-width: 0; overflow-x: hidden; }
    #threads-left.split { flex: 0 0 320px; }
    #thread-pane { flex: 1; display: flex; flex-direction: column; border-left: 1px solid #30363d; margin-left: 16px; padding-left: 16px; height: 75vh; min-height: 300px; }
    .pane-header { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid #30363d; flex-shrink: 0; }
    .pane-title { flex: 1; color: #8b949e; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pane-btn { background: none; border: 1px solid #30363d; color: #8b949e; padding: 2px 8px; cursor: pointer; border-radius: 3px; font-size: 11px; text-decoration: none; font-family: monospace; }
    .pane-btn:hover { border-color: #8b949e; color: #c9d1d9; }
    #file-tree { overflow-y: auto; max-height: 180px; border-bottom: 1px solid #30363d; padding: 4px 0; flex-shrink: 0; }
    .file-dir-label { padding: 5px 0 2px; color: #484f58; font-size: 11px; user-select: none; }
    .file-item { padding: 3px 0 3px 12px; cursor: pointer; color: #8b949e; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-item:hover { color: #c9d1d9; }
    .file-item.file-selected { color: #58a6ff; }
    #file-content { flex: 1; overflow-y: auto; padding-top: 12px; min-height: 0; }
    #file-content pre { background: #161b22; padding: 12px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; color: #8b949e; font-size: 12px; line-height: 1.5; margin: 0; }
    .md-content { line-height: 1.6; }
    .md-content h1 { font-size: 17px; color: #c9d1d9; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid #30363d; }
    .md-content h2 { font-size: 14px; color: #c9d1d9; margin: 14px 0 6px; }
    .md-content h3 { font-size: 13px; color: #c9d1d9; margin: 10px 0 4px; }
    .md-content p { color: #c9d1d9; margin: 0 0 8px; }
    .md-content code { background: #161b22; padding: 1px 4px; border-radius: 3px; font-size: 11px; color: #f0883e; }
    .md-content pre { background: #161b22; padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
    .md-content pre code { background: none; padding: 0; color: #c9d1d9; font-size: 12px; }
    .md-content ul, .md-content ol { padding-left: 20px; margin: 0 0 8px; color: #c9d1d9; }
    .md-content li { margin-bottom: 2px; }
    .md-content a { color: #58a6ff; }
    .md-content blockquote { border-left: 3px solid #30363d; padding-left: 12px; color: #8b949e; margin: 8px 0; }
    .md-content hr { border: none; border-top: 1px solid #30363d; margin: 12px 0; }
    .md-content table { border-collapse: collapse; width: 100%; margin: 8px 0; }
    .md-content th, .md-content td { border: 1px solid #30363d; padding: 5px 8px; text-align: left; }
    .md-content th { background: #161b22; }
    .md-content strong { color: #c9d1d9; }
    .md-content em { color: #c9d1d9; }
  </style>
</head>
<body>
  <header>
    <h1>nanoclaw</h1>
    <nav>
      <button id="tab-threads" class="active" onclick="setTab('threads')">Threads</button>
      <button id="tab-schedules" onclick="setTab('schedules')">Schedules</button>
    </nav>
    <span id="status">connecting…</span>
  </header>
  <main>
    <div id="view-threads">
      <div id="threads-left"></div>
      <div id="thread-pane" class="hidden">
        <div class="pane-header">
          <span id="thread-pane-title" class="pane-title"></span>
          <a id="thread-vscode-link" href="#" class="pane-btn" title="Open in VS Code">↗ vscode</a>
          <button class="pane-btn" onclick="closeThreadPane()">✕</button>
        </div>
        <div id="file-tree"></div>
        <div id="file-content"><p style="color:#484f58">Select a file</p></div>
      </div>
    </div>
    <div id="view-schedules" class="hidden"></div>
  </main>
  <script>
    const store = { groups: [], tasks: [], selectedJid: null, selectedFolder: null, selectedAbsPath: null, files: [], selectedFile: null, tab: 'threads', lastFetch: null };

    function setTab(tab) {
      store.tab = tab;
      document.getElementById('tab-threads').classList.toggle('active', tab === 'threads');
      document.getElementById('tab-schedules').classList.toggle('active', tab === 'schedules');
      document.getElementById('view-threads').classList.toggle('hidden', tab !== 'threads');
      document.getElementById('view-schedules').classList.toggle('hidden', tab !== 'schedules');
      render();
    }

    async function selectThread(jid, name, folder, absPath) {
      store.selectedJid = jid;
      store.selectedFolder = folder;
      store.selectedAbsPath = absPath;
      store.files = [];
      store.selectedFile = null;
      document.getElementById('thread-pane').classList.remove('hidden');
      document.getElementById('threads-left').classList.add('split');
      document.getElementById('thread-pane-title').textContent = name;
      document.getElementById('thread-vscode-link').href = 'vscode://file/' + absPath;
      document.getElementById('file-tree').innerHTML = '<p style="color:#484f58;padding:4px 0;font-size:12px">Loading…</p>';
      document.getElementById('file-content').innerHTML = '<p style="color:#484f58">Select a file</p>';
      renderThreads();
      const files = await fetch('/api/files/' + encodeURIComponent(folder)).then(r => r.json());
      store.files = files;
      renderFileTree();
      if (files.length > 0) await selectFile(folder, files[0].path);
    }

    function closeThreadPane() {
      store.selectedJid = null;
      store.selectedFolder = null;
      store.selectedAbsPath = null;
      store.files = [];
      store.selectedFile = null;
      document.getElementById('thread-pane').classList.add('hidden');
      document.getElementById('threads-left').classList.remove('split');
      renderThreads();
    }

    async function selectFile(folder, filePath) {
      store.selectedFile = filePath;
      renderFileTree();
      document.getElementById('file-content').innerHTML = '<p style="color:#484f58;font-size:12px">Loading…</p>';
      const segs = filePath.split('/').map(encodeURIComponent).join('/');
      const data = await fetch('/api/file/' + encodeURIComponent(folder) + '/' + segs).then(r => r.json());
      renderFileContent(data, filePath);
    }

    function renderFileContent(data, filePath) {
      const el = document.getElementById('file-content');
      if (data.error) { el.innerHTML = '<p style="color:#f85149">' + esc(data.error) + '</p>'; return; }
      let html = data.truncated ? '<p style="color:#484f58;font-size:11px;margin-bottom:8px">… (truncated — showing last portion) …</p>' : '';
      if (filePath.endsWith('.md')) {
        html += '<div class="md-content">' + marked.parse(data.content) + '</div>';
      } else {
        html += '<pre>' + esc(data.content) + '</pre>';
      }
      el.innerHTML = html;
    }

    function renderFileTree() {
      const el = document.getElementById('file-tree');
      if (!store.files.length) { el.innerHTML = '<p style="color:#484f58;padding:4px 0;font-size:12px">No files</p>'; return; }
      const byDir = {};
      for (const f of store.files) {
        const slash = f.path.lastIndexOf('/');
        const dir = slash >= 0 ? f.path.slice(0, slash) : '';
        if (!byDir[dir]) byDir[dir] = [];
        byDir[dir].push(f);
      }
      let html = '';
      if (byDir['']) {
        for (const f of byDir['']) {
          html += '<div class="file-item' + (store.selectedFile === f.path ? ' file-selected' : '') + '" onclick="selectFile(' + JSON.stringify(store.selectedFolder) + ',' + JSON.stringify(f.path) + ')">' + esc(f.path) + '</div>';
        }
      }
      for (const dir of Object.keys(byDir).filter(d => d).sort()) {
        html += '<div class="file-dir-label">' + esc(dir) + '/</div>';
        for (const f of byDir[dir]) {
          const name = f.path.slice(f.path.lastIndexOf('/') + 1);
          html += '<div class="file-item' + (store.selectedFile === f.path ? ' file-selected' : '') + '" onclick="selectFile(' + JSON.stringify(store.selectedFolder) + ',' + JSON.stringify(f.path) + ')">' + esc(name) + '</div>';
        }
      }
      el.innerHTML = html;
    }

    async function refresh() {
      try {
        const [groups, tasks] = await Promise.all([
          fetch('/api/groups').then(r => r.json()),
          fetch('/api/tasks').then(r => r.json()),
        ]);
        store.groups = groups;
        store.tasks = tasks;
        store.lastFetch = Date.now();
        render();
      } catch (e) {
        document.getElementById('status').textContent = 'fetch error';
      }
    }

    function render() {
      renderThreads();
      renderSchedules();
      updateStatus();
    }

    function renderThreads() {
      const el = document.getElementById('threads-left');
      if (!store.groups.length) { el.innerHTML = '<p style="color:#484f58;padding:8px">No threads</p>'; return; }
      el.innerHTML = '<table><thead><tr><th>Name</th><th>Folder</th><th>Channel</th><th>Last Activity</th></tr></thead><tbody>' +
        store.groups.map(g =>
          '<tr class="' + (store.selectedJid === g.jid ? 'row-selected' : '') + '" onclick="selectThread(' + JSON.stringify(g.jid) + ',' + JSON.stringify(g.name) + ',' + JSON.stringify(g.folder) + ',' + JSON.stringify(g.absolutePath) + ')">' +
          '<td>' + esc(g.name) + '</td>' +
          '<td style="color:#8b949e">' + esc(g.folder) + '</td>' +
          '<td style="color:#8b949e">' + esc(g.channel || '—') + '</td>' +
          '<td style="color:#8b949e">' + (g.last_activity ? reltime(g.last_activity) : '—') + '</td>' +
          '</tr>'
        ).join('') + '</tbody></table>';
    }

    function renderSchedules() {
      const el = document.getElementById('view-schedules');
      if (!store.tasks.length) { el.innerHTML = '<p style="color:#484f58;padding:8px">No schedules</p>'; return; }
      el.innerHTML = '<table><thead><tr><th>Group</th><th>Type</th><th>Schedule</th><th>Status</th><th>Next Run</th><th>Prompt</th></tr></thead><tbody>' +
        store.tasks.map((t, i) =>
          '<tr>' +
          '<td>' + esc(t.group_folder) + '</td>' +
          '<td style="color:#8b949e">' + esc(t.schedule_type) + '</td>' +
          '<td style="color:#8b949e">' + esc(t.schedule_value) + '</td>' +
          '<td><span class="tag tag-' + esc(t.status) + '">' + esc(t.status) + '</span></td>' +
          '<td style="color:#8b949e">' + (t.next_run ? reltime(t.next_run) : '—') + '</td>' +
          '<td><span class="prompt" id="prompt-' + i + '" onclick="event.stopPropagation();togglePrompt(' + i + ')" title="click to expand">' + esc(t.prompt) + '</span></td>' +
          '</tr>'
        ).join('') + '</tbody></table>';
    }

    function togglePrompt(i) {
      document.getElementById('prompt-' + i).classList.toggle('expanded');
    }

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function reltime(iso) {
      const diff = (Date.now() - new Date(iso).getTime()) / 1000;
      if (diff < 60) return Math.round(diff) + 's ago';
      if (diff < 3600) return Math.round(diff / 60) + 'm ago';
      if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
      return Math.round(diff / 86400) + 'd ago';
    }

    function updateStatus() {
      if (!store.lastFetch) return;
      const s = Math.round((Date.now() - store.lastFetch) / 1000);
      document.getElementById('status').textContent = 'updated ' + s + 's ago';
    }

    setInterval(refresh, 5000);
    setInterval(updateStatus, 1000);
    refresh();
  </script>
</body>
</html>`;
```

**Step 2: Run existing UI server tests**

```bash
cd /Users/abathur/work/nanoclaw && npm test -- --reporter=verbose src/ui-server.test.ts
```

Expected: all 5 existing tests pass (the HTML test checks `res.body.toContain('nanoclaw')` — still true).

**Step 3: Run the full test suite**

```bash
cd /Users/abathur/work/nanoclaw && npm test
```

Expected: all tests pass.

**Step 4: Commit**

```bash
cd /Users/abathur/work/nanoclaw && git add src/ui-server.ts
git commit -m "feat: two-pane file browser in threads view"
```

**Step 5: Restart and verify in browser**

```bash
cd /Users/abathur/work/nanoclaw && npm run restart
```

Open `http://localhost:3001`. Verify:
- Threads tab shows the thread list
- Clicking a thread opens a right pane with folder name, VS Code link, file tree
- Most recent log is auto-selected and shown
- Clicking a `.md` file renders formatted markdown
- Clicking a `.log` file shows monospace text
- ✕ button closes the pane and returns to full-width thread list

---

## Verification

After both tasks complete and service restarts:

```bash
curl -s http://localhost:3001/api/files/main | python3 -m json.tool | head -20
curl -s http://localhost:3001/api/file/main/CLAUDE.md | python3 -m json.tool | head -5
```

Both should return JSON with file data.
