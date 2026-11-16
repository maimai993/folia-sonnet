import type { MotionValue } from 'framer-motion';
import type { Theme } from '../../../types';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { loadPixi } from '../pixi/loadPixi';
import { makePixiContext } from '../pixi/pixiWebGLContext';
import { linkPixiPrograms } from '../pixi/pixiProgramLinks';
import { resolveWordColor } from '../wordColoring';
import { buildPromptCard, PROMPT_MONO_STACK, PROMPT_PALETTE, type PromptCardView } from './promptBox';
import type { PromptBoxPlan } from './promptProgram';
import { readEffectTrack } from '../../../services/beatFx/effectTracks';
import { getBeatEffectStrength } from '../../../services/beatFx/beatFxLive';
import { BEAT_EFFECT_IDS } from '../../../services/beatFx/beatEffects';

// src/components/visualizer/prompt/createPromptPixiRuntime.ts
// 「提示词」样式自己的 Pixi 运行时。它不认商籁那套节目单（场景 / 镜头 / 排版），只做三件事：
//
//   1. 收下 promptProgram 编译好的节目单（一句一个框）；
//   2. 按播放时间挑出此刻该在台上的那一句，交给 promptBox 搭出「一块小悬浮窗 + 逐词下划线」；
//   3. 驱动**镜头**：整块窗跟着唱到的位置推近、横移 —— 不是让字在窗里自己滚。
//
// 字号：基础值只跟屏宽和「歌词字号」那个全局系数走；一句太长按比例缩，**缩到底就不再缩**，
// 剩下的靠镜头横移。字少的时候**绝不放大**（两个字撑满一屏就是「字少时太难看」）。
type PixiModule = typeof import('pixi.js');

/** 量宽用的参考字号：先按 100 量出逐词宽度，再按真实字号线性缩放。 */
const FONT_BASE = 100;
/** 一个词从「没出现」到「全亮」用多久。 */
const WORD_REVEAL_S = 0.09;
/**
 * 镜头推近后，**画面里只想留下这一句的这么多**（剩下的在窗里被裁掉，靠横移一路看过去）。
 * 0.78 = 一屏里能看到大半句 —— 跟得不那么紧，字也就不会显得那么大。
 */
const FOCUS_RATIO = 0.78;
/** 再怎么推近，一屏里至少也要留下内容区的这么多 —— 不然长句会放大得只剩一两个字。 */
const MIN_VISIBLE_RATIO = 0.6;
/**
 * 推近的上限，**按屏宽分档**：屏幕越宽，同样的倍率意味着字在物理尺寸上越大。
 * 手机上 2 倍刚好；手机横屏（屏宽 640+）画面本来就矮，再贴脸字就顶到上下边了；
 * 平板（1000+）更是要退开一点。
 */
const zoomCapFor = (width: number): number => (
    width >= 1000 ? 1.35 : width >= 640 ? 1.5 : 2
);
/**
 * 字的纹理按这个倍数先烤大再缩回去。
 *
 * 镜头会把整块窗放大到 2 倍，而 Text 是 resolution 1 烤的 —— 拿原尺寸的纹理放大就是
 * 一张糊字。所以字按 2 倍字号烤、节点再 scale 回 1/2：屏幕上放大到 2 倍时正好用满纹理。
 */
const BAKE_ZOOM = 2;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const progressOf = (time: number, start: number, end: number) => (
    end <= start ? (time >= end ? 1 : 0) : clamp01((time - start) / (end - start))
);
const easeOutExpo = (value: number) => (value >= 1 ? 1 : 1 - Math.pow(2, -10 * value));
const easeInCubic = (value: number) => value * value * value;
const easeInOutCubic = (value: number) => (
    value <= 0 ? 0 : value >= 1 ? 1
        : value < 0.5 ? 4 * value * value * value
            : 1 - Math.pow(-2 * value + 2, 3) / 2
);

/**
 * 主题色 → pixi 色号。**必须提亮到看得见**：AI 主题的 primaryColor 常常是近黑的深色，
 * 直接拿去画字就是「黑底黑字」—— 看起来和没画一样，而且不报错。所以按亮度兜一道底，
 * 太暗就往骨白提，保住色相。
 */
const themeColor = (pixi: PixiModule, value: string | undefined, fallback: string, minLum: number): number => {
    const shared = pixi.Color.shared;
    let color: import('pixi.js').Color;
    try {
        color = shared.setValue(value || fallback);
    } catch {
        color = shared.setValue(fallback);
    }
    const { red, green, blue } = color;
    const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    if (!Number.isFinite(lum)) return shared.setValue(fallback).toNumber();
    if (lum >= minLum) return color.toNumber();
    const lift = (minLum + 0.08 - lum) / Math.max(1e-4, 1 - lum);
    return shared.setValue([
        red + (0.95 - red) * lift,
        green + (0.95 - green) * lift,
        blue + (0.95 - blue) * lift,
    ]).toNumber();
};

/** 一首歌的全部输入。整体换掉意味着换歌。 */
export interface PromptSongContext {
    seed: string | number | undefined;
    boxes: PromptBoxPlan[];
    theme: Theme;
    /** 设置里那个「歌词字号」系数（别的样式都乘它，这里也必须乘）。 */
    fontScale: number;
}

export interface PromptRuntimeOptions {
    host: HTMLDivElement;
    song: PromptSongContext;
    currentTime: MotionValue<number>;
    paused: boolean;
    /** 减少动感：不做镜头推拉。 */
    staticMode: boolean;
    signal?: AbortSignal;
}

interface WordBox {
    text: string;
    left: number;
    width: number;
    startTime: number;
    endTime: number;
}

interface BuiltWord {
    node: import('pixi.js').Text;
    box: WordBox;
}

/** 唱完一个词之后飞出去的那个「残影」：位置/速度/出生时间都由这里记着。 */
interface GhostWord {
    node: import('pixi.js').Text;
    originX: number;
    vx: number;
    vy: number;
    born: number;
    life: number;
}

interface BuiltBox {
    /** 镜头：整块窗挂在它下面，推近/横移都动它。 */
    root: import('pixi.js').Container;
    card: PromptCardView;
    words: BuiltWord[];
    caret: import('pixi.js').Graphics;
    tokens: WordBox[];
    fontPx: number;
    /** 可横移的余量（内容比窗能装的多出来的部分）。 */
    overflow: number;
    /** 内容区宽度：镜头横移的参照系。 */
    span: number;
    /** 内容实际占多宽（可能大于 span —— 那就是被裁在窗外的部分）。 */
    contentWidth: number;
    /** 已经放出去残影的词（一个词只飞一次）。 */
    spawned: boolean[];
    ghosts: GhostWord[];
    /** 造残影用的字样式（和正文同一套，只是换了色/透明度）。 */
    wordStyle: import('pixi.js').TextStyle;
    wordPad: number;
    /** 这一句的种子：残影往哪边飞按它定，不同句子的轨迹不一样。 */
    seed: number;
    startTime: number;
    endTime: number;
}

export class PromptPixiRuntime {
    private readonly boxes = new Map<number, BuiltBox>();
    /** 高亮色缓存：主题与 wordColors 都没换就直接命中（见 highlightOf）。 */
    private highlightTheme: Theme | null = null;
    private highlightColors: Theme['wordColors'] | null = null;
    private highlightCount = 0;
    /** 值可以是 null：「这个词没有高亮色」也要缓存住，否则每帧重算一遍。 */
    private highlightMap = new Map<string, number | null>();
    private destroyed = false;
    private resizeObserver: ResizeObserver | null = null;
    private lastWidth = 0;
    private lastHeight = 0;

    private stage!: import('pixi.js').Container;

    private constructor(
        private readonly pixi: PixiModule,
        private readonly options: PromptRuntimeOptions,
        private readonly app: import('pixi.js').Application,
    ) { }

    static async create(options: PromptRuntimeOptions) {
        const pixi = await loadPixi();
        // 窗是自己画墨底的，画布本身要透明（底下是 VisualizerShell 的背景）。
        const contextOptions = {
            backgroundAlpha: 0,
            antialias: true,
            powerPreference: 'high-performance',
        } as const;
        const context = await makePixiContext(pixi, contextOptions, options.signal);
        const app = new pixi.Application();
        const width = Math.max(options.host.clientWidth, 320);
        const height = Math.max(options.host.clientHeight, 240);
        await app.init({
            width,
            height,
            ...contextOptions,
            ...context,
            autoDensity: true,
            resolution: clamp(window.devicePixelRatio || 1, 1, 2),
            autoStart: false,
            sharedTicker: false,
            preference: 'webgl',
        });
        const runtime = new PromptPixiRuntime(pixi, options, app);
        runtime.stage = new pixi.Container();
        app.stage.addChild(runtime.stage);

        if (options.signal?.aborted) {
            runtime.destroy();
            throw new DOMException('Prompt runtime creation was cancelled', 'AbortError');
        }
        await runtime.install();
        if (options.signal?.aborted) {
            runtime.destroy();
            throw new DOMException('Prompt runtime creation was cancelled', 'AbortError');
        }
        return runtime;
    }

    /**
     * 首帧分几个任务做：先按真实尺寸搭好第一个框并画一帧，再让程序在页面继续跑的时候链接，
     * 最后才把画布挂进页面。和商籁同一条路径（见 pixiProgramLinks）。
     */
    private async install() {
        await new Promise((resolve) => { window.setTimeout(resolve); });
        if (this.options.signal?.aborted) return;
        this.resizeToHost();
        this.renderFrame();
        await linkPixiPrograms(this.pixi, this.app.renderer, this.app.stage, 'Prompt', this.options.signal);
        if (this.options.signal?.aborted) return;
        this.options.host.appendChild(this.app.canvas);
        this.app.canvas.style.cssText = 'width:100%;height:100%;display:block';
        this.app.ticker.add(this.renderFrame);
        this.resizeObserver = new ResizeObserver(() => {
            if (this.destroyed || !this.resizeToHost()) return;
            if (this.options.paused) this.renderOnce();
        });
        this.resizeObserver.observe(this.options.host);
        this.app.renderer.render(this.app.stage);
        if (!this.options.paused) this.app.start();
    }

    private resizeToHost() {
        if (this.destroyed) return false;
        const width = Math.max(this.options.host.clientWidth, 320);
        const height = Math.max(this.options.host.clientHeight, 240);
        if (width === this.lastWidth && height === this.lastHeight) return false;
        this.lastWidth = width;
        this.lastHeight = height;
        this.app.renderer.resize(width, height);
        // 窗宽、字号、下划线都按屏宽解，尺寸一变就得重搭。
        this.clearBoxes();
        return true;
    }

    private clearBoxes() {
        this.boxes.forEach(box => this.destroyBox(box));
        this.boxes.clear();
    }

    private destroyBox(box: BuiltBox) {
        this.stage.removeChild(box.root);
        // 逐节点销毁：destroy({children:true}) 会留下每个 Text 自建纹理的引用。
        box.words.forEach(word => word.node.destroy());
        box.caret.destroy();
        box.card.root.destroy({ children: true });
        box.root.destroy({ children: false });
    }

    /** 主题字色与强调色：每搭一次框读一次（主题换了下一次搭框就跟上）。 */
    private palette() {
        const { theme } = this.options.song;
        return {
            text: themeColor(this.pixi, theme?.primaryColor, PROMPT_PALETTE.bone, 0.62),
            accent: themeColor(this.pixi, theme?.accentColor, PROMPT_PALETTE.signal, 0.4),
        };
    }

    /** 歌词字体：跟主题那个字体选项走（不再是写死的等宽）。 */
    private fontFamily() {
        return resolveThemeFontStack(this.options.song.theme) || PROMPT_MONO_STACK;
    }

    private fontWeight() {
        return resolveThemeFontWeight(this.options.song.theme, 600);
    }

    /**
     * 基础字号：屏宽 × 系数 × 设置里的「歌词字号」。
     * **不按内容反解**：字少的时候它就是这个值，不会被放大成两屏高；太长由 promptBox 按比例缩。
     */
    private baseFontPx() {
        const scale = Number.isFinite(this.options.song.fontScale) ? this.options.song.fontScale : 1;
        /*
         * ⭐参照的是**较短的那一边**，不是屏宽。
         *
         * 按屏宽算的话，横屏一转、平板一上，字号就跟着胀（平板上更是直接顶到上限）——
         * 而横屏时画面**矮**得多，字一大就顶到上下边。拿 min(宽, 高×1.25) 当参照，
         * 竖屏（高比宽大得多）取到的还是屏宽、和以前一样；横屏取到的是高度那边，字就收回来了。
         */
        const reference = Math.min(this.lastWidth, Math.max(240, this.lastHeight) * 1.25);
        return clamp(reference * 0.072 * clamp(scale, 0.4, 2.4), 16, 60);
    }

    /** 窗最多能有多宽：留出两边的呼吸位，别顶到屏幕边。平板能宽一点。 */
    private maxWindowWidth() {
        return clamp(this.lastWidth * 0.86, 200, 900);
    }

    private buildBox(plan: PromptBoxPlan, index: number): BuiltBox {
        const { Container, Graphics, Text, TextStyle } = this.pixi;
        const colors = this.palette();
        const height = Math.max(240, this.lastHeight);

        const root = new Container();
        root.position.set(this.lastWidth / 2, height / 2);

        const card = buildPromptCard(this.pixi, {
            maxWidth: this.maxWindowWidth(),
            fontPx: this.baseFontPx(),
            accent: colors.accent,
            textColor: colors.text,
            fontFamily: this.fontFamily(),
            fontWeight: this.fontWeight(),
            tokens: plan.words.map(word => ({ text: word.text, startTime: word.startTime, endTime: word.endTime })),
        });
        root.addChild(card.root);

        /*
         * 字：白色纹理 + tint —— 主题色、AI 高亮色都只是换个 tint，不用重烤纹理。
         * 发光用 dropShadow（canvas 的 shadowBlur，distance 0）烤进同一张纹理，比复制一层字
         * 挂 BlurFilter 便宜得多；padding 给光晕留位置，字形会因此内缩，所以每个词往左补回去。
         */
        const wordPad = Math.round(clamp(card.fontPx * 0.09, 6, 40));
        const wordStyle = new TextStyle({
            fontFamily: this.fontFamily(),
            fontWeight: this.fontWeight() as never,
            fontSize: card.fontPx * BAKE_ZOOM,
            fill: '#ffffff',
            padding: wordPad * BAKE_ZOOM,
            dropShadow: {
                color: '#ffffff',
                alpha: 0.7,
                blur: Math.max(6, card.fontPx * 0.055) * BAKE_ZOOM,
                distance: 0,
                angle: 0,
            },
        });

        const tokens: WordBox[] = plan.words.map((word, slot) => ({
            text: word.text,
            left: card.laid[slot]?.left ?? 0,
            width: card.laid[slot]?.width ?? 0,
            startTime: word.startTime,
            endTime: word.endTime,
        }));
        const words: BuiltWord[] = tokens.map(token => {
            // resolution 1：字大到几十上百 px，按设备像素比烤纹理一张就是好几兆；带发光看不出软。
            const node = new Text({ text: token.text, style: wordStyle, resolution: 1 });
            node.anchor.set(0, 0.5);
            node.position.set(token.left - wordPad, 0);
            // 纹理是按 BAKE_ZOOM 倍字号烤的，缩回去才是设计字号；镜头推近时才有像素可用。
            node.scale.set(1 / BAKE_ZOOM);
            node.visible = false;
            return { node, box: token };
        });
        words.forEach(word => card.textLayer.addChild(word.node));

        const caret = new Graphics()
            .rect(0, 0, Math.max(2, card.fontPx * 0.045), card.fontPx * 0.78)
            .fill({ color: colors.accent, alpha: 1 });
        caret.pivot.set(0, card.fontPx * 0.39);
        caret.alpha = 0;
        card.textLayer.addChild(caret);

        this.stage.addChild(root);
        const span = card.contentSpan;
        return {
            root,
            card,
            words,
            caret,
            tokens,
            fontPx: card.fontPx,
            overflow: Math.max(0, card.contentWidth - span),
            span,
            contentWidth: card.contentWidth,
            spawned: tokens.map(() => false),
            ghosts: [],
            wordStyle,
            wordPad,
            seed: plan.vocabSeed,
            startTime: plan.startTime,
            endTime: plan.endTime,
        };
    }

    /**
     * 唱完一个词，就从它原来的位置放一个「残影」飞出去 —— 参考项目里那些从输入框里飘走的字。
     * 方向按词的序号左右交替，速度也一样，所以同一句每次重放飞的是同一批轨迹。
     */
    private spawnGhost(box: BuiltBox, index: number, time: number) {
        const token = box.tokens[index];
        if (!token) return;
        const { Text } = this.pixi;
        /*
         * 起点要**夹在窗的内容区里**。
         *
         * 残影那层不裁（它就是要飘出框外的），但它的起点是词本来的位置 —— 一句装不下时
         * 后面的词本来就在窗外（正文被 mask 裁掉，所以看不见），残影却照原位置生成，
         * 于是凭空在窗外、甚至屏幕外冒出一行字（英文歌最明显：词又多又宽）。
         * 夹回内容区之后，残影一律从框里飞出去，这才是要的效果。
         */
        const startX = clamp(token.left, 0, Math.max(0, box.span));
        const node = new Text({ text: token.text, style: box.wordStyle, resolution: 1 });
        node.anchor.set(0, 0.5);
        node.position.set(startX - box.wordPad, 0);
        node.scale.set(1 / BAKE_ZOOM);
        node.tint = this.palette().accent;
        node.alpha = 0.7;
        // 残影挂 ghostLayer（不裁在窗里）—— 它本来就是要飘到框外面去的。
        box.card.ghostLayer.addChild(node);
        // 方向由这一句的种子定：同一句每次重放飞同一条轨迹，不同句子左右不同。
        const dir = ((box.seed >>> ((index % 8) * 3)) & 1) === 0 ? -1 : 1;
        box.ghosts.push({
            node,
            originX: node.x,
            vx: dir * (18 + (index % 3) * 14),
            vy: -(58 + (index % 4) * 12),
            born: time,
            life: 0.85,
        });
    }

    /** 残影：往斜上飘、边飘边淡、稍微放大一点，飘完就销毁。 */
    private updateGhosts(box: BuiltBox, time: number) {
        for (let index = box.ghosts.length - 1; index >= 0; index -= 1) {
            const ghost = box.ghosts[index];
            const age = time - ghost.born;
            const progress = clamp01(age / ghost.life);
            if (age > ghost.life || age < 0) {
                ghost.node.destroy();
                box.ghosts.splice(index, 1);
                continue;
            }
            ghost.node.x = ghost.originX + ghost.vx * age;
            ghost.node.y = ghost.vy * age * (1 - 0.35 * progress);
            ghost.node.alpha = 0.7 * (1 - progress) * (1 - progress);
            ghost.node.scale.set((1 + 0.12 * progress) / BAKE_ZOOM);
        }
    }

    /**
     * 推近的倍数：按「一屏里想留下多少歌词」反解。
     *
     * 窗放大 zoom 倍之后，屏幕上能看到窗内的宽度 = 屏宽 / zoom（窗坐标）。
     * 想让这一句在镜头里只露出 FOCUS_RATIO 那么多（剩下的靠横移一路看过去），
     * zoom 就等于 屏宽 / 想露出的宽度。
     *
     * 竖屏太矮时再按高度夹一道：整块窗放大后高过屏幕的话上下会被切掉。
     */
    private zoomFor(box: BuiltBox, card: PromptCardView) {
        const screenW = Math.max(320, this.lastWidth);
        const want = clamp(box.contentWidth * FOCUS_RATIO, card.contentSpan * MIN_VISIBLE_RATIO, card.contentSpan);
        const byWidth = screenW / Math.max(1, want);
        const byHeight = Math.max(240, this.lastHeight) * 0.92 / Math.max(1, card.windowHeight);
        return clamp(Math.min(byWidth, byHeight), 1, zoomCapFor(screenW));
    }

    /** 句尾「瞬间拉回看清整行」的倍数：整行装得下就是 1，装不下就退到刚好装下的那一档。 */
    private zoomOutFor(box: BuiltBox, card: PromptCardView) {
        return clamp(card.contentSpan / Math.max(1, box.contentWidth), 0.5, 1);
    }

    /** 此刻台上是第几句：取「最后一个已经开唱」的；都还没到就是第一句（它自己还在场外，画不出来）。 */
    private indexAt(time: number) {
        const { boxes } = this.options.song;
        let index = 0;
        for (let cursor = 0; cursor < boxes.length; cursor += 1) {
            if (boxes[cursor].startTime <= time) index = cursor;
            else break;
        }
        return index;
    }

    private ensure(index: number): BuiltBox | null {
        const existing = this.boxes.get(index);
        if (existing) return existing;
        const plan = this.options.song.boxes[index];
        if (!plan) return null;
        const built = this.buildBox(plan, index);
        this.boxes.set(index, built);
        return built;
    }

    private prune(active: number) {
        this.boxes.forEach((box, index) => {
            if (Math.abs(index - active) <= 1) return;
            this.destroyBox(box);
            this.boxes.delete(index);
        });
    }

    /*
     * 词 → AI 标的高亮色。整行同色会很花，所以只给「被 AI 标过的词」备一份。
     *
     * ⭐按**主题对象的引用**缓存，但**每帧都重新问一次** —— 不能只在搭框时读一次：
     * AI 主题的 `wordColors` 常常比颜色晚到（叠层那一侧尤其：主题是先推一份、再补 AI 那份），
     * 而换主题并不会重建框（见 swapSong 的 sameLook），晚到的那份于是永远用不上 ——
     * 表现就是「播放页有 AI 高亮、桌面叠层一点没有」。
     * 主题对象没换就直接命中缓存，一帧一次 Map 查找，不贵。
     */
    private highlightOf(text: string): number | null {
        const theme = this.options.song.theme;
        const key = text.trim();
        if (!key) return null;
        const colors = theme?.wordColors;
        /*
         * 缓存失效看三样：主题对象、**wordColors 这份数组**、以及它的长度。
         *
         * 只看主题对象是不够的：叠层那一侧主题常常是「先推一份、再补 AI 那份」，
         * 补的时候可能还在同一个对象上 —— 缓存不失效，先前算出的「没高亮」就
         * 永远钉在这个词上（AI 那份到得再晚也用不上）。
         */
        if (this.highlightTheme !== theme || this.highlightColors !== colors
            || this.highlightCount !== (colors?.length ?? 0)) {
            this.highlightTheme = theme;
            this.highlightColors = colors;
            this.highlightCount = colors?.length ?? 0;
            this.highlightMap = new Map();
        }
        const cached = this.highlightMap.get(key);
        if (cached !== undefined) return cached;
        /*
         * ⭐取色必须和商籁 / 卡登萨那几套走**同一条规则**（resolveWordColor）：
         * 这里早先是拿 AI 标的词建表、再按 token **精确相等**取色，而那几套是
         * 「AI 标的词包含这个 token」就算命中。中文一切词就不是同一个字符串了
         * （AI 标「温柔的夜」，切出来是「温柔」「的」「夜」），于是同一份
         * wordColors 在播放页有高亮、在这一套里一个都不亮。英文两边都按空格切，
         * 所以只有中文有事。
         */
        const resolved = resolveWordColor(key, colors, '');
        const value = resolved ? themeColor(this.pixi, resolved, PROMPT_PALETTE.bone, 0.55) : null;
        this.highlightMap.set(key, value);
        return value;
    }

    /** 一整句的姿势：字的落下与高亮、下划线、以及整块窗的镜头。 */
    private updateBox(box: BuiltBox, time: number, staticMode: boolean) {
        const { startTime, endTime, tokens, fontPx, card } = box;
        // 帧值兜底：时间窗坏了（云端歌词偶尔会有缺 endTime 的行）会算出 NaN，
        // 而 alpha 一旦是 NaN，visible 就永远为 false —— 空屏，且没有任何报错。
        const safe = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

        const span = Math.max(0.2, endTime - startTime);
        const enterDuration = clamp(span * 0.2, 0.26, 0.5);
        const exitDuration = clamp(span * 0.2, 0.24, 0.42);
        const exitStart = endTime - exitDuration;
        const enter = easeOutExpo(progressOf(time, startTime, startTime + enterDuration));
        const exit = easeInCubic(progressOf(time, exitStart, endTime));
        const fadeIn = clamp01(progressOf(time, startTime, startTime + enterDuration * 0.7));
        const alpha = fadeIn * (1 - clamp01(progressOf(time, exitStart + exitDuration * 0.32, endTime)));

        // 唱到哪儿：光标位置 = 已落下的词里最靠右的那个；正在唱的那个词，光标在词里按进度走。
        let caretX = tokens[0]?.left ?? 0;
        let activeToken = -1;
        let lastStart = startTime;
        tokens.forEach((token, index) => {
            if (token.startTime > time) return;
            caretX = token.left + token.width * progressOf(time, token.startTime, token.endTime);
            lastStart = Math.max(lastStart, token.startTime);
            if (time <= token.endTime + 0.1) activeToken = index;
        });
        const colors = this.palette();
        if (staticMode) {
            box.root.scale.set(1);
            box.root.position.set(this.lastWidth / 2, this.lastHeight / 2);
            box.root.alpha = time >= (tokens[0]?.startTime ?? startTime) - 0.2 ? 1 : 0;
        } else {
            /*
             * 镜头（用户要的那条节奏）：
             *   1. 进场这段把镜头**直接推近**到 zoomIn（一屏里只留下大半句，左右两边被推出画面）；
             *   2. 唱到哪横移到哪，让正在唱的那一段留在画面正中；
             *   3. 唱到这行的**最后一点**时慢慢拉回，退回能看见整个整行的那一档；
             *   4. 整行淡出消失，下一句再从推近开始。
             *
             * 第 3 步是**缓动**不是硬切：硬切的话画面咔一下跳回全景，看着像镜头故障。
             * 拉回要赶在淡出**之前**走完 —— 先看清整行，再让它消失。
             */
            const punch = safe(Math.max(0, 1 - (time - lastStart) / 0.2), 0);
            const pullDuration = clamp(span * 0.25, 0.4, 0.8);
            const pullStart = Math.max(startTime + enterDuration, exitStart - pullDuration);
            const pull = easeInOutCubic(progressOf(time, pullStart, Math.max(pullStart + 0.01, exitStart)));

            const near = (1 + (this.zoomFor(box, card) - 1) * enter) * (1 + punch * 0.02);
            const far = this.zoomOutFor(box, card);
            /*
             * 智能动感（文字PV）：镜头本来就在唱到哪推到哪，这里让这句话的「气口」也进镜头 ——
             *   typePace —— 整句能量起来时推近一点点，像打字加快时的逼近。
             *   boxFly   —— 人声扬起来时再推一点，框体显得向前浮出。
             * 只乘在 zoom 上（一个数），token 位置、打字进度、换行一个都不动；两个效果都关时恒为 1。
             */
            /*
             * 两条都走效果表：typePace 登记的是伴奏（harmony / pad），boxFly 是人声。
             * 原来 typePace 读 `musicBody` —— 那条线里掺着 other 轨残留的鼓，打字节奏
             * 会跟着底鼓一冲一冲。现在推镜只跟乐句的厚薄走。
             */
            const typePaceLift = Math.min(1, readEffectTrack(BEAT_EFFECT_IDS.promptTypePace) * 1.5) * 0.1 * getBeatEffectStrength(BEAT_EFFECT_IDS.promptTypePace);
            const boxFlyLift = Math.min(1, readEffectTrack(BEAT_EFFECT_IDS.promptBoxFly) * 1.6) * 0.04 * getBeatEffectStrength(BEAT_EFFECT_IDS.promptBoxFly);
            const zoom = (near + (far - near) * pull) * (1 + typePaceLift + boxFlyLift);

            /*
             * 横移：把「正在唱的那个位置」挪到画面正中。
             *
             * 直接 -focus * zoom 会露馅 —— 窗比画面大的时候，移过头就会看见窗外的空白。
             * 所以焦点要夹在「离窗边缘还有半个画面」的区间里（装不下整窗时才有这个区间）。
             * 拉回的那一段里 zoom 一直在变，焦点每帧跟着重算，退出去时正好回到正中。
             */
            const half = Math.max(1, this.lastWidth) / (2 * Math.max(1e-3, zoom));
            const minFocus = card.left + half;
            const maxFocus = card.left + card.windowWidth - half;
            const focus = maxFocus > minFocus
                ? clamp(card.contentLeft + caretX, minFocus, maxFocus)
                : 0;
            const rawPan = -focus * zoom * (1 - pull);

            box.root.scale.set(safe(zoom, 1));
            box.root.position.set(
                this.lastWidth / 2 + safe(rawPan, 0),
                this.lastHeight / 2
                + safe((1 - enter) * this.lastHeight * 0.03 - exit * this.lastHeight * 0.04, 0),
            );
            box.root.alpha = safe(alpha, 0);
        }
        box.root.visible = box.root.alpha > 0.004;

        /*
         * 字：唱到才落下；**唱过的高亮色留着不还回去** —— 一句唱完整行都是亮的。
         * AI 标过色的词用它自己的色，其余用主题强调色。
         */
        box.words.forEach(word => {
            const appear = clamp01((time - word.box.startTime) / WORD_REVEAL_S);
            word.node.visible = appear > 0;
            if (!word.node.visible) return;
            word.node.alpha = appear;
            word.node.y = (1 - appear) * fontPx * 0.14;
            /*
             * 高亮色**每帧问一次**（highlightOf 内部按主题缓存）：AI 那份 wordColors
             * 常常比颜色晚到，而换主题不重建框 —— 只在搭框时读一次的话，晚到的那份
             * 就永远落不到字上（桌面叠层那一侧正是这样）。
             */
            const marked = this.highlightOf(word.box.text);
            const tint = time >= word.box.startTime ? (marked ?? colors.accent) : colors.text;
            if (word.node.tint !== tint) word.node.tint = tint;
        });

        // 字飞出框：唱完一个词就放一个残影出去（静态模式不放，那是给省电/截图用的）。
        if (!staticMode) {
            box.tokens.forEach((token, index) => {
                if (box.spawned[index] || time < token.endTime) return;
                box.spawned[index] = true;
                this.spawnGhost(box, index, time);
            });
            this.updateGhosts(box, time);
        }

        // 光标：唱到哪儿跟到哪儿；句尾之后先亮半秒再闪。
        const blinkOn = time - lastStart < 0.5 || Math.floor(time * 1.6) % 2 === 1;
        box.caret.x = caretX + fontPx * 0.06;
        box.caret.alpha = blinkOn ? 1 : 0.12;

        card.update(time, activeToken);
    }

    private renderFrame = () => {
        if (this.destroyed) return;
        if (this.lastWidth <= 0 || this.lastHeight <= 0) return;
        const { boxes } = this.options.song;
        if (boxes.length === 0) {
            this.stage.visible = false;
            return;
        }
        this.stage.visible = true;
        const time = this.options.currentTime.get();
        const active = this.indexAt(time);
        const current = this.ensure(active);
        // 上一句还在演它的退场（整块窗在句尾抽走），所以两块一起驱动；它们各自按绝对时间算姿势。
        const previous = active > 0 ? this.ensure(active - 1) : null;
        this.prune(active);

        const staticMode = this.options.staticMode;
        if (current) this.updateBox(current, time, staticMode);
        if (previous) this.updateBox(previous, time, staticMode);
        this.boxes.forEach((box, index) => {
            if (index !== active && index !== active - 1 && box.root.visible) box.root.visible = false;
        });
    };

    /**
     * 换一首歌：节目单整体换掉、缓存清空。
     *
     * 这里**不做整层淡入**。以前会在换歌时把 stage.alpha 压到 0 再花 220ms 推回 1，代价是
     * 只要调用方多换几次歌（播放页重算 theme、切字幕开关都会让 song 对象换个引用），画面就永远
     * 停在 alpha≈0 的那一帧 —— 看起来就是「选了提示词，只有背景，什么都没有」。框自己每一句都
     * 有进场，硬切一次比看不见好。
     *
     * 字体 / 字号变了也要重搭：字是在搭框时量好并烤进纹理的，不重搭就永远用旧的。
     */
    swapSong(song: PromptSongContext) {
        if (this.destroyed) return;
        const previous = this.options.song;
        const sameProgram = song.boxes === previous.boxes;
        const sameLook = song.theme?.fontStyle === previous.theme?.fontStyle
            && song.fontScale === previous.fontScale;
        this.options.song = song;
        if (sameProgram && sameLook) {
            if (this.options.paused) this.renderOnce();
            return;
        }
        this.clearBoxes();
        this.stage.alpha = 1;
        if (this.options.paused) this.renderOnce();
    }

    setPaused(paused: boolean) {
        if (this.destroyed) return;
        this.options.paused = paused;
        if (paused) {
            this.app.stop();
            this.renderOnce();
        } else {
            this.app.start();
        }
    }

    renderOnce() {
        if (this.destroyed) return;
        this.renderFrame();
        this.app.renderer.render(this.app.stage);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.app.stop();
        this.app.ticker.remove(this.renderFrame);
        this.clearBoxes();
        this.app.destroy({ removeView: true }, { children: true, texture: true });
    }
}
