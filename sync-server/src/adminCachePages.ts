import { Hono } from 'hono';
import { requireAdmin } from './admin.js';
import type { D1Database, Env } from './app.js';
import { MAX_CACHE_BACKUPS, restoreCacheBackup } from './aiCacheBackups.js';
import { invalidateSongTotalCache } from './aiCacheSongTotal.js';
import {
  renderAdminBackupPage,
  renderAdminCachePage,
  renderAdminMissingPage,
  type AdminCacheItem,
} from './adminCacheView.js';

// sync-server/src/adminCachePages.ts
// 管理面板的「看一条缓存」页面 —— 主题渲染 + 覆盖副本。
//
// 面板那张表只能把 payload 当 JSON 摊开，主题长什么样全靠人自己读色值；覆盖副本更干脆
// 一套 JSON 接口了事，得手敲 URL 才看得见。这里补上一个能点的页面：当前这一版照着访客
// 检索页那样渲染（色块 + 高亮词用本色），下面挂着被覆盖留下来的旧版，点一下就能捞回来。
//
// 路由挂在 `/admin/cache` 下，整条都要管理员 —— 它读的是任何人都能推的 payload，
// 渲染也全在服务端做，但「捞回来」这件事只能管理员干。

/** 一条缓存（当前版本或副本）从库里读出来的形状。 */
type CacheRow = {
  id?: number;
  kind: string;
  cache_key: string;
  payload_json: string;
  payload_bytes: number;
  song_title: string | null;
  provider: string | null;
  model: string | null;
  platform: string | null;
  hits: number | null;
  created_at: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
};

const toItem = (row: CacheRow): AdminCacheItem => ({
  ...(typeof row.id === 'number' ? { id: row.id } : {}),
  kind: row.kind,
  key: row.cache_key,
  payloadJson: row.payload_json ?? '',
  songTitle: row.song_title ?? '',
  provider: row.provider ?? '',
  model: row.model ?? '',
  platform: row.platform ?? '',
  payloadBytes: Number(row.payload_bytes ?? 0),
  hits: Number(row.hits ?? 0),
  createdAt: row.created_at ?? '',
  ...(row.updated_at != null ? { updatedAt: row.updated_at } : {}),
  ...(row.archived_at != null ? { archivedAt: row.archived_at } : {}),
});

const CURRENT_COLUMNS = 'kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at';
const BACKUP_COLUMNS = 'id, kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at';

const html = (body: string) => new Response(body, {
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});

export const adminCachePages = (() => {
  const routes = new Hono<{ Bindings: Env }>();
  routes.use('*', requireAdmin);

  /** GET /admin/cache/:kind/:key —— 这一条现在长什么样 + 它被覆盖留下的旧版。 */
  routes.get('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/.test(kind) || !/^[a-f0-9]{32}$/.test(key)) {
      return html(renderAdminMissingPage('这个键不合法。'));
    }
    const db: D1Database = c.env.FOLIA_SYNC_DB;

    const current = await db
      .prepare(`SELECT ${CURRENT_COLUMNS} FROM ai_cache WHERE kind = ? AND cache_key = ?`)
      .bind(kind, key)
      .first<CacheRow>();

    const backups = await db
      .prepare(`SELECT ${BACKUP_COLUMNS} FROM ai_cache_backups WHERE kind = ? AND cache_key = ? ORDER BY archived_at DESC, id DESC`)
      .bind(kind, key)
      .all<CacheRow>();

    if (!current && (backups.results ?? []).length === 0) {
      return html(renderAdminMissingPage('这个键既没有内容，也没有留下副本。'));
    }

    return html(renderAdminCachePage({
      kind,
      key,
      current: current ? toItem(current) : null,
      backups: (backups.results ?? []).map(toItem),
      limit: MAX_CACHE_BACKUPS,
    }));
  });

  /** GET /admin/cache/backups/:id —— 某一版副本单独看一页。 */
  routes.get('/backups/:id', async (c) => {
    const id = Number.parseInt(String(c.req.param('id') || ''), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return html(renderAdminMissingPage('这个副本编号不合法。'));
    }
    const row = await c.env.FOLIA_SYNC_DB
      .prepare(`SELECT ${BACKUP_COLUMNS} FROM ai_cache_backups WHERE id = ?`)
      .bind(id)
      .first<CacheRow>();
    if (!row) return html(renderAdminMissingPage('没有这一版副本 —— 可能已经被捞回去了。'));

    return html(renderAdminBackupPage({ backup: toItem(row), limit: MAX_CACHE_BACKUPS }));
  });

  /*
   * POST /admin/cache/backups/:id/restore —— 表单提交的那条路。
   *
   * 页面上是整页刷新的表单（不是 fetch），捞完重定向回条目页，管理员一眼就能看到
   * 现在这一版变成了什么。JSON 那条接口（/admin/api/ai-cache-backups/...）照旧给面板用。
   */
  routes.post('/backups/:id/restore', async (c) => {
    const id = Number.parseInt(String(c.req.param('id') || ''), 10);
    const result = await restoreCacheBackup(c.env.FOLIA_SYNC_DB, id, invalidateSongTotalCache);
    if (!result.ok) return html(renderAdminMissingPage(`没捞回来：${result.error}`));
    return c.redirect(`/admin/cache/${encodeURIComponent(result.kind)}/${encodeURIComponent(result.key)}`, 303);
  });

  return routes;
})();
