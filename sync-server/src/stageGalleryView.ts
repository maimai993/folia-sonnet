// src/stageGalleryView.ts
// 云缓存对外那一面的**渲染与解析**：按歌名搜，点进去看这首歌被 AI 定成了什么样子。
//
// 缓存的键是**歌词文件的 MD5**，不是歌名 —— 歌名是推的时候顺手记在 `song_title`
// 列上的。所以检索只能走这一列：没记歌名的条目搜不到，这不是缺陷，这一面本来
// 就该只展示「知道自己在说哪首歌」的那些。
//
// 页面上出现的每一个字节都来自**任何人都能 PUT 的** payload，一律当不可信输入：
// 文本转义、颜色只认 `#hex`、词与理由都截长度。颜色尤其要卡死 —— 它们会被拼进
// `style="..."`，放过一个 `;` 就是一处注入。
//
// 这一面只读。路由与查询在 `stageGallery.ts`，这里只管把一条缓存翻成人能看的样子，
// 而且刻意不依赖 hono —— 单测要能直接引它。

export const MAX_QUERY_CHARS = 64;
export const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
const MAX_WORD_COLORS = 32;
const MAX_PARAM_ROWS = 24;
const MAX_REASON_CHARS = 400;
const MAX_NAME_CHARS = 120;
const MAX_WORD_CHARS = 24;
const MAX_DESCRIPTION_CHARS = 200;

/*
 * 模式名与一句话性格，跟 `src/services/lyricDirector/catalog.ts` 对齐。
 *
 * 服务端没有 i18n、也不该为了展示几个名字去引渲染层的模块，所以这里抄一份。
 * 加了新模式要两边一起补；认不出来的 id 退回显示 id 本身，不会白屏。
 */
const MODE_NAMES: Record<string, string> = {
  still: '静止',
  classic: '流光',
  cadenza: '心象',
  partita: '云阶',
  fume: '浮名',
  cappella: '群唱',
  tilt: '倾诉',
  claddagh: '回环',
  monet: '莫奈',
  diorama: '镜台',
  pendolo: '时计',
  sonnet: '商籁',
  tempera: '凝彩',
  lumiere: '绘光',
  hanabi: '花火',
  prompt: '提示词',
};

const MODE_HINTS: Record<string, string> = {
  still: '只有歌词文字，几乎无动画',
  classic: '逐字发光、旋转与呼吸浮动，均衡通用',
  cadenza: '大字心象、光晕与光束，情绪外放',
  partita: '分栏排版、阶梯式入场，叙事感强',
  fume: '纸张印刷质感、镜头缓慢推拉',
  cappella: '群聊气泡、表情与头像，轻松俏皮',
  tilt: '文字倾斜、裂开与换色，躁动感强',
  claddagh: '环形排布、绕环流转，浪漫',
  monet: '油画质感的歌词栏、缓慢滚动',
  diorama: '点云三维场景、镜头飞行，空间感强',
  pendolo: '钟表机械、指针与齿轮',
  sonnet: '日式 MV 分镜、相机运动与转场，电影感强',
  tempera: '印刷色块与拼贴、逐字入场',
  lumiere: '光场与烟雾、辉光崩解，华丽',
  hanabi: '花火粒子与夜空、升空绽放与拼贴，节庆感强',
  prompt: '提示词输入框风格、逐词 token 与卡拉OK进度，极客感',
};

/** 与 `src/services/themeSanitizer.ts` 同一条规则：只认 #rgb / #rrggbb。 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const FALLBACK_BACKGROUND = '#0b0b10';
const FALLBACK_PRIMARY = '#f5f5f7';

export const normalizeHexColor = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return fallback;
  const hex = trimmed.slice(1).toLowerCase();
  return hex.length === 3
    ? `#${hex.split('').map((char) => `${char}${char}`).join('')}`
    : `#${hex}`;
};

/** 色块上压什么颜色的字：按亮度在黑 / 白之间挑，别让浅色背景吃掉浅色字。 */
const pickTextColor = (background: string): string => {
  const hex = background.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#111827' : '#f8fafc';
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readText = (value: unknown, limit: number): string => (
  typeof value === 'string' ? value.trim().slice(0, limit) : ''
);

export const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export interface WordColor {
  word: string;
  color: string;
}

export interface ThemeSummary {
  name: string;
  description: string;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  secondaryColor: string;
  fontStyle: string;
  animationIntensity: string;
  wordColors: WordColor[];
}

export interface StageSummary {
  mode: string;
  modeName: string;
  modeHint: string;
  reason: string;
  params: { key: string; value: string }[];
  light: ThemeSummary | null;
  dark: ThemeSummary | null;
}

export interface GalleryEntry {
  key: string;
  songTitle: string;
  provider: string;
  model: string;
  hits: number;
  createdAt: string;
  updatedAt: string;
  stage: StageSummary;
}

const readWordColors = (value: unknown, fallback: string): WordColor[] => {
  if (!Array.isArray(value)) return [];
  const result: WordColor[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const word = readText(entry.word, MAX_WORD_CHARS);
    if (!word) continue;
    result.push({ word, color: normalizeHexColor(entry.color, fallback) });
    if (result.length >= MAX_WORD_COLORS) break;
  }
  return result;
};

const readTheme = (value: unknown): ThemeSummary | null => {
  if (!isRecord(value)) return null;
  const backgroundColor = normalizeHexColor(value.backgroundColor, FALLBACK_BACKGROUND);
  const primaryColor = normalizeHexColor(value.primaryColor, FALLBACK_PRIMARY);
  const accentColor = normalizeHexColor(value.accentColor, primaryColor);
  const secondaryColor = normalizeHexColor(value.secondaryColor, accentColor);
  return {
    name: readText(value.name, MAX_NAME_CHARS),
    description: readText(value.description, MAX_DESCRIPTION_CHARS),
    backgroundColor,
    primaryColor,
    accentColor,
    secondaryColor,
    fontStyle: readText(value.fontStyle, 16) || 'sans',
    animationIntensity: readText(value.animationIntensity, 16) || 'normal',
    /* 高亮词没有合法颜色时退回强调色 —— 词本身还是要显示，只是不再「花」。 */
    wordColors: readWordColors(value.wordColors, accentColor),
  };
};

/*
 * 动画决策有两种来处，形状不一样：模型刚答出来的 mode 与 theme 并列在顶层，
 * 缓存条目里的则已经收进 `decision`。两种都认，跟 `normalizeStagePayload` 一致。
 */
const readDecision = (payload: Record<string, unknown>): Record<string, unknown> | null => {
  const nested = payload.decision;
  const candidate = isRecord(nested) ? nested : payload;
  if (!isRecord(candidate)) return null;
  if (!readText(candidate.mode, 64)) return null;
  return candidate;
};

export const summarizePayload = (raw: string | null): StageSummary => {
  let payload: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) payload = parsed;
    } catch {
      payload = {};
    }
  }

  const theme = isRecord(payload.theme) ? payload.theme : null;
  const decision = readDecision(payload);
  const mode = decision ? readText(decision.mode, 64) : '';
  const params: { key: string; value: string }[] = [];
  if (decision && isRecord(decision.params)) {
    for (const [key, value] of Object.entries(decision.params)) {
      if (params.length >= MAX_PARAM_ROWS) break;
      const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      params.push({ key: key.slice(0, 48), value: String(rendered ?? '').slice(0, 120) });
    }
  }

  return {
    mode,
    modeName: mode ? (MODE_NAMES[mode] || mode) : '',
    modeHint: mode ? (MODE_HINTS[mode] || '') : '',
    reason: decision ? readText(decision.reason, MAX_REASON_CHARS) : '',
    params,
    light: readTheme(theme ? theme.light : null),
    dark: readTheme(theme ? theme.dark : null),
  };
};

/* ---------------------------------------------------------------- 页面外壳 */

const STYLES = `
  :root {
    --bg: #08080b;
    --panel: rgba(255,255,255,0.045);
    --panel-strong: rgba(255,255,255,0.08);
    --line: rgba(255,255,255,0.10);
    --line-soft: rgba(255,255,255,0.06);
    --text: #f4f4f6;
    --muted: #9aa3b2;
    --accent: #8b5cf6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background-color: var(--bg);
    background-image: radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px);
    background-size: 24px 24px;
    color: var(--text);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    padding: 32px 24px 64px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  .head { margin-bottom: 24px; }
  h1 { font-size: 20px; font-weight: 700; margin: 0; letter-spacing: .01em; }
  .sub { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.6; }
  a { color: #c4b5fd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 18px;
    margin-bottom: 18px;
  }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  input[type=text] {
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(255,255,255,0.05);
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  input[type=text]:focus { border-color: rgba(139,92,246,.6); }
  button {
    font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 10px;
    border: 1px solid var(--line); background: var(--panel-strong); color: var(--text);
    padding: 9px 14px; cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: transparent; color: #fff; }
  .toolbar { display: flex; gap: 8px; align-items: flex-end; }
  .toolbar .field { flex: 1; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-top: 18px; }
  .tile {
    display: block; background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 14px; color: inherit; text-decoration: none;
    transition: border-color .15s, background .15s;
  }
  .tile:hover { border-color: rgba(139,92,246,.45); background: var(--panel-strong); text-decoration: none; }
  .tile .name { font-size: 14px; font-weight: 600; line-height: 1.35; word-break: break-word; }
  .tile .meta { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 600; padding: 3px 9px;
    border-radius: 999px; background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4);
    color: #ddd6fe; margin-top: 8px;
  }
  .badge.none { background: rgba(255,255,255,.06); border-color: var(--line); color: var(--muted); }
  .dots { display: flex; gap: 4px; margin-top: 10px; }
  .dots i { width: 18px; height: 18px; border-radius: 6px; border: 1px solid rgba(255,255,255,.14); }
  .empty { color: var(--muted); font-size: 13px; padding: 24px 0; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
  .stage-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .stage-title { font-size: 22px; font-weight: 700; line-height: 1.3; word-break: break-word; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .fact { background: rgba(255,255,255,.04); border: 1px solid var(--line-soft); border-radius: 12px; padding: 10px 12px; }
  .fact span { display: block; font-size: 11px; color: var(--muted); }
  .fact b { font-size: 13px; font-weight: 600; word-break: break-all; }
  .palettes { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .palette { border-radius: 14px; padding: 16px; border: 1px solid var(--line); }
  .palette .sample { font-size: 18px; font-weight: 700; line-height: 1.4; word-break: break-word; }
  .palette .desc { font-size: 12px; margin-top: 6px; opacity: .85; line-height: 1.5; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .chip { font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 8px; }
  .chip.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 500; }
  .words { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; align-items: center; }
  .word { font-size: 15px; font-weight: 700; padding: 4px 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  .reason { font-size: 13px; line-height: 1.7; color: #e5e7eb; }
  .back { font-size: 12px; }
`;

export const page = (title: string, body: string, script = ''): string => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">${body}</div>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;

/* ------------------------------------------------------------------ 搜索页 */

const renderModeBadge = (stage: StageSummary): string => (
  stage.modeName
    ? `<span class="badge">${escapeHtml(stage.modeName)}</span>`
    : '<span class="badge none">未定动画</span>'
);

const renderSwatches = (entry: GalleryEntry): string => {
  const theme = entry.stage.light ?? entry.stage.dark;
  if (!theme) return '';
  const colors = [theme.backgroundColor, theme.primaryColor, theme.accentColor, theme.secondaryColor];
  return `<div class="dots">${colors
    .map((color) => `<i style="background:${color}"></i>`)
    .join('')}</div>`;
};

export const renderEntryTiles = (entries: readonly GalleryEntry[]): string => {
  if (entries.length === 0) {
    return '<div class="empty">没有匹配的条目。缓存条目是按歌词正文存的，歌名只是顺手记的 —— 换一个更短的关键词试试。</div>';
  }
  return `<div class="grid">${entries.map((entry) => `
    <a class="tile" href="/stage/entry/${escapeHtml(entry.key)}">
      <div class="name">${escapeHtml(entry.songTitle || '(未记歌名)')}</div>
      <div class="meta">${escapeHtml(entry.provider || '未知来源')}${entry.model ? ` · ${escapeHtml(entry.model)}` : ''}</div>
      ${renderModeBadge(entry.stage)}
      ${renderSwatches(entry)}
      <div class="meta">命中 ${escapeHtml(entry.hits)} 次 · ${escapeHtml(entry.updatedAt.slice(0, 10) || '—')}</div>
    </a>`).join('')}</div>`;
};

export const renderSearchPage = (query: string, entries: readonly GalleryEntry[]): string => page(
  'AI 舞台缓存 · 检索',
  `
  <div class="head">
    <h1>AI 舞台缓存</h1>
    <div class="sub">
      这里躺着别人已经生成好的那一份：某首歌配了什么颜色、歌词用哪种动画。<br>
      按歌名搜，点进去看细节。只读，不需要登录。
    </div>
  </div>
  <form class="card" id="search-form" method="get" action="/stage">
    <div class="toolbar">
      <div class="field">
        <label for="q">歌曲名称</label>
        <input type="text" id="q" name="q" value="${escapeHtml(query)}" placeholder="例如：晴天" autocomplete="off" autofocus>
      </div>
      <button class="primary" type="submit">搜索</button>
    </div>
  </form>
  <div id="results">${renderEntryTiles(entries)}</div>
  `,
  /*
   * 输入即搜。
   *
   * 结果片段由服务端渲染好后直接从接口取回：渲染逻辑只有一份，转义也只在服务端
   * 做一遍 —— 页面上每一个字都来自任何人都能推的 payload，这份活不能分两处做。
   *
   * 这段是**模板字符串里的内容**，TS 不会转译它 —— 别在里面写类型注解。
   */
  `
  (function () {
    var input = document.getElementById('q');
    var results = document.getElementById('results');
    var form = document.getElementById('search-form');
    if (!input || !results || !form) return;
    var timer = null;
    var last = null;
    var token = 0;
    function run() {
      var q = input.value.trim();
      if (q === last) return;
      last = q;
      var mine = ++token;
      fetch('/api/stage-gallery/search?q=' + encodeURIComponent(q) + '&limit=${DEFAULT_LIMIT}')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (mine !== token || !data || !data.ok) return;
          results.innerHTML = data.html || '';
          try {
            window.history.replaceState(null, '', q ? '/stage?q=' + encodeURIComponent(q) : '/stage');
          } catch (e) {}
        })
        .catch(function () {});
    }
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (timer) clearTimeout(timer);
      run();
    });
  })();
  `,
);

/* ------------------------------------------------------------------ 详情页 */

const renderPalette = (
  label: string,
  theme: ThemeSummary | null,
  songTitle: string,
): string => {
  if (!theme) {
    return `<div class="card"><h2>${escapeHtml(label)}</h2><div class="empty">这一条里没有${escapeHtml(label)}主题。</div></div>`;
  }
  const textColor = pickTextColor(theme.backgroundColor);
  const chips: { label: string; color: string }[] = [
    { label: '主色', color: theme.primaryColor },
    { label: '强调色', color: theme.accentColor },
    { label: '次色', color: theme.secondaryColor },
  ];

  const words = theme.wordColors.length === 0
    ? `<span class="chip" style="color:${textColor};opacity:.6">没有高亮词</span>`
    : theme.wordColors
      .map((entry) => `<span class="word" style="color:${entry.color}">${escapeHtml(entry.word)}</span>`)
      .join('');

  return `
    <div class="palette" style="background:${theme.backgroundColor};color:${textColor}">
      <div style="font-size:11px;opacity:.65">${escapeHtml(label)}</div>
      <div class="sample">${escapeHtml(songTitle || 'Folia')}</div>
      ${theme.description ? `<div class="desc">${escapeHtml(theme.description)}</div>` : ''}
      <div class="chips">
        ${chips.map((chip) => `
          <span class="chip mono" style="background:${chip.color};color:${pickTextColor(chip.color)}">${escapeHtml(chip.label)} ${escapeHtml(chip.color)}</span>
        `).join('')}
      </div>
      <div style="font-size:11px;opacity:.65;margin-top:14px">AI 标出的高亮词</div>
      <div class="words">${words}</div>
      <div style="font-size:11px;opacity:.5;margin-top:10px">
        字体 ${escapeHtml(theme.fontStyle)} · 动感 ${escapeHtml(theme.animationIntensity)}
      </div>
    </div>`;
};

/*
 * 一条缓存条目的**详情正文**：动画模式 + 主题颜色（含 AI 高亮词的本色）+ 参数表。
 *
 * 抽出来是因为管理面板也要看同一份东西 —— 而且管理面板以前只把 payload 当 JSON 摊开，
 * 主题长什么样全靠人自己读色值。渲染逻辑只留一份，转义也只在服务端做一遍。
 */
export const renderStageDetail = (entry: GalleryEntry): string => {
  const { stage } = entry;
  const paramRows = stage.params.length === 0
    ? '<div class="empty">这一条没有带动画参数。</div>'
    : `<table><thead><tr><th>参数</th><th>值</th></tr></thead><tbody>${
      stage.params
        .map((row) => `<tr><td class="mono">${escapeHtml(row.key)}</td><td class="mono">${escapeHtml(row.value)}</td></tr>`)
        .join('')
    }</tbody></table>`;

  return `
    <div class="card stage-head">
      <div>
        <div class="stage-title">${escapeHtml(entry.songTitle || '(未记歌名)')}</div>
        <div style="margin-top:8px">
          ${renderModeBadge(stage)}
          ${stage.modeHint ? `<span style="margin-left:8px;font-size:11px;color:var(--muted)">${escapeHtml(stage.modeHint)}</span>` : ''}
        </div>
      </div>
      <div class="mono" style="font-size:11px;color:var(--muted)">${escapeHtml(entry.key)}</div>
    </div>

    <div class="card">
      <h2>这首歌用了什么动画</h2>
      <div class="facts">
        <div class="fact"><span>动画模式</span><b>${escapeHtml(stage.modeName || '未定')}</b></div>
        <div class="fact"><span>模式 ID</span><b>${escapeHtml(stage.mode || '—')}</b></div>
        <div class="fact"><span>生成来源</span><b>${escapeHtml(entry.provider || '未知')}</b></div>
        <div class="fact"><span>模型</span><b>${escapeHtml(entry.model || '—')}</b></div>
        <div class="fact"><span>命中次数</span><b>${escapeHtml(entry.hits)}</b></div>
        <div class="fact"><span>更新时间</span><b>${escapeHtml(entry.updatedAt || '—')}</b></div>
      </div>
      ${stage.reason ? `<div style="margin-top:14px"><div style="font-size:11px;color:var(--muted);margin-bottom:6px">AI 的理由</div><div class="reason">${escapeHtml(stage.reason)}</div></div>` : ''}
    </div>

    <div class="card">
      <h2>主题颜色</h2>
      <div class="palettes">
        ${renderPalette('浅色', stage.light, entry.songTitle)}
        ${renderPalette('深色', stage.dark, entry.songTitle)}
      </div>
    </div>

    <div class="card">
      <h2>动画参数</h2>
      ${paramRows}
    </div>
  `;
};

export const renderDetailPage = (entry: GalleryEntry): string => page(
  `${entry.songTitle || '未记歌名'} · AI 舞台缓存`,
  `<div class="back" style="margin-bottom:16px"><a href="/stage">← 返回检索</a></div>${renderStageDetail(entry)}`,
);

export const renderMissingPage = (message: string): string => page(
  '没有这一条',
  `<div class="empty">${escapeHtml(message)}<br><br><a href="/stage">返回检索</a></div>`,
);

export const clampGalleryLimit = (requested: number): number => (
  Number.isFinite(requested) ? Math.max(1, Math.min(MAX_LIMIT, requested)) : DEFAULT_LIMIT
);
