import { Hono } from 'hono';
import { isoMinutesAgo, pruneHitLog } from './aiCache.js';
import { readFontStats } from './fonts.js';
import type { D1Database, Env } from './app.js';

// src/statsImage.ts
// `GET /admin/api/stats.svg` — 一张把云缓存概况画出来的图。
//
// 要它能直接塞进 `<img>`（面板、README、群聊里甩一张图），所以返回的是**图**而不是
// JSON：浏览器拿 Content-Type 就能渲染，不用再写一遍前端。
//
// 选 SVG 而不是 PNG：仓库里没有栅格化依赖，也不需要 —— 曲线是直的、文字是文字，
// 矢量既清晰又小。代价是中文字形由看图那一侧的系统字体决定，所以字体栈里要把
// 中日韩字体都列上（见 FONT_STACK）。
//
// 需要登录：图里有条目数量、库大小这类内部数字，跟面板同一道门。同源的 `<img>`
// 会带上会话 cookie，所以直接嵌就行。

const WIDTH = 780;
const HEIGHT = 690;
const PADDING = 28;

/* 中日韩字体列全：渲染端多半是台没有中文字体的机器，漏一个就会掉成方框。 */
const FONT_STACK = "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC','WenQuanYi Micro Hei',system-ui,-apple-system,'Segoe UI',sans-serif";

const MONO_STACK = "ui-monospace,SFMono-Regular,'SF Mono',Consolas,'Liberation Mono',monospace";

const COLORS = {
    card: 'rgba(255,255,255,0.05)',
    line: 'rgba(255,255,255,0.10)',
    text: '#f4f4f6',
    muted: '#9aa3b2',
    accent: '#8b5cf6',
    accentSoft: 'rgba(139,92,246,0.22)',
};

type HitLogRow = {
    kind: string;
    cache_key: string;
    song_title: string | null;
    at: string;
};

export interface CacheOverview {
    entryCount: number;
    payloadBytes: number;
    totalHits: number;
    recentHits: number;
    recentMinutes: number;
    hourly: { hour: string; label: string; count: number }[];
    latest: HitLogRow[];
    fontCount: number;
    fontBytes: number;
    databaseBytes: number | null;
}

const escapeXml = (value: unknown): string => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/* 只留前 8 位：全 32 位太长，认条目用不着，也更省得把整串指纹摊在截图里。 */
const shortKey = (value: unknown): string => String(value ?? '').slice(0, 8) || '—';

const formatBytes = (value: number): string => {
    const size = Math.max(0, Number(value) || 0);
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
};

const clampMinutes = (value: unknown): number => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 5;
    return Math.min(1440, Math.max(1, parsed));
};

/**
 * 图上所有钟点都按 **UTC+8** 画。
 *
 * 存的是 UTC，画的是 UTC（还特意标了「UTC」）—— 可看这张图的人在北京时间里，
 * 图上写 02:13 而自己手机上是 10:13，「时间不对」就是从这儿来的。写死一个固定偏移
 * 而不是服务器本地时区：这个服务可能跑在任何机器上，跟着机器走反而更对不上。
 */
const DISPLAY_OFFSET_MS = 8 * 60 * 60 * 1000;

const displayParts = (at: Date): { yyyy: string; MM: string; dd: string; hh: string; mm: string; ss: string } => {
    const shifted = new Date(at.getTime() + DISPLAY_OFFSET_MS);
    const pad = (entry: number) => String(entry).padStart(2, '0');
    return {
        yyyy: String(shifted.getUTCFullYear()),
        MM: pad(shifted.getUTCMonth() + 1),
        dd: pad(shifted.getUTCDate()),
        hh: pad(shifted.getUTCHours()),
        mm: pad(shifted.getUTCMinutes()),
        ss: pad(shifted.getUTCSeconds()),
    };
};

const formatClock = (date: Date): string => {
    const { hh, mm } = displayParts(date);
    return `${hh}:${mm}`;
};

/** 按**显示时区**的小时分桶用的键：`YYYY-MM-DDTHH`。 */
const hourKeyOf = (at: Date): string => {
    const { yyyy, MM, dd, hh } = displayParts(at);
    return `${yyyy}-${MM}-${dd}T${hh}`;
};

/*
 * 最近 24 个小时桶，老的在前。
 *
 * 分桶用的键与图上标的钟点同一套（UTC+8）：原来键按 UTC 取、标签按 UTC 画，虽然一致，
 * 但看的人在自己的时区里对不上（见 displayParts 那条注释）。
 *
 * 分桶现在在 SQL 里做（见 `readCacheOverview`）：原来是把 24 小时里的命中流水**整批**
 * 取回 Node 再逐条 `Date.parse` 分桶 —— 命中一多就是几十万行，而 better-sqlite3 是同步的，
 * 这几百毫秒里整个进程都在等它。现在进到这里的是「一行一个钟点」的 24 行。
 */
const buildHourlyBuckets = (rows: readonly { at: string }[]): CacheOverview['hourly'] => {
    const counts = new Map<string, number>();
    rows.forEach((row) => {
        const parsed = Date.parse(String(row.at ?? ''));
        if (!Number.isFinite(parsed)) return;
        const key = hourKeyOf(new Date(parsed));
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    const now = Date.now();
    const buckets: CacheOverview['hourly'] = [];
    for (let offset = 23; offset >= 0; offset -= 1) {
        const at = new Date(now - offset * 60 * 60 * 1000);
        const key = hourKeyOf(at);
        buckets.push({
            hour: key,
            label: formatClock(at),
            count: counts.get(key) ?? 0,
        });
    }
    return buckets;
};

/*
 * 三个数字来自三个不同的窗口，别混着查：
 *  · 累计命中 —— 全表累加器，看总量；
 *  · 最近 N 分钟 —— 短窗口，看「现在还有没有人在用」；
 *  · 24 小时分桶 —— 画分布图用。
 * 前两个共用一个查询会算错，第三个覆盖了前两个的时间范围却要给图用。
 */
export const readCacheOverview = async (
    db: D1Database,
    options: { recentMinutes?: unknown; databaseBytes?: number | null } = {},
): Promise<CacheOverview> => {
    const recentMinutes = clampMinutes(options.recentMinutes);

    const [entries, recent, daily, latest, fonts] = await Promise.all([
        db
            .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes, COALESCE(SUM(hits), 0) AS hits FROM ai_cache')
            .first<{ count: number; bytes: number; hits: number }>(),
        db
            // 阈值要和 `at`（ISO 串）同一种写法，否则字符串比较会把「当天更早的」也算进来 ——
            // 于是 5 分钟和 24 小时出来是同一个数。见 aiCache.ts 的 isoMinutesAgo。
            .prepare(`SELECT COUNT(*) AS count FROM ai_cache_hits WHERE at >= ${isoMinutesAgo(-recentMinutes)}`)
            .first<{ count: number }>(),
        db
            /*
             * 24 小时分桶直接在 SQL 里数，一条给一行：`substr(at, 1, 13)` 就是
             * `YYYY-MM-DDTHH`，跟 `hourKeyOf` 的键长得一样。24 小时里有几十万次命中时，
             * 原来那条 `SELECT ... ORDER BY at DESC` 要把它们一条条搬回 Node 再数。
             */
            .prepare(
                `SELECT substr(at, 1, 13) AS hour, COUNT(*) AS count
                 FROM ai_cache_hits
                 WHERE at >= ${isoMinutesAgo(-24 * 60)}
                 GROUP BY hour
                 ORDER BY hour ASC`,
            )
            .all<{ hour: string; count: number }>(),
        db
            .prepare('SELECT kind, cache_key, song_title, at FROM ai_cache_hits ORDER BY id DESC LIMIT 5')
            .all<HitLogRow>(),
        readFontStats(db),
    ]);

    return {
        entryCount: Number(entries?.count ?? 0),
        payloadBytes: Number(entries?.bytes ?? 0),
        totalHits: Number(entries?.hits ?? 0),
        recentHits: Number(recent?.count ?? 0),
        recentMinutes,
        /*
         * 一行一个钟点：把 `hour` 摆成 `at` 的样子（`YYYY-MM-DDTHH:00:00`）再交给
         * `buildHourlyBuckets`，分桶逻辑与图上标签仍然只有那一份。
         */
        hourly: buildHourlyBuckets((daily?.results ?? []).map((row) => ({ at: `${row.hour}:00:00` }))),
        latest: latest?.results ?? [],
        fontCount: fonts.fontCount,
        fontBytes: fonts.fontBytes,
        databaseBytes: options.databaseBytes ?? null,
    };
};

const statCard = (x: number, y: number, width: number, label: string, value: string): string => `
  <g>
    <rect x="${x}" y="${y}" width="${width}" height="62" rx="10" fill="${COLORS.card}" stroke="${COLORS.line}" />
    <text x="${x + 14}" y="${y + 26}" fill="${COLORS.muted}" font-family="${FONT_STACK}" font-size="11">${escapeXml(label)}</text>
    <text x="${x + 14}" y="${y + 48}" fill="${COLORS.text}" font-family="${MONO_STACK}" font-size="18" font-weight="600">${escapeXml(value)}</text>
  </g>`;

/** 最近 24 小时的柱状图。没有命中时画一条基线，别让图变成一片空白。 */
const hourlyChart = (
    x: number,
    y: number,
    width: number,
    height: number,
    buckets: readonly CacheOverview['hourly'][number][],
): string => {
    const axisY = y + height - 18;
    const plotHeight = height - 40;
    const peak = Math.max(1, ...buckets.map((bucket) => bucket.count));
    const slot = width / buckets.length;
    const barWidth = Math.max(4, slot * 0.62);

    const bars = buckets.map((bucket, index) => {
        const ratio = bucket.count / peak;
        const barHeight = bucket.count > 0 ? Math.max(2, Math.round(plotHeight * ratio)) : 0;
        const barX = x + index * slot + (slot - barWidth) / 2;
        const barY = axisY - barHeight;
        return `<rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${bucket.count > 0 ? COLORS.accent : COLORS.accentSoft}" />`;
    }).join('');

    const labels = buckets.map((bucket, index) => {
        // 每 3 小时标一个刻度：24 个全标会挤成一团。
        if (index % 3 !== 0 && index !== buckets.length - 1) return '';
        const labelX = x + index * slot + slot / 2;
        return `<text x="${labelX.toFixed(1)}" y="${axisY + 14}" fill="${COLORS.muted}" font-family="${MONO_STACK}" font-size="9" text-anchor="middle">${escapeXml(bucket.label)}</text>`;
    }).join('');

    return `
  <g>
    <text x="${x}" y="${y - 8}" fill="${COLORS.text}" font-family="${FONT_STACK}" font-size="13" font-weight="600">最近 24 小时命中分布（UTC+8）</text>
    <text x="${x + width}" y="${y - 8}" fill="${COLORS.muted}" font-family="${MONO_STACK}" font-size="10" text-anchor="end">峰值 ${escapeXml(peak)} / 小时</text>
    <line x1="${x}" y1="${axisY}" x2="${x + width}" y2="${axisY}" stroke="${COLORS.line}" stroke-width="1" />
    ${bars}
    ${labels}
  </g>`;
};

/*
 * 最近五条。
 *
 * 歌名一律截断：歌名长度没有上限，不截会把整张图撑破。按 11px 字号估一个
 * 大概的字数上限 —— 这里不需要精确排版，只要不溢出卡片。
 */
const truncate = (value: string, limit: number): string => (
    value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value
);

const latestRows = (x: number, y: number, rows: readonly HitLogRow[]): string => {
    const head = `
    <text x="${x}" y="${y}" fill="${COLORS.text}" font-family="${FONT_STACK}" font-size="13" font-weight="600">最近 5 条命中</text>
    <text x="${x}" y="${y + 16}" fill="${COLORS.muted}" font-family="${FONT_STACK}" font-size="10">时间 · 歌名 · 条目 MD5</text>`;

    if (rows.length === 0) {
        return `${head}
    <text x="${x}" y="${y + 46}" fill="${COLORS.muted}" font-family="${FONT_STACK}" font-size="11">最近还没有命中记录。</text>`;
    }

    const body = rows.map((row, index) => {
        const parsed = Date.parse(String(row.at ?? ''));
        const at = Number.isFinite(parsed)
            ? (() => {
                const parts = displayParts(new Date(parsed));
                return `${parts.MM}-${parts.dd} ${parts.hh}:${parts.mm}:${parts.ss}`;
            })()
            : '—';
        const title = String(row.song_title ?? '').trim() || '（未记录歌名）';
        return `
    <text x="${x}" y="${y + 46 + index * 22}" font-family="${FONT_STACK}" font-size="11">
      <tspan fill="${COLORS.muted}" font-family="${MONO_STACK}">${escapeXml(at)}</tspan>
      <tspan fill="${COLORS.text}">  ${escapeXml(truncate(title, 22))}</tspan>
      <tspan fill="${COLORS.muted}" font-family="${MONO_STACK}">  ${escapeXml(shortKey(row.cache_key))}</tspan>
    </text>`;
    }).join('');

    return head + body;
};

export const renderCacheOverviewSvg = (overview: CacheOverview): string => {
    const chartX = PADDING;
    const chartY = 168;
    const chartWidth = WIDTH - PADDING * 2;
    const chartHeight = 210;

    const databaseSize = overview.databaseBytes === null
        ? '不可用（Worker 无文件系统）'
        : formatBytes(overview.databaseBytes);

    const generated = (() => {
        const parts = displayParts(new Date());
        return `${parts.yyyy}-${parts.MM}-${parts.dd} ${parts.hh}:${parts.mm}:${parts.ss}`;
    })();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Folia 云缓存概况">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#12121a" />
      <stop offset="100%" stop-color="#08080c" />
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" rx="18" />
  <g>
    <text x="${PADDING}" y="58" fill="${COLORS.text}" font-family="${FONT_STACK}" font-size="22" font-weight="700">Folia 云缓存概况</text>
    <text x="${PADDING}" y="80" fill="${COLORS.muted}" font-family="${FONT_STACK}" font-size="12">AI 主题 + AI 导演 · 按歌词文件 MD5 共享</text>
    <text x="${WIDTH - PADDING}" y="80" fill="${COLORS.muted}" font-family="${MONO_STACK}" font-size="11" text-anchor="end">生成于 ${escapeXml(generated)} UTC+8</text>
  </g>
  <g>
    ${statCard(PADDING, 104, 172, '累计命中', String(overview.totalHits))}
    ${statCard(PADDING + 184, 104, 172, `最近 ${overview.recentMinutes} 分钟`, String(overview.recentHits))}
    ${statCard(PADDING + 368, 104, 172, '缓存条目', String(overview.entryCount))}
    ${statCard(PADDING + 552, 104, 172, '数据库大小', databaseSize)}
  </g>
  ${hourlyChart(chartX, chartY, chartWidth, chartHeight, overview.hourly)}
  ${latestRows(PADDING, 452, overview.latest)}
</svg>`;
};

/*
 * `GET /admin/api/stats.svg` —— 刻意不设门禁。
 *
 * 虽然挂在 /admin/api 下，但它不是管理接口：不带任何凭据、不暴露密钥，
 * 只是一张运营看的概况图（累计命中 / 最近几分钟 / 24 小时分布 / 库大小 /
 * 最近五条歌名）。要的就是能直接把 URL 打开或嵌到别处，套一层登录
 * 反而把唯一的用法堵死了。
 *
 * 所以这里**不要**加 requireAdmin —— 同前缀的字体与缓存管理接口是要的，
 * 只有这一条是例外。
 */
export const adminStatsImageRoutes = (() => {
    const routes = new Hono<{ Bindings: Env }>();

    routes.get('/stats.svg', async (c) => {
        const url = new URL(c.req.url);
        let overview: CacheOverview;
        try {
            // 顺手清掉过期流水：读是低频操作，写路径上就不必再多一条语句。
            await pruneHitLog(c.env.FOLIA_SYNC_DB);
            overview = await readCacheOverview(c.env.FOLIA_SYNC_DB, {
                recentMinutes: url.searchParams.get('minutes') ?? 5,
                databaseBytes: c.env.readDatabaseBytes?.() ?? null,
            });
        } catch (error) {
            console.error('[Stats] failed to build cache overview:', error);
            return c.json({ ok: false, error: 'stats_unavailable' }, 500);
        }
        return new Response(renderCacheOverviewSvg(overview), {
            status: 200,
            headers: {
                'Content-Type': 'image/svg+xml; charset=utf-8',
                // 概况是实时数字，别让中间层把它缓存住。
                'Cache-Control': 'no-store',
            },
        });
    });

    return routes;
})();
