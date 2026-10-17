import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import type { D1Database, Env } from './app.js';
import { normalizeStageIdentity } from './stageIdentity.js';
import { validateStagePayload } from './stagePayload.js';

// sync-server/src/aiStage.ts
// 通用歌曲公共版本：公开补缺，显式授权 CAS 替换，有限历史。
export const STAGE_HISTORY_LIMIT = 10;
export const stageSchema = [
  `CREATE TABLE IF NOT EXISTS ai_stages (
    identity_key TEXT PRIMARY KEY, title TEXT NOT NULL, artists_json TEXT NOT NULL,
    revision TEXT NOT NULL, payload_json TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT '', media_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_stage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, identity_key TEXT NOT NULL, revision TEXT NOT NULL,
    payload_json TEXT NOT NULL, payload_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_stage_sources (
    identity_key TEXT NOT NULL, provider TEXT NOT NULL, media_id TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'client_reported', first_seen_at TEXT NOT NULL,
    PRIMARY KEY (identity_key, provider, media_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_ai_stage_history_key ON ai_stage_history(identity_key, id)',
  `CREATE TRIGGER IF NOT EXISTS ai_stage_archive BEFORE UPDATE OF revision ON ai_stages
   WHEN OLD.revision <> NEW.revision BEGIN
     INSERT INTO ai_stage_history (identity_key, revision, payload_json, payload_bytes, updated_at, archived_at)
       VALUES (OLD.identity_key, OLD.revision, OLD.payload_json, OLD.payload_bytes, OLD.updated_at, NEW.updated_at);
     DELETE FROM ai_stage_history WHERE identity_key = OLD.identity_key AND id NOT IN
       (SELECT id FROM ai_stage_history WHERE identity_key = OLD.identity_key ORDER BY id DESC LIMIT ${STAGE_HISTORY_LIMIT});
   END`,
];

type StageRow = {
  identity_key: string; title: string; artists_json: string; revision: string;
  payload_json: string; payload_bytes: number; created_at: string; updated_at: string;
};
const readCurrent = (db: D1Database, key: string) => db.prepare('SELECT * FROM ai_stages WHERE identity_key = ?').bind(key).first<StageRow>();
const publicRow = (row: StageRow) => ({
  ok: true, hit: true, identityKey: row.identity_key, title: row.title, artists: JSON.parse(row.artists_json),
  revision: row.revision, payload: JSON.parse(row.payload_json), payloadBytes: row.payload_bytes,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const readIdentity = (title: unknown, artists: unknown) => {
  if (typeof title !== 'string' || title.length > 500 || !Array.isArray(artists) || artists.length > 32
    || artists.some((item) => typeof item !== 'string' || item.length > 200)) return null;
  return normalizeStageIdentity({ title, artists });
};
const parseArtists = (value: string | undefined): unknown => { try { return JSON.parse(value ?? 'null'); } catch { return null; } };
const meta = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/u.test(value));

const writeBuckets = new Map<string, { start: number; count: number }>();
// 每进程/Worker isolate 的基础资源约束；反向代理后可能共用桶，正式公网仍需边缘限流。
export const stageWriteRateLimit: import('hono').MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.method !== 'PUT') return next();
  const incoming = c.env as Env & { incoming?: { socket?: { remoteAddress?: string } } };
  const cf = (c.req.raw as Request & { cf?: unknown }).cf;
  const ip = incoming.incoming?.socket?.remoteAddress ?? (cf ? c.req.header('cf-connecting-ip') : undefined) ?? 'anonymous';
  const now = Date.now();
  for (const [key, bucket] of writeBuckets) if (now - bucket.start >= 60_000) writeBuckets.delete(key);
  if (!writeBuckets.has(ip) && writeBuckets.size >= 1024) { c.header('Retry-After', '60'); return c.json({ ok: false, error: 'rate_limited' }, 429); }
  const bucket = writeBuckets.get(ip) ?? { start: now, count: 0 };
  writeBuckets.set(ip, bucket);
  if (++bucket.count > 120) { c.header('Retry-After', '60'); return c.json({ ok: false, error: 'rate_limited' }, 429); }
  return next();
};

export const aiStageRoutes = new Hono<{ Bindings: Env }>();
aiStageRoutes.use('*', stageWriteRateLimit);
aiStageRoutes.use('*', bodyLimit({ maxSize: 80 * 1024, onError: (c) => c.json({ ok: false, error: 'request_too_large' }, 413) }));
aiStageRoutes.use('/replace', async (c, next) => bearerAuth<{ Bindings: Env }>({ token: c.env.SYNC_TOKEN })(c, next));
aiStageRoutes.use('/history', async (c, next) => bearerAuth<{ Bindings: Env }>({ token: c.env.SYNC_TOKEN })(c, next));

aiStageRoutes.get('/', async (c) => {
  const identity = readIdentity(c.req.query('title'), parseArtists(c.req.query('artists')));
  if (!identity) return c.json({ ok: false, error: 'invalid_identity' }, 400);
  const row = await readCurrent(c.env.FOLIA_SYNC_DB, identity.key);
  c.header('Cache-Control', 'no-cache');
  if (!row) return c.json({ ok: true, hit: false, identityKey: identity.key });
  const etag = `"${row.revision}"`;
  c.header('ETag', etag);
  if ((c.req.header('If-None-Match') ?? '').split(',').some((item) => item.trim().replace(/^W\//, '') === etag || item.trim() === '*')) return c.body(null, 304);
  return c.json(publicRow(row));
});

aiStageRoutes.get('/history', async (c) => {
  const identity = readIdentity(c.req.query('title'), parseArtists(c.req.query('artists')));
  if (!identity) return c.json({ ok: false, error: 'invalid_identity' }, 400);
  const rows = await c.env.FOLIA_SYNC_DB.prepare('SELECT revision, payload_json, updated_at, archived_at FROM ai_stage_history WHERE identity_key = ? ORDER BY id DESC').bind(identity.key)
    .all<{ revision: string; payload_json: string; updated_at: string; archived_at: string }>();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, identityKey: identity.key, history: (rows.results ?? []).map((row) => ({ revision: row.revision, payload: JSON.parse(row.payload_json), updatedAt: row.updated_at, archivedAt: row.archived_at })) });
});

/** 所有竞争由单条 INSERT/条件 UPDATE 裁决；历史 trigger 与替换天然同事务。 */
const writeRoutes = (replace: boolean) => async (c: import('hono').Context<{ Bindings: Env }>) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ ok: false, error: 'invalid_request' }, 400);
  const identity = readIdentity(body.title, body.artists);
  if (!identity) return c.json({ ok: false, error: 'invalid_identity' }, 400);
  const payload = validateStagePayload(body.payload);
  if (!payload) return c.json({ ok: false, error: 'invalid_payload' }, 400);
  if (!meta(body.provider, 64) || !meta(body.mediaId, 200)) return c.json({ ok: false, error: 'invalid_metadata' }, 400);
  if (replace && (typeof body.baseRevision !== 'string' || !body.baseRevision || body.baseRevision.length > 100)) return c.json({ ok: false, error: 'base_revision_required' }, 400);
  const db = c.env.FOLIA_SYNC_DB;
  const now = new Date().toISOString();
  const revision = crypto.randomUUID();
  if (replace) {
    // 相同内容也检查 baseRevision，过期授权不能冒充当前修订确认。
    const before = await readCurrent(db, identity.key);
    if (!before || before.revision !== body.baseRevision) return c.json({ ...(before ? publicRow(before) : { hit: false }), ok: false, error: 'revision_conflict' }, 409);
    if (before.payload_json === payload.json) return c.json({ ...publicRow(before), stored: false });
    await db.prepare(`UPDATE ai_stages SET revision = ?, payload_json = ?, payload_bytes = ?, provider = ?, media_id = ?, updated_at = ? WHERE identity_key = ? AND revision = ?`)
      .bind(revision, payload.json, payload.bytes, body.provider ?? '', body.mediaId ?? '', now, identity.key, body.baseRevision).run();
  } else {
    await db.prepare(`INSERT INTO ai_stages (identity_key, title, artists_json, revision, payload_json, payload_bytes, provider, media_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity_key) DO NOTHING`)
      .bind(identity.key, identity.title, JSON.stringify(identity.artists), revision, payload.json, payload.bytes, body.provider ?? '', body.mediaId ?? '', now, now).run();
  }
  const current = await readCurrent(db, identity.key);
  if (!current) return c.json({ ok: false, error: 'write_failed' }, 500);
  if (replace && current.revision !== revision) return c.json({ ...publicRow(current), ok: false, error: 'revision_conflict' }, 409);
  // 自报来源只作诊断关联；即使提交候选落败，也不获得公共覆盖权。
  if (body.provider && body.mediaId) await db.prepare(`INSERT INTO ai_stage_sources (identity_key, provider, media_id, first_seen_at)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ai_stage_sources WHERE identity_key = ?) < 64
    ON CONFLICT(identity_key, provider, media_id) DO NOTHING`)
    .bind(identity.key, body.provider, body.mediaId, now, identity.key).run();
  c.header('ETag', `"${current.revision}"`);
  return c.json({ ...publicRow(current), stored: current.revision === revision });
};
aiStageRoutes.put('/', writeRoutes(false));
aiStageRoutes.put('/replace', writeRoutes(true));
