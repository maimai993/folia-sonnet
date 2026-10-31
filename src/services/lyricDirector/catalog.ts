import { BUILTIN_VISUALIZER_MODES } from '../../types/visualizerModes';
import { SONNET_CAMERA_INTENSITY_MAX, type VisualizerMode } from '../../types';

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
    hanabi: '花火粒子与夜空、升空绽放与拼贴，节庆感强',
    prompt: '提示词输入框风格、逐词 token 与卡拉OK进度，极客感',
    nebbia: '雨夜车窗上的手写字、雾气与霓虹，安静',
    machi: '三维街区实景、雨夜霓虹与镜头漫游，电影感与空间感强',
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
    hanabi: '花火',
    prompt: '提示词',
    nebbia: '雾笺',
    machi: '町景',
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
    hanabi: 'ui.visualizerHanabi',
    prompt: 'ui.visualizerPrompt',
    nebbia: 'ui.visualizerNebbia',
    machi: 'ui.visualizerMachi',
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
export const MODE_PARAMS: Record<string, DirectorModeSpec> = {
    classic: {
        setter: 'handleSetClassicTuning',
        params: {
            enableWordRotation: { kind: 'boolean', zh: '逐字旋转' },
            breathingFloatMultiplier: { kind: 'number', min: 0, max: 2, zh: '呼吸浮动' },
            wordSpacing: { kind: 'number', min: 0, max: 2, zh: '词间距' },
            useLegacyLayout: { kind: 'boolean', zh: '旧版排版' },
        },
    },
    cadenza: {
        setter: 'handleSetCadenzaTuning',
        params: {
            fontScale: { kind: 'number', min: 0.6, max: 2, zh: '字号' },
            widthRatio: { kind: 'number', min: 0.3, max: 1, zh: '行宽占比' },
            motionAmount: { kind: 'number', min: 0, max: 2, zh: '运动量' },
            glowIntensity: { kind: 'number', min: 0, max: 2, zh: '光晕强度' },
        },
    },
    partita: {
        setter: 'handleSetPartitaTuning',
        params: {
            showGuideLines: { kind: 'boolean', zh: '参考线' },
            useSemanticLayout: { kind: 'boolean', zh: '语义排版' },
            staggerMin: { kind: 'number', min: 0, max: 180, zh: '入场错开下限' },
            staggerMax: { kind: 'number', min: 0, max: 180, zh: '入场错开上限' },
        },
    },
    fume: {
        setter: 'handleSetFumeTuning',
        params: {
            hidePrintSymbols: { kind: 'boolean', zh: '隐藏印刷符号' },
            disableGeometricBackground: { kind: 'boolean', zh: '关闭几何背景' },
            backgroundObjectOpacity: { kind: 'number', min: 0, max: 1, zh: '背景元素不透明度' },
            textHoldRatio: { kind: 'number', min: 0, max: 1, zh: '文字停留比例' },
            cameraTrackingMode: { kind: 'select', options: ['stepped', 'smooth'], zh: '镜头跟随' },
            cameraSpeed: { kind: 'number', min: 0.55, max: 1.85, zh: '镜头速度' },
            glowIntensity: { kind: 'number', min: 0, max: 1.8, zh: '辉光强度' },
            heroScale: { kind: 'number', min: 0.82, max: 1.32, zh: '主字缩放' },
        },
    },
    claddagh: {
        setter: 'handleSetCladdaghTuning',
        params: {
            focusScaleRatio: { kind: 'number', min: 0, max: 1.5, zh: '聚焦缩放' },
            radiusScale: { kind: 'number', min: 0.5, max: 1.5, zh: '环半径' },
            ellipseTiltDeg: { kind: 'number', min: 0, max: 60, zh: '环倾角' },
            showAxisLine: { kind: 'boolean', zh: '轴线' },
            letterSpacingOffset: { kind: 'number', min: -5, max: 20, zh: '字距偏移' },
        },
    },
    cappella: {
        setter: 'handleSetCappellaTuning',
        params: {
            showEmoMessages: { kind: 'boolean', zh: '表情消息' },
            emojiPackSource: { kind: 'select', options: ['builtin', 'custom'], zh: '表情包来源' },
            avatarSource: { kind: 'select', options: ['builtin', 'cover', 'color', 'custom'], zh: '头像来源' },
        },
    },
    tilt: {
        setter: 'handleSetTiltTuning',
        params: {
            splitProbability: { kind: 'number', min: 0, max: 1, zh: '裂开概率' },
            tiltStyleProbability: { kind: 'number', min: 0, max: 1, zh: '倾斜样式概率' },
            colorScheme: { kind: 'select', options: ['default', 'swap', 'accentAll', 'primaryAll'], zh: '配色方案' },
        },
    },
    monet: {
        setter: 'handleSetMonetTuning',
        params: {
            showDescription: { kind: 'boolean', zh: '显示简介' },
            fontScale: { kind: 'number', min: 0.7, max: 1.5, zh: '字号' },
            portraitStyle: { kind: 'select', options: ['square', 'rectangular'], zh: '封面样式' },
        },
    },
    diorama: {
        setter: 'handleSetDioramaTuning',
        params: {
            cameraSpeed: { kind: 'number', min: 0.55, max: 1.85, zh: '镜头速度' },
            motionAmount: { kind: 'number', min: 0.4, max: 1.6, zh: '运动量' },
            audioReactivity: { kind: 'number', min: 0, max: 1.5, zh: '音频响应' },
            particleScale: { kind: 'number', min: 0.65, max: 1.6, zh: '粒子缩放' },
            showParticles: { kind: 'boolean', zh: '显示粒子' },
            glowEnabled: { kind: 'boolean', zh: '普通辉光跟唱' },
            glowIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '辉光强度' },
            soulEnabled: { kind: 'boolean', zh: '灵魂出窍跟唱' },
            soulIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '灵魂出窍强度' },
            gradientEnabled: { kind: 'boolean', zh: '渐变跟唱' },
            gradientIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '渐变强度' },
            soulActiveEnabled: { kind: 'boolean', zh: '当前字跟随漂移' },
            particleGlowEnabled: { kind: 'boolean', zh: '粒子光晕' },
            particleGlowIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '粒子光晕强度' },
        },
    },
    pendolo: {
        setter: 'handleSetPendoloTuning',
        params: {
            arcRadius: { kind: 'number', min: 0.25, max: 0.8, zh: '弧半径' },
            arcAngleDeg: { kind: 'number', min: 40, max: 160, zh: '弧角度' },
            tickSnappiness: { kind: 'number', min: 0.5, max: 2, zh: '走时干脆度' },
            activeScale: { kind: 'number', min: 1, max: 1.6, zh: '当前行缩放' },
            showGearDecor: { kind: 'select', options: ['none', 'subtle', 'full'], zh: '齿轮装饰' },
            showCenterGradient: { kind: 'boolean', zh: '中心渐变' },
            showCoverOnWatchFace: { kind: 'boolean', zh: '表盘显示封面' },
            enableLineGlow: { kind: 'boolean', zh: '行发光' },
        },
    },
    sonnet: {
        setter: 'handleSetSonnetTuning',
        params: {
            cameraIntensity: { kind: 'number', min: 0, max: SONNET_CAMERA_INTENSITY_MAX, zh: '相机强度' },
            typographyMotion: { kind: 'number', min: 0, max: 2, zh: '字体运动' },
            mgDensity: { kind: 'number', min: 0, max: 2, zh: '动图密度' },
            showOnlyText: { kind: 'boolean', zh: '只显示文字' },
            showGuide: { kind: 'boolean', zh: '参考线' },
            showBackgroundMg: { kind: 'boolean', zh: '背景动图' },
            showFixedGeo: { kind: 'boolean', zh: '固定几何' },
            showGiantDecorativeText: { kind: 'boolean', zh: '巨型装饰字' },
            showBackgroundDecor: { kind: 'boolean', zh: '背景装饰' },
            enableTransitions: { kind: 'boolean', zh: '转场' },
            outerFrameMode: { kind: 'select', options: ['none', 'frame', 'full'], zh: '外框' },
            textureResolution: { kind: 'number', min: 0.5, max: 4, zh: '纹理分辨率' },
            postProcessEnabled: { kind: 'boolean', zh: '后处理总开关' },
            postProcessGrain: { kind: 'number', min: 0, max: 1, zh: '胶片颗粒' },
            postProcessContrast: { kind: 'number', min: 0, max: 1, zh: '对比度' },
            postProcessRgbShift: { kind: 'number', min: 0, max: 1, zh: 'RGB 偏移' },
            postProcessHalftone: { kind: 'number', min: 0, max: 1, zh: '半调网屏' },
            postProcessVignette: { kind: 'number', min: 0, max: 2, zh: '暗角' },
            postProcessLensDistortion: { kind: 'number', min: 0, max: 2, zh: '镜头畸变' },
            postProcessLensDispersion: { kind: 'number', min: 0, max: 1, zh: '镜头色散' },
        },
    },
    tempera: {
        setter: 'handleSetTemperaTuning',
        params: {
            cameraIntensity: { kind: 'number', min: 0, max: 2, zh: '相机强度' },
            glyphMotion: { kind: 'number', min: 0, max: 2, zh: '逐字入场' },
            wholeLineLyrics: { kind: 'boolean', zh: '整行不切分' },
            glyphSettleStretch: { kind: 'number', min: 0, max: 1, zh: '逐字入场时序' },
            colorMode: { kind: 'select', options: ['duo', 'mono', 'gradient'], zh: '配色模式' },
            showBlocks: { kind: 'boolean', zh: '色块' },
            showDecor: { kind: 'boolean', zh: '装饰' },
            showCornerMarks: { kind: 'boolean', zh: '角标' },
            textInversion: { kind: 'boolean', zh: '文字动态反色' },
            enableTransitions: { kind: 'boolean', zh: '转场' },
            textureResolution: { kind: 'number', min: 0.5, max: 4, zh: '纹理分辨率' },
            postProcessEnabled: { kind: 'boolean', zh: '后处理总开关' },
            postProcessGrain: { kind: 'number', min: 0, max: 1, zh: '颗粒' },
            postProcessContrast: { kind: 'number', min: 0, max: 1, zh: '对比度' },
            postProcessRgbShift: { kind: 'number', min: 0, max: 1, zh: 'RGB 偏移' },
            postProcessVignette: { kind: 'number', min: 0, max: 2, zh: '暗角' },
            postProcessLensDistortion: { kind: 'number', min: 0, max: 2, zh: '镜头畸变' },
        },
    },
    hanabi: {
        setter: 'handleSetHanabiTuning',
        params: {
            sparkAmount: { kind: 'number', min: 0, max: 2, zh: '火星数量' },
            ornamentAmount: { kind: 'number', min: 0, max: 2, zh: '装饰数量' },
            textMotion: { kind: 'number', min: 0, max: 2, zh: '文字动势' },
            blockOpacity: { kind: 'number', min: 0, max: 1, zh: '色块不透明度' },
            riseSpeed: { kind: 'number', min: 0, max: 2, zh: '上升速度' },
            spin: { kind: 'number', min: 0, max: 2, zh: '旋转' },
            ambient: { kind: 'number', min: 0, max: 2, zh: '环境光' },
            glow: { kind: 'number', min: 0, max: 2, zh: '辉光' },
            bloom: { kind: 'number', min: 0, max: 2, zh: '泛光' },
            chorusBloom: { kind: 'number', min: 0, max: 2, zh: '副歌泛光' },
            sky: { kind: 'number', min: 0, max: 1, zh: '夜空浓度' },
            collage: { kind: 'number', min: 0, max: 2, zh: '拼贴密度' },
            launches: { kind: 'boolean', zh: '升空尾迹' },
            overlayFrame: { kind: 'boolean', zh: '画面边框' },
            textOnly: { kind: 'boolean', zh: '仅歌词文字' },
            colorMode: { kind: 'select', options: ['mixed', 'vivid', 'theme'], zh: '配色' },
            renderQuality: { kind: 'select', options: ['full', 'balanced', 'low'], zh: '画质' },
        },
    },
    lumiere: {
        setter: 'handleSetLumiereTuning',
        params: {
            lightIntensity: { kind: 'number', min: 0.3, max: 2, zh: '光强' },
            audioResponse: { kind: 'number', min: 0, max: 2, zh: '随音乐变亮' },
            fogDensity: { kind: 'number', min: 0, max: 2, zh: '烟雾浓度' },
            fogOctaves: { kind: 'number', min: 2, max: 6, zh: '烟雾细节' },
            moteAmount: { kind: 'number', min: 0, max: 2, zh: '浮尘数量' },
            bloom: { kind: 'number', min: 0, max: 2, zh: '图形辉光' },
            textBloom: { kind: 'number', min: 0, max: 2, zh: '文字辉光' },
            unlitOpacity: { kind: 'number', min: 0.05, max: 0.6, zh: '未唱字透明度' },
            darkField: { kind: 'number', min: 0, max: 1, zh: '暗场强度' },
            decay: { kind: 'number', min: 0, max: 2, zh: '崩解强度' },
            echo: { kind: 'number', min: 0, max: 2, zh: '背景歌词亮度' },
            windowNeighbors: { kind: 'select', options: [1, 2], zh: '邻行数' },
            lineArt: { kind: 'boolean', zh: '线稿' },
            frontBokeh: { kind: 'boolean', zh: '前景散景' },
            trails: { kind: 'boolean', zh: '轨迹线' },
            seamlessTransitions: { kind: 'boolean', zh: '无缝转场' },
            overlayFrame: { kind: 'boolean', zh: '画框' },
            textOnly: { kind: 'boolean', zh: '仅歌词文字' },
            themeIcons: { kind: 'boolean', zh: '主题图标' },
            themeColorMix: { kind: 'number', min: 0, max: 1, zh: '主题色占比' },
            renderQuality: { kind: 'select', options: ['full', 'balanced', 'low'], zh: '画质' },
        },
    },
    nebbia: {
        setter: 'handleSetNebbiaTuning',
        params: {
            credits: { kind: 'boolean', zh: '结尾写曲名与歌手' },
            jitter: { kind: 'number', min: 0, max: 1.5, zh: '手写歪斜' },
            warp: { kind: 'number', min: 0, max: 1.5, zh: '手写变形' },
            mist: { kind: 'number', min: 0.2, max: 1, zh: '雾气浓度' },
            hold: { kind: 'number', min: 0, max: 6, zh: '下一句开始后保持' },
            refog: { kind: 'number', min: 0.5, max: 12, zh: '重新起雾用时' },
            strokeWidth: { kind: 'number', min: 0.04, max: 0.16, zh: '笔画粗细' },
            writeSpeed: { kind: 'number', min: 0.4, max: 2.5, zh: '书写速度' },
            doodle: { kind: 'number', min: 0, max: 1, zh: '句尾画图标' },
            busSpeed: { kind: 'number', min: 0, max: 3, zh: '车速' },
            neon: { kind: 'number', min: 0, max: 2, zh: '霓虹' },
            spot: { kind: 'number', min: 0, max: 2, zh: '聚光灯' },
            spotX: { kind: 'number', min: 0, max: 1, zh: '聚光灯横向位置' },
            rainHit: { kind: 'number', min: 0, max: 3, zh: '雨点打在玻璃上' },
            rainBig: { kind: 'number', min: 0, max: 2, zh: '吐字时的大雨点' },
            bump: { kind: 'number', min: 0, max: 2.5, zh: '颠簸' },
            resolution: { kind: 'number', min: 0.5, max: 2, zh: '渲染分辨率' },
        },
    },
    machi: {
        setter: 'handleSetMachiTuning',
        params: {
            motion: { kind: 'boolean', zh: '运镜' },
            motionSpeed: { kind: 'number', min: 0.25, max: 3, zh: '运镜速度' },
            gyro: { kind: 'boolean', zh: '陀螺仪适配' },
            aperture: { kind: 'number', min: 1.4, max: 16, zh: '光圈' },
            dof: { kind: 'number', min: 0, max: 2, zh: '景深强度' },
            dofRange: { kind: 'number', min: 0.3, max: 3, zh: '景深范围' },
            tiltShift: { kind: 'number', min: 0, max: 1, zh: '移轴' },
            focusOffset: { kind: 'number', min: -10, max: 10, zh: '对焦点偏移' },
        },
    },
    still: { setter: null, params: {} },
    // 提示词模式自己没有可调的参数（框的几何跟着歌词走），但它是个合法的导演目标 ——
    // 内建清单里有它，`isKnownDirectorMode` 就会放行，所以这里必须有一格空的，
    // 否则「AI 选了提示词却拿不到任何参数」是唯一没有登记的模式。与 still 同形。
    prompt: { setter: null, params: {} },
};

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
