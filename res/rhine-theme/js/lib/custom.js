"use strict";
// The custom colour scheme (MENU › Style › CUSTOM): the user picks the page, text and accent colour for light and for
// dark (settings "customScheme"); every other token is worked out from them the way tools/check-contrast.py derives the
// built-in schemes (the same steps between page and text as ARCHIVE). lib/tokens.js adds it to TOKENS.schemes as
// "custom". Columns UI takes its colours from a preset file: tools/build-layout.py ships templates whose colours are
// placeholders (CUSTOM_MARKS, same table), and writeCustomPresets() writes the user's colours over them byte for byte
// into <profile>\audio-archive-custom\, from where frame.js imports them like any scheme's preset.

const CUSTOM_DIR = fb.ProfilePath + "audio-archive-custom\\";
// ARCHIVE's own page, text and accent: where a new custom scheme starts
const CUSTOM_START = { light: { bg: "#eeede7", fg: "#252821", accent: "#ff7a01" }, dark: { bg: "#0b0b0b", fg: "#f2f0ea", accent: "#ff7a01" } };
const CUSTOM_KEYS = ["bg", "fg", "accent"];
const CUSTOM_DERIVED = ["fg-soft", "text-muted", "line-dim", "mark", "line-faint", "hair", "panel", "panel-hi", "case", "case-hi", "well"];
// placeholders in the templates (tools/build-layout.py CUSTOM_MARKS): r = 0xA1 + n (+ 8 for dark), g = 0xC1, b = 0xE0 / 0xE1
const CUSTOM_MARKS = { light: {}, dark: {} };
["light", "dark"].forEach((m, i) => ["bg", "fg", "fg-soft", "accent", "text-accent"].forEach((k, j) => {
    CUSTOM_MARKS[m][k] = [0xA1 + i * 8 + j, 0xC1, 0xE0 + i];
}));

const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbHex = c => "#" + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
function relLum(h) {
    const f = c => (c /= 255) <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
    const [r, g, b] = hexRgb(h);
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
}
function contrast(a, b) {
    const x = relLum(a), y = relLum(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

// one mode's full token set from its page, text and accent (ref: ARCHIVE's set of the same mode)
function deriveCustomMode(u, ref) {
    const bg = hexRgb(u.bg), fg = hexRgb(u.fg), rb = hexRgb(ref.bg), rf = hexRgb(ref.fg), t = { bg: u.bg, fg: u.fg, accent: u.accent };
    for (const k of CUSTOM_DERIVED) {
        const x = hexRgb(ref[k]), ts = [0, 1, 2].filter(i => Math.abs(rf[i] - rb[i]) > 8).map(i => (x[i] - rb[i]) / (rf[i] - rb[i]));
        const s = ts.length ? ts.reduce((a, b) => a + b, 0) / ts.length : .5;
        t[k] = rgbHex(bg.map((v, i) => v + (fg[i] - v) * s));
    }
    t["on-accent"] = contrast(t.bg, t.accent) > contrast(t.fg, t.accent) ? t.bg : t.fg;
    return t;
}

// the accent as text on the page: itself, or moved towards the text colour until it reads (tools/build-layout.py)
function textAccent(t) {
    if (contrast(t.accent, t.bg) >= 2.2) return t.accent;
    const a = hexRgb(t.accent), b = hexRgb(t.fg);
    for (let k = 1; k <= 20; k++) {
        const c = rgbHex(a.map((v, i) => v + (b[i] - v) * k / 20));
        if (contrast(c, t.bg) >= 3) return c;
    }
    return t.fg;
}

// the user's choice (settings), checked; missing parts from CUSTOM_START
function customChoice() {
    const s = getSetting("customScheme", null), out = { light: {}, dark: {} };
    for (const m of ["light", "dark"])
        for (const k of CUSTOM_KEYS) {
            const v = s && s[m] && s[m][k];
            out[m][k] = typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : CUSTOM_START[m][k];
        }
    return out;
}

// TOKENS.schemes.custom. Every scheme's page colour must be its own (the panels find the scheme in use from it), so a
// page that equals a built-in one is moved by one step of blue.
function customScheme(tokens) {
    const u = customChoice(), sc = { name: "CUSTOM" };
    for (const m of ["light", "dark"]) {
        const taken = Object.keys(tokens.schemes).filter(id => id !== "custom").map(id => tokens.schemes[id][m].bg.toLowerCase());
        let bg = u[m].bg;
        while (taken.includes(bg)) { const c = hexRgb(bg); c[2] += c[2] < 255 ? 1 : -1; bg = rgbHex(c); }
        sc[m] = deriveCustomMode(Object.assign({}, u[m], { bg }), tokens.schemes.archive[m]);
    }
    return sc;
}

// The Columns UI presets for the custom scheme (album and index preset, light and dark), from the templates. Returns
// false when a template is missing or a file cannot be written.
function writeCustomPresets(sc) {
    try {
        if (!utils.IsDirectory(CUSTOM_DIR)) utils.CreateFolder(CUSTOM_DIR);
        const ascii = s => Array.from(s, ch => ch.charCodeAt(0));
        const pairs = [];   // [from bytes, to bytes]
        for (const m of ["light", "dark"]) {
            const t = Object.assign({ "text-accent": textAccent(sc[m]) }, sc[m]);
            for (const k of Object.keys(CUSTOM_MARKS[m])) {
                const mk = CUSTOM_MARKS[m][k], v = hexRgb(t[k]);
                pairs.push([mk.concat([0]), v.concat([0])]);   // COLORREF: r, g, b, 0
                const tf = c => `$rgb(${c.map(n => String(n).padStart(3, "0")).join(",")})`;
                pairs.push([ascii(tf(mk)), ascii(tf(v))]);
            }
        }
        for (const preset of ["album", "index"])
            for (const mode of ["light", "dark"]) {
                const src = `${THEME_ROOT}columns\\preset-${preset}-custom-${mode}.fcl`;
                if (!utils.IsFile(src)) return false;
                const b = new Uint8Array(utils.ReadBinaryFile(src));
                for (const [from, to] of pairs)
                    for (let i = 0; i <= b.length - from.length; i++) {
                        let hit = true;
                        for (let j = 0; j < from.length && hit; j++) hit = b[i + j] === from[j];
                        if (hit) { b.set(to, i); i += from.length - 1; }
                    }
                utils.WriteBinaryFile(`${CUSTOM_DIR}preset-${preset}-custom-${mode}.fcl`, b);
            }
        return true;
    } catch (e) {
        console.log("audio-archive custom scheme: " + e);
        return false;
    }
}
