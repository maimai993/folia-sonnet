import { Theme } from '../../../types';

// src/components/visualizer/kinetic/jizuraCore.ts
// JIZURA 移植的底层数学：同款缓动表（01_util.js J.E）、确定性哈希随机（J.h/J.r/J.rs）、
// mulberry32 随机流（J.rng）与主题色角色提取。动画与布局共用，保证观感与参考一致。

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp01 = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number) => {
    const t = clamp01((x - a) / (b - a || 1));
    return t * t * (3 - 2 * t);
};

/** JIZURA J.E 的缓动表：recipe 的时间曲线全部来自这里，不另造缓动。 */
export const E = {
    lin: (x: number) => clamp01(x),
    inQuad: (x: number) => { const c = clamp01(x); return c * c; },
    outQuad: (x: number) => { const c = clamp01(x); return 1 - (1 - c) * (1 - c); },
    inCubic: (x: number) => { const c = clamp01(x); return c * c * c; },
    outCubic: (x: number) => 1 - Math.pow(1 - clamp01(x), 3),
    inOutCubic: (x: number) => { const c = clamp01(x); return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2; },
    outExpo: (x: number) => { const c = clamp01(x); return c >= 1 ? 1 : 1 - Math.pow(2, -10 * c); },
    inExpo: (x: number) => { const c = clamp01(x); return c <= 0 ? 0 : Math.pow(2, 10 * c - 10); },
    inOutExpo: (x: number) => {
        const c = clamp01(x);
        if (c <= 0 || c >= 1) return c;
        return c < 0.5 ? Math.pow(2, 20 * c - 10) / 2 : (2 - Math.pow(2, -20 * c + 10)) / 2;
    },
    outBack: (x: number, s = 1.9) => {
        const c = clamp01(x);
        const k = s + 1;
        return 1 + k * Math.pow(c - 1, 3) + s * Math.pow(c - 1, 2);
    },
    outElastic: (x: number) => {
        const c = clamp01(x);
        if (c === 0 || c === 1) return c;
        return Math.pow(2, -10 * c) * Math.sin((c * 10 - 0.75) * (TAU / 3)) + 1;
    },
    inOutSine: (x: number) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2,
};

/** JIZURA 的 05_anim.js drop 用到的弹跳曲线。 */
export const bounce = (x: number) => {
    const n1 = 7.5625, d1 = 2.75;
    const t = clamp01(x);
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t - 1.5 / d1) * (t - 1.5 / d1) + 0.75;
    if (t < 2.5 / d1) return n1 * (t - 2.25 / d1) * (t - 2.25 / d1) + 0.9375;
    return n1 * (t - 2.625 / d1) * (t - 2.625 / d1) + 0.984375;
};

/** JIZURA J.h：数字键 -> uint32 确定性哈希（与参考同结构）。 */
export const jHash = function (a: number, b = 0, c = 0, d = 0, e = 0): number {
    let h = 0x9e3779b9 ^ (a | 0);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = (h + Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35)) | 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h + Math.imul((d | 0) + 0x1b873593, 0x85ebca6b)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x165667b1);
    h = (h + Math.imul((c | 0) + 0x5bd1e995, 0x27d4eb2f)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
    h = (h + Math.imul((e | 0) + 0x68e31da4, 0x9e3779b1)) | 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
};

/** JIZURA J.r：0..1 确定性随机。 */
export const jr = (a: number, b = 0, c = 0, d = 0, e = 0) => jHash(a, b, c, d, e) / 4294967296;
/** JIZURA J.rs：-1..1 确定性随机。 */
export const jrs = (a: number, b = 0, c = 0, d = 0, e = 0) => jr(a, b, c, d, e) * 2 - 1;
/** JIZURA J.rr：lo..hi 区间确定性随机。 */
export const jrr = (lo: number, hi: number, a: number, b = 0, c = 0, d = 0) => lo + (hi - lo) * jr(a, b, c, d);

export interface JizuraRng {
    (): number;
    range: (lo: number, hi: number) => number;
    int: (lo: number, hi: number) => number;
    pick: <T>(arr: readonly T[]) => T;
    chance: (p: number) => boolean;
    wpick: <T>(list: ReadonlyArray<{ v: T; w: number }>) => T;
}

/** JIZURA J.rng：mulberry32 随机流（编排抽选用）。 */
export const jizuraRng = (seed: number): JizuraRng => {
    let s = seed >>> 0;
    const f = (() => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }) as JizuraRng;
    f.range = (lo, hi) => lo + (hi - lo) * f();
    f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
    f.pick = arr => arr[Math.floor(f() * arr.length) % arr.length];
    f.chance = p => f() < p;
    f.wpick = list => {
        let total = 0;
        for (const it of list) total += it.w;
        let x = f() * total;
        for (const it of list) { if ((x -= it.w) <= 0) return it.v; }
        return list[list.length - 1].v;
    };
    return f;
};

/** JIZURA 颜色角色：bg/fg/accent/ghostA/ghostB 五角色映射到 App 主题（04_styles.js 的 scheme 角色）。 */
export interface JizuraScheme {
    bg: string;
    fg: string;
    sub: string;
    accent: string;
    accent2: string;
    ink: string;
    dim: string;
    ghostA: string;
    ghostB: string;
}

export const hexToRgb = (hex: string): [number, number, number] => {
    const h = String(hex || '#000').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const luminanceOf = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** 主题色 -> JIZURA 五角色（含 fitContrast：与背景对比不足时拉近明度）。 */
export const buildSchemeFromTheme = (theme: Theme): JizuraScheme => {
    const bg = theme.backgroundColor || '#060607';
    const fg = theme.primaryColor || '#F5EEEA';
    const accent = theme.accentColor || theme.primaryColor || '#F5A50C';
    const accent2 = theme.secondaryColor || theme.primaryColor || '#16F4D4';
    const dimBg = luminanceOf(bg) < 0.5
        ? mixColors(bg, '#ffffff', 0.08)
        : mixColors(bg, '#000000', 0.08);
    return {
        bg,
        fg,
        sub: mixColors(fg, bg, 0.45),
        accent: fitContrast(accent, bg, 2.4),
        accent2: fitContrast(accent2, bg, 1.6),
        ink: fg,
        dim: dimBg,
        ghostA: fitContrast(theme.secondaryColor || accent, bg, 1.35),
        ghostB: fitContrast(accent2, bg, 1.35),
    };
};

export const mixColors = (from: string, to: string, t: number) => {
    const a = hexToRgb(from), b = hexToRgb(to);
    const c = a.map((v, i) => Math.round(lerp(v, b[i], t)));
    return '#' + c.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
};

const contrastRatio = (a: string, b: string) => {
    const L = (hex: string) => {
        const c = hexToRgb(hex).map(v => {
            const u = v / 255;
            return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const x = L(a), y = L(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** JIZURA J.fitContrast：与背景对比不足时按明度方向逐步推开。 */
export const fitContrast = (hex: string, bg: string, min = 3) => {
    if (contrastRatio(hex, bg) >= min) return hex;
    let l = luminanceOf(hex);
    const dark = luminanceOf(bg) < 0.5;
    for (let i = 0; i < 24; i++) {
        l = dark ? Math.min(0.96, l + 0.035) : Math.max(0.04, l - 0.035);
        const mixed = dark ? mixColors(hex, '#ffffff', (i + 1) * 0.06) : mixColors(hex, '#000000', (i + 1) * 0.06);
        if (contrastRatio(mixed, bg) >= min) return mixed;
        void l;
    }
    return dark ? '#ffffff' : '#111111';
};

/** JIZURA scramble 入场用到的替换字符池（J.pool('scramble')）。 */
export const SCRAMBLE_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789＊+×÷=≠§¶◆◇○●□■△▲※※※※';
