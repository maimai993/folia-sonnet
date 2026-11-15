// sync-server/src/aiCacheBackups.ts
// 缓存条目的旧版与恢复：每次被覆盖之前留一份，被盖掉了能整条捞回来。
//
// 上传是公开的（没填 Key 的人也要能推），所以「有人用空数据把别人做好的那条盖掉」
// 是迟早会发生的事。校验能挡住空数据，挡不住「一份能看但很糟的主题」—— 留着旧版
// 不只是能回滚：真被盖了，管理员在这里把好的那版捞回来，比让人重新生成一遍划算得多。

import { Hono } from 'hono';
import { requireAdmin } from './admin.js';
import type { D1Database, Env } from './app.js';
import { invalidateSongTotalCache } from './aiCacheSongTotal.js';
import { rebuildTitleTokens } from './aiCacheTitleIndex.js';

/** 同一个键最多留几份旧版：够把被盖掉的那条捞回来，又不至于无限长。 */
export const MAX_CACHE_BACKUPS = 10;

const KIND_PATTERN = /^[a-z0-9_-]{1,32}$/;
const KEY_PATTERN = /^[a-f0-9]{32}$/;

export type AiCacheBackupRow = {
  id: number;
  kind: string;
  cache_key: string;
  payload_json: string;
  payload_bytes: number;
  song_title: string | null;
  provider: string | null;
  model: string | null;
  platform: string | null;
  hits: number;
  created_at: string;
  archived_at: string;
};

/** 备份表里的一行：够管理员看清是哪一版，也能整版捞回来。 */
export const mapBackupRow = (row: AiCacheBackupRow) => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: Number(row.id ?? 0),
    kind: row.kind,
    key: row.cache_key,
    payload,
    songTitle: row.song_title ?? '',
    provider: row.provider ?? '',
    model: row.model ?? '',
    platform: row.platform ?? '',
    payloadBytes: Number(row.payload_bytes ?? 0),
    hits: Number(row.hits ?? 0),
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
};

/**
 * 把某一版副本捞回成当前那条 —— JSON 接口与管理页面共用这一份。
 *
 * 先把**现在这条**也存进备份再覆盖：万一捞错了还能再捞回来，不会把当前版本弄丢。
 * 这一版捞回来之后自己就没必要留着了，删掉。
 *
 * `invalidateSongTotal` 是 /songs 总数缓存的失效钩子：捞回来的那条可能带着一个当前
 * 库里已经没有的歌名，不通知的话那个数最长会陈旧一个 TTL。
 */
export const restoreCacheBackup = async (
  db: D1Database,
  id: number,
  invalidateSongTotal: (db: D1Database) => void,
): Promise<{ ok: true; kind: string; key: string } | { ok: false; error: string; status: 400 | 404 }> => {
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'invalid_id', status: 400 };
  }
  const now = new Date().toISOString();
  // Resolve and consume the target inside one transaction; a missing target makes every write a no-op.
  const results = await db.batch([
    db.prepare('SELECT kind, cache_key FROM ai_cache_backups WHERE id = ?').bind(id),
    db.prepare(`
      INSERT INTO ai_cache_backups
        (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at)
      SELECT current.kind, current.cache_key, current.payload_json, current.payload_bytes,
        current.song_title, current.provider, current.model, current.platform, current.hits, current.created_at, ?
      FROM ai_cache AS current
      JOIN ai_cache_backups AS target ON target.kind = current.kind AND target.cache_key = current.cache_key
      WHERE target.id = ?
    `).bind(now, id),
    db.prepare(`
      DELETE FROM ai_cache_backups
      WHERE (kind, cache_key) = (SELECT kind, cache_key FROM ai_cache_backups WHERE id = ?)
        AND id <> ?
        AND id NOT IN (
          SELECT id FROM ai_cache_backups
          WHERE (kind, cache_key) = (SELECT kind, cache_key FROM ai_cache_backups WHERE id = ?)
            AND id <> ?
          ORDER BY archived_at DESC, id DESC
          LIMIT ?
        )
    `).bind(id, id, id, id, MAX_CACHE_BACKUPS),
    db.prepare(`
      INSERT INTO ai_cache (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at)
      SELECT kind, cache_key, payload_json, COALESCE(payload_bytes, 0), COALESCE(song_title, ''),
        COALESCE(provider, ''), COALESCE(model, ''), COALESCE(platform, ''), COALESCE(hits, 0), COALESCE(created_at, ?), ?
      FROM ai_cache_backups WHERE id = ?
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        song_title = excluded.song_title,
        provider = excluded.provider,
        model = excluded.model,
        platform = excluded.platform,
        updated_at = excluded.updated_at
    `).bind(now, now, id),
    db.prepare('DELETE FROM ai_cache_backups WHERE id = ?').bind(id),
  ]);
  const row = (results[0] as { results?: { kind: string; cache_key: string }[] }).results?.[0];
  if (!row) return { ok: false, error: 'not_found', status: 404 };
  /*
   * 倒排索引在事务之后重建：token 是 JS 算出来的，SQL 里编不出来。
   * 从主表读回刚恢复的歌名（而不是从备份表的入参拼），保证和主表一致。
   */
  await rebuildTitleTokens(db, row.kind, row.cache_key);
  invalidateSongTotal(db);
  return { ok: true, kind: row.kind, key: row.cache_key };
};

/*
 * Admin: `/admin/api/ai-cache-backups/...` —— 每次被覆盖之前的那一版。
 *
 * `invalidateSongTotal` 与 `restoreCacheBackup` 同一个用途（见那里的说明）。
 */
export const buildAdminCacheBackupRoutes = (
  invalidateSongTotal: (db: D1Database) => void,
) => {
  const routes = new Hono<{ Bindings: Env }>();
  routes.use('*', requireAdmin);

  /** GET /admin/api/ai-cache-backups/:kind/:key —— 这个键留下来的旧版，新的在前。 */
  routes.get('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!KIND_PATTERN.test(kind) || !KEY_PATTERN.test(key)) {
      return c.json({ ok: false, error: 'invalid_key' }, 400);
    }
    const rows = await c.env.FOLIA_SYNC_DB
      .prepare('SELECT id, kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at FROM ai_cache_backups WHERE kind = ? AND cache_key = ? ORDER BY archived_at DESC, id DESC')
      .bind(kind, key)
      .all<AiCacheBackupRow>();
    return c.json({
      ok: true,
      limit: MAX_CACHE_BACKUPS,
      backups: (rows.results ?? []).map(mapBackupRow),
    });
  });

  /*
   * POST /admin/api/ai-cache-backups/:id/restore —— 把某一版捞回成当前那条。
   *
   * 接口与页面共用同一个 `restoreCacheBackup`；这里只负责把结果说成 JSON。
   */
  routes.post('/:id/restore', async (c) => {
    const id = Number.parseInt(String(c.req.param('id') || ''), 10);
    const result = await restoreCacheBackup(c.env.FOLIA_SYNC_DB, id, invalidateSongTotal);    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, restored: id });
  });

  return routes;
};

/*
 * 挂到 `app` 上的实例。
 *
 * 直接在这里构造好、以一个具名导出交给 app.ts，而不是让它去调工厂：契约提取脚本
 * 按 `app.route('前缀', 标识符)` 回溯 import 表，一个现成的实例它认得出来。
 * 总数缓存的失效钩子在这里就绑好，调用方不必关心。
 */
export const adminCacheBackupRoutes = buildAdminCacheBackupRoutes(invalidateSongTotalCache);
