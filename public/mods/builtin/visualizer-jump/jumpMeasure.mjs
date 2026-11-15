// mods/visualizer-jump/jumpMeasure.mjs
// 一块柱子上的字到底有多宽：用宿主给的字体在离屏画布上量一次，量不到时回落到按字身估。
// 柱顶与译文两层共用同一块画布（以前画布在 jumpTranslation 里，柱子那一层够不着）。
//
// 为什么柱子那一层非量不可：块长与字盒都由「这块字的长宽比」反推（jumpShape），
// 而 `jumpProject.resolveTypeBox` 把**字盒的高**当字号用，所以这个长宽比必须是
// 真实进宽 ÷ 字号，也就是以字号为单位的字宽（em）。老代码按「CJK 一格、拉丁 0.58 格」
// 累加出宽，再除以「拉丁字母只有 0.58 格那么高」——两件都不是量出来的数：
//   - 中文恰好对上（一个字正好一 em），于是看不出问题；
//   - 英文的宽被那个 0.58 除了一次，凭空放大约 1.7 倍，字盒比字宽出一大截，
//     屏幕上就是「英文歌词字边缘到柱子边缘的距离明显更大」。
// 现在整块字交给真字体量一次（字距、合字都算进去），中文英文混排也一并准了。

/**
 * 参考字号（像素）：量这么大的字再换成 em，于是量出来的比例不受像素取整影响。
 *
 * 小字号上有些 CJK 字体走的是点阵（Windows 上 22px 以下还有），进宽并不随字号线性变化
 * （fume 那边量到 24px 以下有偏差），所以这里取一个远离点阵的大字号。
 */
const MEASURE_PX = 128;

/**
 * 字盒的高在 em 里恒等于 1：`resolveTypeBox` 里 `fontSize` 取的就是字盒高。
 *
 * 它就是字宽那个分母。用它当分母，`aspect` 才正好是「以字号为单位的字宽」，
 * 字盒于是与文字同宽（老分母取的是墨迹高度，拉丁 0.58 —— 字盒高是字号，不是墨迹高，
 * 那一除就是上面那条「英文空隙更大」）。`jumpShape.resolvePillarTypePx` 那把尺子
 * 一直用的是 1，柱子这里对齐它。
 */
export const TYPE_BOX_EM = 1;

/** 量不到真字体时的估算：CJK 一个字一 em，拉丁约 0.58，空白更窄。 */
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

const estimateEm = (char) => (/\s/u.test(char) ? 0.35 : WIDE_CHAR.test(char) ? 1 : 0.58);

/** 老估算：Σ 每个字的字身系数。回落到它时画面与没有这一层时一致。 */
export const estimateTextSpan = (text) => Math.max(0, Array.from(text ?? '')
    .reduce((sum, char) => sum + estimateEm(char), 0));

/** 老估算：这块字里最高的那个字占多高（em）。回落到它时与老行为一致。 */
export const estimateGlyphEm = (text) => {
    const chars = Array.from(text ?? '').filter((char) => !/\s/u.test(char));
    if (chars.length === 0) return 1;
    return Math.max(...chars.map((char) => Math.min(1, Math.max(0.4, estimateEm(char)))));
};

let measureContext = null;

/** 从 `500 32px sans-serif` 这样的 font 里抠出字号；抠不到按 1px 一个字算。 */
const estimateGlyphPx = (font) => {
    const match = /(\d+(?:\.\d+)?)px/.exec(String(font ?? ''));
    return match ? Number(match[1]) : 1;
};

/**
 * 量字宽用的那块画布（1×1 离屏画布，开销可以忽略）。
 *
 * 拿不到画布时（无头环境、极简 DOM 桩）给一个桩，字宽与分行仍算得出来，只是不精确
 * ——桩上带 `stub`，需要真字体的地方（`measureTextEm`）据此回落到按字身估。
 */
export const getMeasureContext = () => {
    if (measureContext) return measureContext;
    if (typeof OffscreenCanvas !== 'undefined') {
        measureContext = new OffscreenCanvas(1, 1).getContext('2d');
        return measureContext;
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        measureContext = document.createElement('canvas')?.getContext?.('2d') ?? null;
    }
    if (!measureContext) {
        measureContext = {
            stub: true,
            font: '',
            measureText: (text) => ({ width: Array.from(String(text ?? '')).length * estimateGlyphPx(measureContext.font) }),
        };
    }
    return measureContext;
};

/** 真的能量字时才返回画布：桩不算。 */
const getCanvasContext = () => {
    const context = getMeasureContext();
    return context && !context.stub ? context : null;
};

/** 丢掉那块画布（测试与卸载时用）。 */
export const clearMeasureContext = () => { measureContext = null; };

/**
 * 一块字排出来有多宽（以字号为单位，em）：`MEASURE_PX` 上量一次再换算。
 *
 * 整块字一起量（不是逐字累加），字距与合字于是都在里面。量不到时返回 `null`，
 * 由调用方回落到 `estimateTextSpan`。
 */
const EM_CACHE_LIMIT = 2048;
const emCache = new Map();

export const measureTextEm = (text, fontFamily, fontWeight) => {
    const source = typeof text === 'string' ? text : '';
    const family = typeof fontFamily === 'string' && fontFamily ? fontFamily : 'sans-serif';
    const weight = Number.isFinite(fontWeight) ? fontWeight : 500;
    const key = `${weight}|${family}|${source}`;
    const cached = emCache.get(key);
    if (cached !== undefined) return cached;

    let value = null;
    const context = getCanvasContext();
    if (context) {
        context.font = `${weight} ${MEASURE_PX}px ${family}`;
        const width = Number(context.measureText(source).width);
        if (Number.isFinite(width) && width > 0) value = width / MEASURE_PX;
    }
    if (emCache.size >= EM_CACHE_LIMIT) {
        const oldest = emCache.keys().next();
        if (!oldest.done) emCache.delete(oldest.value);
    }
    emCache.set(key, value);
    return value;
};

/**
 * 柱顶那块字交给字盒的两个数：`span` 是字宽（em），`glyph` 是量它的那把尺子（1 em）。
 *
 * `aspect = span / glyph` 于是正好是「以字号为单位的字宽」——字盒与文字同宽，中文英文
 * 混排都一样，字边缘到柱子边缘的空当只由这块字真实有多宽决定，不再看语种。
 * 量不到真字体时回落到老估算，画面与没有这一层时一致。
 */
export const resolveUnitMetrics = (text, fontFamily, fontWeight) => {
    const source = typeof text === 'string' ? text : '';
    const widthEm = measureTextEm(source, fontFamily, fontWeight);
    if (widthEm === null) {
        return { span: estimateTextSpan(source), glyph: estimateGlyphEm(source) };
    }
    return { span: Math.max(0, widthEm), glyph: TYPE_BOX_EM };
};
