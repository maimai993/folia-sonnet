import { getFromCache, saveToCache } from '../db';
import { analyzeMusicEnvelopesNativeFromUrl, cancelNativeSeparation } from '../automix/nativeModels';
import { MUSIC_ENVELOPE_PREFIX } from './beatGridKeys';
import { joinStemRun, stemRunReached } from './stemRun';

// src/services/analysis/musicEnvelope.ts
// 一首歌的四条音乐包络：低频（bass 轨）、人声（vocals 轨）、其余乐器（other 轨）、整体（混音）。
//
// 为什么要它们：智能动感模式原先只有两种驱动 —— beat_this 的拍点，和 htdemucs 鼓轨上的鼓点。
// 于是画面能「跟着鼓动」，却不会唱歌、不会随低频下沉、不会在副歌亮起来。这四条曲线就是
// 那三件事的原料：低频管脉动与下沉，人声管光与色温，整体能量管明暗与景深，other 轨管
// 和声/旋律变化带来的结构位移。
//
// 成本几乎为零：htdemucs 本来就一次吐四轨（drums/bass/other/vocals），原先只拷 drums，
// 现在多拷三份，推理时间一模一样；每轨只交回每 50ms 一个 RMS 值（四分钟约 60KB），
// 波形一个字节都不过桥。分离本身与鼓点共用同一次任务（stemRun.ts），不会跑两遍。
//
// 与人的听感对齐要做的两件事：
//   · 归一化 —— 交回的是绝对 RMS，整首歌（或者已分离到的部分）的 97 分位当成 1。
//     这里不能按块拉满：否则前奏和副歌一样亮，画面就失去起伏。
//   · 平滑 —— 20fps 的 RMS 直接读会有台阶，采样时取当前时刻往前 0.15 秒的平均。
//     采样是纯函数（只看时间），拖进度条、暂停之后画面一致。

/**
 * 十八条曲线，分成三层。
 *
 *   · 前十条是能量：前四条整轨 RMS，后六条是原生对**同一批已分离波形**再做带通得到的
 *     细分维度（超低频、气声、亮度、底鼓、军鼓、镲片）。
 *   · 中间四条是语义轨（drums / vocalBody / harmony / pad）：同一条波形按频段再切，
 *     让「歌词的呼吸」和「鼓的冲击」在数据上就分开。
 *   · 最后四条是语义层（vocalVoicing / vocalPitch / chordRoot / chordMinor）：
 *     原生 `AudioFeatures` 用自相关与色度谱算出来的「有没有唱、唱多高、什么和弦」。
 *
 * 三层都不重跑分离、不换模型，APK 一个字节都不多占 —— 全部来自已经分离出来的波形。
 */
export const MUSIC_ENVELOPE_KINDS = [
    'bass', 'vocals', 'other', 'energy',
    'bassSub', 'vocalAir', 'brightness', 'kick', 'snare', 'hat',
    /*
     * 四条「语义轨」：每个效果只读它真正需要的那一条，而不是读一条什么都掺的聚合曲线。
     *
     * 四轨模型（SCNet）能给的只有 drums / bass / other / vocals，这四条是在**已分离的
     * 波形**上再按频段切的，不换模型、不多占一个字节：
     *   drums     鼓组整体
     *   vocalBody 人声基频与共振峰（250–2000），歌词句子的厚度
     *   harmony   伴奏主体（other 250–2000），和声与乐句的厚薄
     *   pad       伴奏铺底（other 80–250），低频的「托」
     *
     * 分出来的直接好处：歌词类画面读 vocalBody 时，底鼓再重也进不来 ——
     * 以前它们读的 `musicBody` 里掺着 other 轨残留的鼓，字就一直跟着鼓点抖。
     */
    'drums', 'vocalBody', 'harmony', 'pad',
    /*
     * 语义层四条 —— 由原生 `AudioFeatures` 从**已分离的波形**上算出，不跑额外模型：
     *   vocalVoicing 这一帧有没有人在唱（自相关的周期可信度）
     *   vocalPitch   唱到多高（55–880Hz 四个八度归一）
     *   chordRoot    根音 / 12；chordMinor 0 大三和弦、1 小三和弦
     *
     * 前两条是「歌词什么时候该动」的真正依据：能量只说明「这一下很响」，
     * 发声才说明「这一句在唱」。第三条让画面能跟着和声走，而不是跟着鼓走。
     */
    'vocalVoicing', 'vocalPitch', 'chordRoot', 'chordMinor',
] as const;

export type MusicEnvelopeKind = typeof MUSIC_ENVELOPE_KINDS[number];

/**
 * 一条完整的曲线，外加它「是怎么来的」。
 *
 * 两条路叠着用（这是这一版的核心）：
 *   · **基线**：原生对整曲做频段 RMS，一两秒出全部十条，曲线立刻铺满整首 —— 画面马上可用。
 *   · **精修**：htdemucs 一块一块分离，块到了就按区间**盖掉**基线对应的那一段。
 *
 * 所以还要记住 `refined`：哪些秒数已经被真分轨盖过了。它决定后台还要不要继续跑，
 * 也决定缓存能不能直接命中（都盖完了就永远不用再跑）。
 */
export type MusicEnvelope = {
    fps: number;
    /** 曲线有数据的长度（秒）。基线铺满后就是整曲。 */
    until?: number;
    /** 已被真分轨覆盖的区间，扁平存 [起, 止, 起, 止, …]（秒）。 */
    refined?: number[];
    /**
     * 整曲平均色度（12 维，和为 1）。
     *
     * 它不是曲线，而是一首歌一个的**常量**：调性（key）要从整首歌的音级分布里看，
     * 单帧的 12 个分量没有意义。原生每块回传一份，这里按块长加权平均。
     */
    chromaMean?: Float32Array;
} & Record<MusicEnvelopeKind, Float32Array>;

const EMPTY = new Float32Array(0);

/**
 * 曲线含义变了才加一、旧记录不再读。
 *
 * v1 只有四条主曲线，v2 多了六条细分，v3 多了「精修区间」——三者都还能读。
 * v4 换了 `brightness` 的来源（整混音 4kHz → other 轨 4kHz 以上）：旧记录里全是镲片与军鼓，
 * 读进来就是「雾与光束跟着鼓闪」。
 * v5 又多了四条语义轨（drums / vocalBody / harmony / pad）。缺了它们的旧记录会让所有
 * 「只读人声」「只读和声」的效果整首停在 0 —— 那比看见鼓在闪更糟，所以也整首重算。
 * v6 的 `vocalBody` 换了算法：不再取 vocals 轨 250–2000 的裸带通，而是在同一频段上
 * 减掉 drums 的贡献、再按鼓击上升沿门控（见原生 `VocalCurve`）。旧记录里那条曲线
 * 每一拍都有鼓的鼓包，留着它等于什么都没修。
 * v7 多了语义层四条（vocalVoicing / vocalPitch / chordRoot / chordMinor）与整曲色度。
 * 缺了它们，歌词类画面读到的发声恒为 0 —— 字会整首不动，比抖动更糟，同样整首重算。
 */
const ENVELOPE_VERSION = 7;

/** 归一化的分位：整首歌里最响的那一小撮当成 1。 */
const TOP_SHARE = 0.97;

/**
 * 采样时往回平均多少秒。
 *
 * 原先 0.15 秒：够平滑，但慢半拍 —— 唱到字上、鼓砸下去的时候，画面要再过一会儿才跟上，
 * 主观上就是「有动但不够跟手」（真机反馈「有点素」）。0.13 秒仍足够吃掉 20fps 的台阶，
 * 又保住「相邻两段交界处不是一步到位」的过渡。
 */
const SMOOTH_SECONDS = 0.13;


/** 每这么多秒落一次盘：切歌或退出之后，下次从这里接着算。 */
const SAVE_SECONDS = 30;

const isMusicEnvelope = (value: unknown): value is MusicEnvelope => {
    const entry = value as (MusicEnvelope & { version?: number }) | null;
    /*
     * 只认当前版本。
     *
     * 以前这里连 v1 / v2 一起收：那时新增的都是可选维度，缺的补空曲线就行。
     * v4 不同 —— brightness 的来源换了，旧的那条不是「缺」，而是「含义不同」，
     * 补成空曲线也比拿旧的凑合好（空曲线会被当成没有亮度，画面照常，只是不闪）。
     */
    if (!entry || entry.version !== ENVELOPE_VERSION) return false;
    return Number.isFinite(entry.fps) && entry.fps > 0
        && entry.bass instanceof Float32Array && entry.vocals instanceof Float32Array
        && entry.other instanceof Float32Array && entry.energy instanceof Float32Array;
};

/** 把一条记录（可能是 v1 的旧数据）补齐成十条曲线，缺哪条给空曲线。 */
const readCurves = (raw: Partial<MusicEnvelope>): Record<MusicEnvelopeKind, Float32Array> => {
    const curves = {} as Record<MusicEnvelopeKind, Float32Array>;
    for (const kind of MUSIC_ENVELOPE_KINDS) {
        curves[kind] = raw[kind] instanceof Float32Array ? raw[kind] : EMPTY;
    }
    return curves;
};

/** Per key, the envelopes in memory this session, the most recent kept. */
const envelopes = new Map<string, MusicEnvelope>();
const MAX_TRACKS = 8;

/**
 * 曲线内容的版本号。
 *
 * 为什么要它：设置卡片上那句「正在补齐整曲的音轨分离 · 30s」读的是 `until`，
 * 而 `until` 每块才变一次。组件的重渲染原来是靠 `beatFxStatus` 触发的 ——
 * 那个快照「一首歌变一次」，于是补齐在后台一路推进（30、60、90…），界面却**永远停在 30**。
 * 看上去和卡死一模一样，连排查方向都被带偏。
 *
 * 这里只做一件事：任何一次写入（新块到达、整曲落定）都让版本号 +1，
 * 订阅者据此重渲染，读到的是当时那一刻的 `until`。
 */
let revision = 0;
const revisionListeners = new Set<() => void>();

const bumpRevision = () => {
    revision += 1;
    for (const listener of revisionListeners) listener();
};

/** 当前版本号（`useSyncExternalStore` 的快照）。 */
export const getMusicEnvelopeRevision = (): number => revision;

/** 曲线有任何更新时回调。 */
export const subscribeMusicEnvelope = (listener: () => void): (() => void) => {
    revisionListeners.add(listener);
    return () => { revisionListeners.delete(listener); };
};

const keep = (key: string, envelope: MusicEnvelope) => {
    envelopes.delete(key);
    envelopes.set(key, envelope);
    while (envelopes.size > MAX_TRACKS) {
        const oldest = envelopes.keys().next().value;
        if (oldest === undefined) break;
        envelopes.delete(oldest);
    }
    bumpRevision();
};

/** 这首歌的包络（可能只有前几段），没有就 null。画面每帧调它，必须是同步的。 */
export const getMusicEnvelope = (key: string | null): MusicEnvelope | null => (key ? envelopes.get(key) ?? null : null);

/** 归一用的「顶点」，按曲线缓存：97 分位要排序，不能每帧算一次。 */
const tops = new WeakMap<MusicEnvelope, Partial<Record<MusicEnvelopeKind, number>>>();

const topOf = (envelope: MusicEnvelope, kind: MusicEnvelopeKind): number => {
    const cached = tops.get(envelope);
    if (cached && cached[kind] !== undefined) return cached[kind];
    const track = envelope[kind];
    let top = 0;
    if (track.length) {
        const sorted = track.slice().sort();
        top = sorted[Math.min(sorted.length - 1, Math.floor(TOP_SHARE * sorted.length))];
    }
    const entry = cached ?? {};
    entry[kind] = top;
    tops.set(envelope, entry);
    return top;
};

/**
 * 曲线在 `seconds` 处的值，0..1（对该曲自己归一），带 0.15 秒的平滑。
 *
 * **超出已分离范围返回 0**，不是把最后一帧重复下去。后者看上去像「有值」，实际是一条恒定
 * 平线：渲染层读到的动感在后半首冻结成一个数，画面就静止了 —— 而它和「这里真的这么安静」
 * 分不开，正是「整首只有一小段有动感」最难查的一种表现。返回 0 让上层能用实时频谱兜底。
 */
export const sampleMusicEnvelope = (
    envelope: MusicEnvelope,
    kind: MusicEnvelopeKind,
    seconds: number,
    /**
     * 是否按 97 分位归一。
     *
     * 能量类曲线必须归一（不归一则前奏和副歌差十倍，画面没有起伏）；但「音高位置」
     * 「和弦根音」这类曲线本身就是 0..1 的**坐标**，一归一就会被除成一个错的值 ——
     * 音高 0.5 会被当成「半响」，C 大调的根音 0 会被当成「没数据」。
     */
    normalize = true,
): number => {
    const track = envelope[kind];
    if (!track.length) return 0;
    if (envelope.until !== undefined && seconds > envelope.until) return 0;
    const top = normalize ? topOf(envelope, kind) : 1;
    if (normalize && !(top > 1e-6)) return 0;
    const last = track.length - 1;
    const span = Math.max(1, Math.round(SMOOTH_SECONDS * envelope.fps));
    /** 以某一帧为右端的滑动平均。窗口只有三帧，逐帧重算比维护环形缓冲更省事。 */
    const averageAt = (frame: number): number => {
        const end = Math.min(last, Math.max(0, frame));
        const from = Math.max(0, end - span + 1);
        let sum = 0;
        for (let index = from; index <= end; index += 1) sum += track[index];
        return sum / (end - from + 1);
    };
    /*
     * 在相邻两帧之间插值。
     *
     * 曲线是 25fps 的，画面是 60/120fps。只取整帧的话，同一个值会连着出现两三帧再跳一次，
     * 于是所有读曲线的位移与缩放都变成「一格一格走」—— 看上去就是抖。插值之后每一帧的值
     * 都不同，曲线在时间上是连续的，画面才是滑的。
     *
     * 这一步和分轨质量无关，是**接口**层面的时间对齐：信号本身是 25fps，消费端是 60fps。
     *
     * `chordRoot` / `chordMinor` 不插值：它们表示「第几个音级」「大还是小」，中间值没有意义，
     * 半步根音会让画面卡在两个和弦之间动弹不得。
     */
    const position = Math.max(0, seconds * envelope.fps);
    const lower = Math.min(last, Math.floor(position));
    const fraction = Math.min(1, Math.max(0, position - lower));
    const discrete = kind === 'chordRoot' || kind === 'chordMinor';
    const value = discrete || fraction <= 0
        ? averageAt(lower)
        : averageAt(lower) * (1 - fraction) + averageAt(lower + 1) * fraction;
    /*
     * 不做 gamma 提亮：抬中段就是把前奏也一起抬起来，「安静段仍安静」这条对比会跟着丢，
     * 而它正是副歌能亮起来的前提。要更明显就调各样式自己的幅度与效果强度。
     */
    return Math.min(1, value / top);
};

/**
 * 把 `tail` 放到整条曲线的第 `startFrame` 帧上。
 *
 * 按**帧位置**放，而不是简单追加：两张听众可能在不同的起点发起分离（一个人从 0，一个人从
 * 缓存里半份的位置），块到达的顺序也就未必首尾相接。缺口补 0，重叠部分丢掉 —— 时间轴必须
 * 按秒对齐，否则后面每一条曲线都是错的。
 */
const place = (head: Float32Array, tail: Float32Array, startFrame: number): Float32Array => {
    if (!tail.length) return head;
    const at = Math.max(0, Math.round(startFrame));
    const skip = Math.max(0, head.length - at);
    if (skip >= tail.length) return head;
    const take = tail.subarray(skip);
    const gap = Math.max(0, at - head.length);
    const out = new Float32Array(head.length + gap + take.length);
    out.set(head, 0);
    out.set(take, head.length + gap);
    return out;
};

/**
 * 把 `patch` **盖**到 `base` 的第 `at` 帧上，保留两侧原有内容。
 *
 * 与 `place` 的区别是语义：`place` 只能往后接（曲线还没长到那里），`overlay` 是替换
 * （那一段已经有基线了，精修结果要盖掉它）。基线铺满整曲之后，所有精修都必须走这条 ——
 * 用 `place` 会把 3 分钟的歌「接」到 5 分钟长，中间那一截全是零。
 */
const overlay = (base: Float32Array, patch: Float32Array, at: number): Float32Array => {
    if (!patch.length) return base;
    const start = Math.max(0, Math.round(at));
    const end = start + patch.length;
    const length = Math.max(base.length, end);
    if (length === base.length) {
        // 原地替换要复制一份：这条曲线是 `useMemo`/`useTransform` 的输入，不能就地改。
        const out = base.slice();
        out.set(patch, start);
        return out;
    }
    const out = new Float32Array(length);
    out.set(base, 0);
    out.set(patch, start);
    return out;
};

/** 把 [from, to) 并进区间表（扁平 [起, 止, …]，秒）。相邻或重叠的合并成一段。 */
const mergeRange = (ranges: number[] | undefined, from: number, to: number): number[] => {
    const list: Array<[number, number]> = [];
    if (ranges) {
        for (let index = 0; index + 1 < ranges.length; index += 2) list.push([ranges[index], ranges[index + 1]]);
    }
    if (to > from) list.push([from, to]);
    list.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of list) {
        // at(-1)：合并时最后一个元素确实可能不存在（数组为空），类型上也带着 undefined。
        const last = merged.at(-1);
        // 0.01 秒的容差：块与块之间按秒取整，接缝常常差几毫秒，不合并就会碎成几百段。
        if (last && start <= last[1] + 0.01) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged.flat();
};

/** 已用真分轨覆盖的总秒数。卡片上的「提升精度 x%」用它。 */
export const refinedSeconds = (envelope: MusicEnvelope | null | undefined): number => {
    const ranges = envelope?.refined;
    if (!ranges?.length) return 0;
    let sum = 0;
    for (let index = 0; index + 1 < ranges.length; index += 2) {
        sum += Math.max(0, ranges[index + 1] - ranges[index]);
    }
    return sum;
};

/**
 * 两块色度合并：取平均再归一。
 *
 * 不做「按块长精确加权」——色度只有一个用途（判整曲调性），而调性由音级**分布**决定，
 * 一两块的权重偏差不影响结论。反过来，精确加权要额外记「已经累计了多少帧」，
 * 而那个数在精修块重叠时很难说清。等权平均在这里既够用，也解释得通。
 */
const mergeChroma = (prior: Float32Array | undefined, incoming: Float32Array | undefined): Float32Array | undefined => {
    if (!incoming || incoming.length !== 12) return prior;
    if (!prior || prior.length !== 12) return incoming;
    const out = new Float32Array(12);
    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
        out[index] = (prior[index] + incoming[index]) * 0.5;
        sum += out[index];
    }
    if (sum > 1e-6) for (let index = 0; index < 12; index += 1) out[index] /= sum;
    return out;
};

/** Krumhansl–Schmuckler 的调性轮廓：大调、小调各 12 个音级的经验权重。 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export type MusicalKey = {
    /** 0 = C，1 = C#/Db，…… 11 = B。 */
    root: number;
    minor: boolean;
    /** 0..1，最佳轮廓与次佳之间的差距，越大越可信。 */
    confidence: number;
};

const keys = new WeakMap<MusicEnvelope, MusicalKey | null>();

const correlation = (chroma: Float32Array, profile: number[], root: number): number => {
    let meanC = 0;
    let meanP = 0;
    for (let index = 0; index < 12; index += 1) {
        meanC += chroma[index];
        meanP += profile[index];
    }
    meanC /= 12;
    meanP /= 12;
    let cov = 0;
    let varC = 0;
    let varP = 0;
    for (let index = 0; index < 12; index += 1) {
        const c = chroma[(index + root) % 12] - meanC;
        const p = profile[index] - meanP;
        cov += c * p;
        varC += c * c;
        varP += p * p;
    }
    const denominator = Math.sqrt(varC * varP);
    return denominator > 1e-9 ? cov / denominator : 0;
};

/**
 * 整曲调性：把平均色度与 24 条轮廓（12 根音 × 大小调）做相关，取最高的一条。
 *
 * 为什么不在原生算：调性要看**整首歌**的音级分布，而原生是一块一块处理的，
 * 它只知道这一块是什么调。色度只要 12 个数就能过桥，合并与判定放在 Web 侧更自然。
 */
export const detectKey = (envelope: MusicEnvelope | null | undefined): MusicalKey | null => {
    if (!envelope?.chromaMean || envelope.chromaMean.length !== 12) return null;
    const cached = keys.get(envelope);
    if (cached !== undefined) return cached;
    const chroma = envelope.chromaMean;
    let sum = 0;
    for (let index = 0; index < 12; index += 1) sum += chroma[index];
    if (!(sum > 1e-6)) {
        keys.set(envelope, null);
        return null;
    }
    let best: MusicalKey | null = null;
    let runnerUp = -1;
    for (let root = 0; root < 12; root += 1) {
        for (const minor of [false, true]) {
            const value = correlation(chroma, minor ? MINOR_PROFILE : MAJOR_PROFILE, root);
            if (!best || value > best.confidence) {
                if (best) runnerUp = best.confidence;
                best = { root, minor, confidence: value };
            } else if (value > runnerUp) {
                runnerUp = value;
            }
        }
    }
    if (!best) return null;
    const result: MusicalKey = { ...best, confidence: Math.max(0, best.confidence - Math.max(0, runnerUp)) };
    keys.set(envelope, result);
    return result;
};

/**
 * 从 0 开始第一个**还没精修**的位置（秒）。
 *
 * 顺序上的「下一个要补的地方」：区间是并集，扫到第一处断开就返回。
 * 整首都盖过了就返回曲长（调用方据此判断可以收工）。
 */
export const nextUnrefinedFrom = (envelope: MusicEnvelope | null | undefined, durationSec: number): number => {
    const ranges = envelope?.refined ?? [];
    let cursor = 0;
    for (let index = 0; index + 1 < ranges.length; index += 2) {
        if (ranges[index] > cursor + 0.05) break;
        cursor = Math.max(cursor, ranges[index + 1]);
    }
    return Math.min(cursor, Math.max(0, durationSec));
};

/**
 * 收下一块曲线。
 *
 * 两种写入：
 *   · 默认 —— **基线**（原生整曲频段分析）。曲线没有的地方往后接，已有的地方保留。
 *   · `refine` —— **精修**（htdemucs 分轨）。按区间覆盖基线，并记进 `refined`。
 *
 * `block.untilSec` 是这块到第几秒，存进 `until`：半份也要能读，下次播放从那里接着算。
 */
export const ingestMusicEnvelope = (key: string, block: {
    fps: number;
    fromSec: number;
    untilSec: number;
    /** 整曲平均色度（12 维，和为 1）。只有原生回传才有。 */
    chromaMean?: Float32Array;
} & Partial<Record<MusicEnvelopeKind, Float32Array>>, options: { refine?: boolean } = {}): MusicEnvelope => {
    const known = envelopes.get(key);
    // 帧率变了（旧记录、旧包）就不接，免得两条曲线的时间轴错位。
    const head = known && known.fps === block.fps ? known : null;
    const refine = options.refine === true;
    const startFrame = block.fromSec * block.fps;
    const curves = {} as Record<MusicEnvelopeKind, Float32Array>;
    for (const kind of MUSIC_ENVELOPE_KINDS) {
        // 缺的那一维（旧 APK 没回传）保持原样，不把已算好的部分抹掉。
        const base = head?.[kind] ?? EMPTY;
        const patch = block[kind] ?? EMPTY;
        curves[kind] = refine ? overlay(base, patch, startFrame) : place(base, patch, startFrame);
    }
    const refined = refine ? mergeRange(head?.refined, block.fromSec, block.untilSec) : head?.refined;
    /*
     * 色度逐块平均，而不是「后者覆盖前者」。
     *
     * 只留最后一块的话，调性会变成「结尾那 11 秒的调」—— 尾奏常常转调，或者只剩一个
     * 属和弦，判出来的调十有八九是错的。平均之后才是整首歌的音级分布。
     */
    const chromaMean = mergeChroma(head?.chromaMean, block.chromaMean);
    const envelope: MusicEnvelope = {
        ...curves,
        fps: block.fps,
        /*
         * 精修不动长度：基线已经把整首铺满了，覆盖只是换内容。
         * 只有基线/顺序补齐才把 `until` 往前推。
         */
        until: refine && head ? head.until : Math.max(block.untilSec, (head?.bass.length ?? 0) / block.fps),
        ...(refined && refined.length ? { refined } : {}),
        ...(chromaMean ? { chromaMean } : {}),
    };
    keep(key, envelope);
    return envelope;
};

/**
 * 存一份。整曲写 `complete:true` 且不带 `until`，半份写 `complete:false` 且带 `until`。
 *
 * 显式标记是必要的：光靠「有没有 until」分不清「真整曲」和「老版本误把半份的 until 去掉了」，
 * 后者会让缓存永久冻结、整首歌只有开头一小段有曲线（这正是那次「只有一小段有效果」的根因）。
 */
const store = async (key: string, envelope: MusicEnvelope, complete: boolean): Promise<void> => {
    try {
        const { until, refined, ...curves } = envelope;
        await saveToCache(`${MUSIC_ENVELOPE_PREFIX}${key}`, {
            version: ENVELOPE_VERSION,
            ...curves,
            // 精修区间必须一起存：它决定下次还要不要跑分离，少存就等于每次都从头跑。
            ...(refined && refined.length ? { refined } : {}),
            complete,
            ...(complete ? {} : { until }),
        });
    } catch (error) {
        console.warn(`[MusicEnvelope] ${key}: cache write failed`, error);
    }
};

/** 曲线已经覆盖整首：去掉 `until` 并按整曲落盘，下次读到就不再续算。 */
const markComplete = (key: string): void => {
    const envelope = envelopes.get(key);
    if (!envelope) return;
    const final: MusicEnvelope = {
        ...readCurves(envelope),
        fps: envelope.fps,
        ...(envelope.refined?.length ? { refined: envelope.refined } : {}),
        ...(envelope.chromaMean?.length === 12 ? { chromaMean: envelope.chromaMean } : {}),
    };
    keep(key, final);
    void store(key, final, true);
};

/** 已经存着的包络（半份也交），没有就 null。 */
export const loadStoredMusicEnvelope = async (key: string): Promise<MusicEnvelope | null> => {
    const known = envelopes.get(key);
    if (known) return known;
    try {
        const stored = await getFromCache<MusicEnvelope & {
            version?: number;
            complete?: boolean;
        }>(`${MUSIC_ENVELOPE_PREFIX}${key}`);
        if (!isMusicEnvelope(stored)) return null;
        const reached = stored.bass.length / stored.fps;
        /*
         * v1 / v2 没有 `refined`：那些记录里的曲线**全部来自真分轨**（当时还没有基线这条路），
         * 所以整段都算精修过 —— 读回来直接用，不必为同一首歌再跑几分钟模型。
         * v3 必须照实读，它可能只是基线。
         */
        const legacy = stored.version !== ENVELOPE_VERSION;
        const refined = legacy
            ? (reached > 0 ? [0, reached] : undefined)
            : (Array.isArray(stored.refined) ? stored.refined : undefined);
        // 旧版本落盘时没有 complete 标记，且可能把「半份」误当成整曲去掉了 until。
        // 一律按曲线实际长度补一个 until：真整曲会在泵里按曲长瞬间判定完成，半份则接着补，
        // 两种情况都不会再被永久冻结在开头那一小段。
        const complete = stored.complete === true && typeof stored.until !== 'number';
        // 色度也要一起读回来：少了它，二次打开这首歌就没有调性，画面会退回默认色。
        const chromaMean = ArrayBuffer.isView(stored.chromaMean) || Array.isArray(stored.chromaMean)
            ? Float32Array.from(stored.chromaMean as ArrayLike<number>)
            : undefined;
        const envelope: MusicEnvelope = {
            ...readCurves(stored),
            fps: stored.fps,
            ...(complete ? {} : { until: Math.max(reached, stored.until ?? 0) }),
            ...(refined && refined.length ? { refined } : {}),
            ...(chromaMean?.length === 12 ? { chromaMean } : {}),
        };
        keep(key, envelope);
        return envelope;
    } catch (error) {
        console.warn(`[MusicEnvelope] ${key}: cache read failed`, error);
        return null;
    }
};

/** 这首歌已经存到第几秒（没有则 0）。 */
export const musicEnvelopeReached = async (key: string): Promise<number> => {
    const stored = await loadStoredMusicEnvelope(key);
    if (!stored) return 0;
    return stored.until ?? stored.bass.length / stored.fps;
};

export interface MusicEnvelopeRunOptions {
    /** 还要不要继续（切歌、画面切走、效果关掉）。 */
    wanted: () => boolean;
    /** 曲长（秒）：判「是否已经覆盖整首」用。拿不到就退回原生「跑到文件尾」的判据。 */
    durationSec?: number;
}

/** 当前要补齐到整首的目标。切歌或关效果后 `wanted()` 转假，泵自然停下。 */
interface EnvelopeTarget {
    key: string;
    url: string;
    durationSec: number;
    wanted: () => boolean;
}
let target: EnvelopeTarget | null = null;
/** 上一次发起补齐的时刻：挂在已有的 tickBeatFx RAF 上节流，不新增循环。 */
let lastPumpAt = 0;
/** 连续「发起了却一点没往前推进」的次数。只用来退避间隔，**永不放弃**。 */
let stalled = 0;
/** 下一趟最早什么时候再试；没进展时翻倍，有进展归零。 */
let backoffMs = 0;
const PUMP_INTERVAL_MS = 1500;
/**
 * 退避上限。以前这里是 `MAX_STALLED = 5`，到 5 次就永久不再发起 ——
 * 一次切后台、一次原生 OOM、一次被别的取消标记打断，攒够 5 次之后**这首歌就再也补不齐了**，
 * 直到切歌。而屏幕上那句「正在补齐」还挂着不动。现在改成退避到 20 秒一次，一直试下去。
 */
const MAX_BACKOFF_MS = 20_000;
/** 一趟分离超过这么久还没有任何新块，就当作卡住，主动叫停让下一趟重来。 */
const RUN_WATCHDOG_MS = 120_000;
/** 尾块可能略短，覆盖到曲长前两秒就算整首。 */
const END_TOLERANCE_SEC = 2;
/** 当前这一趟的看门狗：最近一次有新块到达的时刻（0 = 没有在跑）。 */
let runStartedAt = 0;
/**
 * 连续「一趟跑完，却一秒都没精修上」的次数。
 *
 * 0% 一直不动是最难判断的一种失败：可能是模型在本机跑不起来、音频地址失效、
 * 也可能只是很慢。攒到三次就认为这条链路在本机走不通，**停止重试**，并把状态交给界面
 * 说实话 —— 否则卡片上那句「正在提升分轨精度 · 0%」会永远挂着，看起来就是「分析停了」，
 * 而实际上整曲频段曲线早就在驱动画面了。
 */
let refineFailures = 0;
/**
 * 哪首歌的分轨精修已被判定走不通（`null` = 没有）。
 *
 * 记 key 而不是一个布尔：切歌之后要自动作废，否则上一首失败会把下一首也一起判死。
 */
let refineBlockedKey: string | null = null;
const REFINE_FAILURE_LIMIT = 3;

/** 当前这首歌的分轨精修是不是已经被判定走不通（界面用：不再报 0%）。 */
export const getMusicEnvelopeRefineBlocked = (): boolean => (
    refineBlockedKey !== null && target?.key === refineBlockedKey
);

/** 曲线已经覆盖到第几秒。 */
const coveredSeconds = (envelope: MusicEnvelope): number =>
    envelope.until ?? envelope.bass.length / envelope.fps;

/** 还有没有分离在跑：`stemRunReached` 非 null 就是有（正常结束/被停都会从表里删掉）。 */
const separationRunning = (key: string): boolean => stemRunReached(key) !== null;

/**
 * 这一趟是不是已经把整首都精修完了。
 *
 * 判据从「曲线覆盖到第几秒」换成「还有没有没被真分轨盖过的秒数」——
 * 基线已经把曲线铺满整首了，曲线长度不再能说明分离跑没跑完。
 * 旧包不回传包络时没有 `refined` 可看，退回「跑到文件尾」。
 */
const completeIfWhole = (key: string, durationSec: number, reachedEnd: boolean): boolean => {
    const envelope = envelopes.get(key);
    if (!envelope) return false;
    const span = durationSec > 0 ? durationSec : coveredSeconds(envelope);
    const refinedTo = nextUnrefinedFrom(envelope, span);
    const whole = span > 0 && refinedTo >= span - END_TOLERANCE_SEC;
    const fallback = reachedEnd && envelope.until === undefined && !envelope.refined?.length;
    if (whole || fallback) {
        markComplete(key);
        stalled = 0;
        return true;
    }
    return false;
};

/**
 * 从「第一个还没精修的位置」发起一趟分离。被打断（切后台 / 切样式 / 切歌）后由
 * `pumpMusicEnvelope` 重新发起，这里只管这一趟。与鼓点共用同一次分离，不会跑两遍。
 */
const startEnvelopeRun = (item: EnvelopeTarget): void => {
    if (separationRunning(item.key)) return;
    const known = envelopes.get(item.key);
    const span = item.durationSec > 0 ? item.durationSec : (known ? coveredSeconds(known) : 0);
    /*
     * 起点跟着「区间图上的第一个空洞」走，而不是跟着曲线长度走。
     * 基线铺满之后曲线长度恒等于曲长，用它当起点会让每一趟都从 0 开始重算同一段。
     */
    const from = nextUnrefinedFrom(known, span);
    if (span > 0 && from >= span - END_TOLERANCE_SEC) {
        completeIfWhole(item.key, span, true);
        return;
    }
    runStartedAt = performance.now();
    let lastSaved = refinedSeconds(known);
    void joinStemRun(item.key, item.url, {
        wanted: item.wanted,
        onBlock: (block) => {
            const curves = block.envelopes;
            if (!curves) return;
            const envelope = ingestMusicEnvelope(item.key, {
                fps: curves.fps,
                bass: curves.bass,
                vocals: curves.vocals,
                other: curves.other,
                energy: curves.energy,
                bassSub: curves.bassSub,
                vocalAir: curves.vocalAir,
                brightness: curves.brightness,
                kick: curves.kick,
                snare: curves.snare,
                hat: curves.hat,
                drums: curves.drums,
                vocalBody: curves.vocalBody,
                harmony: curves.harmony,
                pad: curves.pad,
                vocalVoicing: curves.vocalVoicing,
                vocalPitch: curves.vocalPitch,
                chordRoot: curves.chordRoot,
                chordMinor: curves.chordMinor,
                chromaMean: curves.chromaMean,
                fromSec: block.fromSec,
                untilSec: block.untilSec,
            }, { refine: true });
            // 有块到就算这一趟活着：看门狗按「最近一次进展」重新计时。
            runStartedAt = performance.now();
            backoffMs = 0;
            refineFailures = 0;
            if (refineBlockedKey !== null) {
                refineBlockedKey = null;
                bumpRevision();
            }
            const refined = refinedSeconds(envelope);
            if (refined - lastSaved >= SAVE_SECONDS) {
                lastSaved = refined;
                void store(item.key, envelope, envelope.until === undefined);
                stalled = 0;                            // 有实打实的进展
            }
        },
        onDone: (outcome) => {
            runStartedAt = 0;
            const envelope = envelopes.get(item.key);
            if (!envelope) return;
            const reachedEnd = outcome !== null && !outcome.cancelled && outcome.done;
            // 原生一路跑到文件尾时，把它的终点当作曲长，判据更准。
            if (outcome && reachedEnd) item.durationSec = Math.max(item.durationSec, outcome.seconds);
            const whole = completeIfWhole(item.key, item.durationSec, reachedEnd);
            const refined = refinedSeconds(envelope);
            if (refined > lastSaved + 1) {
                stalled = 0;
                refineFailures = 0;
            } else {
                stalled += 1;
                refineFailures += 1;
                /*
                 * 连着几趟都没有任何一秒被精修：多半是原生那条路在这台机器上跑不起来
                 * （SCNet 加载失败、音频地址失效）。继续每 20 秒重试只会让状态栏永远
                 * 停在 0%，所以到这里就停手，让界面诚实地说「用的是整曲频段曲线」。
                 */
                if (refineFailures >= REFINE_FAILURE_LIMIT && refineBlockedKey !== item.key) {
                    refineBlockedKey = item.key;
                    bumpRevision();
                    console.warn(
                        `[MusicEnvelope] ${item.key}: ${refineFailures} 趟分离都没有进展，`
                        + '停止重试；整曲曲线继续驱动画面',
                    );
                }
            }
            if (whole) {
                backoffMs = 0;
                console.info(`[MusicEnvelope] ${item.key}: refined the whole track (${refined.toFixed(0)}s)`);
            } else {
                void store(item.key, envelope, envelope.until === undefined);
                if (refined <= lastSaved + 1) {
                    // 没进展：退避，但一直试 —— 见 MAX_BACKOFF_MS 的说明。
                    backoffMs = Math.min(MAX_BACKOFF_MS, PUMP_INTERVAL_MS * 2 ** Math.min(stalled, 4));
                }
                console.info(`[MusicEnvelope] ${item.key}: refined ${refined.toFixed(0)}s, will resume`);
            }
        },
    }, from);
};

/**
 * 挂在**已有的** `tickBeatFx` 帧循环上（不新增循环）：只要这首歌还没覆盖整首、效果还开着、
 * 在前台、且当前没有分离在跑，就从断点重新发起，直到整首补齐。
 *
 * 这是以前「整首歌只有开头一小段有动感」缺的那一环：补齐只在切歌时发起过一次，
 * 被 `stemRun` 的后台让路 / 监听回收打断后，回前台再也没有人续，`until` 就冻在断点了。
 * 现在回前台这一帧就自动接上，切后台依旧让路（低负载那条不变）。
 */
export const pumpMusicEnvelope = (nowMs: number): void => {
    const item = target;
    if (!item || !item.wanted()) return;
    if (refineBlockedKey === item.key) return;   // 已经判定这条链路在本机走不通，不再空转
    if (typeof document !== 'undefined' && document.hidden) return;
    // 没进展时按退避拉长间隔，但**不会停**：一直试到整首补齐或切歌。
    if (nowMs - lastPumpAt < Math.max(PUMP_INTERVAL_MS, backoffMs)) return;
    lastPumpAt = nowMs;
    const envelope = envelopes.get(item.key);
    const span = item.durationSec > 0 ? item.durationSec : (envelope ? coveredSeconds(envelope) : 0);
    /*
     * 收工的条件是「曲线整曲 **且** 没有待精修的区间」。
     * 只看曲线长度会把「基线铺满了」当成「分离跑完了」，后台就再也不会去补真分轨。
     */
    if (envelope && envelope.until === undefined && span > 0
        && nextUnrefinedFrom(envelope, span) >= span - END_TOLERANCE_SEC) {
        return;
    }
    if (separationRunning(item.key)) {
        /*
         * 看门狗：原生那头（取音频、解码、四轨推理）任何一步卡住，`joinStemRun` 都不会回
         * onDone，泵就永远在「正在跑」上打转 —— 屏幕上是那句「正在补齐整曲的音轨分离 ·
         * 30s」一动不动。超过两分钟没有任何新块就当作卡死，叫停这一趟，下一拍从断点重来。
         */
        if (runStartedAt > 0 && nowMs - runStartedAt > RUN_WATCHDOG_MS) {
            console.warn(`[MusicEnvelope] ${item.key}: no block for ${Math.round(RUN_WATCHDOG_MS / 1000)}s, restarting the separation`);
            runStartedAt = 0;
            void cancelNativeSeparation();
        }
        return;
    }
    startEnvelopeRun(item);
};

/** 切歌 / 关效果：清掉补齐目标，泵随即停下。 */
export const clearMusicEnvelopeTarget = (): void => {
    target = null;
    stalled = 0;
    backoffMs = 0;
    runStartedAt = 0;
    refineFailures = 0;
    refineBlockedKey = null;
};

/**
 * 读这首歌的包络。
 *
 * 顺序是这一版的核心：
 *   1. 缓存里有「整曲 + 精修完」→ 直接交，一个模型都不跑（第二次听同一首歌零成本）。
 *   2. 否则先要一份**秒出的基线**（原生整曲频段分析，一两秒）→ 曲线立刻铺满整首，画面马上可用。
 *   3. 再让 htdemucs 一块块盖上去（`pumpMusicEnvelope` 续跑），盖到哪段哪段更准。
 *
 * 以前是「先跑几分钟分离才有曲线」：补到 30 秒时用户已经听完副歌了，而界面上只有一句
 * 「正在补齐」。现在补不补得完只影响精度，不影响能不能看。
 */
export const loadTrackMusicEnvelope = async (
    key: string,
    url: string,
    options: MusicEnvelopeRunOptions,
): Promise<MusicEnvelope | null> => {
    const stored = await loadStoredMusicEnvelope(key);
    const span = Math.max(0, options.durationSec ?? 0);
    // 曲线整曲、并且每一秒都被真分轨盖过：收工，不必再跑。
    if (stored && stored.until === undefined && span > 0
        && nextUnrefinedFrom(stored, span) >= span - END_TOLERANCE_SEC) {
        // 只清自己的目标：切歌时单例 target 可能已经是新歌的，别顺手把它停掉。
        if (target === null || target.key === key) clearMusicEnvelopeTarget();
        return stored;
    }
    /*
     * 换了一首歌才复位「精修走不通」的判定。
     *
     * 同一首歌里切样式也会走到这里，若每次都复位，刚判定失败的那条链路会被
     * 一遍遍地重新发起 —— 每 20 秒白烧一次推理，状态栏也跟着在 0% 与「走不通」之间跳。
     */
    if (target?.key !== key) {
        refineFailures = 0;
        refineBlockedKey = null;
    }
    /*
     * 用局部 item 而不是全局 target：下面 `await` 基线这几十秒里用户可能切歌，
     * target 会被新歌覆盖。之后的每一步都要先确认 target 仍是自己，否则只把结果
     * 落到自己 key 下就收手，绝不把上一首的曲长 / 分离目标写到新歌上。
     */
    const item: EnvelopeTarget = { key, url, durationSec: span, wanted: options.wanted };
    target = item;
    stalled = 0;
    lastPumpAt = 0;
    /*
     * 还没有整曲曲线（没缓存、或缓存只有半截）才要基线。
     *
     * 判据必须看**曲线实际长度**，不能只看 `until` 在不在：基线铺完之后内存里那份
     * 仍然带着 `until`（它表示曲线长度），用它判断会让每切一次样式就重跑一遍解码与十次带通。
     *
     * 基线失败就退回老路（直接跑分离、跑到哪算哪），所以这里不是一个必须成功的分支。
     */
    const curvesWhole = stored
        ? coveredSeconds(stored) >= (span > 0 ? span - END_TOLERANCE_SEC : 0) && stored.bass.length > 0
        : false;
    if (!curvesWhole) {
        const baseline = await analyzeMusicEnvelopesNativeFromUrl(url);
        if (baseline && baseline.frames > 0) {
            ingestMusicEnvelope(key, {
                fps: baseline.fps,
                bass: baseline.bass,
                vocals: baseline.vocals,
                other: baseline.other,
                energy: baseline.energy,
                bassSub: baseline.bassSub,
                vocalAir: baseline.vocalAir,
                brightness: baseline.brightness,
                kick: baseline.kick,
                snare: baseline.snare,
                hat: baseline.hat,
                drums: baseline.drums,
                vocalBody: baseline.vocalBody,
                harmony: baseline.harmony,
                pad: baseline.pad,
                vocalVoicing: baseline.vocalVoicing,
                vocalPitch: baseline.vocalPitch,
                chordRoot: baseline.chordRoot,
                chordMinor: baseline.chordMinor,
                chromaMean: baseline.chromaMean,
                fromSec: baseline.fromSec,
                untilSec: baseline.untilSec,
            });
            // 曲线已经整曲：去掉 until 并按整曲落盘，精修进度另存在 `refined` 里。
            markComplete(key);
            // 切歌了：这份基线属于旧歌，落盘即可，不碰新歌的 target。
            if (target !== item) return envelopes.get(key) ?? null;
            // 曲长拿不到时（某些流媒体源不给时长），用基线自己的长度当整曲长度。
            if (item.durationSec <= 0) item.durationSec = baseline.untilSec;
            startEnvelopeRun(item);
            return envelopes.get(key) ?? null;
        }
    }
    // 同理：基线没出的分支也不能替新歌启动分离。
    if (target !== item) return stored;
    startEnvelopeRun(item);
    return stored;
};

/**
 * 提前把这首歌的**整曲曲线**算好并落盘，供下次播放直接命中。
 *
 * 为什么单独一条路、不复用 [loadTrackMusicEnvelope]：那个函数是给「正在播、画面正开着」用的，
 * 它会抢掉模块级单例 `target`，还会启动分轨精修 —— 预取下一首时调用它，正在播的这首歌
 * 立刻就不补齐了。这里只做**秒出的整曲基线**（解码 + 十次带通 + YIN，不跑 SCNet），
 * 不设目标、不发起分离、不碰任何播放状态。
 *
 * 落盘用的是同一个 `complete:true` 记录，所以下次播放读缓存时曲线已经铺满整首，
 * 画面从第一个字就有数据；精修区间为空，播放时的泵会照常从 0 继续把真分轨盖上去。
 */
const prewarming = new Set<string>();

export const prewarmMusicEnvelope = async (
    key: string,
    url: string,
    durationSec: number,
): Promise<boolean> => {
    if (prewarming.has(key)) return false;
    const stored = await loadStoredMusicEnvelope(key);
    // 已经有整曲曲线了（不管是基线还是精修过的），不必再解码一遍。
    if (stored && stored.bass.length > 0 && stored.until === undefined) return false;
    prewarming.add(key);
    try {
        const baseline = await analyzeMusicEnvelopesNativeFromUrl(url);
        if (!baseline || baseline.frames <= 0) return false;
        ingestMusicEnvelope(key, {
            fps: baseline.fps,
            bass: baseline.bass,
            vocals: baseline.vocals,
            other: baseline.other,
            energy: baseline.energy,
            bassSub: baseline.bassSub,
            vocalAir: baseline.vocalAir,
            brightness: baseline.brightness,
            kick: baseline.kick,
            snare: baseline.snare,
            hat: baseline.hat,
            drums: baseline.drums,
            vocalBody: baseline.vocalBody,
            harmony: baseline.harmony,
            pad: baseline.pad,
            vocalVoicing: baseline.vocalVoicing,
            vocalPitch: baseline.vocalPitch,
            chordRoot: baseline.chordRoot,
            chordMinor: baseline.chordMinor,
            chromaMean: baseline.chromaMean,
            fromSec: baseline.fromSec,
            untilSec: baseline.untilSec,
        });
        // 曲长只影响「精修要跑到哪」；基线自己已经铺满，这里只留一行可查的记录。
        console.info(
            `[MusicEnvelope] ${key}: prewarmed ${(durationSec || baseline.untilSec).toFixed(0)}s baseline`,
        );
        markComplete(key);
        return true;
    } catch (error) {
        console.warn(`[MusicEnvelope] ${key}: prewarm failed`, error);
        return false;
    } finally {
        prewarming.delete(key);
    }
};

/**
 * 「删除分析缓存」的内存侧：把这一会话里所有已加载的整曲曲线清空、停掉补齐目标。
 *
 * 盘上那些 `music_envelope_v1_*` 记录由存储页的 analysis 分类一起删；这里不清的话，
 * 删完盘上数据画面这一帧还在读内存里的旧曲线，一直到下次切歌才换过来，
 * 看起来就像「删了没用」。两处一起调才干净。
 */
export const clearMusicEnvelopeCache = (): void => {
    clearMusicEnvelopeTarget();
    envelopes.clear();
    prewarming.clear();
    lastPumpAt = 0;
    bumpRevision();
};
