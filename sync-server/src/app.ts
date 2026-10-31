import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import adminAuthRoutes, {
  pruneExpiredSessions,
  readAdminSession,
  requireAdmin,
  touchAdminSession,
  readAdminCredentials,
  isSameOriginAdminMutation,
  readAdminPublicOrigin,
} from './admin.js';
import { renderLoginPage, renderPanelPage } from './panel.js';
import { aiCacheRoutes, adminCacheRoutes, readCacheStats } from './aiCache.js';
import { adminCacheBackupRoutes } from './aiCacheBackups.js';
import { adminCachePages } from './adminCachePages.js';
import { adminFontRoutes, fontRoutes, readFontStats } from './fonts.js';
import { adminStatsImageRoutes } from './statsImage.js';
import { galleryApiRoutes, galleryPageRoutes } from './stageGallery.js';
import type { FontBlobStore } from './fontBlobs.js';
import { ensureAdminSessionSchema } from './adminSchema.js';
import { compareAndSetSettings, readSettingsRow, settingsConfirmation, settingsRevision } from './settingsConfirmation.js';

export type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
  run: () => Promise<unknown>;
};

export type D1Database = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<unknown[]>;
};

export type Env = {
  FOLIA_SYNC_DB: D1Database;
  SYNC_TOKEN: string;
  DASHBOARD_TOKEN?: string;
  /** Explicit panel credentials; missing/weak configuration disables admin access. */
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  /** Explicit browser origin for trusted HTTPS reverse-proxy deployments. */
  ADMIN_PUBLIC_ORIGIN?: string;
  /** Where the font bytes go. Absent means "fall back to D1". See src/fontBlobs.ts. */
  FONT_BLOBS?: FontBlobStore;
  /**
   * 上传时拿平台上的歌词原文件重算哈希这道校验的开关。设成 `off` 就只留空数据与
   * 合规那两道 —— 第三方接口整片不通时的退路。默认开着。
   */
  AI_CACHE_VERIFY?: string;
  /** Database file size in bytes; Workers have no filesystem, so this stays unset there. */
  readDatabaseBytes?: () => number | null;
};

// Bumped to 2 by the font market + AI cloud cache tables.
const SCHEMA_VERSION = 2;
const THEME_BUCKET_COUNT = 256;
const MAX_THEME_BATCH_SIZE = 500;
const MAX_THEME_BUCKET_REQUEST_SIZE = 32;
const DEFAULT_THEME_LIST_LIMIT = 500;
const MAX_THEME_LIST_LIMIT = 1000;

const hashSyncString = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const getThemeBucketId = (fingerprint: string) => hashSyncString(fingerprint) % THEME_BUCKET_COUNT;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const schemaInitializations = new WeakMap<D1Database, Promise<void>>();

const initializeSchema = async (db: D1Database) => {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS themes (
        fingerprint TEXT PRIMARY KEY,
        bucket_id INTEGER NOT NULL,
        theme_json TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS theme_buckets (
        bucket_id INTEGER PRIMARY KEY,
        count INTEGER NOT NULL,
        hash TEXT NOT NULL,
        updated_at TEXT
      )
    `),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_themes_updated_at ON themes(updated_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_themes_bucket_id ON themes(bucket_id)'),
    // Font market: metadata here, bytes in font_files / font_previews so a
    // catalogue request never has to touch a multi-megabyte blob.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS font_market (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        family TEXT NOT NULL,
        category TEXT NOT NULL,
        license TEXT,
        file_name TEXT,
        mime_type TEXT,
        file_size INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS font_files (
        font_id TEXT PRIMARY KEY,
        data BLOB NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS font_previews (
        font_id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data BLOB NOT NULL
      )
    `),
    // AI cloud cache: keyed by kind + MD5 of the lyric file.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ai_cache (
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL DEFAULT 0,
        song_title TEXT,
        provider TEXT,
        model TEXT,
        platform TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, cache_key)
      )
    `),
    /*
     * 歌名的倒排索引：`ai_cache` 里每条的 `song_title` 拆成几种 token 各存一行，
     * 于是 `POST /api/ai-cache/resolve` 的按歌名找候选不再需要 `LIKE '%…%'` 全表扫，
     * 而是按 token 精确命中走索引（实测 4 万条时 14ms → 0.03ms，且与库大小无关）。
     *
     * 冗余存 `song_title`、`updated_at` 是为了命中之后**不必回主表**就能排序截断 ——
     * 主表每行带最大 64KB 的 payload，那才是「一碰整表就慢」的根源。
     * 这张表由写入路径维护（见 aiCache.ts 的 `writeTitleTokens`），不回填历史数据：
     * 老条目靠**首次命中时补写**（见 `backfillTitleTokens`），不阻塞启动。
     */
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ai_cache_title_token (
        kind TEXT NOT NULL,
        token TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        song_title TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, token, cache_key)
      )
    `),
    /*
     * 每次被覆盖之前的那一版。
     *
     * 上传是公开的（没填 Key 的人也要能推），所以「有人用空数据把别人做好的那条盖掉」
     * 是迟早会发生的事。留着旧版不只是能回滚：真被盖了，后台还能把好的那版捞回来。
     * 每个键最多留 MAX_CACHE_BACKUPS 份，超了删最旧的 —— 缓存条目本身就不大，
     * 但同一个键被反复覆盖时不该无限长。
     */
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ai_cache_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL DEFAULT 0,
        song_title TEXT,
        provider TEXT,
        model TEXT,
        platform TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        archived_at TEXT NOT NULL
      )
    `),
    // 每次命中记一行。`ai_cache.hits` 只是个累加器，看不出「什么时候命中的」，
    // 而概况图要的正是时间分布 —— 几点到几点命中多少、最近几分钟有多少。
    // 这里只留时间戳，不记歌词、不记提示词，也不留任何凭据。
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ai_cache_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        song_title TEXT,
        at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_font_market_enabled ON font_market(enabled)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_cache_updated_at ON ai_cache(updated_at)'),
    /*
     * 命中流水只按时间读、也只按时间清（「最近 N 分钟」、24 小时分桶、七天前的那一批），
     * 而这里**原来从没建过 `at` 上的索引** —— 于是每一条这样的查询都是整表扫。
     * 命中一多，流水表就是这个库里长得最快的一张：20w 行时一条 `DELETE ... WHERE at <`
     * 要扫 56ms，每小时一次，每次都把整个进程的事件循环按在地上。
     */
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_cache_hits_at ON ai_cache_hits(at)'),
    /*
     * 管理列表的排序入口：`kind` 在最前面，带 kind 筛选时 SQL 能顺着索引取够一页就停。
     * 覆盖索引 `idx_ai_cache_kind_updated` 管的是「某个 kind 下按时间 + 只取几列」，
     * 而管理列表要的是整行的元数据列，用不上它；没有这条索引时带 kind 的列表会把
     * 整个 kind 分支取回来再排（实测 4w 行 339ms）。
     */
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_cache_kind_updated_at ON ai_cache(kind, updated_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_cache_backups_key ON ai_cache_backups(kind, cache_key, archived_at)'),
    /*
     * 覆盖索引一：按 (kind, updated_at) 排序/扫描的入口 —— 访客检索页、管理列表、
     * resolve 的模糊捞行。把 song_title、cache_key 也收进索引之后，这些查询**只扫索引
     * 就能完成过滤与排序**，不必为每一行去碰大字段 payload_json（每条最大 64KB，
     * 10w 行全表扫一次就是几个 GB 的页 —— 这是原来「扛不住」的主因）。
     * 捞到最终那几条之后，再按主键把整行（含 payload）取回来。
     */
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_cache_kind_updated ON ai_cache(kind, updated_at, song_title, cache_key)'),
    /*
     * 覆盖索引二：/songs 的 `GROUP BY song_title`。
     * SELECT 里要的每一列（updated_at/hits/cache_key/platform）都在索引里，
     * 分组与聚合全程只扫索引，不碰大字段；按 `song_title` 排序时也能顺着它取够一页就停。
     */
  ]);

  // Upgrade legacy tables before creating indexes that reference newer columns.
  for (const table of ['ai_cache', 'ai_cache_backups']) {
    const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!columns.results?.some((column) => column.name === 'platform')) {
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN platform TEXT`).run();
      } catch (error) {
        const after = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
        if (!after.results?.some((column) => column.name === 'platform')) throw error;
      }
    }
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_cache_song_group ON ai_cache(song_title, updated_at, hits, cache_key, platform)').run();
  await ensureAdminSessionSchema(db);
};

const ensureSchema = (db: D1Database): Promise<void> => {
  const pending = schemaInitializations.get(db);
  if (pending) return pending;
  const initialization = initializeSchema(db).catch((error) => {
    schemaInitializations.delete(db);
    throw error;
  });
  schemaInitializations.set(db, initialization);
  return initialization;
};

const parseThemeInput = (value: unknown) => {
  if (!isRecord(value)
    || typeof value.fingerprint !== 'string'
    || !value.fingerprint
    || typeof value.updatedAt !== 'string'
    || !isRecord(value.theme)
  ) {
    return null;
  }
  const source = value.source === 'auto' || value.source === 'fallback' || value.source === 'edited'
    ? value.source
    : 'manual';
  return { fingerprint: value.fingerprint, theme: value.theme, updatedAt: value.updatedAt, source };
};

const mapThemeRow = (row: { fingerprint: string; theme_json: string; source: string; updated_at: string }) => ({
  fingerprint: row.fingerprint,
  theme: JSON.parse(row.theme_json),
  source: row.source,
  updatedAt: row.updated_at,
});



const getThemeManifest = async (db: D1Database) => {
  const rows = await db
    .prepare('SELECT bucket_id, count, hash, updated_at FROM theme_buckets')
    .all<{ bucket_id: number; count: number; hash: string; updated_at: string | null }>();
  const buckets = Array.from({ length: THEME_BUCKET_COUNT }, (_, bucketId) => ({
    bucketId, count: 0, hash: '0', updatedAt: null as string | null,
  }));
  (rows.results ?? []).forEach((row) => {
    if (Number.isInteger(row.bucket_id) && row.bucket_id >= 0 && row.bucket_id < THEME_BUCKET_COUNT) {
      buckets[row.bucket_id] = {
        bucketId: row.bucket_id, count: Number(row.count), hash: row.hash, updatedAt: row.updated_at,
      };
    }
  });
  return { schemaVersion: SCHEMA_VERSION, bucketCount: THEME_BUCKET_COUNT, buckets };
};

const app = new Hono<{ Bindings: Env }>();

const publicCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
});
app.use('*', async (c, next) => {
  if (c.req.path === '/admin' || c.req.path.startsWith('/admin/')) {
    c.header('Cache-Control', 'no-store');
    if (!readAdminCredentials(c.env) || !readAdminPublicOrigin(c)) return c.json({ ok: false, error: 'admin_not_configured' }, 503);
    if (!isSameOriginAdminMutation(c)) return c.json({ ok: false, error: 'invalid_origin' }, 403);
    await next();
    return;
  }
  return publicCors(c, next);
});

// Token length validation middleware
app.use('*', async (c, next) => {
  if (!c.env.SYNC_TOKEN || c.env.SYNC_TOKEN.length < 8) {
    return c.json({ ok: false, error: 'SYNC_TOKEN is too weak. Must be at least 8 characters long.' }, 500);
  }
  await next();
});

// Initialize Schema
app.use('*', async (c, next) => {
  if (c.req.path !== '/') {
    await ensureSchema(c.env.FOLIA_SYNC_DB);
  }
  await next();
});

// Dashboard Route
app.get('/', async (c) => {
  const dashboardToken = c.env.DASHBOARD_TOKEN;
  const reqToken = c.req.query('token');
  
  if (!dashboardToken || reqToken !== dashboardToken) {
    return c.text('Not Found', 404);
  }

  await ensureSchema(c.env.FOLIA_SYNC_DB);

  const settingsRow = await c.env.FOLIA_SYNC_DB
    .prepare('SELECT updated_at FROM settings WHERE key = ?')
    .bind('visual')
    .first<{ updated_at: string }>();
    
  const themesRow = await c.env.FOLIA_SYNC_DB
    .prepare('SELECT MAX(updated_at) AS themesUpdatedAt, SUM(count) AS themeCount FROM theme_buckets')
    .first<{ themesUpdatedAt: string | null; themeCount: number }>();

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Folia Sync Server</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #000000;
            --dot-color: rgba(255, 255, 255, 0.1);
            --text-main: #ffffff;
            --text-muted: #94a3b8;
            --border-color: rgba(255, 255, 255, 0.1);
        }
        * { box-sizing: border-box; }
        body { 
            font-family: 'Inter', system-ui, sans-serif; 
            background-color: var(--bg-color);
            background-image: radial-gradient(var(--dot-color) 1px, transparent 1px);
            background-size: 24px 24px;
            color: var(--text-main); 
            min-height: 100vh;
            margin: 0;
            display: flex; 
            flex-direction: column;
            align-items: center;
            padding: 4rem 2rem; 
        }
        .header {
            width: 100%;
            max-width: 900px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 5rem;
        }
        .title {
            font-size: 1.5rem;
            font-weight: 700;
            margin: 0;
            letter-spacing: 0.02em;
        }
        .version-pill {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid var(--border-color);
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.875rem;
            font-weight: 500;
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            color: #cbd5e1;
        }
        .content {
            width: 100%;
            max-width: 900px;
        }
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(3, 1fr); 
            gap: 2rem; 
            align-items: center;
        }
        .stat-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            gap: 1rem;
        }
        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            color: var(--text-main);
            line-height: 1.2;
        }
        .stat-value.text-base {
            font-size: 1.25rem;
            font-weight: 600;
        }
        .stat-label {
            font-size: 0.875rem;
            color: var(--text-main);
            font-weight: 500;
            letter-spacing: 0.05em;
        }
        .footer-note {
            margin-top: 5rem;
            padding-top: 1.5rem;
            border-top: 1px dashed var(--border-color);
            font-size: 0.875rem;
            color: var(--text-muted);
            line-height: 1.6;
        }
        .footer-note code {
            background: rgba(255, 255, 255, 0.1);
            padding: 0.15rem 0.35rem;
            border-radius: 4px;
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            color: #e2e8f0;
        }
        .footer-note ul {
            margin: 0.5rem 0 0 0;
            padding-left: 1.25rem;
        }
        .footer-note li {
            margin-bottom: 0.25rem;
        }
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: 1fr; gap: 3rem; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1 class="title">Folia Sync Server</h1>
        <div class="version-pill">v1.0.0</div>
    </div>
    
    <div class="content">
        <div class="stats-grid">
            <div class="stat-item">
                <div class="stat-value">${Number(themesRow?.themeCount ?? 0)}</div>
                <div class="stat-label">已同步主题数</div>
            </div>
            <div class="stat-item">
                <div class="stat-value text-base">${themesRow?.themesUpdatedAt ? new Date(themesRow.themesUpdatedAt).toLocaleString('zh-CN') : '暂无数据'}</div>
                <div class="stat-label">主题最近更新</div>
            </div>
            <div class="stat-item">
                <div class="stat-value text-base">${settingsRow?.updated_at ? new Date(settingsRow.updated_at).toLocaleString('zh-CN') : '暂无数据'}</div>
                <div class="stat-label">设置最近更新</div>
            </div>
        </div>

        <div class="footer-note">
            如果你遗忘了 <code>SYNC_TOKEN</code> 密钥：
            <ul>
                <li><strong>Cloudflare 部署</strong>：运行 <code>wrangler secret put SYNC_TOKEN</code> 重置覆盖。</li>
                <li><strong>自托管 (Node.js)</strong>：请检查服务器的 <code>.env</code> 文件配置。</li>
            </ul>
        </div>
    </div>
</body>
</html>`;

  return c.html(html);
});

// API Routes
app.get('/health', (c) => c.json({ ok: true, schemaVersion: SCHEMA_VERSION, backend: 'hono-sync' }));

const api = new Hono<{ Bindings: Env }>();

// Protect all API routes with Bearer Auth
api.use('*', async (c, next) => {
  const auth = bearerAuth({ token: c.env.SYNC_TOKEN });
  return auth(c as any, next);
});

api.get('/state', async (c) => {
  const settingsRow = await c.env.FOLIA_SYNC_DB
    .prepare('SELECT updated_at FROM settings WHERE key = ?')
    .bind('visual')
    .first<{ updated_at: string }>();
  const themesRow = await c.env.FOLIA_SYNC_DB
    .prepare('SELECT MAX(updated_at) AS themesUpdatedAt, SUM(count) AS themeCount FROM theme_buckets')
    .first<{ themesUpdatedAt: string | null; themeCount: number }>();
  return c.json({
    schemaVersion: SCHEMA_VERSION,
    settingsUpdatedAt: settingsRow?.updated_at ?? null,
    themesUpdatedAt: themesRow?.themesUpdatedAt ?? null,
    themeCount: Number(themesRow?.themeCount ?? 0),
  });
});

api.get('/settings', async (c) => {
  const row = await c.env.FOLIA_SYNC_DB
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .bind('visual')
    .first<{ value_json: string }>();
  return c.json(row ? JSON.parse(row.value_json) : null);
});

api.get('/themes/manifest', async (c) => c.json(await getThemeManifest(c.env.FOLIA_SYNC_DB)));

api.get('/settings/confirmation', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await settingsConfirmation(await readSettingsRow(c.env.FOLIA_SYNC_DB)));
});

api.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  // Settings exports shipped as v1 even after the server's wire metadata moved to v2.
  if (!body || (body.schemaVersion !== 1 && body.schemaVersion !== SCHEMA_VERSION) || typeof body.updatedAt !== 'string' || !isRecord(body.data)) {
    return c.json({ ok: false, error: 'invalid_settings' }, 400);
  }
  if ('expectedRevision' in body) {
    c.header('Cache-Control', 'no-store');
    if (body.expectedRevision !== null && (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision))) {
      return c.json({ ok: false, error: 'invalid_revision' }, 400);
    }
    const observed = await readSettingsRow(c.env.FOLIA_SYNC_DB);
    if (await settingsRevision(observed) !== body.expectedRevision) {
      return c.json({ ok: false, error: 'settings_conflict' }, 409);
    }
    const written = await compareAndSetSettings(c.env.FOLIA_SYNC_DB, observed, body);
    if (!written) return c.json({ ok: false, error: 'settings_conflict' }, 409);
    return c.json({ ok: true, accepted: true, ...await settingsConfirmation(written) });
  }
  await c.env.FOLIA_SYNC_DB
    .prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= settings.updated_at
    `)
    .bind('visual', JSON.stringify(body), body.updatedAt)
    .run();
  
  console.log(`[Sync] Updated settings (timestamp: ${body.updatedAt})`);
  return c.json({ ok: true });
});

api.post('/themes/get', async (c) => {
  const body = await c.req.json<{ fingerprints?: unknown[] }>().catch(() => null);
  const fingerprints = Array.from(new Set((body?.fingerprints ?? []).filter((value): value is string => (
    typeof value === 'string' && Boolean(value)
  )))).slice(0, MAX_THEME_BATCH_SIZE);
  if (fingerprints.length === 0) return c.json({ themes: [] });

  const placeholders = fingerprints.map(() => '?').join(',');
  const rows = await c.env.FOLIA_SYNC_DB
    .prepare(`SELECT fingerprint, theme_json, source, updated_at FROM themes WHERE fingerprint IN (${placeholders})`)
    .bind(...fingerprints)
    .all<{ fingerprint: string; theme_json: string; source: string; updated_at: string }>();
  return c.json({ themes: (rows.results ?? []).map(mapThemeRow) });
});

api.post('/themes/put', async (c) => {
  const body = await c.req.json<{ themes?: unknown[] }>().catch(() => null);
  const themes = (body?.themes ?? []).map(parseThemeInput);
  if (themes.some(theme => !theme) || themes.length > MAX_THEME_BATCH_SIZE) {
    return c.json({ ok: false, error: 'invalid_themes' }, 400);
  }

  const validThemes = themes as NonNullable<ReturnType<typeof parseThemeInput>>[];
  if (validThemes.length === 0) {
    return c.json({ ok: true, savedCount: 0 });
  }

  const fingerprints = validThemes.map(t => t.fingerprint);
  const placeholders = fingerprints.map(() => '?').join(',');
  
  const oldRows = await c.env.FOLIA_SYNC_DB
    .prepare(`SELECT fingerprint, updated_at FROM themes WHERE fingerprint IN (${placeholders})`)
    .bind(...fingerprints)
    .all<{ fingerprint: string; updated_at: string }>();
    
  const oldThemesMap = new Map(oldRows.results?.map(r => [r.fingerprint, r.updated_at]) ?? []);
  const bucketDiffs = new Map<number, { countDelta: number; hashDelta: number; maxUpdatedAt: string }>();

  validThemes.forEach(theme => {
    const bucketId = getThemeBucketId(theme.fingerprint);
    let bucketDiff = bucketDiffs.get(bucketId);
    if (!bucketDiff) {
      bucketDiff = { countDelta: 0, hashDelta: 0, maxUpdatedAt: theme.updatedAt };
      bucketDiffs.set(bucketId, bucketDiff);
    }
    
    const oldUpdatedAt = oldThemesMap.get(theme.fingerprint);
    if (!oldUpdatedAt) {
      bucketDiff.countDelta += 1;
      bucketDiff.hashDelta ^= hashSyncString(`${theme.fingerprint}\u0000${theme.updatedAt}`);
    } else if (theme.updatedAt >= oldUpdatedAt) {
      bucketDiff.hashDelta ^= hashSyncString(`${theme.fingerprint}\u0000${oldUpdatedAt}`);
      bucketDiff.hashDelta ^= hashSyncString(`${theme.fingerprint}\u0000${theme.updatedAt}`);
    }

    if (Date.parse(theme.updatedAt) > Date.parse(bucketDiff.maxUpdatedAt)) {
       bucketDiff.maxUpdatedAt = theme.updatedAt;
    }
  });

  const batchStatements: D1PreparedStatement[] = [];

  validThemes.forEach(theme => {
    batchStatements.push(c.env.FOLIA_SYNC_DB.prepare(`
      INSERT INTO themes (fingerprint, bucket_id, theme_json, source, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        bucket_id = excluded.bucket_id,
        theme_json = excluded.theme_json,
        source = excluded.source,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= themes.updated_at
    `).bind(
      theme.fingerprint,
      getThemeBucketId(theme.fingerprint),
      JSON.stringify(theme.theme),
      theme.source,
      theme.updatedAt,
    ));
  });

  bucketDiffs.forEach((diff, bucketId) => {
    batchStatements.push(c.env.FOLIA_SYNC_DB.prepare(`
      INSERT INTO theme_buckets (bucket_id, count, hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bucket_id) DO UPDATE SET
        count = theme_buckets.count + excluded.count,
        hash = CAST(((CAST(theme_buckets.hash AS INTEGER) | CAST(excluded.hash AS INTEGER)) - (CAST(theme_buckets.hash AS INTEGER) & CAST(excluded.hash AS INTEGER))) AS TEXT),
        updated_at = MAX(theme_buckets.updated_at, excluded.updated_at)
    `).bind(
      bucketId,
      diff.countDelta,
      String(diff.hashDelta >>> 0),
      diff.maxUpdatedAt,
    ));
  });

  await c.env.FOLIA_SYNC_DB.batch(batchStatements);
  
  console.log(`[Sync] Saved ${validThemes.length} themes (batch update)`);
  return c.json({ ok: true, savedCount: validThemes.length });
});

api.post('/themes/bucket', async (c) => {
  const body = await c.req.json<{ bucketIds?: unknown[] }>().catch(() => null);
  const bucketIds = Array.from(new Set((body?.bucketIds ?? []).filter((value): value is number => (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < THEME_BUCKET_COUNT
  )))).slice(0, MAX_THEME_BUCKET_REQUEST_SIZE);
  if (bucketIds.length === 0) return c.json({ themes: [] });

  const placeholders = bucketIds.map(() => '?').join(',');
  const rows = await c.env.FOLIA_SYNC_DB
    .prepare(`
      SELECT fingerprint, theme_json, source, updated_at
      FROM themes
      WHERE bucket_id IN (${placeholders})
      ORDER BY fingerprint ASC
    `)
    .bind(...bucketIds)
    .all<{ fingerprint: string; theme_json: string; source: string; updated_at: string }>();
  return c.json({ themes: (rows.results ?? []).map(mapThemeRow) });
});

api.post('/themes/list', async (c) => {
  const body = await c.req.json<{ cursor?: unknown; limit?: unknown }>().catch(() => null);
  const cursor = typeof body?.cursor === 'string' ? body.cursor : '';
  const requestedLimit = typeof body?.limit === 'number' && Number.isFinite(body.limit)
    ? Math.trunc(body.limit)
    : DEFAULT_THEME_LIST_LIMIT;
  const limit = Math.max(1, Math.min(MAX_THEME_LIST_LIMIT, requestedLimit));
  const rows = await c.env.FOLIA_SYNC_DB
    .prepare(`
      SELECT fingerprint, theme_json, source, updated_at
      FROM themes
      WHERE fingerprint > ?
      ORDER BY fingerprint ASC
      LIMIT ?
    `)
    .bind(cursor, limit)
    .all<{ fingerprint: string; theme_json: string; source: string; updated_at: string }>();
  const themes = (rows.results ?? []).map(mapThemeRow);
  return c.json({
    themes,
    cursor: themes.length === limit ? themes[themes.length - 1].fingerprint : null,
  });
});

/*
 * The font market and the AI cloud cache sit outside the bearer gate on
 * purpose. The gate protects the theme *sync* traffic between devices that
 * share a token; these two are meant to be readable by any player, including
 * one that has never filled in an API key — that is the entire point of
 * turning the cache on by default.
 */
app.route('/api/fonts', fontRoutes);
app.route('/api/ai-cache', aiCacheRoutes);

/*
 * 访客检索：`/stage` 是搜索页，`/stage/entry/<md5>` 是详情页。
 *
 * 这两条**必须**挂在文件末尾那张 `app.route('/', api)` 兜底网之前 —— 那张网会给
 * 所有没被认领的路径套上 Bearer 校验，访客手上没有 token，挂到后面就谁也进不来。
 */
app.route('/stage', galleryPageRoutes);
app.route('/api/stage-gallery', galleryApiRoutes);

// Visual panel: /admin is the page, /admin/api/* is what it talks to.
app.route('/admin', adminAuthRoutes);
app.get('/admin', async (c) => {
  const username = await readAdminSession(c);
  if (!username) return c.html(renderLoginPage());
  await pruneExpiredSessions(c.env.FOLIA_SYNC_DB);
  await touchAdminSession(c);
  return c.html(renderPanelPage());
});
app.route('/admin/api/fonts', adminFontRoutes);
app.route('/admin/api/ai-cache', adminCacheRoutes);
/*
 * 旧版列表与「捞回某一版」。恢复之后要让 `/songs` 的总数缓存作废 —— 捞回来的那条
 * 可能带着一个当前库里已经没有的歌名（原因见 aiCacheSongTotal.ts）。
 *
 * 这里用一个包装好的模块级实例、并以**导入名**挂载：契约提取脚本（ci/contracts/extract.ts）
 * 按 `app.route('前缀', 标识符)` 回溯到 import 表，内联调用或另起局部常量它都找不到。
 */
app.route('/admin/api/ai-cache-backups', adminCacheBackupRoutes);
/*
 * 管理面板的缓存详情页面：`/admin/cache/:kind/:key`。
 *
 * 面板那张表只能把 payload 当 JSON 摊开（主题长什么样得靠人自己读色值），覆盖副本
 * 更是只有一套 JSON 接口。这里补一个能点的页面：当前这一版按访客检索页那套渲染
 * （色块 + 高亮词用本色），下面挂着被覆盖留下的旧版，点一下就捞回来。
 */
app.route('/admin/cache', adminCachePages);
// 概况图：`GET /admin/api/stats.svg`，挂在 /admin/api 下，跟面板同一道门。
app.route('/admin/api', adminStatsImageRoutes);
app.get('/admin/api/stats', requireAdmin, async (c) => {
  const [fonts, cache] = await Promise.all([
    readFontStats(c.env.FOLIA_SYNC_DB),
    readCacheStats(c.env.FOLIA_SYNC_DB),
  ]);
  return c.json({ ok: true, ...fonts, ...cache });
});

/*
 * favicon 必须挂在 `/` 那张兜底网**之前**。
 *
 * 最后那句 `app.route('/', api)` 会给所有剩下没匹配上的路径套上 bearer 校验，
 * 浏览器自动请求的 /favicon.ico 也掉进去了 —— 于是每次进后台控制台都留一条
 * 401，看着像哪儿坏了，其实只是没人认领这个请求。
 *
 * 声明了 <link rel="icon"> 之后现代浏览器多半直接取 svg，.ico 这条只是兜底。
 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="folia_gradient" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#48828E"/>
      <stop offset="1" stop-color="#B6BAF3"/>
    </linearGradient>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="120" fill="url(#folia_gradient)"/>
  <path d="M160 128 C 160 110 175 110 190 110 H 220 C 235 110 250 125 250 140 V 372 C 250 388 235 402 220 402 H 190 C 175 402 160 388 160 372 V 128 Z" fill="white"/>
  <path d="M240 110 H 340 C 380 110 400 140 400 170 C 400 200 360 200 340 200 H 250 V 110 Z" fill="white"/>
  <path d="M250 240 H 320 C 350 240 360 260 360 280 C 360 300 340 300 320 300 H 250 V 240 Z" fill="white"/>
</svg>`;

app.get('/favicon.svg', (c) => c.body(FAVICON_SVG, 200, {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': 'public, max-age=604800',
}));

app.get('/favicon.ico', (c) => c.body(null, 204, {
  'Cache-Control': 'public, max-age=604800',
}));

app.route('/', api);

export default app;
