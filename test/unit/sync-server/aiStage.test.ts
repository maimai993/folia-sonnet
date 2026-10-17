import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { previewStageMigration } from '../../../sync-server/src/stageMigrationPreview';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from '../../../sync-server/node_modules/hono';
import { stageWriteRateLimit } from '../../../sync-server/src/aiStage';
import { aiStageRoutes, stageSchema } from '../../../sync-server/src/aiStage';
import { aiCacheRoutes } from '../../../sync-server/src/aiCache';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';
import { normalizeStageIdentity } from '../../../sync-server/src/stageIdentity';
import type { Env } from '../../../sync-server/src/app';

// test/unit/sync-server/aiStage.test.ts
const colors = { backgroundColor: '#fff', primaryColor: '#111', accentColor: '#123456', secondaryColor: '#abcdef' };
const payload = (reason = '视觉') => ({ theme: { light: { ...colors }, dark: { ...colors } }, decision: { mode: 'classic', params: {}, reason } });
const resources: { directory: string; dbs: D1Emulator[] }[] = [];
afterEach(() => { for (const resource of resources.splice(0)) { resource.dbs.forEach((db) => db.close()); rmSync(resource.directory, { recursive: true, force: true }); } });
const setup = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folia-stage-'));
  const db = new D1Emulator(join(directory, 'test.sqlite'));
  const second = new D1Emulator(join(directory, 'test.sqlite'));
  resources.push({ directory, dbs: [db, second] });
  await db.batch(stageSchema.map((query) => db.prepare(query)));
  const app = new Hono<{ Bindings: Env }>().route('/api/ai-stage', aiStageRoutes).route('/api/ai-cache', aiCacheRoutes);
  const request = (path: string, body?: unknown, auth = false, database = db, headers: Record<string, string> = {}) => app.request(path, {
    method: body ? 'PUT' : 'GET', headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: 'Bearer testing-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }, { FOLIA_SYNC_DB: database, SYNC_TOKEN: 'testing-token', AI_CACHE_VERIFY: 'off' });
  const input = (reason = '视觉') => ({ title: 'Song (Live)', artists: ['Artist'], payload: payload(reason) });
  const query = '/api/ai-stage?title=Song%20(Live)&artists=%5B%22Artist%22%5D';
  return { db, second, request, input, query };
};

describe('universal stage API with real SQLite', () => {
  it('normalizes only formatting while preserving versions and whole artist names', () => {
    const a = normalizeStageIdentity({ title: ' ＳＯＮＧ （ Live ） ', artists: [' A & B ', 'Ｃ', 'c'] });
    expect(a).toEqual(normalizeStageIdentity({ title: 'song(Live)', artists: ['c', 'a & b'] }));
    expect(a?.key).not.toBe(normalizeStageIdentity({ title: 'song', artists: ['a & b', 'c'] })?.key);
    expect(normalizeStageIdentity({ title: 'song', artists: [] })).toBeNull();
    expect(normalizeStageIdentity({ title: 'song', artists: ['a & b'] })?.key).not.toBe(normalizeStageIdentity({ title: 'song', artists: ['a', 'b'] })?.key);
  });

  it('atomically fills once across connections and returns the winning payload to every writer', async () => {
    const { request, input, second, query, db } = await setup();
    const responses = await Promise.all(Array.from({ length: 16 }, (_, index) => request('/api/ai-stage', input(String(index)), false, index % 2 ? second : db)));
    const values = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(values.map((value) => value.revision)).size).toBe(1);
    expect(new Set(values.map((value) => value.payload.decision.reason)).size).toBe(1);
    expect(values.filter((value) => value.stored)).toHaveLength(1);
    await request('/api/ai-stage', { ...input(), provider: 'kugou', mediaId: '999' });
    await request('/api/ai-stage', { ...input(), provider: 'netease', mediaId: '888' });
    const sources = await db.prepare('SELECT * FROM ai_stage_sources').all<{ confidence: string }>();
    expect(sources.results).toHaveLength(2);
    expect(sources.results?.every((source) => source.confidence === 'client_reported')).toBe(true);
    const mismatched = await request('/api/ai-stage?title=Other&artists=%5B%22Artist%22%5D&provider=kugou&mediaId=999');
    expect((await mismatched.json()).hit).toBe(false);
    const result = await request(`${query}&provider=kugou&mediaId=999`);
    expect((await result.json()).revision).toBe(values[0].revision);
    const repeat = await request('/api/ai-stage', { ...input(), payload: values[0].payload });
    expect((await repeat.json()).revision).toBe(values[0].revision);
    expect((await db.prepare('SELECT count(*) AS n FROM ai_stage_history').first<{ n: number }>())?.n).toBe(0);
  });

  it('uses ETag conditional reads and keeps missing artists separate from misses', async () => {
    const { request, input, query } = await setup();
    expect((await request('/api/ai-stage?title=Song')).status).toBe(400);
    expect((await (await request(query)).json()).hit).toBe(false);
    const value = await (await request('/api/ai-stage', input())).json();
    const response = await request(query);
    expect(response.headers.get('etag')).toBe(`"${value.revision}"`);
    const unchanged = await request(query, undefined, false, undefined, { 'If-None-Match': `W/"${value.revision}"` });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
  });

  it('requires explicit authorization and current base revision; keeps bounded restorable history', async () => {
    const { request, input, query } = await setup();
    let current = await (await request('/api/ai-stage', input())).json();
    expect((await request('/api/ai-stage/replace', { ...input('new'), baseRevision: current.revision })).status).toBe(401);
    expect((await request('/api/ai-stage/replace', input('new'), true)).status).toBe(400);
    const old = current;
    for (let index = 0; index < 12; index++) {
      current = await (await request('/api/ai-stage/replace', { ...input(String(index)), baseRevision: current.revision }, true)).json();
      expect(current.stored).toBe(true);
    }
    expect((await request('/api/ai-stage/replace', { ...input('stale'), baseRevision: old.revision }, true)).status).toBe(409);
    const same = await (await request('/api/ai-stage/replace', { ...input('11'), baseRevision: current.revision }, true)).json();
    expect(same.revision).toBe(current.revision);
    const historyPath = query.replace('/api/ai-stage?', '/api/ai-stage/history?');
    expect((await request(historyPath)).status).toBe(401);
    const history = await (await request(historyPath, undefined, true)).json();
    expect(history.history).toHaveLength(10);
    const restored = await (await request('/api/ai-stage/replace', { ...input(), payload: history.history[0].payload, baseRevision: current.revision }, true)).json();
    expect(restored.payload).toEqual(history.history[0].payload);
    expect(restored.revision).not.toBe(history.history[0].revision);
  });

  it('allows only one authorized concurrent replacement of the same base revision', async () => {
    const { request, input, db, second } = await setup();
    const original = await (await request('/api/ai-stage', input())).json();
    const responses = await Promise.all([db, second].map((connection, index) => request('/api/ai-stage/replace', { ...input(`replace-${index}`), baseRevision: original.revision }, true, connection)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await db.prepare('SELECT count(*) AS n FROM ai_stage_history').first<{ n: number }>())?.n).toBe(1);
  });

  it('rejects incomplete colors, bad modes, unknown/out of range params, malformed and UTF8 oversized payloads', async () => {
    const { request, input } = await setup();
    const bad: unknown[] = [{}, { theme: {} }, { ...payload(), decision: { mode: 'unknown', params: {} } },
      { ...payload(), decision: { mode: 'classic', params: { unknown: true } } },
      { ...payload(), decision: { mode: 'classic', params: { wordSpacing: 3 } } },
      { ...payload(), decision: { mode: 'classic', params: { enableWordRotation: 'true' } } },
      { ...payload(), theme: { light: colors, dark: { ...colors, accentColor: 'red;foo' } } },
      { ...payload(), large: '汉'.repeat(23000) }];
    for (const value of bad) expect((await request('/api/ai-stage', { ...input(), payload: value })).status).toBe(400);
    expect((await request('/api/ai-stage', { ...input(), payload: { ...payload(), large: 'x'.repeat(90000) } })).status).toBe(413);
  });

  it('protects existing legacy entries against public overwrite', async () => {
    const { db, request } = await setup();
    await db.prepare(`CREATE TABLE ai_cache (kind TEXT, cache_key TEXT, payload_json TEXT, payload_bytes INTEGER, song_title TEXT, provider TEXT, model TEXT, platform TEXT, hits INTEGER, created_at TEXT, updated_at TEXT, PRIMARY KEY(kind,cache_key))`).run();
    const path = '/api/ai-cache/stage/0123456789abcdef0123456789abcdef';
    await request(path, { payload: payload('first') });
    const response = await request(path, { payload: payload('late') });
    const value = await response.json();
    expect(value.entry.payload.decision.reason).toBe('first');
    expect(value.stored).toBe(false);
  });

  it('previews only explicit identity and exact current content without database writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'folia-preview-'));
    const filename = join(directory, 'legacy.sqlite');
    const db = new D1Emulator(filename);
    resources.push({ directory, dbs: [db] });
    await db.prepare('CREATE TABLE ai_cache (kind TEXT, cache_key TEXT, payload_json TEXT)').run();
    const key = '0123456789abcdef0123456789abcdef';
    await db.prepare('INSERT INTO ai_cache VALUES (?, ?, ?)').bind('stage', key, JSON.stringify(payload())).run();
    const archive = join(directory, 'metadata.jsonl');
    writeFileSync(archive, [
      { key, title: 'Song', artists: ['Artist'], payload: payload() },
      { key, title: 'Song', payload: payload() },
      { key, title: 'Other', artists: ['Artist'], payload: payload('changed') },
    ].map((item) => JSON.stringify(item)).join('\n'));
    const before = readFileSync(filename);
    const result = await previewStageMigration(filename, archive);
    expect(result.candidates).toHaveLength(1);
    expect(result.counts.missingIdentity).toBe(1);
    expect(result.counts.contentMismatch).toBe(1);
    expect(readFileSync(filename)).toEqual(before);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM ai_cache').first<{ n: number }>())?.n).toBe(1);
  });

  it('bounds anonymous public writes without trusting forged forwarding headers', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', stageWriteRateLimit);
    app.put('/', (c) => c.json({ ok: true }));
    let response: Response | undefined;
    for (let index = 0; index < 121; index++) response = await app.request('/', { method: 'PUT', headers: { 'X-Forwarded-For': `fake-${index}` } }, { SYNC_TOKEN: 'testing-token' } as Env);
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('rolls back a failing SQLite batch', async () => {
    const { db } = await setup();
    await expect(db.batch([db.prepare('CREATE TABLE rollback_probe (id INTEGER)'), db.prepare('INSERT INTO missing_table VALUES (1)')])).rejects.toThrow();
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='rollback_probe'").first()).toBeNull();
  });
});
