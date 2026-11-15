// mods/visualizer-jump/jumpTranslation.mjs
// 屏幕正中那一块译文。纯计算，不碰 DOM。
//
// 为什么要有这一层：柱顶写的是这一行**正在唱**的字，一屏三行各写各的；译文却是
// 「现在唱到哪一句」的注解，摆在柱子群里会被四面八方的字挤没。所以它单独浮在画面正中，
// 一次只露**一句**，这一句唱完再换下一句（换句时淡淡地落定，见 jumpTimeline
// 的 resolveTranslationStart / resolveTranslationReveal）。
//
// 三件事：
//   1. 取哪一行（pickTranslationLine）：优先宿主给的行号，取不到就按时刻自己找；
//   2. 怎么分行（splitTranslationRows）：中日韩按字断，拉丁按词断，标题行不截断；
//   3. 字号多大（resolveTranslationType）：先给一版「按行数取」的字号，量过之后再按
//      「有没有超出屏幕宽 / 有没有被行数夹住」收一档（见 fitTranslationLayout）。
//
// 透视（translationTilt）是「镜头俯角」那一档：把整块字当作躺在脚下的一层地砖，
// 用同一个 θ 往下压扁。**变形的深浅由俯角同步给**（resolveTranslationTiltAmount）：
// 俯角越大越接近俯视，这块字越像正对着镜头的一片，变形越小；俯角越小越接近平视，
// 它就越扁、越歪、越像远处地上的一条。参照俯角（面板默认值）那一档正好是「没有这个
// 概念时」的那一版画面。真透视要除以深度，这里的 depth 只作分母里的一点点修正，
// 于是近处大、远处小，而字的分行与行宽仍按压扁前的宽度算得出来。
//
// 摆放（resolveTranslationAnchor）由**对齐方式 + 偏移**给：对齐定这块字钉在窗口的哪一头、
// 也定它钉住自己哪一头；偏移是「整块挪几个窗口高」，0 就正好贴在那条线上，±0.8 够把字
// 推出画面。不再用「离底边多少」那种比例，也不再有隐藏的留白把行程吃掉。

// 量字宽用的那块画布在 jumpMeasure：柱顶那一层也要量（块长与字盒都由字宽反推），
// 两层共用一块，卸载时也只清一处。
import { clearMeasureContext, getMeasureContext } from './jumpMeasure.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * 译文块的排法：**只缩字号，不压字**。
 *
 * 这里不再先把一行放宽再横着压回来：那样一句话在窄屏上会被压成细长的一条
 * （宽高比失真，越窄越难看）。放不下就换小一档字号重排，横向缩放只剩
 * 「撞到字号下限还放不下」时的保底，而且收得很少（见 fitTranslationLayout）。
 */

/** 字号往下收时的收缩步长（每档缩这么多）与最多收几档。 */
const SIZE_STEP = 0.94;
const MAX_SIZE_STEPS = 24;

/**
 * 实在放不下时，横向最多再收这么多（`fitTranslationLayout`）。
 *
 * 只是保底系数，不是排版手段：正常路径靠缩字号，横向缩放一直停在 1。
 * 收到 0.86 时宽高比已经看得出不对，所以不许再往下。
 */
const MAX_SQUEEZE_X = 0.86;

/** 这一行有没有能读的字：纯标记行（`//`、`●●●`）不算，跟宿主的字幕判据一致。 */
export const hasReadableText = (text) => typeof text === 'string' && /[\p{L}\p{N}]/u.test(text);

/** 中日韩与全角标点：这些字之间随便断，一个词摆在两行里也读得通。 */
const CJK = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** 拉丁词里允许断开的接缝（`rock-and-roll`、`holdin'`）。 */
const LATIN_JOINT = /[-‐‑–—'’]/u;

/**
 * 这一行显示哪一条替代文字：`translation`（译文）或 `romanization`（罗马音）。
 * 与宿主的字幕口径一致：优先行上的同名字段，其次 `alternateTexts` 里同角色且有字的那一条。
 */
export const resolveAlternateText = (line, role = 'translation') => {
    if (!line) return '';
    const direct = role === 'romanization' ? line.romanization : line.translation;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const list = Array.isArray(line.alternateTexts) ? line.alternateTexts : [];
    const found = list.find((entry) => entry?.role === role && typeof entry.text === 'string' && entry.text.trim());
    return found ? found.text.trim() : '';
};

/**
 * 这一刻译文属于哪一行。
 *
 * 优先用宿主给的行号（`getLineIndex()`）：那是播放器认定的「现在这一句」，和别处
 * （柱顶的亮度、字幕）用的是同一个答案。它取不到（`-1`：两句之间的空档）、或者
 * 那一行没有译文时，按时刻自己找：最后一句**已经开口**、且还没被下一句顶掉的行。
 * 一句都没有开口（前奏）时返回 `null`——那时屏幕上本来也不该有字。
 */
export const pickTranslationLine = (lines, options = {}) => {
    const list = Array.isArray(lines) ? lines : [];
    const time = Number.isFinite(options.time) ? options.time : 0;
    const role = options.role === 'romanization' ? 'romanization' : 'translation';
    const readable = (line) => Boolean(line) && hasReadableText(resolveAlternateText(line, role));
    const index = Number(options.index);
    if (Number.isInteger(index) && index >= 0 && index < list.length) {
        const line = list[index];
        // 行号指着这一行、而这一行没有译文（纯音乐标记、没翻过来）时，退回按时刻找。
        if (readable(line) && time >= (Number.isFinite(line.startTime) ? line.startTime : 0)) return line;
    }
    for (let cursor = list.length - 1; cursor >= 0; cursor -= 1) {
        const line = list[cursor];
        if (!line) continue;
        const start = Number.isFinite(line.startTime) ? line.startTime : 0;
        if (time < start) continue;
        return readable(line) ? line : null;
    }
    return null;
};

/**
 * 一句译文按「一行大概能放几个字」铺成几行。
 *
 * `capacity` 是这一行还能放多少**字宽**（以字号为单位）：中日韩一个字占 1，拉丁约 0.55。
 * 断点：中文（CJK）之间随便断，词摆在两行里也读得通；拉丁只在词与词之间断，接缝
 * （连字符、撇号）归前一块——不会把 `hello` 劈成 `hel / lo`。一个词自己就超了宽时独占一行。
 * 标点黏在前一个字上（下一行不从逗号、句号开头）。
 */
export const wrapTranslationRows = (text, capacity) => {
    const source = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
    if (!source) return [];
    const limit = Math.max(1, Number(capacity) || 1);
    const widthOf = (value) => Array.from(value).reduce((sum, char) => (
        sum + (/\s/u.test(char) ? 0.35 : CJK.test(char) ? 1 : 0.55)
    ), 0);
    const tokens = [];
    let token = '';
    Array.from(source).forEach((char) => {
        if (/\s/u.test(char)) {
            if (token) tokens.push(token);
            token = '';
            tokens.push(' ');
            return;
        }
        const last = token.slice(-1);
        // 中文之间一刀一个词元；拉丁只在接缝之后断（`rock-and-roll` 断成 `rock-` / `and-` / `roll`）。
        const splitting = Boolean(token) && (CJK.test(char) || LATIN_JOINT.test(last));
        if (splitting) {
            tokens.push(token);
            token = char;
            return;
        }
        token += char;
    });
    if (token) tokens.push(token);

    const rows = [];
    let row = '';
    let rowWidth = 0;
    tokens.forEach((piece) => {
        if (piece === ' ') {
            if (row) row += ' ';
            return;
        }
        const width = widthOf(piece);
        if (row && rowWidth + width > limit) {
            rows.push(row.trim());
            row = '';
            rowWidth = 0;
        }
        row += piece;
        rowWidth += width;
    });
    if (row.trim()) rows.push(row.trim());
    return rows;
};

/** 按字号量出来的字宽（像素），一行放得下多少字由它反推（见 buildTranslationLayout）。 */
export const measureTranslationWidth = (rows, sizePx, fontFamily, fontWeight) => {
    const list = Array.isArray(rows) ? rows : [];
    // 逐字那一档给的是字数组（每个字一格）：先拼回一行再量，格与格之间没有额外字距。
    const textOf = (row) => (Array.isArray(row) ? row.join('') : row ?? '');
    const widest = list.reduce((max, row) => Math.max(max, Array.from(textOf(row)).length), 0);
    const context = getMeasureContext();
    if (!context || widest === 0) return widest * sizePx * 0.6;
    context.font = `${fontWeight} ${sizePx}px ${fontFamily}`;
    return list.reduce((max, row) => Math.max(max, context.measureText(textOf(row)).width), 0);
};

/**
 * 行盒比**字**高出来的那两条空白（像素）：块的顶边到第一行的墨迹、最后一行墨迹到块的底边。
 *
 * 块在 CSS 里的边界是行盒的边界，而行盒比字高：多出来的那一份就是 half-leading
 * （行高比字体给的字形盒高出的部分上下各一半）。摆位问的是「字的上边缘贴没贴上沿」，
 * 所以顶对齐得把整块往上抬第一条、底对齐对称地往下坠。
 *
 * 只扣 half-leading，不再扣 `ascent − 墨迹 ascent`：canvas 的 `fontBoundingBoxAscent`
 * 与浏览器排版用的那一份并不完全一致，把那个差也减掉会多抬两三个像素，字顶反而被切掉一线。
 * 实测两种文字量下来，half-leading 加上这一点点差正好落在亚像素级。
 *
 * 量不到字体度量时（无头环境、极简 DOM 桩）按「行高比字号松的那一份折半」估：
 * 只影响贴边的那几像素，不影响摆到哪。
 */
export const measureTranslationInk = (options = {}) => {
    const sizePx = Math.max(1, Number(options.sizePx) || 1);
    const lineHeight = Math.max(sizePx, Number(options.lineHeight) || 0);
    const fontFamily = typeof options.fontFamily === 'string' && options.fontFamily
        ? options.fontFamily
        : 'sans-serif';
    const fontWeight = Number.isFinite(options.fontWeight) ? options.fontWeight : 500;
    const rows = Array.isArray(options.rows) ? options.rows : [];
    const textOf = (row) => (Array.isArray(row) ? row.join('') : typeof row === 'string' ? row : '');
    const blankOf = (text) => {
        const context = text ? getMeasureContext() : null;
        if (!context) return (lineHeight - sizePx) / 2;
        context.font = `${fontWeight} ${sizePx}px ${fontFamily}`;
        const box = context.measureText(text);
        const ascent = Number(box?.fontBoundingBoxAscent);
        const descent = Number(box?.fontBoundingBoxDescent);
        // 认不出字形盒（极简桩）时按字号的九成折半算：仍是一份有限的空白。
        if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return (lineHeight - sizePx * 0.9) / 2;
        return Math.max(0, (lineHeight - (ascent + descent)) / 2);
    };
    const first = textOf(rows[0]);
    const last = textOf(rows[rows.length - 1]);
    if (!first) return { top: 0, bottom: 0 };
    return { top: blankOf(first), bottom: last ? blankOf(last) : 0 };
};

/** 丢掉量字宽用的那块画布（测试与卸载时用：它只是一张 1×1 的离屏画布，开销可以忽略）。 */
export const clearTranslationMeasureCache = () => clearMeasureContext();

/**
 * 译文块的字号：试几档字号，取第一个「折出来的行数不超过 `maxRows`」的。
 *
 * 不写死一行能放几个字：中文一个字一格、拉丁一个词大半个格，写死就必然在另一种语言上
 * 出错。所以这里用真字体量（`measureTranslationWidth`）一边折行一边试——从大字号往小试，
 * 第一个折得下的就是它。都折不下（一句长台词）时取下限那一档，再由
 * `fitTranslationLayout` 把多出来的行收进这块高度里。
 *
 * `size` 是旋钮给的目标字号（像素），`width/room` 是这块字横向能占多宽、`roomHeight` 是
 * 纵向能占多高。返回的行数与尺寸就是这一帧要画的。
 */
export const buildTranslationLayout = (options = {}) => {
    const text = typeof options.text === 'string' ? options.text : '';
    const width = Math.max(1, Number(options.room) || 1);
    const roomHeight = Math.max(1, Number(options.roomHeight) || 1);
    const maxRows = Math.max(1, Math.round(Number(options.maxRows) || 3));
    const target = Math.max(1, Number(options.size) || 1);
    const scale = clamp(Number(options.scale) || 1, 0.2, 4);
    const fontFamily = typeof options.fontFamily === 'string' && options.fontFamily
        ? options.fontFamily
        : 'sans-serif';
    const fontWeight = Number.isFinite(options.fontWeight) ? options.fontWeight : 500;
    const lineHeightRatio = Number.isFinite(options.lineHeight) ? options.lineHeight : 1.24;

    /*
     * 字号收到底的那一档：不低于柱顶那一块字（`minSize`）。译文再小也不该比柱子上的字还小——
     * 那时宁可让它多占一行（行数上限只管住「别盖住柱子顶上的字」，见 client 的预算）。
     */
    /*
     * 字号旋钮拧得很大时也不许「一行放不下就整块转小字号」：下限跟着目标字号走
     * （目标的一大半），装不下就横着缩一点（见 fitTranslationLayout 的 `scaleX`），
     * 于是「译文字号」这个旋钮是听得见的——拧大就是更大。
     */
    const floorSize = Math.max(10, Math.min(target * 0.95, Number(options.minSize) || 14));

    /*
     * 一个字号下的排法：按 `room` 断行，量出宽度与高度。横向**不压**——字宽就是字体给的字宽，
     * 一句话在窄屏上于是折成更多行，而不是被压成一条细长的字（压过之后宽高比失真，
     * 越窄越难看，而字号缩一档仍然读得清）。
     */
    const attempt = (sizePx) => {
        const rows = wrapTranslationRows(text, width / Math.max(1, sizePx));
        const widest = measureTranslationWidth(rows, sizePx, fontFamily, fontWeight);
        const rowCount = Math.max(1, rows.length);
        return {
            sizePx,
            rows,
            width: Math.max(1, widest),
            height: rowCount * sizePx * lineHeightRatio,
            lineCount: rowCount,
        };
    };

    let best = null;
    // 从「目标字号」往回收：每次 6%，最多二十来档；第一个折得进屏幕的档位就是它。
    for (let step = 0; step <= MAX_SIZE_STEPS; step += 1) {
        const sizePx = Math.max(floorSize, target * scale * Math.pow(SIZE_STEP, step));
        const candidate = attempt(sizePx);
        best = candidate;
        if (candidate.lineCount <= maxRows && candidate.height <= roomHeight) break;
        if (sizePx <= floorSize + 1e-6) break;
    }
    const height = best.height;
    return {
        ...best,
        maxRows,
        // 行数还是被夹住时，多出来的那一点高度也让它留在块里（见 fitTranslationLayout）。
        lineHeight: best.sizePx * lineHeightRatio,
        // 被行数上限或屏幕高夹住的那些行也要画出来：这一块宁可高一点也不丢字。
        clipped: best.lineCount > maxRows || height > roomHeight + 1e-6,
    };
};

/**
 * 译文透视的三档（见 jumpSettings 的 `translationPerspective`）：
 *   `off`   正面对着镜头，不做任何变换——最好读；
 *   `block` 整块字当一张平面一起压扁（一个字一个矩阵的那种纵深没有）；
 *   `glyph` 透视逐字生效，靠里的字收得更紧，像一行行躺在往远处去的地上。
 */
export const TRANSLATION_PERSPECTIVES = ['off', 'block', 'glyph'];

/** 旋钮值 → 三档之一（认不出来时按最好读的那一档，不按面板默认值）。 */
export const resolveTranslationPerspective = (value) => (
    TRANSLATION_PERSPECTIVES.includes(value) ? value : 'off'
);

/**
 * 透视的参照俯角（度）：面板上「俯角」的默认值。
 *
 * 变形量在这里正好是 1 —— 也就是没有「变形量」这个概念时的那一版画面。于是拖俯角
 * 只会在「比它更像正面」与「比它更像贴在地上的地砖」之间移动，默认观感不变。
 */
export const TRANSLATION_TILT_PITCH = 34;

/** 变形量的上限：俯角压到面板最低那一档（18°）时约 1.57，再往下的余地留一点。 */
const MAX_TILT_AMOUNT = 2.5;

/**
 * 俯角 → **变形量**（1 = 参照俯角那一档）。
 *
 * 一块躺在脚下的字，从低处平着看几乎被压成一条线，从头顶直着看下去则一点也不扁：
 * 变形的深浅跟着 `1 − sinθ` 走。按参照俯角归一化之后：
 *
 *   - 俯角**变大**（更接近俯视）→ 变形量变小：字越来越像正对着镜头的一片，读得更清；
 *   - 俯角**变小**（更接近平视）→ 变形量变大：压得更扁、歪得更厉害，真像躺在远处地上。
 *
 * 以前这个量写死成 1：两种透视档位各有一套固定形状，拖俯角滑杆时译文纹丝不动。
 */
export const resolveTranslationTiltAmount = (pitch) => {
    const value = clamp(Number(pitch) || TRANSLATION_TILT_PITCH, 1, 89);
    const rad = (value * Math.PI) / 180;
    const reference = (TRANSLATION_TILT_PITCH * Math.PI) / 180;
    // 两个都是「离平视还有多远」：平视（θ→0）时最大，头顶（θ→90°）时归零。
    const reach = 1 - Math.sin(rad);
    const base = Math.max(1e-6, 1 - Math.sin(reference));
    return clamp(reach / base, 0, MAX_TILT_AMOUNT);
};

/** 参照俯角下纵向压扁的深度：旧版那个 `1 − cosθ`，变形量 1 时压扁就压这么多。 */
const SQUASH_AT_REFERENCE = 1 - Math.cos((TRANSLATION_TILT_PITCH * Math.PI) / 180);

/** 参照俯角下「近大远小」的深浅：旧版给 `depth` 的那一份（`0.42 + 0.9`）。 */
const DEPTH_GAIN_AT_REFERENCE = 1.32;

/** 参照俯角下那块侧倾（横向错切）的系数。 */
const LEAN_AT_REFERENCE = 0.18;

/**
 * 「镜头俯角」那一档的透视：把整块字当成躺在脚下的一层地砖。
 *
 * 返回一个 4×4 矩阵（`matrix3d` 的十六个分量，列优先），只做三件事：
 *   1. 沿纵轴压扁（俯角越大越不扁——越接近俯视，地面上的一片字就越接近它本来的样子）；
 *   2. 沿竖轴侧倾一点（只够「站歪了一点」的程度，不至于读不出）；
 *   3. 用 `depth` 做一点点真透视：近处大、远处小，字因此略呈梯形。
 *
 * 三件事的**深浅由同一个变形量给**（`resolveTranslationTiltAmount`）：俯角大 → 都变浅，
 * 俯角小 → 都变深。变形量 1 就是参照俯角那一档，与旧版逐项相同；`strength` 再乘一层，
 * 给到 0 时整份矩阵就是恒等（不压、不歪、不呈梯形）。
 *
 * 角度按「块高的一半」算，所以整块字的重心仍在原处：压扁是朝中心收的，不是整块往下掉。
 */
export const translationTilt = (options = {}) => {
    const pitch = clamp(Number(options.pitch) || TRANSLATION_TILT_PITCH, 1, 89);
    const strength = clamp(Number(options.strength ?? 1), 0, 1);
    /*
     * 三个深度都写成「参照那一档的数 × 变形量」：
     *   - 压扁与侧倾跟着变形量放大，于是俯角小的时候字真的被压得更扁、歪得更多；
     *   - `depth` 反过来除以它（`depth` 越小梯形越深），于是俯角大的时候近大远小几乎消失。
     */
    const amount = Math.max(0, resolveTranslationTiltAmount(pitch) * strength);
    const squash = 1 - SQUASH_AT_REFERENCE * amount;
    const lean = LEAN_AT_REFERENCE * amount;
    const depth = amount > 1e-6
        ? (Number(options.depth) || 600) * DEPTH_GAIN_AT_REFERENCE / amount
        : Number.POSITIVE_INFINITY;
    const half = (Number(options.height) || 1) / 2;
    /*
     * 远近：这一层「地砖」有多深。横轴（`x`）的齐次项**不给**——给一点就是水平梯形，
     * 两边被拉成斜的、行也往右歪，读起来像斜着摆的一张纸。只让纵向有远近：
     * 顶上的行离镜头远一点、收得紧一点，整块仍是正对着的那一片地。
     */
    return [
        1, 0, 0, 0,
        -lean, squash, 0, -1 / depth,
        0, 0, 1, 0,
        // 让「压扁」围绕块心进行：先挪到中心、做完再挪回去（Z 取块心，透视也围着它）。
        0, half * (1 - squash), 0, 1 + (half / depth) * (1 - squash),
    ];
};

/** 一档 `matrix3d(...)` 字符串（`null` 表示不透视：旋钮关掉时那一档就是这么画）。 */
export const formatMatrix3d = (values) => (
    Array.isArray(values) && values.length === 16
        ? `matrix3d(${values.map((value) => (Number.isFinite(value) ? value.toFixed(5) : '0')).join(', ')})`
        : null
);

/**
 * 量过之后收这一块：只在**真的放不下**时才收，而且收得很少。
 *
 * 正常路径上字号已经把这块字折进屏幕了（见 buildTranslationLayout），所以这里的两个系数
 * 基本都是 1。留着它只为保底：字号的档位回收有下限（不比柱顶的字还小），长台词撞到那个
 * 下限时整块会略超出一点——那时宁可把它整体收进屏幕，也不能让字跑到画面外面去。
 *
 * 横向与纵向**各收各的**（不按面积等比），并且横向最多只收 `MAX_SQUEEZE_X`：
 * 收得再多就是「把字压扁」，宽高比一失真，字读起来就变味了。
 */
export const fitTranslationLayout = (options = {}) => {
    const width = Math.max(1, Number(options.width) || 1);
    const room = Math.max(1, Number(options.room) || 1);
    const height = Math.max(1, Number(options.height) || 1);
    const roomHeight = Math.max(1, Number(options.roomHeight) || 1);
    const widthFit = Math.min(1, room / width);
    const heightFit = Math.min(1, roomHeight / height);
    return {
        scaleX: Math.max(MAX_SQUEEZE_X, widthFit),
        scaleY: heightFit,
        // 有没有被屏幕的边夹住：夹住了就说明这一句本来就放不下，调用方据此再收一档字号。
        squeezed: widthFit < 0.999 || heightFit < 0.999,
    };
};

/** 整块译文横向占画面宽的多少：两边各留一点，长句于是折行而不是顶到边。 */
export const TRANSLATION_ROOM_SHARE = 0.84;

/**
 * 译文排版的三档（见 jumpSettings 的 `translationAlign`）：
 *   `top`    第一行的上边缘钉在**窗口上沿**，多出来的行往下长；
 *   `center` 块心钉在**窗口正中**——折几行都围着同一个中心，行数变化时上下各长一半；
 *   `bottom` 最后一行的下边缘钉在**窗口下沿**，多出来的行往上长（跟底栏字幕同一条底线）。
 */
export const TRANSLATION_ALIGNS = ['top', 'center', 'bottom'];

/** 旋钮值 → 三档之一（认不出来时按「底部」，那是这个特效一直以来的摆法）。 */
export const resolveTranslationAlign = (value) => (
    TRANSLATION_ALIGNS.includes(value) ? value : 'bottom'
);

/**
 * 译文那一块字排版时按画面高的多少给纵向余地（折行与缩字号的预算）。
 *
 * 只是排版预算，**不约束摆在哪**：位置完全由 resolveTranslationAnchor 给，
 * 偏移摆到尽头就是把字推出画面。这里的用处是「长台词别缩成一行小字」——
 * 超出这一段的句子宁可多折两行，也不把字号压到看不清。
 */
export const TRANSLATION_BAND_SHARE = 0.8;

/**
 * 偏移的极限（占窗口高的比例）。
 *
 * `0.8` 意味着摆到尽头时整块字被推出画面大半——这是有意的：想把译文挪出屏幕看背景，
 * 这个旋钮就得到得了那儿。面板滑杆的范围也从这里取（见 jumpSettings）。
 */
export const TRANSLATION_OFFSET_LIMIT = 0.8;

/**
 * 整块译文摆在哪：横向屏幕正中，纵向由**对齐方式 + 偏移**给。
 *
 * 两件事各管一件：
 *   - **对齐**只回答「钉住这块字的哪一头、那一头的零点在窗口的哪里」：
 *     顶对齐钉第一行的上边缘、零点在窗口上沿；居中钉块心、零点在窗口正中；
 *     底对齐钉最后一行的下边缘、零点在窗口下沿。
 *   - **偏移**是「整块挪几个窗口高」：`0` 就是正好贴在零点上——顶部对齐时第一行的
 *     上边缘压着窗口上沿，底部对齐时最后一行的下边缘压着窗口下沿；`±0.8` 就挪掉
 *     0.8 个窗口高，够把字拉出画面。正值往上。
 *
 * 以前这里是「在上沿留白与底栏之间的那条区间里按几成扫」：0 落在区间正中，顶对齐永远
 * 差着 6% 的留白，滑到头也出不去——「要贴边贴不上」就是这么来的。现在没有隐藏的留白、
 * 也没有底栏当地板，画面自己的边距不再约束这个旋钮。
 *
 * `topInk` / `bottomInk` 是行盒比**字**高出来的那两条空白（像素，见 measureTranslationInk）：
 * 块在 CSS 里的边界是行盒的边界，不扣掉这两份，偏移归零时字的上边缘就总差着一小截。
 * 顶对齐扣 `topInk`（整块往上抬，第一行真正的字才贴上沿）、底对齐扣 `bottomInk`
 * （对称地往下坠），居中两头一样多、正好抵消。
 *
 * 返回 `y`（锚点像素）与 `anchorPercent`（块的哪一头钉在锚点上：`0%` / `-50%` / `-100%`）。
 * 块的尺寸由 CSS 的 `translate(-50%, Y%)` 自己算，所以这里不需要知道块有多高。
 */
export const resolveTranslationAnchor = (options = {}) => {
    const width = Math.max(1, Number(options.width) || 1);
    const height = Math.max(1, Number(options.height) || 1);
    const align = resolveTranslationAlign(options.align);
    const offset = clamp(
        Number(options.offset) || 0,
        -TRANSLATION_OFFSET_LIMIT,
        TRANSLATION_OFFSET_LIMIT,
    );
    // 钉住的那一头在窗口里的零点：上沿、正中、下沿。
    const pinY = align === 'top' ? 0 : align === 'center' ? height / 2 : height;
    // 正值往上：屏幕 y 变小。
    const shift = -offset * height;
    // 行盒里那两条空白不算字：顶对齐往上抬、底对齐往下坠。
    const topInk = Math.max(0, Number(options.topInk) || 0);
    const bottomInk = Math.max(0, Number(options.bottomInk) || 0);
    const bleed = align === 'top' ? -topInk : align === 'bottom' ? bottomInk : 0;
    return {
        x: width / 2,
        y: pinY + shift + bleed,
        align,
        anchorPercent: align === 'top' ? 0 : align === 'center' ? -50 : -100,
    };
};

/**
 * 逐字的密排层用哪几行：在「逐字」与「按字号折行」之间取**少的**那个。
 *
 * 逐字那套是给「一个字一个字从地上亮起来」用的：把这一句的字按字号量成一行行、
 * 每个字一格（见 jumpStage 的 paintTranslation），行数与「按字号折行」一致时，
 * 两种画法看上去是同一块字。取少的那个只是保底——长台词不会因为逐字层排得宽
 * 就把整块字撑出画面。
 */
export const resolveGlyphRows = (text, sizePx, room, fontFamily, fontWeight, maxRows) => {
    const perRow = Array.from(typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '');
    if (perRow.length === 0) return [];
    const lineWidth = Math.max(1, Number(room) || 1);
    const limit = Math.max(1, Math.round(Number(maxRows) || 3));
    const context = getMeasureContext();
    const rows = [];
    // 逐字那一档要的是**字格**：每个字自己一格（透视逐字生效），所以这一层返回的是字数组。
    let row = [];
    let rowWidth = 0;
    perRow.forEach((char) => {
        const width = context
            ? (context.font = `${fontWeight} ${sizePx}px ${fontFamily}`, context.measureText(char).width)
            : sizePx;
        if (row.length > 0 && rowWidth + width > lineWidth) {
            rows.push(row);
            row = [];
            rowWidth = 0;
        }
        /*
         * 标点不落在一行的头上（它黏在前一个字上）：这一行还放得下就先塞进去，
         * 下一行才不会从逗号、句号开始。
         */
        if (/\s/u.test(char) && row.length === 0) return;
        row.push(char);
        rowWidth += width;
    });
    if (row.length > 0) rows.push(row);
    return rows.slice(0, Math.max(1, limit));
};
