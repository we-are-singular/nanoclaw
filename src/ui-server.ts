import fs from 'fs';
import path from 'path';

import Fastify, { FastifyInstance } from 'fastify';

import { GROUPS_DIR, UI_PORT } from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getLatestMessages,
} from './db.js';
import { logger } from './logger.js';

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
    .hidden { display: none !important; }
    /* Two-pane layout */
    #view-threads { display: flex; gap: 0; }
    #threads-left { flex: 1; min-width: 0; overflow-x: hidden; }
    #threads-left.split { flex: 3; min-width: 200px; }
    #thread-pane { flex: 7; display: flex; flex-direction: column; border-left: 1px solid #30363d; margin-left: 16px; padding-left: 16px; height: 75vh; min-height: 300px; }
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
      document.getElementById('file-tree').innerHTML = '<p style="color:#484f58;padding:4px 0;font-size:12px">Loading\u2026</p>';
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
      document.getElementById('file-content').innerHTML = '<p style="color:#484f58;font-size:12px">Loading\u2026</p>';
      const segs = filePath.split('/').map(encodeURIComponent).join('/');
      const data = await fetch('/api/file/' + encodeURIComponent(folder) + '/' + segs).then(r => r.json());
      renderFileContent(data, filePath);
    }

    function renderFileContent(data, filePath) {
      const el = document.getElementById('file-content');
      if (data.error) { el.innerHTML = '<p style="color:#f85149">' + esc(data.error) + '</p>'; return; }
      let html = data.truncated ? '<p style="color:#484f58;font-size:11px;margin-bottom:8px">\u2026 (truncated \u2014 showing last portion) \u2026</p>' : '';
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
          html += '<div class="file-item' + (store.selectedFile === f.path ? ' file-selected' : '') + '" onclick="selectFile(' + esc(JSON.stringify(store.selectedFolder)) + ',' + esc(JSON.stringify(f.path)) + ')">' + esc(f.path) + '</div>';
        }
      }
      for (const dir of Object.keys(byDir).filter(d => d).sort()) {
        html += '<div class="file-dir-label">' + esc(dir) + '/</div>';
        for (const f of byDir[dir]) {
          const name = f.path.slice(f.path.lastIndexOf('/') + 1);
          html += '<div class="file-item' + (store.selectedFile === f.path ? ' file-selected' : '') + '" onclick="selectFile(' + esc(JSON.stringify(store.selectedFolder)) + ',' + esc(JSON.stringify(f.path)) + ')">' + esc(name) + '</div>';
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
          '<tr class="' + (store.selectedJid === g.jid ? 'row-selected' : '') + '" onclick="selectThread(' + esc(JSON.stringify(g.jid)) + ',' + esc(JSON.stringify(g.name)) + ',' + esc(JSON.stringify(g.folder)) + ',' + esc(JSON.stringify(g.absolutePath)) + ')">' +
          '<td>' + esc(g.name) + '</td>' +
          '<td style="color:#8b949e">' + esc(g.folder) + '</td>' +
          '<td style="color:#8b949e">' + esc(g.channel || '\u2014') + '</td>' +
          '<td style="color:#8b949e">' + (g.last_activity ? reltime(g.last_activity) : '\u2014') + '</td>' +
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
          '<td style="color:#8b949e">' + (t.next_run ? reltime(t.next_run) : '\u2014') + '</td>' +
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

export function buildUiServer(groupsDir: string = GROUPS_DIR): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (req.raw.url?.includes('..')) {
      return reply.code(400).send({ error: 'Invalid path' });
    }
  });

  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(HTML);
  });

  app.get('/api/groups', async () => {
    const groups = getAllRegisteredGroups();
    const chats = getAllChats();
    const chatMap = new Map(chats.map((c) => [c.jid, c]));

    return Object.entries(groups)
      .map(([jid, g]) => ({
        jid,
        name: g.name,
        folder: g.folder,
        absolutePath: path.join(groupsDir, g.folder),
        channel: chatMap.get(jid)?.channel ?? null,
        last_activity: chatMap.get(jid)?.last_message_time ?? null,
      }))
      .sort((a, b) => {
        if (!a.last_activity) return 1;
        if (!b.last_activity) return -1;
        return b.last_activity.localeCompare(a.last_activity);
      });
  });

  app.get('/api/tasks', async () => {
    return getAllTasks();
  });

  app.get<{ Params: { jid: string } }>('/api/messages/:jid', async (req) => {
    return getLatestMessages(req.params.jid, 50);
  });

  const EXCLUDED_NAMES = new Set([
    '.DS_Store',
    'email-meta.json',
    'package-lock.json',
    'package.json',
  ]);
  const EXCLUDED_DIRS = new Set(['node_modules', '.git']);
  const ALLOWED_EXTS = new Set(['.md', '.log']);

  app.get<{ Params: { folder: string } }>(
    '/api/files/:folder',
    async (req, reply) => {
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
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (EXCLUDED_NAMES.has(entry.name)) continue;
          if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.has(entry.name)) continue;
            walk(
              path.join(dir, entry.name),
              prefix ? `${prefix}/${entry.name}` : entry.name,
            );
          } else if (entry.isFile()) {
            if (!ALLOWED_EXTS.has(path.extname(entry.name).toLowerCase()))
              continue;
            try {
              const stat = fs.statSync(path.join(dir, entry.name));
              files.push({
                path: prefix ? `${prefix}/${entry.name}` : entry.name,
                mtime: stat.mtime.toISOString(),
              });
            } catch {
              /* skip unreadable */
            }
          }
        }
      }

      walk(groupDir, '');
      files.sort((a, b) => {
        const aLog = a.path.startsWith('logs/');
        const bLog = b.path.startsWith('logs/');
        if (aLog && bLog)
          return b.mtime.localeCompare(a.mtime) || b.path.localeCompare(a.path);
        if (aLog) return -1;
        if (bLog) return 1;
        return a.path.localeCompare(b.path);
      });
      return files;
    },
  );

  app.get<{ Params: { folder: string; '*': string } }>(
    '/api/file/:folder/*',
    async (req, reply) => {
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
      if (!fs.existsSync(fullPath))
        return reply.code(404).send({ error: 'File not found' });

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
      } catch {
        return reply.code(500).send({ error: 'Could not read file' });
      }

      if (filePath.endsWith('.log')) {
        const lines = content.split('\n');
        if (lines.length > 200) {
          content = lines.slice(-200).join('\n');
          truncated = true;
        }
      }
      return { content, truncated };
    },
  );

  return app;
}

export async function startUiServer(): Promise<void> {
  const app = buildUiServer();
  try {
    await app.listen({ port: UI_PORT, host: '127.0.0.1' });
    logger.info({ port: UI_PORT }, 'UI server listening');
  } catch (err) {
    logger.error({ err }, 'Failed to start UI server');
  }
}
