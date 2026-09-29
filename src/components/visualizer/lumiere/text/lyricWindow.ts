import type { Container, Graphics, Sprite } from 'pixi.js';
import type { Line } from '../../../../types';
import { createRng } from '../lumiereRandom';
import { compressLight, lightAt, type ResolvedBeam } from '../light/rig';
import type { LightSprites } from '../light/sprites';
import { hexOf, mixRgb, WHITE, type Rgb } from '../color';
import { buildGlyphLine, type GlyphLine } from './glyphLine';
import { clampInto, createTextMeasurer, fitScale, flowLine, frameBand, shouldWrap, type LineFlow, type LineVariant } from './lineWrap';
import { buildGlyphTimings, flashEnvelope, glyphProgress, type GlyphTiming } from './reveal';
import { MAX_WORD_SCALE, segmentWords, wordJags, wordScales } from './wordStyle';
import type { WordColorMatcher } from '../../wordColoring';
import { KEYWORD_HALO_GAIN, keywordTints, resolveGlyphKeywordColors, type KeywordTints } from './keywordColors';

// src/components/visualizer/lumiere/text/lyricWindow.ts
// 局部平铺窗口：只排当前行附近的几行（fume 的错落版式，但不是整首歌）。未来行是未点亮的刻字，
// 过去行是余光，当前行最大。当前行换到下一行时，各行换到新的槽位，最老的一行淡出进烟里。
//
// 纵横：每个字同时有横排位置与竖排位置（各有单行与折成两行 / 两列两种，见 lineWrap）。三种排版：横排为主、竖排为主、纵横交错。纵横交错时中心是
// 当前行的横排，周围的行按种子各有落点（上一行在上半圈、下一行在下半圈，角度与远近随机，横竖都可能、
// 还会倾斜）。换槽位时每个字沿自己的贝塞尔曲线飞过去（朝向不变也会甩出去再绕回来），身后拖一条细径迹：
// 径迹记录的是字在画面上真正走过的路（叠加了行本身的移动、转动与缩放），像云室里的粒子。字号按分词有差异。
//
// 崩解：字点亮一会儿之后开始沿各自的方向（多数向上）漂离排版位置并转动，越往后越快；
// 还没唱到的行反过来，字从散开的位置逐渐聚拢。所有字都有一点呼吸般的晃动。
//
// 点亮：每个字的亮度 = 点亮进度 × (底光 + 该字位置的光场强度)，唱到的一瞬有四芒闪点，受光强的字
// 下面垫一层柔光晕——这就是参考图里化学式被光柱照到的部分局部发光。全部是 t 的纯函数。
type PixiModule = typeof import('pixi.js');

/** 文字区（高度单位，中心 + 宽高）。 */
export interface WindowRegion {
    cx: number;
    cy: number;
    w: number;
    h: number;
}

/** horizontal：横排为主；vertical：竖排为主（右起）；crossed：当前行横排，周围的行自由落点、横竖都有。 */
export type WindowTypography = 'horizontal' | 'vertical' | 'crossed';

export interface DecaySpec {
    /** 崩解强度（0 = 不崩解）。 */
    strength: number;
    /** 字点亮后多久开始漂离（秒）。 */
    delay: number;
}

export interface LyricWindowOptions {
    width: number;
    height: number;
    lines: Line[];
    font: string;
    weight: number;
    resolution: number;
    region: WindowRegion;
    /** 当前行的字号（逻辑像素）。 */
    heroPx: number;
    /** 当前行之外显示几行：1 = 上一行，2 = 上一行 + 下一行。 */
    neighbors: 1 | 2;
    /** 默认排版。 */
    typography: WindowTypography;
    /**
     * 逐镜头的排版：第 lineIndex 行成为当前行时用哪种排版（它所在镜头的排版）。不给则全都用 typography。
     * 每次换行的起点槽位用上一次换行的排版，所以排版切换处也连续，字沿曲线飞过去。
     */
    typographyOf?: (lineIndex: number) => WindowTypography;
    decay: DecaySpec;
    /** 每次换槽位都让字沿曲线飞、拖出径迹（不给则只有纵横交错或朝向变化时才飞）。 */
    alwaysFly?: boolean;
    /** 漂移与绕行的倍率（片尾卡用 0：字停在原位，只留呼吸）。默认 1。 */
    drift?: number;
    seed: string;
    sprites: LightSprites;
    letterSpacing?: number;
    /** 关键字着色的匹配器（主题 wordColors，prepareLumiereKeywords）；不给或为空则不着色。 */
    keywords?: readonly WordColorMatcher[];
}

export interface LyricWindowFrame {
    time: number;
    beams: readonly ResolvedBeam[];
    litColor: Rgb;
    unlitColor: Rgb;
    unlitAlpha: number;
    /** 整体亮度（进退场）。 */
    intensity: number;
}

interface Point {
    x: number;
    y: number;
}

/**
 * 换槽位时字的飞行曲线（三次贝塞尔）。控制点按种子：有的走弧线、有的打卷成 S 形；起飞时间错开。
 * 起点与终点相同时（朝向不变）就是甩出去再绕回来的一个圈。
 */
export interface GlyphFlight {
    /** 两个控制点：分别相对起点与终点的偏移（逻辑像素，未缩放）。 */
    c1: Point;
    c2: Point;
    /** 在整段滑动（0..1）里何时起飞、飞多久。 */
    delay: number;
    duration: number;
    /** 飞行途中的转动（弧度，途中最大）。 */
    spin: number;
    /** 径迹抖动的相位。 */
    wobble: number;
}

/** 滑动进度 phase（0..1）下这个字在曲线上的位置参数 0..1。 */
export const flightProgress = (flight: GlyphFlight, phase: number, lag = 0) => {
    const t = Math.min(1, Math.max(0, (phase - flight.delay - lag) / flight.duration));
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** 起点 from → 终点 to 的贝塞尔曲线上参数 s 处的点。 */
export const flightPoint = (flight: GlyphFlight, from: Point, to: Point, s: number): Point => {
    const u = 1 - s;
    const a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
    return {
        x: a * from.x + b * (from.x + flight.c1.x) + c * (to.x + flight.c2.x) + d * to.x,
        y: a * from.y + b * (from.y + flight.c1.y) + c * (to.y + flight.c2.y) + d * to.y,
    };
};

/** 径迹记录过去多久走过的路（秒）；字到位后尾端再过这么久追上，径迹收拢消失。 */
const TRACK_TIME = 0.45;
const TRACK_SAMPLES = 20;

interface GlyphView {
    glyph: Sprite;
    halo: Sprite;
    star: Sprite;
    timing: GlyphTiming;
    blank: boolean;
    /** 在行里的序号：字心位置查 LineView.flow（横竖 × 单行 / 折行）。竖排时的转角。 */
    index: number;
    vRotation: number;
    /** 换槽位时的飞行曲线。 */
    flight: GlyphFlight;
    /** 所在词的字号倍率。 */
    scale: number;
    /** 闪点相对字心的偏移（以字号为单位）、旋转与大小：按种子逐字固定，落点有上下错落。 */
    starShape: { dx: number; dy: number; rotation: number; size: number };
    /** 崩解：漂离方向（单位向量）、速度倍率、转动方向；聚合：散开时的偏移（以字号为单位）；呼吸的相位。 */
    drift: { dx: number; dy: number; speed: number; spin: number };
    scatter: Point;
    phase: number;
    /** 关键字色（不是关键字为 null）与它在当前光色下的几种颜色（光色变了才重算）。 */
    keyword: Rgb | null;
    tints: KeywordTints | null;
}

interface Slot {
    dx: number;
    dy: number;
    scale: number;
    alpha: number;
    /** 朝向：0 横排，1 竖排。 */
    orient: number;
    /** 整行的倾斜（弧度）。 */
    rotation: number;
    /** 0 单行，1 折成两行（两列）。 */
    wrap: number;
}

interface LineView {
    line: Line;
    layout: GlyphLine;
    holder: Container;
    glyphs: GlyphView[];
    /** 四种排版（横竖 × 单行 / 折行）：字心位置、光斑路径与整块尺寸（逻辑像素，含词的字号差异）。 */
    flow: LineFlow;
    /** 纵横交错时这一行在各个相对位置（−2..2，不含 0）上的落点。 */
    placements: Map<number, Slot>;
    /** 追字光斑（每行一个，换行时两行的光斑各自淡入淡出，不会跳）。 */
    spot: Sprite;
    /** 第一个字开始、最后一个字结束的时刻。 */
    singStart: number;
    singEnd: number;
    /** 错落：每行一个稳定的偏移（高度单位；横排时横向、竖排时纵向）。 */
    jitter: number;
    /** 持续漂移：恒定速度（高度单位 / 秒）、绕行与摆动的相位。 */
    velocity: Point;
    motionPhase: number;
}

interface LineTransform {
    current: number;
    x: number;
    y: number;
    scale: number;
    rotation: number;
    alpha: number;
    /** 槽位切换的起止朝向、起止折行与滑动的线性进度；fly 为这一次切换字要不要沿曲线飞。 */
    fromOrient: number;
    toOrient: number;
    fromWrap: number;
    toWrap: number;
    /** 当前的折行程度（0..1，缓动过的）：不飞的时候字在单行与折行的位置之间滑。 */
    wrap: number;
    phase: number;
    fly: boolean;
    /** 这一次滑动开始的时刻（没有滑动时为 −∞）。 */
    slideStart: number;
}

export interface GlyphAnchor {
    x: number;
    y: number;
    fontPx: number;
}

export interface LyricWindow {
    view: Container;
    /** 径迹、光晕、字、闪点几层；bloom 挂在 view 上。 */
    update: (frame: LyricWindowFrame) => void;
    /** 每行可见字（非空白）的点亮时刻，给爆闪选引爆的字。 */
    glyphTimes: (lineIndex: number) => Array<{ glyphIndex: number; start: number }>;
    /** 某个字在时刻 time 的位置（逻辑像素，含崩解偏移）与字号。 */
    glyphAnchor: (lineIndex: number, glyphIndex: number, time: number) => GlyphAnchor;
    /** 某一行在时刻 time 的中心（逻辑像素）、整行缩放与透明度（调试与连贯性检查用）。 */
    lineAnchor: (lineIndex: number, time: number) => { x: number; y: number; scale: number; alpha: number };
    /** 某个字的关键字色（不是关键字为 null），给十字爆闪取色。 */
    glyphKeyword: (lineIndex: number, glyphIndex: number) => Rgb | null;
    destroy: () => void;
}

/**
 * 换行：从新一行开始前 LEAD 秒起，各行依次（按落到的新位置错开 SLIDE_LAG 秒）用 SLIDE 秒滑到新位置——
 * 要离场的行先走，新的当前行随后，新进来的行最后。滑动叠加在每行永不停止的漂移上，画面没有静止的时刻。
 */
const LEAD = 1.2;
const SLIDE = 1.5;
const SLIDE_LAG: Record<number, number> = { [-2]: 0, [-1]: 0.15, 0: 0.3, 1: 0.5, 2: 0.6 };
/** 每行的持续漂移：恒定速度（高度单位 / 秒）范围、绕行幅度（高度单位）。 */
const DRIFT_SPEED: [number, number] = [0.013, 0.022];
const ORBIT = 0.03;
/** 逐字点亮的最短渐变时长（字本身很短时也不会一下跳亮）。 */
const LIGHT_UP = 0.3;
/** 追字光斑的时间平滑：对过去这段时间里的位置取平均。 */
const SPOT_WINDOW = 0.3;
const SPOT_SAMPLES = 8;
/** 未唱的行从开始滑动前多久开始聚拢、聚拢多久。 */
const GATHER_LEAD = 1.6;
const GATHER = 1.8;

const smooth = (value: number) => {
    const t = Math.min(1, Math.max(0, value));
    return t * t * (3 - 2 * t);
};
const easeInOutCubic = (value: number) => {
    const t = Math.min(1, Math.max(0, value));
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
/** 换位用更柔的正弦缓动：两端的减速比三次曲线平缓，叠在漂移上不会有「停住」的感觉。 */
const easeInOutSine = (value: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, value)))) / 2;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpPoint = (a: Point, b: Point, k: number): Point => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) });

/** 时刻 t 的当前行序号（-1 = 第一行之前）、滑动的线性进度 phase 与缓动后的 slide。 */
export const resolveWindowCursor = (lines: readonly Line[], time: number) => {
    let current = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]!.startTime - LEAD <= time) current = i;
        else break;
    }
    const phase = current < 0 ? 1 : clamp01((time - (lines[current]!.startTime - LEAD)) / SLIDE);
    return { current, phase, slide: easeInOutSine(phase) };
};

/** 某一行在这次换行里的滑动进度：按它落到的新位置（relative）错开起步。 */
export const resolveLinePhase = (lines: readonly Line[], current: number, relative: number, time: number) => {
    if (current < 0) return { phase: 1, start: Number.NEGATIVE_INFINITY };
    const start = lines[current]!.startTime - LEAD + (SLIDE_LAG[Math.max(-2, Math.min(2, relative))] ?? 0);
    return { phase: clamp01((time - start) / SLIDE), start };
};

type SpotGlyph = { timing: GlyphTiming; center: number };

/** 行内的演唱位置（以字为单位的连续值，0 = 第一个字之前，n = 唱完）。 */
const singingPosition = (glyphs: readonly SpotGlyph[], time: number) => {
    let position = 0;
    for (const glyph of glyphs) position += glyphProgress(glyph.timing, time);
    return position;
};

/** 连续位置 → 行内坐标：在相邻字心之间线性插值。 */
const positionToX = (glyphs: readonly SpotGlyph[], position: number) => {
    const n = glyphs.length;
    if (n === 0) return 0;
    const index = Math.min(n - 1, Math.max(0, position - 0.5));
    const lower = Math.floor(index);
    const upper = Math.min(n - 1, lower + 1);
    return glyphs[lower]!.center + (glyphs[upper]!.center - glyphs[lower]!.center) * (index - lower);
};

/**
 * 追字光斑在行内的坐标（沿行的方向）：对过去 window 秒里的位置取平均（仍只由 t 决定）。
 * window = 0 时就是不平滑的逐字位置。
 */
export const resolveSpotX = (glyphs: readonly SpotGlyph[], time: number, window = SPOT_WINDOW) => {
    if (window <= 0) return positionToX(glyphs, singingPosition(glyphs, time));
    let x = 0;
    for (let s = 0; s < SPOT_SAMPLES; s += 1) {
        x += positionToX(glyphs, singingPosition(glyphs, time - (window * s) / (SPOT_SAMPLES - 1)));
    }
    return x / SPOT_SAMPLES;
};

/**
 * 崩解的漂离量（以字号为单位）：字点亮 delay 秒之后开始，按 age^1.5 缓慢加速。
 * 3 秒后约 0.4、5 秒约 0.9、8 秒约 1.8 个字号（× strength）：唱的时候只是开始松动，
 * 退到邻行时明显错位，淡出前才散开。
 */
export const decayAmount = (decay: DecaySpec, litAt: number, time: number) => {
    const age = time - litAt - decay.delay;
    return age > 0 ? decay.strength * 0.08 * age ** 1.5 : 0;
};

/** 崩解到多远开始淡出、多远完全看不见（以字号为单位）。 */
const DISSOLVE_FROM = 1;
const DISSOLVE_SPAN = 2;

/**
 * 纵横交错时一行的自由落点：上一行（−1）在上半圈、下一行（+1）在下半圈，角度与远近按种子；
 * 横竖都可能，横排的行倾斜得多一些。更远的位置（±2）沿同一方向再推出去、透明。
 */
export const freePlacements = (random: () => number, region: WindowRegion, nextAlpha: number): Map<number, Slot> => {
    const placement = (upper: boolean, alpha: number): Slot => {
        const angle = upper ? Math.PI * (1.12 + random() * 0.76) : Math.PI * (0.12 + random() * 0.76);
        const rx = region.w * (0.24 + random() * 0.22);
        const ry = region.h * (0.3 + random() * 0.18);
        const vertical = random() < 0.5;
        return {
            dx: Math.cos(angle) * rx,
            dy: Math.sin(angle) * ry,
            scale: 0.5 + random() * 0.2,
            alpha,
            orient: vertical ? 1 : 0,
            rotation: (random() - 0.5) * (vertical ? 0.3 : 0.7),
            wrap: 0,
        };
    };
    const farther = (slot: Slot): Slot => ({ ...slot, dx: slot.dx * 1.45, dy: slot.dy * 1.45, scale: slot.scale * 0.85, alpha: 0 });
    const previous = placement(true, 0.9);
    const next = placement(false, nextAlpha);
    return new Map([[-1, previous], [1, next], [-2, farther(previous)], [2, farther(next)]]);
};

/**
 * 固定槽位里邻行与当前行之间的空隙（以字号为单位）：near 是 ±1 与当前行之间，far 是 ±2 与 ±1 之间。
 * 按单行单列（厚度一个字号）反推，单行时与原来的固定偏移完全一样。
 */
const STACK_GAP = {
    vertical: { previous: 0.95, next: 0.88, farPrevious: 0.78, farNext: 0.7 },
    horizontal: { previous: 0.93, next: 0.735, farPrevious: 0.56, farNext: 0.56 },
};

/**
 * 横排、竖排两种排版的固定槽位（相对文字区中心，高度单位）。relative = 行号 − 当前行号。
 * 邻行按实际厚度排开（竖排看宽度、横排看高度），折成两列 / 两行的行不会压到旁边的行：
 * across(offset, scale) 是「当前行 + offset」那一行在这个槽位缩放下垂直于行方向的厚度（高度单位）。
 */
const fixedSlot = (
    typography: WindowTypography,
    relative: number,
    region: WindowRegion,
    fontH: number,
    nextAlpha: number,
    across: (offset: number, scale: number) => number,
): Slot => {
    const slot = (dx: number, dy: number, scale: number, alpha: number, orient: number): Slot => ({ dx, dy, scale, alpha, orient, rotation: 0, wrap: 0 });
    const vertical = typography === 'vertical';
    const orient = vertical ? 1 : 0;
    if (relative === 0) return slot(0, 0, 1, 1, orient);
    const previous = relative < 0;
    const far = Math.abs(relative) > 1;
    const nearScale = vertical ? 0.58 : 0.52;
    const scale = far ? (vertical ? 0.48 : 0.44) : nearScale;
    const gap = STACK_GAP[vertical ? 'vertical' : 'horizontal'];
    const sign = previous ? -1 : 1;
    let offset = across(0, 1) / 2 + (previous ? gap.previous : gap.next) * fontH;
    if (far) offset += across(sign, nearScale) + (previous ? gap.farPrevious : gap.farNext) * fontH;
    offset += across(relative, scale) / 2;
    const alpha = previous ? (far ? 0 : 0.9) : (far ? 0 : nextAlpha);
    if (vertical) {
        // 竖排从右往左读：上一行在右、下一行在左。
        return slot(-sign * offset, sign * (far ? 0.07 : 0.03), scale, alpha, orient);
    }
    return slot(sign * region.w * (far ? 0.24 : 0.16), sign * offset, scale, alpha, orient);
};

/** 纵横交错时邻行与当前行之间至少留的空隙（以字号为单位）。 */
const CROSSED_CLEARANCE = 0.5;

const sameSlot = (a: Slot, b: Slot) => a.dx === b.dx && a.dy === b.dy && a.scale === b.scale
    && a.alpha === b.alpha && a.orient === b.orient && a.rotation === b.rotation && a.wrap === b.wrap;

export const createLyricWindow = (pixi: PixiModule, options: LyricWindowOptions): LyricWindow => {
    const { height, region, heroPx, sprites, typography, decay } = options;
    const rng = createRng(`${options.seed}:window`);
    const view = new pixi.Container();
    const trackLayer = new pixi.Graphics();
    const halos = new pixi.Container();
    const glyphLayer = new pixi.Container();
    const stars = new pixi.Container();
    const spots = new pixi.Container();
    view.addChild(spots, trackLayer, halos, glyphLayer, stars);
    const spacing = options.letterSpacing ?? 0;
    const nextAlpha = options.neighbors >= 2 ? 0.95 : 0;
    // 长度上限：横排用画框内的整个宽度（纵横交错留一成给四周的行），竖排用画框内的整个高度（避开底部字幕）。
    // 文字区只决定中心，不再限制行长。
    const band = frameBand(options.width, height);
    const columnCap = (band.bottom - band.top) * height;
    const maxWidthOf = (kind: WindowTypography) => (band.right - band.left) * height * (kind === 'crossed' ? 0.9 : 1);
    const measurer = createTextMeasurer(options.font, options.weight, spacing);

    const lines: LineView[] = options.lines.map((line, lineIndex) => {
        // 字形纹理按最大的词字号画，放大的词只缩小不放大。
        const layout = buildGlyphLine(pixi, {
            text: line.fullText,
            fontPx: heroPx * MAX_WORD_SCALE,
            font: options.font,
            weight: options.weight,
            resolution: options.resolution,
            letterSpacing: spacing,
        });
        const timings = buildGlyphTimings(line);
        // 关键字：每行构建时匹配一次，逐字落到颜色上。
        const keywordColors = options.keywords && options.keywords.length > 0
            ? resolveGlyphKeywordColors(line.fullText, options.keywords)
            : null;

        // 分词与字号：每个字归到一个词，带上那个词的字号倍率与错落。
        const words = segmentWords(line);
        const wordSeed = `${options.seed}:${lineIndex}:${line.fullText}`;
        const scales = wordScales(words, wordSeed);
        const jags = wordJags(words, scales, wordSeed);
        const wordOf = layout.glyphs.map((_, index) => Math.max(0, words.findIndex(word => index >= word.start && index < word.end)));
        const glyphScale = (index: number) => scales[wordOf[index]!] ?? 1;
        const glyphJag = (index: number) => (jags[wordOf[index]!] ?? 0) * heroPx;

        // 横排：按词字号推进，基线对齐（小字往下沉一点），每个词再上下错开；竖排：按列推进，居中对齐，每个词左右错开。
        // 词宽用 pretext 量，太长时折成两行 / 两列（lineWrap），四种排版一次算好。
        const flow = flowLine(
            measurer,
            layout.glyphs.map((slice, index) => ({
                char: slice.char,
                scale: glyphScale(index),
                advance: (slice.charWidth / MAX_WORD_SCALE) * glyphScale(index),
                upright: slice.upright,
                jag: glyphJag(index),
            })),
            words,
            { heroPx, limits: { horizontal: maxWidthOf('horizontal'), vertical: columnCap } },
        );

        const holder = new pixi.Container();
        glyphLayer.addChild(holder);
        const glyphs: GlyphView[] = layout.glyphs.map((slice, index) => {
            const glyph = new pixi.Sprite(slice.texture);
            glyph.anchor.set(slice.anchorX, slice.anchorY);
            holder.addChild(glyph);
            // 飞行曲线：第一个控制点朝随机方向甩出去，第二个在它的基础上转过半圈左右（弧线或 S 形、打卷）。
            const a1 = rng() * Math.PI * 2;
            const a2 = a1 + Math.PI * (rng() < 0.5 ? 0.5 : 1.5) + (rng() - 0.5) * 0.8;
            const m1 = heroPx * (1.6 + rng() * 3.2);
            const m2 = heroPx * (1 + rng() * 2.6);
            // 起飞时刻与飞行时长在整段滑动里铺开（delay + duration ≤ 1，滑动结束时一定到位）。
            const duration = 0.45 + rng() * 0.4;
            const flight: GlyphFlight = {
                c1: { x: Math.cos(a1) * m1, y: Math.sin(a1) * m1 },
                c2: { x: Math.cos(a2) * m2, y: Math.sin(a2) * m2 },
                delay: rng() * (1 - duration),
                duration,
                spin: (rng() - 0.5) * 2.4,
                wobble: rng() * Math.PI * 2,
            };
            const halo = new pixi.Sprite(sprites.dot);
            halo.anchor.set(0.5);
            halos.addChild(halo);
            const star = new pixi.Sprite(sprites.star);
            star.anchor.set(0.5);
            stars.addChild(star);
            if (slice.blank) {
                glyph.visible = false;
                halo.visible = false;
                star.visible = false;
            }
            // 漂离方向：多数向上（烟往上走），左右散开。
            const angle = -Math.PI / 2 + (rng() - 0.5) * 2.2;
            const scatterAngle = rng() * Math.PI * 2;
            const scatterDistance = 0.6 + rng() * 1.4;
            return {
                glyph,
                halo,
                star,
                timing: timings[index] ?? { start: line.startTime, end: line.endTime },
                blank: slice.blank,
                index,
                vRotation: slice.upright ? 0 : Math.PI / 2,
                flight,
                scale: glyphScale(index),
                starShape: {
                    dx: -0.15 + rng() * 0.5,
                    // 上下随机：多数落在字的上半，少数压到字脚下。
                    dy: -0.62 + rng() ** 1.4 * 0.9,
                    rotation: (rng() - 0.5) * 0.5,
                    size: 0.65 + rng() * 0.7,
                },
                drift: { dx: Math.cos(angle), dy: Math.sin(angle), speed: 0.6 + rng() * 0.9, spin: (rng() - 0.5) * 2 },
                scatter: { x: Math.cos(scatterAngle) * scatterDistance, y: Math.sin(scatterAngle) * scatterDistance },
                phase: rng() * Math.PI * 2,
                keyword: slice.blank ? null : keywordColors?.[index] ?? null,
                tints: null,
            };
        });
        const spot = new pixi.Sprite(sprites.dot);
        spot.anchor.set(0.5);
        spots.addChild(spot);
        const sung = glyphs.filter(glyph => !glyph.blank);
        return {
            line,
            layout,
            holder,
            glyphs,
            flow,
            // 落点用单独的随机流：排版换来换去时，别的随机量不受影响。
            placements: freePlacements(createRng(`${options.seed}:placements:${lineIndex}`), region, nextAlpha),
            spot,
            singStart: sung.length ? Math.min(...sung.map(glyph => glyph.timing.start)) : line.startTime,
            singEnd: sung.length ? Math.max(...sung.map(glyph => glyph.timing.end)) : line.endTime,
            jitter: (rng() - 0.5) * 0.16,
            velocity: (() => {
                const angle = rng() * Math.PI * 2;
                const speed = DRIFT_SPEED[0] + rng() * (DRIFT_SPEED[1] - DRIFT_SPEED[0]);
                return { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
            })(),
            motionPhase: rng() * Math.PI * 2,
        };
    });

    const fontH = heroPx / height;
    const lineCount = options.lines.length;
    const driftScale = options.drift ?? 1;
    /** 第 c 行成为当前行时的排版（c = −1 即第一行之前，按第一行的排版）。 */
    const typographyAt = (c: number): WindowTypography => (
        options.typographyOf ? options.typographyOf(Math.max(0, Math.min(lineCount - 1, c))) : typography
    );

    /**
     * 第 index 行在槽位缩放 scale、朝向 orient 下落定的样子：单行缩到 SINGLE_MIN_FIT 还放不下才折，
     * 折了还放不下再整体缩小（邻行本身已经小，很少需要折）。
     */
    const settle = (index: number, kind: WindowTypography, orient: 0 | 1, scale: number) => {
        const flow = lines[index]!.flow[orient];
        const budget = orient === 1 ? columnCap : maxWidthOf(kind);
        const wrap = shouldWrap(flow, budget, scale) ? 1 : 0;
        const variant: LineVariant = flow[wrap];
        return { wrap, variant, scale: scale * fitScale(variant.along, budget, scale) };
    };
    /** 第 index 行垂直于行方向的厚度（高度单位，已缩放）；不存在的行（第一行之前）按一个字号。 */
    const acrossOf = (index: number, kind: WindowTypography, orient: 0 | 1, scale: number) => {
        if (index < 0 || index >= lineCount) return fontH * scale;
        const settled = settle(index, kind, orient, scale);
        return (settled.variant.across / height) * settled.scale;
    };
    /** 把当前行整块放进画框的偏移（高度单位）：整个窗口一起挪，行距不变。文字区的中心仍是锚点。 */
    const windowShift = (current: number, kind: WindowTypography): Point => {
        if (current < 0 || current >= lineCount) return { x: 0, y: 0 };
        const orient = kind === 'vertical' ? 1 : 0;
        const { variant, scale } = settle(current, kind, orient, 1);
        const w = (variant.inkWidth / height) * scale;
        const h = (variant.inkHeight / height) * scale;
        return {
            x: clampInto(region.cx, w, band.left, band.right) - region.cx,
            y: clampInto(region.cy, h, band.top, band.bottom) - region.cy,
        };
    };

    // 槽位是（行、当前行、排版）的纯函数，每帧会反复查（径迹还要回溯几十个时刻），缓存起来。
    const slotCache = new Map<string, Slot>();
    /** 当前行为 current、排版为 kind 时第 index 行的槽位（含把当前行放进画框的整体偏移与这一行的折行）。 */
    const slotOf = (index: number, current: number, kind: WindowTypography): Slot => {
        const key = `${index}|${current}|${kind}`;
        const cached = slotCache.get(key);
        if (cached) return cached;
        const view = lines[index]!;
        const clamped = Math.max(-2, Math.min(2, index - current));
        const shift = windowShift(current, kind);
        let slot: Slot;
        let wrap: number | null = null;
        if (kind === 'crossed' && clamped !== 0) {
            // 纵横交错：自由落点在当前行的上半圈 / 下半圈，但要让开当前行（折成两行时更高）：邻行整块的上下边
            // 与当前行之间至少留一段空隙。竖着的邻行很长，当前行与画框之间放不下时先折成两列，还放不下再缩小。
            const base = view.placements.get(clamped)!;
            const baseOrient = base.orient >= 0.5 ? 1 : 0;
            const sign = base.dy < 0 ? -1 : 1;
            const currentHalf = current >= 0 && current < lineCount
                ? (() => {
                    const settled = settle(current, kind, 0, 1);
                    return (settled.variant.inkHeight / height) * settled.scale / 2;
                })()
                : fontH / 2;
            const gap = fontH * CROSSED_CLEARANCE;
            const centerY = region.cy + shift.y;
            const room = sign < 0 ? centerY - currentHalf - gap - band.top : band.bottom - (centerY + currentHalf + gap);
            const flow = view.flow[baseOrient];
            const budget = baseOrient === 1 ? columnCap : maxWidthOf(kind);
            /** 在缩放 s、折法 w 下这一行整块（含落点的倾斜）的高度（高度单位）。 */
            const tilt = Math.abs(base.rotation) + 0.03;
            const heightOf = (w: 0 | 1, s: number) => (
                ((flow[w].inkHeight * Math.cos(tilt) + flow[w].inkWidth * Math.sin(tilt)) / height) * s * fitScale(flow[w].along, budget, s)
            );
            let scale = base.scale;
            let w: 0 | 1 = settle(index, kind, baseOrient, scale).wrap ? 1 : 0;
            if (baseOrient === 1 && room > 0) {
                if (w === 0 && flow[1].lines > 1 && heightOf(0, scale) > room) w = 1;
                const tall = heightOf(w, scale);
                if (tall > room) scale = Math.max(base.scale * 0.5, scale * (room / tall));
            }
            wrap = w;
            const clearance = currentHalf + gap + heightOf(w, scale) / 2;
            const dy = sign * Math.max(Math.abs(base.dy), clearance);
            // 竖着的邻行折成两列时更宽，沿原来的方向再推开多出来的那一半。
            const wider = baseOrient === 1 ? Math.max(0, acrossOf(index, kind, 1, scale) - fontH * scale) / 2 : 0;
            slot = { ...base, scale, dy, dx: base.dx + Math.sign(base.dx) * wider };
        } else {
            const orient = kind === 'vertical' ? 1 : 0;
            slot = fixedSlot(kind === 'crossed' ? 'horizontal' : kind, clamped, region, fontH, nextAlpha, (offset, scale) => (
                acrossOf(offset === clamped ? index : current + offset, kind, orient, scale)
            ));
        }
        const result: Slot = {
            ...slot,
            dx: slot.dx + shift.x,
            dy: slot.dy + shift.y,
            wrap: wrap ?? settle(index, kind, slot.orient >= 0.5 ? 1 : 0, slot.scale).wrap,
        };
        slotCache.set(key, result);
        return result;
    };

    /**
     * 第 index 行在时刻 time 的位置（逻辑像素）、缩放、转角、透明度与槽位切换信息。纯函数，径迹与爆闪也用它。
     *
     * 叠加式：位置 = 第一行开始前的槽位 + Σ 每次换行带来的槽位差 × 这次换行对这一行的缓动进度。
     * 每次换行对各行错开起步（离场的先走），两行间隔很短、上一次还没走完时也连续，不会跳。
     */
    const lineTransform = (index: number, time: number): LineTransform => {
        const view = lines[index]!;
        const { current } = resolveWindowCursor(options.lines, time);
        const initial = slotOf(index, -1, typographyAt(-1));
        let dx = initial.dx, dy = initial.dy, scale = initial.scale, rotation = initial.rotation;
        let alpha = initial.alpha, orient = initial.orient, wrap = initial.wrap;
        // 最近一次正在（或刚刚）作用于这一行的换行：给字的飞行曲线与径迹用。
        let latest: { before: Slot; after: Slot; phase: number; start: number; kind: WindowTypography } | null = null;
        // 随排版变化的量（宽度上限、错落）也跟着换行叠加，排版切换时不跳。
        let widthCap = maxWidthOf(typographyAt(-1));
        let jitterOn = typographyAt(-1) === 'crossed' ? 0 : 1;
        // 排版切换时整个版面都要重排，所以从头叠加（槽位差为 0 的换行直接跳过，代价很小）。
        const first = 0;
        const last = Math.min(lineCount - 1, current);
        for (let c = first; c <= last; c += 1) {
            const beforeKind = typographyAt(c - 1);
            const afterKind = typographyAt(c);
            const before = slotOf(index, c - 1, beforeKind);
            const after = slotOf(index, c, afterKind);
            const kindChanged = beforeKind !== afterKind;
            if (sameSlot(before, after) && !kindChanged) continue;
            const { phase, start } = resolveLinePhase(options.lines, c, index - c, time);
            const k = easeInOutSine(phase);
            if (kindChanged) {
                widthCap += (maxWidthOf(afterKind) - maxWidthOf(beforeKind)) * k;
                jitterOn += ((afterKind === 'crossed' ? 0 : 1) - (beforeKind === 'crossed' ? 0 : 1)) * k;
            }
            // 透明度不跟位移同一条曲线：要淡出的先走（前 60%），要淡入的后到（后 60%）。
            const fade = after.alpha < before.alpha
                ? easeInOutCubic(phase / 0.6)
                : after.alpha > before.alpha ? easeInOutCubic((phase - 0.4) / 0.6) : k;
            dx += (after.dx - before.dx) * k;
            dy += (after.dy - before.dy) * k;
            scale += (after.scale - before.scale) * k;
            rotation += (after.rotation - before.rotation) * k;
            alpha += (after.alpha - before.alpha) * fade;
            orient += (after.orient - before.orient) * phase;
            wrap += (after.wrap - before.wrap) * k;
            if (phase > 0) latest = { before, after, phase, start, kind: afterKind };
        }
        // 太长时整体缩小，不出画框（横排看宽度、竖排看长度；单行 / 折行按折行程度混合）。
        const o = clamp01(orient);
        const w = clamp01(wrap);
        const [hSingle, hWrapped] = view.flow[0];
        const [vSingle, vWrapped] = view.flow[1];
        const fitH = lerp(fitScale(hSingle.along, widthCap, scale), fitScale(hWrapped.along, widthCap, scale), w);
        const fitV = lerp(fitScale(vSingle.along, columnCap, scale), fitScale(vWrapped.along, columnCap, scale), w);
        const fitted = scale * lerp(fitH, fitV, o);
        // 错落只作用在固定槽位的邻行上（横排时横向、竖排时纵向），当前行居中。
        const jitter = jitterOn * view.jitter * region.w * clamp01((1 - scale) / 0.5);
        // 固定槽位里每一行沿自己的方向不出画框（横排左右、竖排上下）：邻行排在垂直于行的方向上，挪了也压不到
        // 当前行。纵横交错的邻行是自由落点，沿行挪可能挪进当前行里，保持原样（和错落一样只作用在固定槽位上）。
        // 漂移不算在里面，照常漂。
        const baseX = region.cx + dx + jitter * (1 - orient);
        const baseY = region.cy + dy + jitter * 0.5 * orient;
        const alongH = (lerp(hSingle.inkWidth, hWrapped.inkWidth, w) / height) * fitted;
        const alongV = (lerp(vSingle.inkHeight, vWrapped.inkHeight, w) / height) * fitted;
        const x = baseX + (clampInto(baseX, alongH, band.left, band.right) - baseX) * (1 - o) * jitterOn;
        const y = baseY + (clampInto(baseY, alongV, band.top, band.bottom) - baseY) * o * jitterOn;
        // 永不停止的漂移：以这一行开始唱的时刻为零点匀速漂（唱的时候正好在槽位上），再叠一点绕行、摆动与呼吸。
        const age = time - view.line.startTime;
        const m = view.motionPhase;
        const driftX = (view.velocity.x * age + Math.sin(time * 0.52 + m) * ORBIT) * driftScale;
        const driftY = (view.velocity.y * age + Math.cos(time * 0.41 + m * 1.3) * ORBIT * 0.7) * driftScale;
        const settledOrient = latest ? latest.after.orient : initial.orient;
        const settledWrap = latest ? latest.after.wrap : initial.wrap;
        return {
            current,
            x: (x + driftX) * height,
            y: (y + driftY) * height,
            scale: fitted * (1 + 0.025 * Math.sin(time * 0.43 + m)),
            rotation: rotation + 0.03 * Math.sin(time * 0.23 + m * 0.7),
            alpha: clamp01(alpha),
            fromOrient: latest ? latest.before.orient : settledOrient,
            toOrient: settledOrient,
            fromWrap: latest ? latest.before.wrap : settledWrap,
            toWrap: settledWrap,
            wrap: w,
            phase: latest ? latest.phase : 1,
            // 纵横交错时每次换槽位都飞；另两种排版只在朝向变化时飞。
            fly: latest !== null && latest.phase < 1
                && (options.alwaysFly === true || latest.kind === 'crossed' || latest.before.orient !== latest.after.orient),
            slideStart: latest ? latest.start : Number.NEGATIVE_INFINITY,
        };
    };

    /**
     * 字在行内的位置（未缩放）、转角与缩放：换槽位时沿自己的贝塞尔曲线飞过去，途中缩小、转动、发亮
     * （flying 为飞行强度 0..1）。再加上聚合、崩解与呼吸。
     */
    const glyphLocal = (view: LineView, glyph: GlyphView, time: number, transform: LineTransform) => {
        const at = (orient: number, wrap: number) => view.flow[orient >= 0.5 ? 1 : 0][wrap >= 0.5 ? 1 : 0].points[glyph.index]!;
        const s = transform.fly ? flightProgress(glyph.flight, transform.phase) : 1;
        const flying = transform.fly ? Math.sin(Math.PI * s) : 0;
        // 不飞的时候，单行与折行之间（邻行变成当前行、需要折开时）字随滑动缓动过去。
        const point = transform.fly
            ? flightPoint(glyph.flight, at(transform.fromOrient, transform.fromWrap), at(transform.toOrient, transform.toWrap), s)
            : lerpPoint(at(transform.toOrient, 0), at(transform.toOrient, 1), transform.wrap);
        let x = point.x;
        let y = point.y;
        let rotation = glyph.vRotation * lerp(transform.fromOrient, transform.toOrient, s) + glyph.flight.spin * flying;
        const pulse = 1 - 0.28 * flying;
        // 聚合：未唱的行从散开的位置逐渐收拢。
        const gather = smooth((time - (view.line.startTime - LEAD - GATHER_LEAD)) / GATHER);
        const scatter = (1 - gather) ** 2 * decay.strength;
        x += glyph.scatter.x * heroPx * scatter;
        y += glyph.scatter.y * heroPx * scatter;
        // 崩解：点亮一会儿之后沿各自的方向漂离、转动。
        const amount = decayAmount(decay, glyph.timing.start, time) * glyph.drift.speed;
        x += glyph.drift.dx * heroPx * amount;
        y += glyph.drift.dy * heroPx * amount;
        rotation += glyph.drift.spin * amount * 0.18;
        // 呼吸：一直有一点轻微晃动。
        const breath = heroPx * 0.022 * Math.min(1, decay.strength + 0.3);
        x += Math.sin(time * 0.9 + glyph.phase) * breath;
        y += Math.cos(time * 1.13 + glyph.phase * 1.7) * breath;
        return { x, y, rotation, gather, flying, scale: glyph.scale * pulse };
    };

    /** 行内坐标 → 画面坐标（行的转角、缩放、位置）。 */
    const toWorld = (transform: LineTransform, point: Point): Point => {
        const cos = Math.cos(transform.rotation);
        const sin = Math.sin(transform.rotation);
        return {
            x: transform.x + (point.x * cos - point.y * sin) * transform.scale,
            y: transform.y + (point.x * sin + point.y * cos) * transform.scale,
        };
    };

    /**
     * 径迹：字在画面上过去 TRACK_TIME 秒里真正走过的路（叠加了行本身的移动、转动与缩放），加一点
     * 垂直方向的抖动，像云室里的粒子径迹；字到位后尾端追上来，径迹收拢消失。只画这一次滑动开始之后的部分。
     */
    const drawTracks = (index: number, view: LineView, time: number, transform: LineTransform, alpha: number, color: number) => {
        if (alpha <= 0.003 || !Number.isFinite(transform.slideStart)) return;
        if (time > transform.slideStart + SLIDE + TRACK_TIME) return;
        const from = Math.max(transform.slideStart, time - TRACK_TIME);
        if (time - from < 1e-3) return;
        const samples = Array.from({ length: TRACK_SAMPLES + 1 }, (_, i) => from + ((time - from) * i) / TRACK_SAMPLES);
        const transforms = samples.map(sample => lineTransform(index, sample));
        if (!transforms.some(sample => sample.fly)) return;
        const width = 1.2;
        view.glyphs.forEach(glyph => {
            if (glyph.blank) return;
            let length = 0;
            let previous: Point | null = null;
            samples.forEach((sample, i) => {
                const local = glyphLocal(view, glyph, sample, transforms[i]!);
                const world = toWorld(transforms[i]!, local);
                const wobble = Math.sin(i * 0.9 + glyph.flight.wobble + sample * 6) * heroPx * 0.02;
                const x = world.x + wobble;
                const y = world.y - wobble * 0.6;
                if (previous) {
                    length += Math.hypot(x - previous.x, y - previous.y);
                    trackLayer.lineTo(x, y);
                } else {
                    trackLayer.moveTo(x, y);
                }
                previous = { x, y };
            });
            // 径迹越长（字飞得越快）越亮；几乎不动的字不留径迹。
            const strength = Math.min(1, length / (heroPx * 3));
            trackLayer.stroke({ width, color, alpha: strength > 0.05 ? alpha * 0.55 * strength : 0, cap: 'round', join: 'round' });
        });
    };

    const keywordGlyphs = lines.flatMap(view => view.glyphs.filter(glyph => glyph.keyword !== null));
    let tintedFor: Rgb | null = null;
    /** 关键字在当前光色下的颜色：光色不变时（通常整个单元都不变）只算一次。 */
    const refreshKeywordTints = (litColor: Rgb) => {
        if (tintedFor && tintedFor[0] === litColor[0] && tintedFor[1] === litColor[1] && tintedFor[2] === litColor[2]) return;
        tintedFor = [litColor[0], litColor[1], litColor[2]];
        for (const glyph of keywordGlyphs) glyph.tints = keywordTints(litColor, glyph.keyword!);
    };

    const update = (frame: LyricWindowFrame) => {
        const { time, beams, litColor, unlitColor, unlitAlpha, intensity } = frame;
        trackLayer.clear();
        if (keywordGlyphs.length > 0) refreshKeywordTints(litColor);
        const litHex = hexOf(litColor);
        const starHex = hexOf(mixRgb(litColor, WHITE, 0.5));

        lines.forEach((view, index) => {
            const transform = lineTransform(index, time);
            const { current, scale } = transform;
            const lineAlpha = transform.alpha * intensity;
            const visible = lineAlpha > 0.003;
            view.holder.visible = visible;
            view.holder.position.set(transform.x, transform.y);
            view.holder.scale.set(scale);
            view.holder.rotation = transform.rotation;
            const passed = index < current || (index === current && time > view.line.endTime);
            const passedAge = passed ? time - view.line.endTime : 0;
            const passedDim = passed ? lerp(1, 0.75, clamp01(passedAge / 2.5)) : 1;
            const lineFontPx = heroPx * scale;
            drawTracks(index, view, time, transform, lineAlpha * passedDim, litHex);

            for (const glyph of view.glyphs) {
                if (glyph.blank) continue;
                if (!visible) {
                    glyph.glyph.visible = false;
                    glyph.halo.visible = false;
                    glyph.star.visible = false;
                    continue;
                }
                const local = glyphLocal(view, glyph, time, transform);
                glyph.glyph.position.set(local.x, local.y);
                glyph.glyph.rotation = local.rotation;
                glyph.glyph.scale.set(local.scale / MAX_WORD_SCALE);
                // 这个字实际的字号（光晕、闪点按它定大小）。
                const fontPx = lineFontPx * local.scale;
                const { x: gx, y: gy } = toWorld(transform, local);
                const lit = smooth((time - glyph.timing.start) / Math.max(glyph.timing.end - glyph.timing.start, LIGHT_UP));
                const flash = flashEnvelope(glyph.timing, time, 0.45);
                const illumination = compressLight(lightAt(beams, gx / height, gy / height));
                // 闪点主要由星形小亮点表现，字身只略微提亮：字身一旦接近白色，文字组的强 bloom 会把笔画糊在一起。
                const heat = clamp01(illumination * 1.3 + flash * 0.2);
                // 崩解得越远越淡，像散进烟里。
                const dissolve = 1 - clamp01((decayAmount(decay, glyph.timing.start, time) * glyph.drift.speed - DISSOLVE_FROM) / DISSOLVE_SPAN);
                const glyphAlpha = lineAlpha * passedDim * dissolve * (0.35 + 0.65 * local.gather);

                glyph.glyph.visible = true;
                // 没唱到的字也会被光柱照出来（冷色、半亮），唱到之后才是暖金色并带辉光；飞行中的字像带电粒子一样发亮。
                const revealed = Math.min(1, unlitAlpha + illumination * 0.45 + local.flying * 0.4);
                glyph.glyph.alpha = glyphAlpha * (revealed * (1 - lit) + lit * Math.min(1, 0.55 + 0.4 * heat + 0.3 * local.flying));
                // 关键字：点亮后的字身、光晕、闪点换成关键字光色（未唱时仍是冷色）。
                const tints = glyph.tints;
                const hot = mixRgb(tints ? tints.glyph : litColor, WHITE, clamp01(0.08 * illumination + 0.1 * flash + 0.25 * local.flying));
                const cold = mixRgb(unlitColor, litColor, illumination * 0.35);
                glyph.glyph.tint = hexOf(mixRgb(cold, hot, lit));

                // bloom 已经很强，光晕与闪点只做「局部更亮」的那一点，不能叠成一团白。
                const haloAlpha = glyphAlpha * lit * (0.03 + 0.14 * illumination + 0.08 * flash) * (tints ? KEYWORD_HALO_GAIN : 1);
                glyph.halo.visible = haloAlpha > 0.003;
                if (glyph.halo.visible) {
                    glyph.halo.position.set(gx, gy);
                    const size = fontPx * (2.2 + 0.8 * illumination);
                    glyph.halo.width = size;
                    glyph.halo.height = size * 0.9;
                    glyph.halo.alpha = haloAlpha;
                    glyph.halo.tint = tints ? tints.halo : litHex;
                }

                const starAlpha = lineAlpha * flash * 0.55;
                glyph.star.visible = starAlpha > 0.003;
                if (glyph.star.visible) {
                    // 亮点避开笔画中心，按种子上下错落；闪的过程中略微转动。
                    const star = glyph.starShape;
                    glyph.star.position.set(gx + fontPx * star.dx, gy + fontPx * star.dy);
                    glyph.star.rotation = star.rotation * (1 + (1 - flash) * 0.6);
                    const size = fontPx * star.size * (0.8 + 0.5 * flash);
                    glyph.star.width = size;
                    glyph.star.height = size;
                    glyph.star.alpha = starAlpha;
                    glyph.star.tint = tints ? tints.star : starHex;
                }
            }

            // 追字光斑：沿行内连续移动，并对过去 SPOT_WINDOW 秒的位置取平均（仍只由 t 决定），
            // 字与字之间的停顿、快慢变化都被抹平；唱前 0.3s 淡入，唱完 0.6s 淡出。
            const spotAlpha = visible
                ? lineAlpha * smooth((time - view.singStart + 0.3) / 0.3) * (1 - smooth((time - view.singEnd) / 0.6))
                : 0;
            view.spot.visible = spotAlpha > 0.003;
            if (view.spot.visible) {
                // 光斑沿行心线（横排）或列心线（竖排）按阅读顺序走：折行时走完一行（一列）跳到下一行（下一列）的开头，
                // 两个坐标用同一套插值，跳的那一下也被时间平均抹平。
                const vertical = transform.toOrient >= 0.5;
                const spotOf = (wrap: 0 | 1): Point => {
                    const path = view.flow[vertical ? 1 : 0][wrap].spots;
                    return {
                        x: resolveSpotX(view.glyphs.map(glyph => ({ timing: glyph.timing, center: path[glyph.index]!.x })), time),
                        y: resolveSpotX(view.glyphs.map(glyph => ({ timing: glyph.timing, center: path[glyph.index]!.y })), time),
                    };
                };
                const local = transform.wrap <= 0 ? spotOf(0) : transform.wrap >= 1 ? spotOf(1) : lerpPoint(spotOf(0), spotOf(1), transform.wrap);
                const position = toWorld(transform, local);
                const size = lineFontPx * 5;
                view.spot.position.set(position.x, position.y);
                view.spot.rotation = transform.rotation;
                view.spot.width = size * (vertical ? 1 : 1.6);
                view.spot.height = size * (vertical ? 1.6 : 1);
                view.spot.alpha = 0.07 * spotAlpha;
                view.spot.tint = litHex;
            }
        });
    };

    return {
        view,
        update,
        glyphTimes: lineIndex => (lines[lineIndex]?.glyphs ?? [])
            .map((glyph, glyphIndex) => ({ glyphIndex, start: glyph.timing.start, blank: glyph.blank }))
            .filter(glyph => !glyph.blank)
            .map(({ glyphIndex, start }) => ({ glyphIndex, start })),
        glyphAnchor: (lineIndex, glyphIndex, time) => {
            const transform = lineTransform(lineIndex, time);
            const view = lines[lineIndex]!;
            const local = glyphLocal(view, view.glyphs[glyphIndex]!, time, transform);
            const world = toWorld(transform, local);
            return { x: world.x, y: world.y, fontPx: heroPx * transform.scale * local.scale };
        },
        lineAnchor: (lineIndex, time) => {
            const transform = lineTransform(lineIndex, time);
            return { x: transform.x, y: transform.y, scale: transform.scale, alpha: transform.alpha };
        },
        glyphKeyword: (lineIndex, glyphIndex) => lines[lineIndex]?.glyphs[glyphIndex]?.keyword ?? null,
        destroy: () => {
            view.destroy({ children: true });
            lines.forEach(line => line.layout.destroy());
        },
    };
};
