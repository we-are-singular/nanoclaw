import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  setRegisteredGroup,
  createTask,
  storeMessage,
  storeChatMetadata,
} from './db.js';
import { buildUiServer } from './ui-server.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('UI server routes', () => {
  it('GET / returns HTML', async () => {
    const app = buildUiServer();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('nanoclaw');
  });

  it('GET /api/groups returns registered groups with last_activity', async () => {
    setRegisteredGroup('abc@email', {
      name: 'Test Group',
      folder: 'testgroup',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    });
    storeChatMetadata(
      'abc@email',
      '2024-01-01T12:00:00.000Z',
      'Test Group',
      'email',
      true,
    );

    const app = buildUiServer();
    const res = await app.inject({ method: 'GET', url: '/api/groups' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].jid).toBe('abc@email');
    expect(body[0].name).toBe('Test Group');
    expect(body[0].folder).toBe('testgroup');
    expect(body[0].last_activity).toBe('2024-01-01T12:00:00.000Z');
  });

  it('GET /api/tasks returns all tasks', async () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'email-main@email',
      prompt: 'Do something',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const app = buildUiServer();
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('task-1');
  });

  it('GET /api/messages/:jid returns latest 50 messages oldest-first', async () => {
    storeChatMetadata(
      'abc@email',
      '2024-01-01T00:02:00.000Z',
      'Test',
      'email',
      true,
    );
    storeMessage({
      id: 'm1',
      chat_jid: 'abc@email',
      sender: 'u1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'm2',
      chat_jid: 'abc@email',
      sender: 'u1',
      sender_name: 'User',
      content: 'world',
      timestamp: '2024-01-01T00:01:00.000Z',
      is_from_me: false,
    });

    const app = buildUiServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/abc@email',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].content).toBe('hello');
    expect(body[1].content).toBe('world');
  });

  it('GET /api/messages/:jid returns empty array for unknown jid', async () => {
    const app = buildUiServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/nope@nope',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});
