# Thread File Browser — Design

**Date:** 2026-02-28

## Overview

Add a file browser to the Threads tab. Clicking a thread opens a right-side panel (email-reader style) showing the group's files — `.md` documents and container `.log` files. Selecting a file renders its content inline. A VS Code button opens the folder directly.

## Layout

Two-pane split when a thread is selected:

```
┌─────────────────────┬──────────────────────────────────────────┐
│ Name  Folder  Last  │  📁 email-379031f...  [⎋ close] [↗ vscode]│
│ ──────────────────  │  ──────────────────────────────────────── │
│ ● reddit crawler    │  logs/                                    │
│   setup groups      │    container-2026-02-28T07-03.log  ← sel  │
│   social-media-mgr  │    container-2026-02-28T07-02.log         │
│   ...               │  reddit-crawler.js                        │
│                     │  ──────────────────────────────────────── │
│                     │  [log content / rendered md here]         │
└─────────────────────┴──────────────────────────────────────────┘
```

- Left pane: thread list stays visible; selected row highlighted
- Right pane: folder name + VS Code button, file tree, file content
- Right pane slides in when a thread is clicked, closes on ⎋

## File Tree

- Show only `.md`, `.log`, `.js`, `.ts`, `.json` files (exclude `node_modules/`, `email-meta.json`, `.DS_Store`)
- Group by subdirectory, `logs/` newest-first
- Display relative path from group folder root

## File Content

- `.md` files: rendered via `marked` (loaded from unpkg CDN, one `<script>` tag)
- `.log` and all other files: raw monospace, last 200 lines shown (logs can be large)
- Auto-selects the most recent `logs/*.log` file on open

## VS Code Button

`<a href="vscode://file/{absolutePath}">` — opens the group folder in VS Code.

## New API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:folder` | List files for a group folder (path, type, mtime) |
| GET | `/api/file/:folder/*` | File content (capped at 500KB) |

## Security

- Both routes validate that the resolved path stays within `groups/{folder}/`
- Path traversal (`../`) rejected with 400

## Files Changed

- `src/ui-server.ts` — add 2 routes + update HTML (two-pane layout, file tree, marked CDN)
