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

// 相对本模块自身地址推导：dev 里是 vite 根下的 /mods/builtin/lizi-stages/stages/，
// 打包后页面走 file:///…/dist/index.html，站根绝对地址会落到磁盘根，这里跟着 client.mjs 走。
const BASE = new URL('./stages/', import.meta.url).href;
const TICK_MS = 66;      // LIZI pushed tick at ~15 Hz; pages interpolate themselves
const LIVE_MS = 125;     // ~8 Hz, same as LIZI's own throttle
const BEAT_GAP_MS = 180; // floor between synthetic beats
const BEAT_LEVEL = 0.42; // power above this counts as a beat

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

/** Characters of one word, each with its own start time, evenly spread over the word. */
function wordChars(word, fallbackStart) {
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
        out.push({ c, t: +(ws + step * i).toFixed(3) });
    }
    return out;
}

/** ctx.lines (FoliumLine[]) → LIZI's { t, dur, text, chars } rows. */
function linesToLizi(lines) {
    const rows = [];
    const list = lines || [];
    for (let i = 0; i < list.length; i++) {
        const line = list[i] || {};
        const next = list[i + 1];
        const t = Number.isFinite(line.startTime) ? line.startTime : 0;
        let end = Number.isFinite(line.endTime) ? line.endTime : 0;
        if (!(end > t)) end = next && Number.isFinite(next.startTime) ? next.startTime : t + 6;
        const dur = Math.max(0.4, end - t);
        const words = line.words || [];
        let chars = [];
        for (const w of words) chars = chars.concat(wordChars(w || {}, t));
        rows.push({
            t: +t.toFixed(3),
            dur: +dur.toFixed(3),
            text: String(line.fullText || ''),
            chars: chars.length ? chars : null,
        });
    }
    return rows;
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
        lines: linesToLizi(ctx.lines),
        duration: ctx.getDuration ? (ctx.getDuration() || 0) : 0,
    };
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
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000;'
        + 'contain:strict;touch-action:manipulation';
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
        const el = document.createElement('iframe');
        el.title = `LIZI ${entry.name}`;
        el.setAttribute('scrolling', 'no');
        el.setAttribute('allow', 'autoplay');
        el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'
            + 'background:#000;display:block';
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
            const now = ts || performance.now();
            if (ready && now - lastTick >= TICK_MS) {
                lastTick = now;
                const time = ctx.lyricTime ? ctx.lyricTime.get() : 0;
                post('tick', { time, playing: !(ctx.isPaused && ctx.isPaused()) });
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
            if (ready && now - lastLive >= LIVE_MS) {
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
                    playing: !(ctx.isPaused && ctx.isPaused()),
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
