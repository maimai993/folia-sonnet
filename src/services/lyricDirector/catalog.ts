import { BUILTIN_VISUALIZER_MODES } from '../../types/visualizerModes';
import type { VisualizerMode } from '../../types';
import { MODE_PARAMS as SHARED_MODE_PARAMS } from '../../../shared/stageCatalog.mjs';

// src/services/lyricDirector/catalog.ts
// The parameter space the director may hand to the AI, and the shape it has to
// be validated into before it is written to the player's own settings.
//
// Two things live here that the rest of the app does not have in machine-readable
// form:
//
//   1. A whitelist per mode. The host's setters (`handleSet<Mode>Tuning`) accept
//      any object, and every range is only expressed as a JSDoc comment on the
//      tuning interface plus a `clamp*` in the persistence layer. The AI needs
//      those ranges in the prompt, and an answer needs them enforced afterwards.
//   2. The gates: values that do nothing while a sibling switch is closed
//      (sonnet's film grain behind `postProcessEnabled`, lumiere's graphics
//      behind `textOnly`). The setters never link a value to its switch, so a
//      decision asking for grain alone would be invisible on screen.
//
// Modes come from the built-in list (types/visualizerModes) rather than the live
// registry: this service runs in the renderer without pulling the 14 renderers
// and three.js along, and a built-in feature has no business deciding on a mode
// a mod injected.

export interface DirectorModeInfo {
    id: string;
    label: string;
    hint: string;
}

/** One-line character notes, so the AI can tell the modes apart. */
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
};

/** Chinese names, used in the prompt (it is written in Chinese) and as the UI fallback. */
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
};

/** i18n keys for the UI. `cadenza` is spelled `Cadenze` in the locale files. */
const MODE_LABEL_KEYS: Record<string, string> = {
    still: 'ui.visualizerStill',
    classic: 'ui.visualizerClassic',
    cadenza: 'ui.visualizerCadenze',
    partita: 'ui.visualizerPartita',
    fume: 'ui.visualizerFume',
    cappella: 'ui.visualizerCappella',
    tilt: 'ui.visualizerTilt',
    claddagh: 'ui.visualizerCladdagh',
    monet: 'ui.visualizerMonet',
    diorama: 'ui.visualizerDiorama',
    pendolo: 'ui.visualizerPendolo',
    sonnet: 'ui.visualizerSonnet',
    tempera: 'ui.visualizerTempera',
    lumiere: 'ui.visualizerLumiere',
};

export type DirectorParamSpec =
    | { kind: 'boolean'; zh: string }
    | { kind: 'number'; min: number; max: number; zh: string }
    | { kind: 'select'; options: (string | number)[]; zh: string };

export interface DirectorModeSpec {
    /** The visualizer store action that writes this mode's tuning; null when it has none. */
    setter: string | null;
    params: Record<string, DirectorParamSpec>;
}

/**
 * Per-mode parameter space the AI may touch. Ranges mirror what the host's own
 * setters clamp to, so a decision can never land outside what the sliders can
 * express. Two exceptions, both deliberately *narrower* than the setter:
 * cadenza has no settings panel and its setter only merges, so those four ranges
 * are our own sane bounds; and sonnet's cameraIntensity stops at
 * SONNET_CAMERA_INTENSITY_MAX (types.ts, which explains why).
 */
export const MODE_PARAMS: Record<string, DirectorModeSpec> = SHARED_MODE_PARAMS;

/* `key` is the switch, `mustBe` the value it needs (or `not` the one that
 * blocks), `setTo` what to write when the director has to open it itself. */
export interface DirectorGate {
    key: string;
    mustBe?: unknown;
    not?: unknown;
    setTo?: unknown;
}

const PARAM_GATES: Record<string, Record<string, DirectorGate | DirectorGate[]>> = {
    classic: {
        wordSpacing: { key: 'useLegacyLayout', mustBe: false },
    },
    cappella: {
        emojiPackSource: { key: 'showEmoMessages', mustBe: true },
    },
    monet: {
        audioStyle: { key: 'showAudioVisualization', mustBe: true },
    },
    pendolo: {
        enableLineGlow: { key: 'showGearDecor', not: 'none', setTo: 'subtle' },
    },
    sonnet: {
        postProcessGrain: { key: 'postProcessEnabled', mustBe: true },
        postProcessContrast: { key: 'postProcessEnabled', mustBe: true },
        postProcessRgbShift: { key: 'postProcessEnabled', mustBe: true },
        postProcessHalftone: { key: 'postProcessEnabled', mustBe: true },
        postProcessVignette: { key: 'postProcessEnabled', mustBe: true },
        postProcessLensDistortion: { key: 'postProcessEnabled', mustBe: true },
        postProcessLensDispersion: { key: 'postProcessEnabled', mustBe: true },
        mgDensity: [
            { key: 'showBackgroundMg', mustBe: true },
            { key: 'showOnlyText', mustBe: false },
        ],
        showBackgroundMg: { key: 'showOnlyText', mustBe: false },
        showFixedGeo: { key: 'showOnlyText', mustBe: false },
        showBackgroundDecor: { key: 'showOnlyText', mustBe: false },
        showGuide: { key: 'showOnlyText', mustBe: false },
        outerFrameMode: { key: 'showOnlyText', mustBe: false },
    },
    tempera: {
        postProcessGrain: { key: 'postProcessEnabled', mustBe: true },
        postProcessContrast: { key: 'postProcessEnabled', mustBe: true },
        postProcessRgbShift: { key: 'postProcessEnabled', mustBe: true },
        postProcessVignette: { key: 'postProcessEnabled', mustBe: true },
        postProcessLensDistortion: { key: 'postProcessEnabled', mustBe: true },
    },
    diorama: {
        particleGlowIntensity: { key: 'particleGlowEnabled', mustBe: true },
        glowIntensity: { key: 'glowEnabled', mustBe: true },
        soulIntensity: { key: 'soulEnabled', mustBe: true },
        soulActiveEnabled: { key: 'soulEnabled', mustBe: true },
        gradientIntensity: { key: 'gradientEnabled', mustBe: true },
    },
    lumiere: {
        themeIcons: { key: 'textOnly', mustBe: false },
        echo: { key: 'textOnly', mustBe: false },
        frontBokeh: { key: 'textOnly', mustBe: false },
        lineArt: { key: 'textOnly', mustBe: false },
        moteAmount: { key: 'textOnly', mustBe: false },
        bloom: { key: 'textOnly', mustBe: false },
        fogDensity: { key: 'textOnly', mustBe: false },
        fogOctaves: { key: 'textOnly', mustBe: false },
        overlayFrame: { key: 'textOnly', mustBe: false },
        renderQuality: { key: 'textOnly', mustBe: false },
    },
};

export const gatesFor = (mode: string, key: string): DirectorGate[] => {
    const raw = PARAM_GATES[mode]?.[key];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
};

/** No tuning read means we cannot prove the gate is closed, so we claim nothing. */
export const gateSatisfied = (tuning: Record<string, unknown> | null, gate: DirectorGate): boolean => {
    if (!tuning) return true;
    const value = tuning[gate.key];
    if (gate.not !== undefined) return value !== gate.not;
    return value === gate.mustBe;
};

/* A value that asks for *less* (a switch off, an intensity of zero) needs no gate:
 * turning something off works whether or not the layer behind it is drawn, and
 * opening the gate would contradict the decision. */
export const isInertValue = (param: DirectorParamSpec | undefined, value: unknown): boolean => {
    if (!param) return false;
    if (param.kind === 'boolean') return value === false;
    if (param.kind === 'number') return value === 0;
    return false;
};

/** `handleSetSonnetTuning` -> the store field it writes (`sonnetTuning`). */
export const tuningStateKey = (setter: string | null): string | null => {
    const match = /^handleSet([A-Za-z]+)Tuning$/.exec(String(setter ?? ''));
    if (!match) return null;
    const name = match[1];
    return `${name.charAt(0).toLowerCase()}${name.slice(1)}Tuning`;
};

export const isKnownDirectorMode = (mode: unknown): mode is VisualizerMode => (
    typeof mode === 'string' && (BUILTIN_VISUALIZER_MODES as readonly string[]).includes(mode)
);

/** Whether the user has told the AI never to pick this mode. */
export const isBlockedDirectorMode = (mode: string, blockedModes: readonly string[] | undefined): boolean => (
    Array.isArray(blockedModes) && blockedModes.includes(mode)
);

/** The modes the AI may choose from, with the label to show for each. */
export const listDirectorModes = (t?: (key: string) => string): DirectorModeInfo[] => (
    (BUILTIN_VISUALIZER_MODES as readonly string[]).map((id) => ({
        id,
        label: modeLabel(id, t),
        hint: MODE_HINTS[id] ?? '',
    }))
);

export const modeLabel = (mode: string, t?: (key: string) => string): string => {
    const key = MODE_LABEL_KEYS[mode];
    const translated = t && key ? t(key) : '';
    // A missing translation comes back as the key itself.
    if (translated && translated !== key) return translated;
    return MODE_NAMES[mode] ?? mode;
};

/** One compact string per mode: the prompt has to carry all of them. */
export const buildParamSpec = (): Record<string, string> => {
    const spec: Record<string, string> = {};
    Object.entries(MODE_PARAMS).forEach(([modeId, mode]) => {
        const fields = Object.entries(mode.params).map(([key, param]) => {
            let text: string;
            if (param.kind === 'boolean') text = `${key}(true|false)`;
            else if (param.kind === 'select') text = `${key}(${param.options.join('|')})`;
            else text = `${key}(${param.min}~${param.max})`;
            // Name the switch a value depends on, so the AI can set it in the same
            // decision instead of producing a value that changes nothing on screen.
            const gates = gatesFor(modeId, key);
            if (gates.length > 0) {
                const need = gates.map((gate) => (
                    gate.not !== undefined ? `${gate.key}≠${gate.not}` : `${gate.key}=${gate.mustBe}`
                )).join(' 且 ');
                text += `[需 ${need}]`;
            }
            return text;
        });
        if (fields.length > 0) spec[modeId] = fields.join(' ');
    });
    return spec;
};

const normalizeParam = (param: DirectorParamSpec, value: unknown): unknown => {
    if (param.kind === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return undefined;
    }
    if (param.kind === 'select') {
        if (param.options.includes(value as string | number)) return value;
        const asNumber = Number(value);
        if (Number.isFinite(asNumber) && param.options.includes(asNumber)) return asNumber;
        return undefined;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    return Math.min(param.max, Math.max(param.min, numeric));
};

/**
 * Whitelisted against the mode's spec and clamped to its range. Applied *and*
 * stored in this form, so the memory never carries keys the player cannot
 * express.
 */
export const sanitizeParams = (mode: string, rawParams: unknown): Record<string, unknown> => {
    const spec = MODE_PARAMS[mode];
    if (!spec || !rawParams || typeof rawParams !== 'object') return {};
    const clean: Record<string, unknown> = {};
    Object.entries(rawParams as Record<string, unknown>).forEach(([key, value]) => {
        const param = spec.params[key];
        if (!param) return;
        const normalized = normalizeParam(param, value);
        if (normalized === undefined) return;
        clean[key] = normalized;
    });
    return clean;
};

export const formatParamValue = (value: unknown): string => (
    typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value)
);
