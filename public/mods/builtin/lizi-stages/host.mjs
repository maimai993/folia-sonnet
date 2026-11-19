// mods/lizi-stages/host.mjs
// The bridge between a Folium visualizer mount and one of LIZI's single-file
// stage pages. The pages were written for LIZI's own player, where the parent
// window pushed five messages over postMessage:
//
//   init   { song, accent, lines:[{t,dur,text,chars}], duration }  (per song)
//   tick   { time, playing }                                        (~15 Hz)
//   beat   { index, level }                                         (per beat)
//   live   { bpm, level, bass, mid, treble, playing }               (~8 Hz)
//   setting{ key, value }                                           (on change)
//
// Here the same pages run inside an <iframe> and the same five messages come
// from the Folium mount context instead: ctx.lines / ctx.lyricTime / ctx.audio,
// with the page's own `ready` handshake kept as-is. Nothing inside the pages is
// modified — they keep their canvases, their settings saved in localStorage,
// their own rAF loops.

import { STAGES } from './data.mjs';

const BASE = '/mods/builtin/lizi-stages/stages/';
/*
 * 频率：LIZI 原来是 tick 15Hz / live 8Hz。安卓 WebView 里每个 postMessage 都要跨
 * 一道 iframe 边界，68 款里有不少是重 canvas，消息一密就掉帧。页面内部本来就会
 * 插值，降到 ~10Hz / ~5Hz 肉眼几乎看不出差别，却能明显减轻主线程与跨帧开销。
 */
const TICK_MS = 100;     // ~10 Hz（原 66 / 15Hz）
const LIVE_MS = 200;     // ~5 Hz（原 125 / 8Hz）
const BEAT_GAP_MS = 180; // floor between synthetic beats
const BEAT_LEVEL = 0.42; // power above this counts as a beat

/*
 * 支持拖动视角的舞台：这类页面靠 pointer/mouse 事件转镜头，iframe 必须吃指针才能拖。
 * 其余绝大多数舞台不需要指针，iframe 一律 pointer-events:none —— 否则铺满全屏的
 * iframe 会把「点屏幕隐藏控件 / 双击暂停 / 左右滑切歌」全部吃掉（见 Folia 里
 * VisualizerKinetic 的同款处理）。这些 id 是从页面源码里逐页查过拖拽监听得到的。
 */
const DRAG_STAGE_IDS = new Set([
    '012', '067', '504', '505', '510', '524', '542', '552',
    '557', '580', '582', '603', '604', '614', '617', '621',
]);

/*
 * 背景很空、适合透出 Folia 自己背景的舞台。这些页面本身不画满屏深色构图（或画得
 * 很淡），把 iframe / 页面底色变透明后能透出用户选的背景，不会露出突兀的黑块。
 * 其余页面本身就是一张满屏的深色画面，强行透明反而会破画，保持原样。
 */
export const TRANSPARENT_STAGE_IDS = new Set([
    '001', '002', '008', '010', '012', '027', '048', '099', '490', '508',
]);

const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

function rgbFromCss(css) {
    if (!css) return null;
    const m = String(css).match(/rgba?\(([^)]+)\)/i);
    if (m) {
        const parts = m[1].split(',').map((p) => parseFloat(p));
        if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
            return [Math.round(parts[0]), Math.round(parts[1]), Math.round(parts[2])];
        }
        return null;
    }
    const hex = String(css).trim().match(/^#([0-9a-f]{3,8})$/i);
    if (!hex) return null;
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length < 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Keyword color of one char: the word-color whose word contains this char. Empty when none. */
function kwColorOf(ch, wordColors) {
    if (!Array.isArray(wordColors) || !ch) return '';
    for (let i = 0; i < wordColors.length; i++) {
        const entry = wordColors[i];
        const w = String((entry && entry.word) || '');
        if (w && w.indexOf(ch) !== -1) return String(entry.color || '');
    }
    return '';
}

/** Characters of one word, each with its own start time, evenly spread over the word. */
function wordChars(word, fallbackStart, wordColors) {
    const text = String(word.text || '');
    const glyphs = Array.from(text);
    if (!glyphs.length) return [];
    const ws = Number.isFinite(word.startTime) ? word.startTime : fallbackStart;
    const we = Number.isFinite(word.endTime) ? word.endTime : ws;
    const span = Math.max(0, we - ws);
    const step = glyphs.length > 1 ? span / glyphs.length : 0;
    const out = [];
    for (let i = 0; i < glyphs.length; i++) {
        const c = glyphs[i];
        if (!c || /\s/u.test(c)) continue;
        const kw = kwColorOf(c, wordColors);
        out.push({ c, t: +(ws + step * i).toFixed(3), kw: kw ? 1 : 0, kc: kw || '' });
    }
    return out;
}

/*
 * Interlude rows. parserCore's attachInterludes inserts a placeholder row into every gap over three
 * seconds (and before the first line when singing starts after 0:03): fullText is
 * INTERLUDE_FULL_TEXT ('......') and its words are six '.'. It marks "no words here" for other code;
 * it is not a lyric anybody wrote. The stage pages find the current line by its `t`, so left alone the
 * row gets performed as a line of dots.
 *
 * The explicit `isInterlude` flag attachInterludes stamps on the row decides it (the flag survives the
 * Folium DTO projection). The text alone cannot: the pipeline deletes lines and regenerates interludes
 * with includeInterludes:true, so a real lyric that reads '......' really does reach here.
 *
 * Without the flag (a host that has not reloaded this mod, or a hand-built row) fall back to the exact
 * fingerprint: fullText is those six ASCII dots, words are exactly six '.', back to back and spanning
 * the whole line. A '......' with no words does not count — that is what a line-level lyric looks like
 * before the parser fills its words in, and swallowing it would drop real lyrics.
 */
const INTERLUDE_TEXT = '......';
const INTERLUDE_DOT_COUNT = 6;

function isInterludeLine(line) {
    if (!line) return false;
    if (line.isInterlude === true) return true;
    if (String(line.fullText) !== INTERLUDE_TEXT) return false;
    const words = Array.isArray(line.words) ? line.words : [];
    if (!words.length) return false;
    if (words.length !== INTERLUDE_DOT_COUNT) return false;
    const start = Number(line.startTime);
    const end = Number(line.endTime);
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return false;
    // Back to back with no gaps at either end: a real lyric's '.' words are never this tidy.
    const tolerance = 0.01;
    if (Math.abs(Number(words[0].startTime) - start) > tolerance) return false;
    if (Math.abs(Number(words[words.length - 1].endTime) - end) > tolerance) return false;
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (String(word.text) !== '.') return false;
        const wordStart = Number(word.startTime);
        const wordEnd = Number(word.endTime);
        if (!(Number.isFinite(wordStart) && Number.isFinite(wordEnd) && wordEnd >= wordStart)) return false;
        if (i > 0 && Math.abs(wordStart - Number(words[i - 1].endTime)) > tolerance) return false;
    }
    return true;
}

/**
 * Keep every stage's "current line" defined from time 0.
 *
 * The stages pick the current line as the last row whose `t` has passed (001 walks `while (ci + 1 <
 * lines.length && T >= lines[ci + 1].t)`, 505 binary-searches the same way). Before the first explicit
 * `t` that lookup returns -1, and the pages each do their own thing with it: 001 shows its
 * 「等待第一句…」 hint, 505 blanks `decodeTarget` (a clear screen). That happens whenever the song's
 * first line starts late, which is exactly the intro interlude case: attachInterludes inserts a
 * '......' row for any song whose singing starts after 0:03, and once that row is dropped the table
 * begins at the first sung line.
 *
 * So the first row's `t` becomes 0 and nothing else moves: during the intro the stage already shows
 * the first lyric, 001 brewing it and then forming it, and the row's own `chars` keep the lyric's
 * word timing. The text is kept on purpose — the stages treat a row whose text is empty as "no lyrics
 * at all" (001 sets `hint.style.opacity = lines.length ? … : '0.4'` while its `hint.textContent`
 * still says 这首没有歌词), so a blank first row would put 「等待第一句…」 / 「这首没有歌词」 back on
 * screen for the whole intro, which is the symptom itself.
 */
function clampFirstRow(rows) {
    if (!rows.length) return rows;
    const first = rows[0];
    if (!(first.t > 0)) return rows;
    return [{ ...first, t: 0 }, ...rows.slice(1)];
}

/** ctx.lines (FoliumLine[]) → LIZI's { t, dur, text, chars } rows. */
export function linesToLizi(lines, wordColors) {
    const list = lines || [];
    // 只有 intro 一条间奏、后面没有任何真歌词时，这首等于没歌词。
    // A lone intro interlude with nothing sung after it: this song has no lyrics.
    if (list.every((line) => isInterludeLine(line))) return [];

    // Interlude rows never become a row of their own; see isInterludeLine above.
    const rows = [];
    for (let i = 0; i < list.length; i++) {
        const line = list[i] || {};
        if (isInterludeLine(line)) continue;
        let next = null;
        let afterInterlude = false;
        for (let j = i + 1; j < list.length; j++) {
            if (isInterludeLine(list[j])) afterInterlude = true;
            else { next = list[j]; break; }
        }
        const t = Number.isFinite(line.startTime) ? line.startTime : 0;
        let end = Number.isFinite(line.endTime) ? line.endTime : 0;
        if (!(end > t)) end = next && Number.isFinite(next.startTime) ? next.startTime : t + 6;
        // 这一句和下一句歌词之间隔着间奏时，把 dur 撑到下一句真正的歌词开始：间奏期间舞台
        // 停在这一句上，不出现点，也不落回「等待第一句」。
        // An interlude between this line and the next: hold this one until the next sung line, so
        // the gap shows neither dots nor the 「等待第一句…」 hint.
        if (afterInterlude && next && Number.isFinite(next.startTime)) {
            end = Math.max(end, next.startTime);
        }
        const dur = Math.max(0.4, end - t);
        const words = line.words || [];
        let chars = [];
        for (const w of words) chars = chars.concat(wordChars(w || {}, t, wordColors));
        rows.push({
            t: +t.toFixed(3),
            dur: +dur.toFixed(3),
            text: String(line.fullText || ''),
            chars: chars.length ? chars : null,
        });
    }
    return clampFirstRow(rows);
}

function songPayload(ctx) {
    const s = ctx.song;
    if (!s) return null;
    return {
        id: s.id == null ? '' : String(s.id),
        name: s.title || '',
        album: s.album || '',
        artists: s.artist || '',
        cover: ctx.getCoverUrl ? (ctx.getCoverUrl() || '') : '',
    };
}

function initPayload(ctx) {
    const theme = (ctx.getTheme && ctx.getTheme()) || {};
    return {
        song: songPayload(ctx),
        accent: rgbFromCss(theme.accentColor) || rgbFromCss(theme.primaryColor) || [150, 165, 255],
        lines: linesToLizi(ctx.lines, theme.wordColors),
        duration: ctx.getDuration ? (ctx.getDuration() || 0) : 0,
    };
}

/**
 * 把「背景很空」的舞台页底色清成透明，透出 Folia 自己画的背景层。
 * 页面是同源的，可以直接操作 contentDocument；但每次 remount 都是新文档，
 * 所以绑在 iframe 的 load 上重复注入。只改底色，不碰页面自己的构图与动画。
 */
function makeTransparent(frame) {
    try {
        const doc = frame.contentDocument;
        if (!doc) return;
        let style = doc.getElementById('__folia_transparent');
        if (!style) {
            style = doc.createElement('style');
            style.id = '__folia_transparent';
            doc.head.appendChild(style);
        }
        style.textContent = 'html,body{background:transparent!important}'
            + 'canvas{background:transparent!important}';
    } catch { /* 跨域 / 页面尚未就绪：这次跳过，load 还会再给一次机会 */ }
}

/**
 * 可拖视角的舞台 iframe 收指针才能拖，于是它内部的点击不会冒泡到 Folia 的手势宿主。
 * 这里在 iframe 文档内注入一个轻量监听：区分「拖动」和「单击」，只有短距离、短时间的
 * 点击才转发 —— 转发方式是在父文档的手势宿主上派发一个原生 click，React 合成事件
 * 会照常收到，于是「单击隐藏控件」在这类舞台上依然可用。双击 / 左右滑按要求不做。
 */
function injectClickRelay(frame) {
    try {
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        if (!doc || !win || doc.getElementById('__folia_click_relay')) return;
        const flag = doc.createElement('script');
        flag.id = '__folia_click_relay';
        flag.textContent = `
(function () {
  var downX = 0, downY = 0, downT = 0;
  document.addEventListener('pointerdown', function (e) {
    downX = e.clientX; downY = e.clientY; downT = Date.now();
  }, true);
  document.addEventListener('pointerup', function (e) {
    var moved = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
    if (moved > 12 || Date.now() - downT > 400) return; // 拖动，不是单击
    var host = parent.document.querySelector('[data-testid="player-visual-surface"]');
    if (host) host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, true);
})();`;
        (doc.head || doc.documentElement).appendChild(flag);
    } catch { /* 注入失败就当没有：拖动照常，只是单击隐藏在这款舞台上失效 */ }
}

/**
 * Mount one stage page into `container`.
 * @param container  the element the host gave us; it is already positioned.
 * @param ctx        FoliumStageContext.
 * @param fixedStage when this mount is one stage's own style (each page is
 *                   registered as its own lyric style), the page it always
 *                   shows. Without it the `stage` setting picks the page, which
 *                   is what the older single-entry registration did.
 * @returns a disposer.
 */
export function mountLiziStage(container, ctx, fixedStage) {
    // The host gives us a box sized for the stage but not always positioned; an
    // absolute child needs a positioned ancestor, so claim that here.
    if (!container) return () => {};
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const root = document.createElement('div');
    // 根容器不画底色：默认交给 iframe 自己的页面去画；透明的舞台则由 iframe 内注入的
    // 样式把底色也清掉，透出 Folia 的背景层。root 自身不拦截指针，手势一律往下传。
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:transparent;'
        + 'contain:strict;touch-action:manipulation;pointer-events:none';
    container.appendChild(root);

    const disposers = [];
    let frame = null;
    let ready = false;
    let currentId = null;
    let lastInitSig = '';
    let lastTick = 0;
    let lastLive = 0;
    let lastBeatAt = 0;
    let beatIndex = 0;
    let shakeOff = false;
    let disposed = false;
    let readyAt = 0;
    let initResent = false;
    let initResent2 = false;

    const settings = () => (ctx.getSettings ? (ctx.getSettings() || {}) : {});

    function post(type, payload) {
        if (!frame || !frame.contentWindow) return;
        try {
            frame.contentWindow.postMessage({ __c100: 1, type, payload }, '*');
        } catch { /* the page may be mid-navigation */ }
    }

    function initSig() {
        const list = ctx.lines || [];
        const first = list[0];
        const last = list[list.length - 1];
        return [
            currentId,
            list.length,
            first ? first.startTime : 0,
            last ? last.startTime : 0,
            (ctx.song && ctx.song.id) || '',
            ctx.getCoverUrl ? (ctx.getCoverUrl() || '').length : 0,
            // 主题换色（关键词颜色跟着主题走）也要重推 init。
            ((ctx.getTheme && ctx.getTheme().wordColors) || []).length,
        ].join('|');
    }

    function pushInit() {
        const sig = initSig();
        lastInitSig = sig;
        post('init', initPayload(ctx));
    }

    function mount(id) {
        const entry = STAGES.find((s) => s.id === id) || STAGES[0];
        if (!entry) return;
        if (frame && currentId === entry.id) return;
        ready = false;
        if (frame) {
            frame.remove();
            frame = null;
        }
        currentId = entry.id;
        lastInitSig = '';
        const draggable = DRAG_STAGE_IDS.has(entry.id);
        const transparent = TRANSPARENT_STAGE_IDS.has(entry.id);
        const el = document.createElement('iframe');
        el.title = `LIZI ${entry.name}`;
        el.setAttribute('scrolling', 'no');
        el.setAttribute('allow', 'autoplay');
        el.setAttribute('allowtransparency', 'true');
        /*
         * 手势：默认 pointer-events:none，点击/双击/滑动直接穿到父层的
         * player-visual-surface，Folia 的三个手势照常工作。只有真正要拖视角的舞台
         * 才收指针（auto），这些舞台在 iframe 内注入的那段脚本会把「单击」转发出去，
         * 保证至少单击隐藏还能用（双击 / 滑动按用户要求不在这类舞台做）。
         */
        el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'
            + `background:${transparent ? 'transparent' : '#000'};display:block;`
            + `pointer-events:${draggable ? 'auto' : 'none'}`;
        if (transparent) {
            el.addEventListener('load', () => makeTransparent(el));
        }
        if (draggable) {
            el.addEventListener('load', () => injectClickRelay(el));
        }
        el.src = BASE + entry.file;
        frame = el;
        root.appendChild(el);
    }

    // The pages announce themselves with { __c100:1, type:'ready' }; LIZI sent the
    // first `init` right after that, so do the same and keep a couple of retries
    // for pages that announce before their listeners are wired.
    function onMessage(e) {
        if (disposed || !frame || e.source !== frame.contentWindow) return;
        const d = e.data;
        if (!d || d.__c100 !== 1) return;
        if (d.type === 'ready') {
            ready = true;
            readyAt = performance.now();
            initResent = false;
            initResent2 = false;
            pushInit();
            return;
        }
        if (d.type === 'request-init') pushInit();
    }
    window.addEventListener('message', onMessage);
    disposers.push(() => window.removeEventListener('message', onMessage));

    const pinned = fixedStage ? String(fixedStage) : null;
    const initial = pinned || String(settings().stage || STAGES[0].id);
    mount(initial);

    // Settings: the stage itself is swapped here; `setting` messages carry the
    // per-page toggles LIZI exposed (shake is the only one wired for every page).
    if (ctx.onChange) {
        disposers.push(ctx.onChange(() => {
            const s = settings();
            const want = pinned || String(s.stage || STAGES[0].id);
            shakeOff = s.shake === false;
            if (want !== currentId) {
                mount(want);
                return;
            }
            if (ready) post('setting', { key: 'shake', value: !shakeOff });
        }));
    }

    // Frame loop: tick at LIZI's rate, live/beat derived from the host analyser.
    if (ctx.onFrame) {
        disposers.push(ctx.onFrame((ts) => {
            if (disposed || !frame) return;
            // 页面在后台 / 宿主已暂停时不再往 iframe 灌消息：页面自己的 rAF 也该歇着，
            // 这是 68 款里不少重 canvas 最费电、最掉帧的来源。
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            const paused = Boolean(ctx.isPaused && ctx.isPaused());
            const now = ts || performance.now();
            if (ready && now - lastTick >= TICK_MS) {
                lastTick = now;
                const time = ctx.lyricTime ? ctx.lyricTime.get() : 0;
                // 暂停时仍以低频发一次 tick（带 playing:false），让页面把动画停住；
                // 其余重消息（live / beat）在暂停时一概不发。
                post('tick', { time, playing: !paused });
                const sig = initSig();
                if (sig !== lastInitSig) pushInit();
                // Pages that announce ready before wiring their listener lose the
                // first init; resend once at ~1 s and once at ~3 s, then stop.
                if (readyAt && !initResent && now - readyAt > 900) {
                    initResent = true;
                    pushInit();
                } else if (readyAt && !initResent2 && now - readyAt > 2600) {
                    initResent2 = true;
                    pushInit();
                }
            }
            if (ready && !paused && now - lastLive >= LIVE_MS) {
                lastLive = now;
                let power = 0;
                let bands = null;
                if (ctx.audio) {
                    try {
                        power = clamp01(ctx.audio.getPower() || 0);
                        bands = ctx.audio.getBands();
                    } catch { /* analyser unavailable */ }
                }
                post('live', {
                    bpm: 0,
                    level: power,
                    bass: bands ? clamp01(bands.bass) : 0,
                    mid: bands ? clamp01((bands.mid + bands.vocal) / 2) : 0,
                    treble: bands ? clamp01(bands.treble) : 0,
                    playing: true,
                });
                if (!shakeOff && power >= BEAT_LEVEL && now - lastBeatAt >= BEAT_GAP_MS) {
                    lastBeatAt = now;
                    beatIndex++;
                    post('beat', { index: beatIndex, level: power });
                } else if (now - lastBeatAt >= BEAT_GAP_MS) {
                    post('beat', { index: beatIndex, level: 0 });
                }
            }
        }));
    }

    // Resize: the pages size themselves to the viewport, so nothing to forward,
    // but a reload after a big size change keeps their layout caches honest.
    let lastW = 0;
    let lastH = 0;
    if (ctx.onResize) {
        disposers.push(ctx.onResize((size) => {
            if (!size) return;
            const w = size.width;
            const h = size.height;
            if (lastW && lastH && (Math.abs(w - lastW) > 240 || Math.abs(h - lastH) > 240)) {
                if (frame) {
                    const id = currentId;
                    frame.remove();
                    frame = null;
                    currentId = null;
                    mount(id);
                }
            }
            lastW = w;
            lastH = h;
        }));
    }

    return () => {
        if (disposed) return;
        disposed = true;
        for (const d of disposers) {
            try { d(); } catch { /* keep tearing down */ }
        }
        disposers.length = 0;
        if (frame) {
            frame.remove();
            frame = null;
        }
        root.remove();
    };
}
