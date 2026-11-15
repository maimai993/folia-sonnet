import { createJumpStage } from './jumpStage.mjs';
import { IMPACT_SECONDS, resolveHopSquash, resolveLandingBurst, resolvePillarSpring } from './jumpCourse.mjs';
import {
    attachChunkTimings,
    buildCharTimings,
    resolveChunkCap,
    splitJumpChunks,
} from './jumpSplit.mjs';
import { resolveUnitMetrics } from './jumpMeasure.mjs';
import {
    buildLineTimeline,
    MIN_IDLE_SECONDS,
    resolveCameraPath,
    resolveLastRelease,
    resolveMotionWindow,
    resolvePathWeights,
    resolveRowReveal,
    resolveRunnerState,
    resolveRestPillar,
    resolveShiftAirborne,
    resolveShiftLanding,
    resolveTailAirborne,
    resolveTrailFade,
} from './jumpTimeline.mjs';
import { accumulateRowRoad, resolveBoardRows, rowBlockCenter } from './jumpBoard.mjs';
import {
    boxFaces,
    cylinderFaces,
    placeText,
} from './jumpProject.mjs';
import {
    FACE_SPAN_CELLS,
    MIN_UNIT_CELLS,
    REST_DIAMETER_CELLS,
    TEXT_FILL,
    resolveBlockShape,
    resolvePillarHeight,
    resolvePillarTypePx,
    resolveTextAspect,
} from './jumpShape.mjs';
import { JUMP_DEFAULT_KNOBS, JUMP_SETTINGS_SCHEMA } from './jumpSettings.mjs';
import {
    CAMERA_DISTANCE_MAX,
    CAMERA_DISTANCE_MIN,
    MAX_CHUNK_CHARS,
    MAX_CHUNKS_PER_ROW,
    PILLAR_RATIO,
    RUNNER_RATIO,
    resolveJumpFrame,
} from './jumpFrame.mjs';
import { resolveJumpPalette } from './jumpPalette.mjs';
import {
    TRANSLATION_BAND_SHARE,
    TRANSLATION_OFFSET_LIMIT,
    TRANSLATION_ROOM_SHARE,
    buildTranslationLayout,
    clearTranslationMeasureCache,
    measureTranslationInk,
    measureTranslationWidth,
    fitTranslationLayout,
    formatMatrix3d,
    pickTranslationLine,
    resolveAlternateText,
    resolveGlyphRows,
    resolveTranslationAnchor,
    resolveTranslationPerspective,
    resolveTranslationTiltAmount,
    translationTilt,
} from './jumpTranslation.mjs';
import { resolveTranslationReveal, resolveTranslationStart } from './jumpTimeline.mjs';

// mods/visualizer-jump/client.mjs
// 「跳一跳」：等距场景里，一个小人在一根根带字的长方块上跳。
//
// 一条路，没有分叉（buildBoard / jumpBoard.accumulateRowRoad）
//   第 k 行沿哪条世界轴走只由 k 的奇偶决定：偶数 +Y（屏幕右上）、奇数 +X（左上）。
//   第 k+1 行接住第 k 行的**拐点**，接着朝自己的方向铺：块按**字宽**排，长词是一根长条、
//   短词是一根短条，块与块之间留「柱子间隙」。于是整首歌在屏幕上是一条连续台阶，
//   一右一左地往上铺，像无限画布；实际只挂当前这三行，画布不用真的无限大。
//   关键是位置是**绝对**的：只由 (行号, 块号) 决定，与「现在轮到第几行在写」无关。
//
// 一套投影，没有第二套（jumpProject）
//   方位 45°、俯角 θ 的正交投影。柱子的三个面、柱子的位置、贴面的文字矩阵，全部由它推出
//   ——所以字与柱子之间不再有夹角：字是真躺在那个面上的（等距是仿射的，一个 2D 矩阵
//   就能把字错切到面上，用不着 3D 引擎）。文字可指定贴在顶面 / 正面（沿路的长条面）/
//   侧面（端头）/ 悬浮在上方，**旋钮说的是哪一档就是哪一档**：字号与倾角由那一面在屏幕上
//   的大小推出来，同一面上一整行的字于是同一个大小、同一个倾角，位置只由这一面定。
//   俯角因此是真的在转镜头，不再是一组凑出来的缩放。
//
// 投影与缩放分开（jumpFrame）
//   俯角只改**形状**（地面铺多开、柱与人多高、字的错切），缩放只认「镜头距离」。
//   取景按 `min(当前俯角, 参照俯角)` 封顶，俯角往下调不再把整屏放大；
//   想要更大 / 更小的画面只动「镜头距离」，它乘在这份取景上，与俯角正交。
//
// 镜头沿路匀速走（paintFrame / jumpTimeline.resolveCameraPath）
//   镜头大致钉住小人此刻踩着的那一块，但**不跟着他的跳走**：他只在腾空那一截前进，
//   落地之后站着不动，照他的曲线走就成了「走一截、停一截」（节奏一快，画面在动—停—动地抖）。
//   所以镜头有自己的到站时刻：一段覆盖「这一跳 + 落地后站着那一截」，段与段首尾相接，
//   行内于是全程匀速，只在每行的最后一块上停一下等跨行。所以整条路不会被拽回来重排，
//   拖动进度、暂停、导出看到的都是同一帧（位置是由时间算出来的，不累加）。
//
// 块是「字有多长就有多长」的长方块（buildBoard / jumpSplit 的字宽）
//   块长按字宽给（长词长条、短词短条），随块厚一起放大，厚与高是常量，块之间留「柱子间隙」；
//   行首行尾各留半个间隙，于是拐点上两块不叠，而两条文字线恰好相交在拐点上。
//
// 行末那根歇脚的圆柱（jumpTimeline.resolveRestPillar / jumpProject.cylinderFaces）
//   两行之间隔得够久（面板上的「歇脚柱」，默认 1.75 秒）时，行末立一根**无字的圆柱**：
//   唱完最后一个字他跳到它上面站着，下一行开口前一个跨行滞空（`shiftFly`）才起跳，
//   落在下一行首块上仍是第一个字开口那一刻。
//   于是间奏里他歇在自己这一行的行末（这一段有意是静的），不会提前站到下一行首块上等着，
//   那一跳也不会因为空档宽而飘成慢动作。0 = 只要两跳塞得下就立；空档窄到站不住就不立
//   （连唱照旧直接跨过去）。
//
// 亮度（这一版的硬规矩）
//   块与字的颜色不随时间变，进度只由小人站在第几块上表达；
//   正在写的那一行实一点、上下两行淡一档，三行不会糊成一条路。
//   柱面的浓淡走「线框强度」，字的亮度只走行的主次——两者分开，字才不会被柱面那份
//   浓度一起乘掉（以前整根柱子共用一个 opacity，字只剩四成亮度）。
//   柱面与棱线的色相由主题推（jumpPalette），不再是写死的中性冷灰。
//   明暗按**屏幕上的左右**给：哪一面落在左下随这一行的朝向交替，按正/侧上色会一明一暗地闪。
//
// 新的一行怎么登场（revealWindowOf / jumpTimeline.resolveRowReveal）
//   每一行第一次出现在画面上的时刻是「镜头切到它前一行那一刻」——那时它作为下一行出现。
//   从那一刻起，它的块按行内序号错开、从落位点下方滑上来并淡入：序号 0 在本行最下、
//   最后一块在最上，所以整行是从下往上依次亮出来的。整行必须在小人跳上来（这一行接手）
//   之前落位，短句就把错开量压一压。正在写的、已经唱完的两行早已落位，登场偏移为 0，
//   看不出差别。时刻同样只由时间算出来，拖动进度不会把动画留在半路。
//
// 落地那一下（resolveLandingBurst / jumpStage.drawImpact）
//   小人磕在柱顶上的那一瞬，落点上铺开一圈环、溅几粒尘——「落在**哪一根**上」一眼看得见。
//   时刻是时间表里现成的那一秒（跨行那一跳就是下一行开口那一刻），所以特效不累加：
//   拖动进度不会留下半开的环，暂停也不会把它冻在中途。
//
// 柱子的弹性（resolvePillarSpring / jumpTimeline 的 pressTime / releaseTime）
//   小人**落地**把柱子踩沉下去，**起跳**那一刻柱子还在最深处、随即弹回来、冲过头一点，
//   再做几下越来越小的振动约 1 秒后停住；他踩在柱顶上，所以跟着柱子一起沉、一起弹。
//   每根柱子自己记两个时刻（踩上来 / 跳走），三段连续、只由时间算出来，不累加。
//   幅度由「柱子弹性」旋钮给：0 = 柱子纹丝不动（也就是加这档特效之前的样子）。
//
// 分工：jumpProject 管投影（面、位置、贴面矩阵）；jumpBoard 管行朝向、这条路的坐标与
// 跨行那一跳；jumpSplit 管切块与字时刻；jumpTimeline 管时间（含新行登场的过渡）；
// jumpCourse 管这一跳本身（三拍挤压与落地冲击）；jumpStage 管节点；
// 这个文件只做「每帧往哪写、镜头摆在哪」。

/** 量不到容器时按 16:9 摆一版，等能量到再纠正。 */
const FALLBACK_SIZE = { width: 1280, height: 720 };

/**
 * 「一格多少像素」与「镜头钉在哪」整套算术都在 jumpFrame：那里把**投影**（俯角）
 * 与**缩放**（镜头距离）分开——俯角只改形状，缩放只认镜头距离。这里只管消费它的结果。
 */

/**
 * 镜头的前瞻量（格）：小人不钉在正中，而是往路的**后方**偏这么点，
 * 前面那几块还没跳到的柱子才看得全。别给太大——换行要换向，这一笔会被来回甩。
 */
const LOOK_AHEAD_CELLS = 1;

/**
 * 起跳那一圈相对落地那一圈的大小与浓淡：蹬开的力道不如磕上去那一记，
 * 所以环小一点、淡一点，也不溅尘——两圈一眼能分出「落下」与「跳出去」。
 */
const TAKEOFF_RING_SCALE = 0.78;
const TAKEOFF_RING_FADE = 0.7;

/**
 * 起跳那一圈与**落在同一根柱子上**的那一圈至少隔多久，才两圈都画（秒）。
 *
 * 他在这一块上站得比这还短就走时，两圈是同一根柱子上前后脚铺开的，看着是一团，
 * 也分不出「落下」与「跳出去」——这时候**只画落地那一圈**（磕上去那一记更重）。
 *
 * 默认是一圈环自己的寿命（`IMPACT_SECONDS`）：落地那圈散完了起跳那圈才起，两圈永远不叠。
 * 调小 = 允许两圈叠一点（唱得快的句子里也看得见起跳那圈）；0 = 只要起跳就画，不管多挤。
 */
const TAKEOFF_RING_MIN_GAP = IMPACT_SECONDS;

/**
 * 收尾那一刻落在末段里的位置：0…1，越小越靠前。
 *
 * 末段（末块落点 → 下一行开口）整段都在走，这个数只回答「唱完那一刻镜头已经走了几成」：
 * 取一个比 0 明显大的数，于是**镜头运动包住「唱完最后一个字」那一刻**，
 * 不是等唱完了才起步。它只影响 `handoverTime` 这个参考时刻，不再拿去拼排版缓存键。
 */
const HANDOVER_SHARE = 0.22;

/** 译文的行高（倍字号）：比柱顶那块字松一点，中文两行之间才不黏在一起。 */
const TRANSLATION_LINE_HEIGHT = 1.26;

/** 译文字号收到底的那一档（相对柱顶那块字）：再小就不如不显示。长台词宁可多折一行，
 * 也不会缩成一行小字（见 jumpTranslation.buildTranslationLayout 的 `minSize`）。
 */
const MIN_TRANSLATION_SIZE = 0.55;

/** 新行登场：柱子从落位点下方这么多格处往上滑出来。 */
const REVEAL_RISE_CELLS = 0.9;



/** 新行登场：单根柱子滑上来用多久（秒）。 */
const REVEAL_SECONDS = 0.4;

/** 新行登场：相邻两根柱子之间错开多少（秒）——整行因此是从下往上依次亮出来的。 */
const REVEAL_STAGGER = 0.07;

/**
 * 新行登场最多占掉「从登场到这一行接手」这段时间的几成。
 * 留一成几的余量：跨行那一跳是在这一行接手**之前**就起跳的，柱子必须先站定。
 */
const REVEAL_BUDGET_SHARE = 0.7;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** 文字贴在哪个面：顶面 / 正面（沿路的长条面）/ 侧面（端头）/ 悬浮在上方。 */
const TEXT_FACES = ['top', 'front', 'side', 'above'];

/** 译文那一层显示的到底是哪一条替代文字（见 jumpTranslation.pickTranslationLine）。 */
const TRANSLATION_MODES = ['translation', 'romanization', 'off'];

/** 译文的排版对齐：整块字贴在它那块竖向空间的哪一头（见 jumpTranslation.resolveTranslationAnchor）。 */
const TRANSLATION_ALIGNS = ['top', 'center', 'bottom'];

/** 读设置：宿主已并入缺省，但非法值（旧版本存下的、面板外写进来的）按缺省回落。 */
const readKnobs = (settings) => {
    const source = settings && typeof settings === 'object' ? settings : {};
    const readNumber = (key) => {
        const raw = Number(source[key]);
        return Number.isFinite(raw) ? raw : JUMP_DEFAULT_KNOBS[key];
    };
    const textFace = typeof source.textFace === 'string' && TEXT_FACES.includes(source.textFace)
        ? source.textFace
        : JUMP_DEFAULT_KNOBS.textFace;
    return {
        pitch: clamp(readNumber('pitch'), 18, 60),
        /*
         * 镜头距离：乘在取景上的缩放（1 = 参照俯角那一版取景）。
         * 以前缩放是由俯角反解出来的，俯角一小画面就放大；现在它与俯角彻底分开，
         * 想要更大 / 更小的画面只动这一根（见 jumpFrame.resolveJumpFrame）。
         */
        cameraDistance: clamp(readNumber('cameraDistance'), CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX),
        textFace,
        // 上限跟着面板走（`spacing` 的上限是 6）：滑到尽头也不能比面板上写的还小。
        spacing: clamp(readNumber('spacing'), 0.1, 6),
        // 空档隔了多久才立行末那根歇脚柱（0 = 只要两跳塞得下就立，见 resolveRestPillar）。
        restGap: clamp(readNumber('restGap'), 0, 10),
        pillarHeight: clamp(readNumber('pillarHeight'), 0.2, 3),
        pillarSpring: clamp(readNumber('pillarSpring'), 0, 2),
        chunkChars: Math.round(clamp(readNumber('chunkChars'), 1, 4)),
        preferPair: readNumber('preferPair') >= 0.5,
        flySeconds: clamp(readNumber('flySeconds'), 0.1, 1.2),
        // 上限跟着面板走（`arc` 的上限是 2.4）：默认值 1.2 别顶在滑块尽头，还留得出更高的一档。
        arc: clamp(readNumber('arc'), 0, 2.4),
        runnerScale: clamp(readNumber('runnerScale'), 0.2, 2),
        // 三根都能滑到 0：0 = 这一面彻底不画（面没了只剩棱线、棱线没了只剩字），见 jumpStage 的 resolveFaceOpacity。
        pillarOpacity: clamp(readNumber('pillarOpacity'), 0, 1),
        pillarSideOpacity: clamp(readNumber('pillarSideOpacity'), 0, 1),
        pillarEdgeOpacity: clamp(readNumber('pillarEdgeOpacity'), 0, 1),
        // 上下两行相对当前行的浓淡：1 = 一样浓，0 = 只剩正在写的那一行（见 paintFrame 的 rowFade）。
        otherRowOpacity: clamp(readNumber('otherRowOpacity'), 0, 1),
        trail: clamp(readNumber('trail'), 0, 1),
        translationMode: TRANSLATION_MODES.includes(source.translationMode)
            ? source.translationMode
            : JUMP_DEFAULT_KNOBS.translationMode,
        translationSize: clamp(readNumber('translationSize'), 0.5, 3),
        translationRows: Math.round(clamp(readNumber('translationRows'), 1, 5)),
        translationAlign: TRANSLATION_ALIGNS.includes(source.translationAlign)
            ? source.translationAlign
            : JUMP_DEFAULT_KNOBS.translationAlign,
        // 偏移是「挪几个窗口高」，两端 ±0.8 够把字推出画面（与面板范围一致）。
        translationOffset: clamp(readNumber('translationOffset'), -TRANSLATION_OFFSET_LIMIT, TRANSLATION_OFFSET_LIMIT),
        translationOpacity: clamp(readNumber('translationOpacity'), 0.15, 1),
        translationPerspective: resolveTranslationPerspective(source.translationPerspective),
        translationGlow: clamp(readNumber('translationGlow'), 0, 1),
    };
};

/** 这一行的第一个字开口的时刻：换行就是它，不是 `startTime`。 */
const resolveEnterTime = (line) => {
    if (!line) return Number.NaN;
    const first = Array.isArray(line.words) && line.words.length > 0 ? line.words[0]?.startTime : null;
    if (Number.isFinite(first)) return first;
    return Number.isFinite(line.startTime) ? line.startTime : Number.NaN;
};

/**
 * 这一行最后一个字什么时候唱完：末块自己的收尾（不是这一行的 `endTime`，那个常常是
 * 「整行还能写多久」）。
 *
 * 没有逐字时间时，字时刻是按这一行均分估出来的，估出来的收尾比真实唱完晚一截；
 * 照它算的话镜头会一直等到下一个字才动，画面仍旧停住——所以只有末块真的比行首晚开口
 * （有逐字 / 逐词时间）时才用它，否则返回 `NaN`，由 `resolveMotionWindow` 按下限估。
 */
const resolveVoicedEnd = (line) => {
    const words = Array.isArray(line?.words) ? line.words : [];
    if (words.length === 0) return Number.NaN;
    const lastEnd = Number(words[words.length - 1]?.endTime);
    if (!Number.isFinite(lastEnd)) return Number.NaN;
    // 一个跨整行的词 = 没有真正的逐字时间（jumpSplit.buildCharTimings 也是这么判的）。
    if (words.length === 1 && Math.abs(lastEnd - Number(line?.endTime)) < 1e-6) return Number.NaN;
    return lastEnd;
};

/**
 * 这一次 mount 里每一行的「时间窗」。
 *
 * 三条都按时间算，所以拖动进度、暂停、导出走同一条链：
 *   - `writeStart`：行首字开口的时刻（换行就发生在这之前一点）；
 *   - `writeEnd`：这一行最晚还能跳的时刻 —— 下一行开口之前（留一点跨行的余量），
 *     并且不超过宿主给的 `renderHints.renderEndTime`（那之后这一句就该让位了）；
 *   - `afterStart` / `afterEnd`：**收尾窗**，最后一个字唱完到下一行开口之间。
 *     这一截里画面的动静只有落地与起跳那两圈环（见 paintFrame 的 landings），
 *     环之间本来就是静的——间奏里没有在唱的东西，静着是对的。
 *
 * `afterEnd` 就是下一行开口（没有下一行时是这一段音乐的收尾）：跨行那一跳与镜头的
 * 末段最晚到这一刻为止。间奏比滞空长时它们先落地 / 到站（唱完 + 一个滞空，见
 * jumpTimeline.resolveShiftFly），剩下的空档小人站着歇——行末立了空柱子就歇在柱子上，
 * 没有就站在下一行首块上。
 */
const buildWriteWindows = (lines) => {
    const enters = lines.map(resolveEnterTime);
    // 每一段音乐的收尾 = 下一次开口（或整首的收尾）：歌词原文唱完之后往往还挂着伴奏。
    const voicedEnds = lines.map(resolveVoicedEnd);
    return lines.map((line, index) => {
        const start = Number.isFinite(line.startTime) ? line.startTime : 0;
        const writeStart = Number.isFinite(enters[index]) ? enters[index] : start;
        const nextEnter = Number.isFinite(enters[index + 1]) ? enters[index + 1] : null;
        const renderEnd = Number.isFinite(line.renderHints?.renderEndTime)
            ? line.renderHints.renderEndTime
            : line.endTime;
        /*
         * 下一行开口前留出一小截：这一行最后一跳要在这之前落地。
         * 留多少按这一行总长给（长句多留、短句少留），两头夹一下，短句也不会被吃掉半句。
         */
        const ahead = nextEnter !== null ? nextEnter - writeStart : Number.NaN;
        const reserve = Number.isFinite(ahead) ? Math.min(0.28, Math.max(0.12, ahead * 0.15)) : 0.12;
        const handOver = nextEnter !== null ? nextEnter - reserve : null;
        const writeEnd = Math.max(
            writeStart,
            handOver !== null ? Math.min(renderEnd, handOver) : renderEnd,
        );
        /*
         * 收尾窗的止点：下一行开口。最后一句没有下一行，就取宿主给的 `renderEndTime`
         * ——它已经把「这一句还能待多久」算进来（歌词写完之后常还挂着一段伴奏）。
         */
        const afterEnd = nextEnter !== null ? nextEnter : Math.max(writeEnd, renderEnd);
        const motion = resolveMotionWindow({
            start,
            end: writeEnd,
            nextStart: afterEnd,
            voicedEnd: voicedEnds[index],
            motionEnd: renderEnd,
        });
        return {
            writeStart,
            writeEnd,
            afterStart: motion ? motion.afterStart : writeEnd,
            afterEnd: motion ? motion.afterEnd : writeEnd,
        };
    });
};

/**
 * 一行的排版：切块 → 每字时刻 → 每块字宽 → 时间表。
 *
 * 世界坐标的尺度留给投影那一步（`buildBoard` 决定一「格」多少像素），
 * 这里只回答「这一行有几块、每块几个字、什么时候落地」。
 */
const layoutLine = ({ line, folium, knobs, lineIndex, window, cap, nextStart, handover, entryLand, fontFamily, fontWeight }) => {
    const text = typeof line?.fullText === 'string' ? line.fullText : '';
    if (!text.trim()) return null;

    const segments = typeof folium?.lyrics?.segmentWords === 'function'
        ? folium.lyrics.segmentWords(line)
        : null;
    const source = segments && segments.length > 0 ? segments : [{ segment: text }];

    let chunks = splitJumpChunks(source, { maxChunkChars: knobs.chunkChars, preferPair: knobs.preferPair });
    /*
     * 太碎了就一层层放宽「每块几个字」，直到块数落进 `cap`：
     * 一行十几根柱子的话，每根只剩指甲盖大，字根本读不出来。
     *
     * 一次都没变少就停下：剩下的块是拆不动的拉丁词（`because` 不能被劈成两半），
     * 再放宽也不会变少，一行长英文句就宁可多几根柱子。
     */
    let perChunk = knobs.chunkChars;
    while (chunks.length > cap && perChunk < MAX_CHUNK_CHARS) {
        perChunk += 1;
        const wider = splitJumpChunks(source, { maxChunkChars: perChunk, preferPair: knobs.preferPair });
        if (wider.length >= chunks.length) break;
        chunks = wider;
    }
    if (chunks.length === 0) return null;

    const timed = attachChunkTimings(chunks, buildCharTimings(line));
    const heightCells = resolvePillarHeight(knobs.textFace, knobs.pillarHeight * PILLAR_RATIO);
    /*
     * 排版只看 `display`（去掉首尾空白的这一块）：
     * 分词常把词间的空格留在块尾，空格看不见却占字宽——按它算块长与字盒，
     * 字就被挤到柱子的一头。只剩空白的块干脆不立柱子（否则是一根什么也不写的柱）。
     */
    const units = timed
        .filter((chunk) => (chunk.display ?? chunk.text).length > 0)
        .map((chunk) => {
            const display = chunk.display ?? chunk.text;
            const charCount = Math.max(1, Array.from(display).length);
            /*
             * 字宽（以字号为单位）与量它的那把尺子：整块字用宿主给的字体量一次
             * （jumpMeasure.resolveUnitMetrics），量不到才回落到按字身估。
             *
             * 以前这两个数是「CJK 1 格、拉丁 0.58 格」累加出来的，字宽还要再除以
             * 「拉丁字母只有 0.58 格那么高」——可字盒的高就是字号（`resolveTypeBox` 里
             * `fontSize` 取字盒高），那个分母取错了：中文恰好对上，英文的宽被凭空放大
             * 约 1.7 倍，字盒比字宽出一大截，字边缘到柱子边缘于是空出一圈。
             * 现在宽是量出来的真进宽、分母是恒定的一个字号，空当只由这块字有多宽决定，
             * 与语种无关。
             */
            const { span, glyph } = resolveUnitMetrics(display, fontFamily, fontWeight);
            // 这块柱子的尺寸都由字宽与字盒的长宽比推出来（jumpShape）：面装得下字，柱子跟着字长。
            const shape = resolveBlockShape(knobs.textFace, span, heightCells, glyph);
            return {
                text: display,
                chars: chunk.chars ?? [],
                startTime: chunk.startTime,
                endTime: chunk.endTime,
                // 字宽（以字号为单位）：这一块的字排出来有多长。
                span,
                glyph,
                len: shape.len,
                depth: shape.depth,
                faceDepth: shape.faceDepth,
                height: shape.height ?? heightCells,
                charCount,
            };
        });
    // 整行只剩空白（分词只吐了几个空格）时没有柱子可摆，这一行就当空行跳过。
    if (units.length === 0) return null;

    /*
     * 行末那根**空柱子**（无字的圆柱）：间奏宽到站得住时立在行末（见 resolveRestPillar）。
     * 唱完最后一个字他跳到它上面歇着，下一行开口前再从它上面起跳——
     * 于是他不提前站到下一行首块上，那一行的第一个字开口时他才动身。
     */
    const lastRelease = resolveLastRelease({
        end: window.afterStart ?? window.writeEnd,
        nextStart,
    });
    const restPillar = resolveRestPillar({
        release: lastRelease,
        nextStart,
        flySeconds: knobs.flySeconds,
        restGap: knobs.restGap,
    });
    if (restPillar) {
        units.push({
            // 没有字：一根光秃秃的圆柱，只在他歇脚的那一截里出现。
            text: '',
            chars: [],
            startTime: restPillar.landTime,
            endTime: restPillar.liftTime,
            span: REST_DIAMETER_CELLS,
            glyph: 1,
            // 圆：沿路与横向都是直径，柱高与这一行的字柱同高（他就站在同样的高度上）。
            len: REST_DIAMETER_CELLS,
            depth: REST_DIAMETER_CELLS,
            faceDepth: REST_DIAMETER_CELLS,
            height: heightCells,
            charCount: 0,
            rest: true,
        });
    }

    /*
     * 时间与字共用一条轴：每块**落在**它自己开唱的那一刻（见 jumpTimeline）——
     * 落地、冲击环、柱子被踩下去，都与这句话的第一个音同时发生；起跳是从那一刻往回
     * 推一个滞空，于是他脚下的那一块永远是正在唱的那一块。
     * 收尾上限用 `window.writeEnd`：下一行开口之前这一行的最后一跳必须已经落地。
     */
    const timeline = buildLineTimeline({
        startTime: window.writeStart,
        endTime: window.writeEnd,
        count: units.length,
        // 滞空按秒给：同一行里每一跳的窗口长短不一，几成比例由时间轴自己按窗口算。
        flySeconds: knobs.flySeconds,
        landTimes: units.map((unit) => unit.startTime),
        /*
         * 最后一根柱子什么时候弹回来 = 他跨行那一跳的起步点：**唱完那一刻**（收尾窗的起头）。
         * 之后到下一行开口之间他在路上，柱子则在他离开时弹回来。
         * 行末有空柱子时，唱完那一刻是他跳上柱子那一刻（柱子由它自己的时刻管）。
         */
        lastRelease,
        // 行末那根空柱子的落点与起跳时刻（间奏不够宽就是 null）。
        rest: restPillar,
        /*
         * 第 0 根柱子被踩下去的那一刻：他从上一行跨过来**落**在它上面的那一刻。
         * 连唱时就是这一行开口；间奏里他落得比开口早一截（见 resolveShiftLanding），
         * 那一沉得跟着他，不能等到开口才凭空沉下去。
         */
        entryLand,
        // 末段的到站时刻：下一行开口（跨行那一跳的落点，与 jumpBoard 的相位同一个时刻）。
        nextStart,
        // 末段（镜头从末块走到下一行首块）的内部节奏：让镜头在收尾那一刻就离站。
        handover,
    });

    return { lineIndex, text, units, timeline };
};

const mountJump = (folium, container, ctx) => {
    const stage = createJumpStage(container);
    /*
     * 「特效不透明度」不在这里写：宿主已经把它加在可视化所在的那一层上了（FoliumDisplay
     * 的 visualizerOpacity 说明写着别再加一遍），再写一次等于把值乘了两次。
     */

    let knobs = readKnobs(ctx.getSettings());
    // 排版缓存：换行要反复读相邻几行，且旋钮 / 时间窗变一次就整表作废。
    const layoutCache = new Map();
    // 时间窗只跟歌词有关：mount 期间歌词是快照，算一次就够。
    let windows = buildWriteWindows(ctx.lines ?? []);
    let palette = resolveJumpPalette(ctx.getTheme(), folium);

    /**
     * 真的去量一次容器尺寸。
     *
     * 量的时候浏览器要把上一帧写进去的那几百处样式 flush 成一次同步布局，代价很高：
     * 逐帧地量（老写法）等于每帧都强制 layout 一次，会把整屏拖成掉帧。
     * 所以这里改成按「可能变了」标记来量：只有标脏了才真的去量一次。
     */
    const measureMetrics = () => {
        const width = stage.root.clientWidth || container.clientWidth || 0;
        const height = stage.root.clientHeight || container.clientHeight || 0;
        if (width > 0 && height > 0) return { width, height };
        return { ...FALLBACK_SIZE };
    };
    let metrics = { ...FALLBACK_SIZE };
    let metricsDirty = true;
    const readMetrics = () => {
        if (!metricsDirty) return metrics;
        metricsDirty = false;
        const next = measureMetrics();
        const moved = next.width !== metrics.width || next.height !== metrics.height;
        metrics = next;
        // 尺寸变了，`cell` 跟着变：方块缓存的键里带着它，旧条目整批作废。
        if (moved) {
            blockCache.clear();
            // 译文的键里带着屏幕宽：旧的排版再也不命中，别留着占位置（几块而已）。
            translationCache.clear();
        }
        return metrics;
    };

    /*
     * 屏幕正中那块译文（见 jumpTranslation / jumpStage.paintTranslation）。
     *
     * 三件事都在这几行里：它显示哪一条替代文字（`translationRole`，`null` = 不显示）、
     * 这一块的排版（`translationLayoutOf`，按行缓存），以及逐字密排的那几行
     * （`translationGlyphRowsOf`，同样按行缓存）。
     *
     * 为什么缓存：字号要试好几档、每档都要用真字体量一遍字宽，逐帧做等于每一帧
     * 排一次版。键里带上字号、行数、屏幕宽、字体与这一句的正文，换一样才重排。
     */
    let translationCache = new Map();

    /**
     * 这会儿画不画译文、画哪一条替代文字（`null` = 不画）。
     *
     * 只认自己的旋钮与宿主的「现在该不该有歌词」：不再跟随宿主的字幕开关与内容模式——
     * 歌词特效自己给了译文，就不该再让底栏那条字幕替它把开关转述一遍。
     */
    const resolveTranslationRole = (display) => {
        if (knobs.translationMode === 'off') return null;
        // 宿主说「现在不该画歌词」（设置窗口盖住播放页之类）时，译文也一样收起来。
        if (display && display.showText === false) return null;
        return knobs.translationMode === 'romanization' ? 'romanization' : 'translation';
    };

    /**
     * 这一帧该画哪一块译文：这一行、这一块排版、这一刻的浓淡。
     * 一条都排不出来（没有译文、旋钮关了、宿主收起了歌词）时返回 `null`。
     */
    const translationLayoutOf = (time, size, display) => {
        const role = resolveTranslationRole(display);
        if (!role) return null;
        const index = Number(ctx.getLineIndex?.());
        const line = pickTranslationLine(ctx.lines ?? [], { time, index, role });
        if (!line) return null;
        const text = resolveAlternateText(line, role);
        if (!text) return null;
        const lineIndex = (ctx.lines ?? []).indexOf(line);
        const window = windows[lineIndex] ?? {};
        const nextStart = windows[lineIndex + 1]?.writeStart;
        const restPillar = layoutOf(lineIndex)?.timeline?.restPillar ?? null;
        const start = resolveTranslationStart({
            start: window.writeStart,
            nextStart,
            rest: restPillar,
        });
        const opacity = resolveTranslationReveal({ time, start });
        if (opacity <= 0.004) return null;

        const fontFamily = palette.translationFontFamily;
        const fontWeight = palette.translationFontWeight;
        /*
         * 柱顶那一块字有多高：译文的字号以它为尺子（`translationSize` = 1 就一样高）。
         *
         * 尺子取**参照取景**那一版投影（镜头距离 = 1），不用当前这一帧的：「镜头距离」
         * 是给场景推近拉远用的，译文浮在画面上、不跟着镜头一起缩放。俯角照样管它——
         * 俯角压平，一格变小，这块字也跟着小一档。
         */
        const pillarTypePx = Math.max(
            10,
            resolvePillarTypePx(
                knobs.textFace,
                resolvePillarHeight(knobs.textFace, knobs.pillarHeight * PILLAR_RATIO),
                // `boardOf`：整屏几何按签名缓存（每帧重建一遍会把整首歌的路重铺一次）。
                boardOf(size).referenceProjection,
            ),
        );
        const room = size.width * TRANSLATION_ROOM_SHARE;
        const targetSize = pillarTypePx * knobs.translationSize;
        /*
         * 纵向的余地：排版时整块字按这一段高度折行、缩字号（见 jumpTranslation 的
         * TRANSLATION_BAND_SHARE）。这只是**折行与缩字号的预算**，不约束摆在哪——
         * 位置完全由下面的「对齐 + 偏移」给，偏移摆到尽头就是把字推出画面。
         */
        const roomHeight = Math.max(targetSize, size.height * TRANSLATION_BAND_SHARE);
        const perspective = knobs.translationPerspective;
        const perGlyph = perspective === 'glyph';
        /*
         * 变形量：由「镜头」那一组的俯角推出来（见 jumpTranslation.resolveTranslationTiltAmount）。
         * 俯角大 = 更像俯视 = 这块字更像正对着镜头的一片，变形小；俯角小 = 更像平视 =
         * 压在远处地上的一条，变形大。以前它是写死的 1，两种透视档位各有固定形状，
         * 于是拖俯角滑杆时译文纹丝不动。
         */
        const tiltAmount = resolveTranslationTiltAmount(knobs.pitch);
        /*
         * 逐字那一档的矩阵是**换句时才写进 `span`** 的（一句几十个字，逐帧写太贵），
         * 而「认出要不要重写」全靠 layout 的 key。透视档位与变形量都必须进 key，
         * 否则拖俯角、或者从逐字切到整体时，画面里的字格纹丝不动。
         */
        const warpTag = `${perspective}:${tiltAmount.toFixed(3)}`;
        const key = [
            lineIndex, text, knobs.translationSize, knobs.translationRows,
            Math.round(size.width), Math.round(size.height), roomHeight.toFixed(1), fontFamily, fontWeight,
        ].join('|');
        const cached = translationCache.get(key);
        const block = cached ?? buildTranslationLayout({
            text,
            room,
            roomHeight,
            size: targetSize,
            maxRows: knobs.translationRows,
            // 再小也不低于柱顶那一块字：译文是给人读的，不该比它注解的字还小。
            minSize: pillarTypePx * MIN_TRANSLATION_SIZE,
            fontFamily,
            fontWeight,
            lineHeight: TRANSLATION_LINE_HEIGHT,
        });
        if (!cached) translationCache.set(key, block);
        // 缓存只留这一句与上一句：换句之后旧的排版再也用不上了。
        if (translationCache.size > 4) {
            const oldest = translationCache.keys().next().value;
            if (oldest !== undefined && oldest !== key) translationCache.delete(oldest);
        }

        /*
         * 逐字那一档按字格排（每个字自己一格，透视才有地方落）；
         * 字格与「按字号折出来的那几行」同宽——按**最长那一行实际的宽度**再量一次，
         * 两边的断点才对得上（不会把逗号甩到行头）。
         */
        const glyphRows = perGlyph
            ? translationGlyphRowsOf(key, text, block, fontFamily, fontWeight, Math.min(room, block.width))
            : null;
        const rows = { lines: glyphRows ?? block.rows };
        const fit = fitTranslationLayout({
            width: perGlyph ? measureTranslationWidth(glyphRows, block.sizePx, fontFamily, fontWeight) : block.width,
            room,
            height: block.height,
            roomHeight,
        });
        /*
         * 锚点：横向正中；纵向由对齐方式定「钉住块的哪一头、零点在窗口哪里」（顶边上沿、
         * 块心正中、底边下沿），偏移就是把整块挪几个窗口高。偏移 0 = 正好贴在那条线上，
         * 所以顶对齐 + 0 就是第一行的上边缘贴着窗口上边缘；±0.8 够把字拉出画面。
         *
         * `ink` 扣的是行盒比字高出来的那两条空白：块的 CSS 边界是行盒的边界，不扣的话
         * 贴边总差着几像素（见 jumpTranslation.measureTranslationInk）。
         */
        const ink = measureTranslationInk({
            rows: rows.lines,
            sizePx: block.sizePx,
            lineHeight: block.lineHeight,
            fontFamily,
            fontWeight,
        });
        const anchor = resolveTranslationAnchor({
            width: size.width,
            height: size.height,
            align: knobs.translationAlign,
            offset: knobs.translationOffset,
            topInk: ink.top * (fit.scaleY || 1),
            bottomInk: ink.bottom * (fit.scaleY || 1),
        });
        /*
         * 透视：角度用的是「镜头」那一组的俯角，距离按这一块字自身的高度给——
         * 压扁于是朝块心收，不会整块往下掉。「整体」把矩阵加在整块上，「逐字」每个字一份，
         * 「关闭」一份都不给。
         */
        const tilt = perspective === 'block'
            ? formatMatrix3d(translationTilt({
                pitch: knobs.pitch,
                strength: 1,
                height: Math.max(1, block.height),
                depth: Math.max(240, size.height * 1.1),
            }))
            : null;
        const glowAlpha = knobs.translationGlow;
        return {
            key: `${key}|${warpTag}|${opacity > 0 ? 1 : 0}`,
            rows,
            perGlyph,
            /*
             * 逐字那一档：每个字都按「它是这一行的第几个字 × 这一行往下压了多少」给一份矩阵。
             * 深度用整块字自身的高度：靠上的字离镜头更远，收得更紧。
             */
            glyphTilt: perGlyph ? {
                pitch: knobs.pitch,
                depth: Math.max(240, size.height * 1.1),
                lineHeight: Math.max(1, block.lineHeight),
                rows: block.rows.length,
                /*
                 * 一行一份矩阵：字格立在「这一行」的底边上，所以斜轴与透视零点按行算；
                 * 压扁的比例再按这一行的底边离镜头多远收一档（`offset` 是它离块底边的高度），
                 * 越靠上的行收得越紧——整块字于是像一层往里塌的地砖。
                 */
                glyphMatrix: (offset) => {
                    const from = Math.max(0, Number(offset) || 0);
                    const depth = Math.max(240, size.height * 1.1);
                    const values = translationTilt({
                        pitch: knobs.pitch,
                        strength: 1,
                        height: Math.max(1, block.lineHeight),
                        depth,
                    });
                    /*
                     * 行越靠上越扁：变形量 1（参照俯角）时最多再收一成，不至于压到读不出来。
                     * 这一份也是「变形」的一部分，跟着变形量一起深浅——俯角越大，
                     * 整块字越接近正对镜头，靠上的行也就越没有那一档额外的压扁。
                     */
                    const shrinkFloor = Math.max(0.78, 1 - 0.1 * tiltAmount);
                    const shrink = Math.max(shrinkFloor, 1 - (from / depth) * 0.9 * tiltAmount);
                    values[5] *= shrink;
                    return formatMatrix3d(values);
                },
            } : null,
            sizePx: block.sizePx,
            lineHeight: block.lineHeight,
            fontFamily,
            fontWeight,
            color: palette.translationText,
            strokeColor: palette.translationStroke,
            textShadow: palette.translationShadow,
            /* 辉光是字周围的一圈光（`text-shadow` 跟着字形走），不是背后垫一块底。 */
            glow: glowAlpha > 0.02,
            glowColor: palette.translationGlowColor,
            glowOpacity: glowAlpha,
            opacity: opacity * knobs.translationOpacity,
            anchor,
            scaleX: fit.scaleX,
            scaleY: fit.scaleY,
            /* 整块的透视只在不逐字时加在块上（逐字时每个字自己一份，见 jumpStage）。 */
            tilt,
        };
    };

    /** 逐字密排那几行：与字号、行宽、字体绑定，按句缓存（一行一句地数，几十个字而已）。 */
    const translationGlyphRowsOf = (key, text, block, fontFamily, fontWeight, room) => {
        const cacheKey = `glyph|${key}`;
        const cached = translationCache.get(cacheKey);
        if (cached) return cached;
        const rows = resolveGlyphRows(
            text,
            block.sizePx,
            // 逐字那一档按「按字号折出来的那几行里最长的那一行」量：两种排法行数一致。
            Math.min(room, Math.max(block.width, block.sizePx * 2)),
            fontFamily,
            fontWeight,
            block.rows.length,
        );
        translationCache.set(cacheKey, rows);
        return rows;
    };

    /**
     * 一行的排版（带缓存）。缓存键里带时间窗与旋钮：两者变了整表作废（见 repaint），
     * 所以只按行号存一份就够。
     */
    const layoutOf = (index) => {
        const line = ctx.lines[index];
        if (!line) return null;
        const window = windows[index] ?? { writeStart: line.startTime, writeEnd: line.endTime };
        const charCount = Array.from(typeof line.fullText === 'string' ? line.fullText : '').length;
        const cap = resolveChunkCap({ charCount, maxChunks: MAX_CHUNKS_PER_ROW });
        // 下一行开口时刻也进键：末根柱子的回弹时刻由它推出来（见 resolveLastRelease）。
        // 下一行开口（跨行那一跳的落地时刻，也是这一行收尾窗的止点）。
        const nextStart = windows[index + 1]?.writeStart;
        // 收尾窗也进键：末段（镜头跨行那一段）的节奏由它给。
        const after = `${window.afterStart ?? '-'}:${window.afterEnd ?? '-'}`;
        /*
         * 他从上一行跨过来、落在这一行首块上的那一刻：上一行行末没立空柱子时，
         * 它比这一行开口早一截（唱完 + 一个滞空）；立了空柱子就是开口那一刻。
         * 上一行唱完那一刻（`afterStart`）进键：它早一秒，这一跳就早一秒。
         */
        const prevAfter = windows[index - 1]?.afterStart ?? null;
        const entryLand = resolveShiftLanding({
            release: prevAfter,
            nextStart: window.writeStart,
            flySeconds: knobs.flySeconds,
            // 上一行行末立不立歇脚柱由这颗旋钮定（见 resolveRestPillar），它决定落地是哪一刻。
            restGap: knobs.restGap,
        });
        /*
         * `HANDOVER_SHARE` 不进键：它只挪 `handoverTime` 这个参考时刻，
         * 真正被画出来的位置由 `tailSpan` / `gapShift` 决定，与它无关。
         * `restGap` 进键：它决定这一行行末有没有那根空柱子（多一块、多一跳）。
         * 字体进键：字宽是拿它量出来的，换主题 / 换字体之后缓存里的那一版就作废了。
         */
        const key = [
            index, line.fullText, window.writeStart, window.writeEnd, after, nextStart,
            knobs.chunkChars, knobs.preferPair ? 1 : 0, knobs.flySeconds, cap,
            prevAfter ?? '-', knobs.restGap, palette.fontFamily, palette.fontWeight,
        ].join('|');
        const cached = layoutCache.get(index);
        if (cached && cached.key === key) return cached.layout;
        if (charCount === 0) {
            layoutCache.delete(index);
            return null;
        }
        const layout = layoutLine({
            line,
            folium,
            knobs,
            lineIndex: index,
            window,
            cap,
            nextStart,
            handover: HANDOVER_SHARE,
            entryLand,
            // 字宽按它量（见 jumpMeasure）：柱顶的字与译文用的是两套字体，各量各的。
            fontFamily: palette.fontFamily,
            fontWeight: palette.fontWeight,
        });
        if (layout) layoutCache.set(index, { key, layout });
        else layoutCache.delete(index);
        return layout;
    };

    /**
     * 每一行有哪些块（按字宽排）：路的形状由它定，块长跟着字走。
     * 块厚只有侧面那一档会随字宽变（见 jumpShape），所以一并带上。
     */
    const resolveRoadRows = () => (ctx.lines ?? []).map((line, index) => {
        const layout = layoutOf(index);
        return {
            index,
            lens: layout ? layout.units.map((unit) => unit.len) : [],
            depths: layout ? layout.units.map((unit) => unit.depth) : [],
            crosses: layout ? layout.units.map((unit) => unit.faceDepth) : [],
        };
    });

    /*
     * 整首歌那条折线的累计坐标只跟歌词与旋钮有关，每帧重算一遍太浪费，按签名缓存。
     * 签名里要带上**柱身宽度**：拐角让位按上一行最宽的那根算（见 `accumulateRowRoad`），
     * 只按块长做签名的话，换了词、块长没变而柱身变了，拐角就会留着上一版的重叠。
     */
    let roadCache = { key: '', road: [] };
    const roadRows = (rows) => {
        // 拐角只跟「这一行最宽的那根柱身」有关，签名里记这一个数就够（见 `accumulateRowRoad`）。
        const shape = rows
            .map((row) => {
                const widest = (row.depths ?? [])
                    .reduce((max, value) => Math.max(max, Number(value) || 0), 0);
                return `${row.lens.join(' ')}@${widest}`;
            })
            .join('|');
        const key = `${shape}|${knobs.spacing}`;
        if (roadCache.key !== key) {
            roadCache = { key, road: accumulateRowRoad({ rows, gap: knobs.spacing }) };
        }
        return roadCache.road;
    };

    /*
     * 方块长相 + 贴面字盒的缓存：同一块长、同一柱身横向、同一柱高、同一朝向、同一俯角、
     * 同一长宽比之下，三个面的多边形与这片字的错切矩阵是一样的，每帧重算纯属白干。
     *
     * `label` 也一起缓存进来：以前 `placeText` 每帧重算六个 `toFixed`，
     * 结果再原封不动写回 DOM；现在和 box 挂在同一个键上吐出去。
     *
     * 键里带着 `cell`（= 尺寸推出来的格子大小）：尺寸或旋钮一变就整表作废
     * （见 repaint / readMetrics）。**不清就是一处泄漏**——拖一次窗口，每个中间尺寸
     * 都会留下一摞永不回收的多边形。
     */
    const blockCache = new Map();
    /** 行末那根空柱子：一根圆柱，没有字，同一 (直径, 柱高, 格子, 俯角) 下只有一份几何。 */
    const cylinderOf = (projection, cells) => {
        const key = [
            'round', REST_DIAMETER_CELLS.toFixed(3), cells.toFixed(3),
            projection.cell.toFixed(2), projection.pitch,
        ].join('|');
        const cached = blockCache.get(key);
        if (cached) return cached;
        const entry = {
            box: null,
            cylinder: cylinderFaces(projection, { diameter: REST_DIAMETER_CELLS, height: cells }),
            label: null,
        };
        blockCache.set(key, entry);
        return entry;
    };
    const blockOf = (projection, unit, along, cells) => {
        if (unit.rest) return cylinderOf(projection, cells);
        const shape = resolveBlockShape(knobs.textFace, unit.span, cells, unit.glyph);
        const aspect = resolveTextAspect(unit.span, unit.glyph);
        const height = shape.height ?? cells;
        const key = [
            along, shape.len.toFixed(3), shape.depth.toFixed(3), height.toFixed(3),
            projection.cell.toFixed(2), projection.pitch, knobs.textFace, aspect.toFixed(3),
        ].join('|');
        const cached = blockCache.get(key);
        if (cached) return cached;
        const box = boxFaces(projection, { along, len: shape.len, depth: shape.depth, height });
        /*
         * 这块字贴哪一面：旋钮说的那一档就是哪一档，永远不换面。
         * 面在屏幕上背着镜头时只翻横轴（从右往左铺），位置、大小、用哪一面都不变。
         * 字盒的长宽比由这块字自己给，字盒于是正正落在面心——四档面共用同一套算法，
         * 不再为侧面那档另取一份投影（换轴量出来的房间与贴面矩阵的方向并不一致，
         * 字就歪在墙的一边，这是上一版「字不在面心」的根因）。
         */
        const label = placeText(projection, box, { face: knobs.textFace, aspect, fill: TEXT_FILL });
        const entry = { box, label };
        blockCache.set(key, entry);
        return entry;
    };

    /**
     * 这一屏的几何：一格多少像素、投影、每一行每一块的位置。
     *
     * 位置一律是**绝对**的：世界坐标由全局行号推出来（`accumulateRowRoad`），再由投影
     * 换成屏幕，与「现在轮到第几行」无关。镜头往前推进只是画布自己的位移，任何一块
     * 都不会因为换行而挪窝——于是整条路是连续的，画面怎么移动都是同一条路。
     */
    const buildBoard = (size) => {
        const rows = resolveRoadRows();
        const road = roadRows(rows);
        /*
         * 柱高：顶面 / 正面就是旋钮给的那个数；侧面那一档往上放宽一点，柱子才装得下字
         * （见 jumpShape.resolvePillarHeight）。一屏里只有一个柱高——字号是柱高的固定几成，
         * 于是同一屏的字号也是同一个，不会「字多就缩小」；跟着字变的只有那面墙的宽度。
         */
        const heightCells = resolvePillarHeight(knobs.textFace, PILLAR_RATIO * knobs.pillarHeight);
        /*
         * 一块的横向尺寸：柱身厚度（= 顶面横向 = 端头墙宽，实心盒子）。
         * 每块有自己的尺寸（字长的块墙面宽一点），预算按**最宽的那一根**算：
         * 格子大小一屏一个数，窄的柱子于是不会顶出画面，各块之间也不会一屏一缩。
         */
        const widestDepth = road.reduce(
            (max, row) => (row.depths ?? []).reduce((inner, value) => Math.max(inner, Number(value) || 0), max),
            resolveBlockShape(knobs.textFace, MIN_UNIT_CELLS, heightCells).depth,
        );
        const widestCross = road.reduce(
            (max, row) => (row.crosses ?? []).reduce((inner, value) => Math.max(inner, Number(value) || 0), max),
            FACE_SPAN_CELLS,
        );
        const depth = widestDepth;
        /*
         * 一格多少像素、投影、小人脚下留多高：整套取景算术在 jumpFrame。
         *
         * 那里把两件事拆开了——**俯角只改投影形状**（地面铺多开、柱与人多高），
         * **缩放只认「镜头距离」**。以前格子是由当前俯角反解出来的，俯角一小、
         * 纵向预算一收缩，格子就跟着放大，拖那根滑杆看着像变焦。现在取景按
         * `min(当前俯角, 参照俯角)` 封顶：俯角往下调不再放大画面。
         */
        const frame = resolveJumpFrame({
            size,
            pitch: knobs.pitch,
            cameraDistance: knobs.cameraDistance,
            heightCells,
            widestDepth,
            widestCross,
            spacing: knobs.spacing,
            runnerScale: knobs.runnerScale,
            arc: knobs.arc,
            textFace: knobs.textFace,
        });
        const { cellPx, projection } = frame;
        // 柱顶那块面的横向宽度（屏幕格数）：截面用得上，顺手带出去。
        const crossCells = (widestDepth + widestCross) / Math.SQRT2;

        /** 一行每一块的屏幕位置：沿本行的世界轴铺开，块心落在路的中心线上。 */
        const placeRow = (lineIndex) => {
            const entry = road[Math.max(0, Math.min(road.length - 1, lineIndex))] ?? null;
            if (!entry) return [];
            return entry.lens.map((len, unitIndex) => {
                /*
                 * 世界坐标：沿本行的轴走到块心，横向就落在中心线上。
                 * 块心由 `jumpBoard.rowBlockCenter` 给——`offsets` 已经是块心，
                 * 这里再补半个块长的话，块就被自己的长度顶出去，间隙成了「随字长变」。
                 */
                const world = rowBlockCenter(entry, unitIndex);
                const screen = projection.project(world.x, world.y, 0);
                // 柱高整屏一个数（见 jumpShape）：跟着字变的只有侧面那面墙的宽度。
                const blockHeight = heightCells;
                return {
                    lineIndex,
                    unitIndex,
                    len,
                    along: entry.along,
                    direction: entry.direction,
                    screen,
                    height: blockHeight,
                    top: projection.project(world.x, world.y, blockHeight),
                };
            });
        };

        /**
         * 这一行的**路尾**（拐点）在柱顶高度上的屏幕位置：下一行从这里起铺，
         * 跨行那一跳的两端就落在它两侧（`accumulateRowRoad` 的行尾点）。
         *
         * 镜头绕过拐角要经过它：从末块一路走到这里，才拐向下一行的首块。
         * 以前是从末块的屏幕坐标上硬推一个 x 偏移量当拐点（`len / √2`），
         * 那一点离末块只有几个像素——「绕拐角」等于原地掉头，两条腿差着几十倍的路。
         */
        const placeCorner = (lineIndex) => {
            const entry = road[Math.max(0, Math.min(road.length - 1, lineIndex))] ?? null;
            if (!entry) return null;
            const world = entry.along === 'x'
                ? { x: entry.x + entry.length, y: entry.y }
                : { x: entry.x, y: entry.y + entry.length };
            return projection.project(world.x, world.y, heightCells);
        };

        return {
            cellPx, depth, crossCells, heightCells, projection,
            /*
             * 参照取景（镜头距离 = 1）那一版投影：给**不跟镜头缩放**的译文层当尺子用。
             * 场景本身仍然只认 `projection`（乘过距离的那一份）。
             */
            referenceProjection: frame.referenceProjection,
            road, placeRow, placeCorner,
            // 小人脚下留给上一行的那块高度：镜头把他钉在离画面底边这么高的地方。
            anchorBelowPx: frame.anchorBelowPx,
        };
    };

    /*
     * 整屏的几何只由 (容器尺寸, 旋钮, 歌词) 决定，**与时间一点关系都没有**：
     * 从前它排在 paintFrame 里每帧从头算一遍，几百行歌词每行都要拼一次缓存键
     * （这一段是按签名缓存的，但拼签名本身就已经是全表扫描了）。
     * 现在按签名算一次存起来，帧上只取返回值——歌曲多长都不再影响帧成本。
     */
    let boardEpoch = 0;
    let boardCache = { key: '', board: null };
    const boardOf = (size) => {
        const key = `${Math.round(size.width)}|${Math.round(size.height)}|${boardEpoch}`;
        if (boardCache.key !== key) boardCache = { key, board: buildBoard(size) };
        return boardCache.board;
    };

    /**
     * 一屏上要画哪几行、各自是什么角色。
     *
     * 三行是从那条绝对折线上截下来的一段：下面刚唱完的、正在写的、上面等着接的。
     * 行的位置由全局行号给出，换行时谁都不动，动的只有镜头。
     */
    const sceneRows = (rows) => {
        const total = ctx.lines?.length ?? 0;
        const list = [];
        // 刚唱完的那一行同样不一定是紧邻的下标：空行排不出柱子，就往上退一格找。
        for (let index = rows.rowIndex - 1; index >= 0 && index >= rows.rowIndex - 3; index -= 1) {
            if (!layoutOf(index)) continue;
            list.push({ index, role: 'prev' });
            break;
        }
        if (rows.rowIndex >= 0) list.push({ index: rows.rowIndex, role: 'current' });
        // 下一行不一定是紧接着的下标：空行、纯标点行排不出柱子，就跳到第一个能排出柱子的行。
        for (let index = rows.rowIndex + 1; index < total; index += 1) {
            if (!layoutOf(index)) continue;
            list.push({ index, role: 'next' });
            break;
        }
        return list;
    };

    /**
     * 这一行之前还排得出柱子吗？排不出就是**整曲第一行**：它前面没有人可跳过来（见入场一跳）。
     * 判法和 `sceneRows` 里找「刚唱完那一行」一样：往回退几行找第一个排得出柱子的行。
     */
    const hasRowBefore = (rowIndex) => {
        for (let index = rowIndex - 1; index >= 0 && index >= rowIndex - 3; index -= 1) {
            if (layoutOf(index)) return true;
        }
        return false;
    };

    /**
     * 这一行登场的两个时刻：
     *   - `start`：它第一次出现在画面上的那一刻——他落在**它前一行**首块上的那一刻
     *     （n 行唱完、跳到 n+1 行时，n+2 行才挂上画面）。那一刻是前一行的时间窗里的
     *     `afterEnd`（= 这一行的开口），**不是** `writeEnd`：`writeEnd` 比交班早一截
     *     （还要留出跨行那一跳的余量），照它排班的话动画在他还在空中时就放完了——
     *     等这一行真的挂上画面，柱子已经站定，看着就是「凭空出现」。
     *     两行之间夹了空行时它会被提前挂上来，那时按行号排班的时刻还在未来，
     *     取两者中更早的那个，免得这一行先隐身一段时间再冒出来；
     *   - `budget`：它必须落位完成的秒数 —— 到它自己接手（变成「正在写」的那一行）为止。
     *     短句时这一截很短，错开量会被压一压，免得小人跳上一根还在上升的柱子。
     *
     * 开头那两行从第一句开口起就在画面上，没有登场时刻（`start` 为 null = 一直在）。
     */
    const revealWindowOf = (index, rowIndex) => {
        if (index <= 1) return { start: null, budget: 0 };
        const scheduled = windows[index - 2]?.afterEnd;
        const onScreen = rowIndex >= 1 ? windows[rowIndex - 1]?.afterEnd : null;
        const start = Math.min(
            Number.isFinite(scheduled) ? scheduled : Number.POSITIVE_INFINITY,
            Number.isFinite(onScreen) ? onScreen : Number.POSITIVE_INFINITY,
        );
        if (!Number.isFinite(start)) return { start: null, budget: 0 };
        const handOver = windows[index - 1]?.writeEnd;
        const span = Number.isFinite(handOver) ? Math.max(0, handOver - start) : 0;
        return { start, budget: span * REVEAL_BUDGET_SHARE };
    };

    /**
     * 画一帧：所有位置都由 timeSec 算出来，不累加。
     *
     * 镜头只干一件事：把小人踩着的那根柱子钉在画面的锚点上。他不动画面就是静止的，
     * 他跳一格——行内一格、跨行也是一格——画布就朝反方向挪一格。
     * 于是整条路从头到尾是同一条，不用在某一行唱完之后重排一次。
     */
    const paintFrame = (timeSec) => {
        const size = readMetrics();
        // 跨行那一跳的窗口全由收尾窗与下一行开口决定（见 jumpBoard.resolveShiftAnchor），
        // 这里不再传时长：滞空由 jumpTimeline 按秒给（间奏再长也不会飘成慢动作）。
        const rows = resolveBoardRows({ windows, time: timeSec });
        const listing = sceneRows(rows);
        if (listing.length === 0) {
            stage.arrange([]);
            stage.paintRunner(null);
            stage.drawTrail([]);
            stage.drawImpact([]);
            stage.moveCanvas(0, 0);
            return;
        }
        const board = boardOf(size);
        const { cellPx, projection } = board;

        /*
         * 三条路一起摆，位置是绝对的：只由 (行号, 块号) 决定，
         * 镜头往后怎么走都不会挪动任何一块。
         */
        const placed = [];
        listing.forEach(({ index, role }) => {
            const layout = layoutOf(index);
            if (!layout) return;
            const debut = revealWindowOf(index, rows.rowIndex);
            board.placeRow(index).forEach((item, unitIndex) => {
                const unit = layout.units[unitIndex];
                if (!unit) return;
                // 时间表一并挂在块上：每帧算「柱子沉多少」时不必再回查排版（查一次要拼一遍缓存键）。
                placed.push({ ...item, unit, role, count: layout.units.length, debut, timeline: layout.timeline });
            });
        });
        /*
         * 柱面与棱线的浓淡 = 各自的透明度旋钮本身（再乘行的主次）。
         *
         * 「柱子透明度」「侧面填充透明度」「棱线透明度」三根**就是**屏幕上的那个 alpha：
         * 100% 时 `fill-opacity` / `stroke-opacity` 都是 1，柱子真的一整面实墙，压在译文上就
         * 挡住。以前这里还乘了「线框强度」那一份（0.12 ~ 0.62），于是面板写着 100%、
         * 画面上永远只有六成——「设成完全不透明还是盖不住译文」就是这么来的。
         * 「线框强度」现在只管线的密度（它本来就是这个意思），不再给浓淡设上限。
         *
         * 三根分开是因为它们各自的 base alpha 差得远（正面 0.17、侧面 0.08、棱线 0.42）：
         * 共用一个系数时，跟着谁走都会让另两样在该实的时候不实、在该淡的时候先没影。
         */
        const faceOpacity = knobs.pillarOpacity;
        const sideOpacity = knobs.pillarSideOpacity;
        const edgeOpacity = knobs.pillarEdgeOpacity;
        // 新行登场的滑出距离：整块（连它的字）一起从落位点下方这么多像素处升上来。
        const risePx = cellPx * REVEAL_RISE_CELLS;
        // 跳跃高度是世界里竖直的一段：投影里竖直 1 格抬 `lift`。
        const arcPx = knobs.arc * projection.lift;

        // 这一行的时间表：柱子什么时候被踩下去、什么时候弹回来，都由它给（见下面 `sinkPxOf`）。
        const timeline = rows.rowIndex >= 0 ? layoutOf(rows.rowIndex)?.timeline : null;
        /*
         * 跨行那一跳落地之后、下一行开口之前：他站在**下一行首块**上把间奏等完
         * （`shiftHold`）。那一截归跨行那一跳管（见下面 `hopper`）：行内只认这一行的块，
         * 交回去会把已经站在下一行首块上的他拽回这一行的末块。
         * 行末有空柱子时这一段不存在——他歇在自己行末那根柱子上。
         */
        const hold = timeline?.shiftHold ?? null;
        const waiting = Boolean(hold) && hold.end > hold.begin
            && timeSec >= hold.begin && timeSec < hold.end;

        /*
         * 入场一跳：全曲**第一行**（它前面没有排得出柱子的行）的第一块没有
         * 「他从别处跳过来」这一下——他一上来就站在那块上面，柱子却照样在第一个字开口
         * 那一刻被踩沉下去（`pressTime` 就是这一行开口）。没有来由地忽然沉一截，看着就是跳变。
         *
         * 于是开口之前给他补一次**原地起跳**：他跳起来、落回同一块的同一点上，
         * 那一沉就成了落地该有的那一沉（冲击环也一并有了，见下面 `landings`）。
         * 开口之前挤不出这一跳（第一个字就贴在 0 秒）时反过来：**这一根始终不下沉**——
         * 宁可少一点弹性，也不要凭空掉一截。
         */
        const openingAt = Number.isFinite(windows[rows.rowIndex]?.writeStart)
            ? windows[rows.rowIndex].writeStart
            : null;
        const debutRow = rows.rowIndex >= 0 && !hasRowBefore(rows.rowIndex) && openingAt !== null;
        // 原地的那一跳也照「滞空时间」那颗旋钮给，看着和行内那几跳是同一套动作。
        const entranceLead = clamp(knobs.flySeconds, 0.2, 0.9);
        const hasEntrance = debutRow && openingAt >= entranceLead;
        const sinklessOpening = debutRow && !hasEntrance;

        /**
         * 这一根柱子此刻沉下去多少（像素）：小人踩上来就沉、跳走就弹回来并小幅振动几下。
         *
         * 每块自带**这一行自己的**时间表（挂在 `item.timeline` 上），所以上下三行各算各的：
         * 刚唱完的那一行末块在他跨走那一刻弹回来，正在写的这行跟着他一沉一弹。
         * 幅度由旋钮「柱子弹性」给，0 = 纹丝不动。
         */
        const sinkPxOf = (item) => {
            /*
             * 没跳可依的那一根（全曲第一块、且开口前挤不出入场一跳）**不许沉**——
             * 它是凭空掉下去的，见下面 `hasEntrance` 那一处。
             */
            if (sinklessOpening && item.role === 'current' && item.unitIndex === 0) return 0;
            const spring = item.timeline?.pillars?.[item.unitIndex];
            if (!spring) return 0;
            return resolvePillarSpring({
                time: timeSec,
                pressTime: spring.pressTime,
                releaseTime: spring.releaseTime,
                strength: knobs.pillarSpring,
            }) * projection.lift;
        };

        /*
         * 绘制顺序就是画家算法：屏幕更靠上的先画、更靠下的压在上面，
         * 于是正在写的这一句整条压在上下两行之上，拐角处不会互相盖住。
         * 排序用**落位点**（不含登场偏移）：否则柱子在滑上来的过程中会互相换位、闪。
         */
        const painted = placed.slice().sort((a, b) => a.screen.y - b.screen.y);
        painted.forEach((item, order) => {
            item.entry = stage.acquirePillar(order);
            /*
             * 刚登场的那一行：柱子从下往上依次滑出来并淡入。
             * 序号 0 在本行最下、最后一根在最上，按序号错开就是「从下往上逐渐显示」。
             */
            const reveal = resolveRowReveal({
                time: timeSec,
                start: item.debut.start,
                budget: item.debut.budget,
                order: item.unitIndex,
                count: item.count,
                riseSeconds: REVEAL_SECONDS,
                stagger: REVEAL_STAGGER,
            });
            /*
             * 柱子被踩下去多少（像素）：小人踩上来就沉、跳走就弹回来并小幅振动几下。
             * 时刻由这一行自己的时间表给（`pressTime` / `releaseTime`），
             * 所以上下两行各自算各自的，且同样只由时间算出来、不累加。
             */
            item.sinkPx = sinkPxOf(item);
            /*
             * 明暗按**屏幕上的左右**给，不按正/侧给：哪一面落在左下随这一行的朝向交替，
             * 按正/侧上色会让相邻两行一明一暗地闪。
             */
            /*
             * 三行用的是同一套面色：行与行的轻重全交给上面那个 `rowFade`，
             * 于是「其他行浓淡」调到 100% 时三行真的长得一样。以前上下两行另取一套更淡的
             * 面色（`palette.back` / `backSide`），那一档藏在调色板里，面板上没有旋钮管它。
             */
            const lit = palette.front;
            const shade = palette.side;
            /*
             * 行的主次：正在写的那一行是 1，上下两行按「其他行浓淡」淡一档。
             * 这一档以前写死——当前行与上下两行永远差着那一截，三根透明度旋钮
             * 怎么调都调不到「三行一样浓」。柱面、棱线与字共用这一个系数
             * （字不吃柱面的浓淡，见 stage 的 `label.opacity`）。
             */
            const rowFade = item.role === 'current' ? 1 : knobs.otherRowOpacity;
            /*
             * 每根柱子自己的三个尺寸都由这块字的字宽与长宽比推出来（jumpShape）：
             * 面永远装得下这块字，柱子于是跟着字长——顶面 / 正面那档块变长、柱顶变宽，
             * 侧面那档端头那面墙变宽，块长只留柱身厚度。
             *
             * 几何与它的贴面字盒本来就是一套东西（同一个尺寸 / 旋钮 / 这块字的字宽下
             * 必然是同一个结果），所以一起由 `blockOf` 按签名缓存：每一帧从这里拿到的是
             * **同一个对象**，stage 那一边比一次身份就知道要不要重写那三个面。
             * 行末那根空柱子走 `cylinder`：一个椭圆 + 柱身两半，没有字。
             */
            const block = blockOf(projection, item.unit, item.along, board.heightCells);
            stage.paintPillar(item.entry, {
                // 沉下去的那一份直接加在落位点上：整根柱子（连它的字）一起沉。
                base: {
                    x: item.screen.x,
                    y: item.screen.y + (1 - reveal) * risePx + item.sinkPx,
                },
                box: block.box,
                cylinder: block.cylinder,
                colors: {
                    edge: palette.edge,
                    // 正在写的这一行用更实的一块材质，上下两行淡一档：三行不会糊成一条。
                    top: lit,
                    front: item.along === 'x' ? lit : shade,
                    side: item.along === 'x' ? shade : lit,
                },
                /*
                 * 柱面与棱线的浓淡只由那三根透明度旋钮给，行的主次另走 `rowFade`
                 * ——**不再连带文字**：以前整根柱子共用一个 `opacity`，字被柱面那份浓度
                 * 一起乘掉（默认旋钮下只剩四成亮度），字于是永远读不实。
                 */
                faceAlpha: faceOpacity,
                sideAlpha: sideOpacity,
                edgeAlpha: edgeOpacity,
                // 行的主次：柱面、棱线、字共用这一个系数（0 = 只剩正在写的那一行）。
                rowFade,
                // 这一行登场时整块（柱面 + 字）一起淡入：只有 `reveal` 参与。
                opacity: reveal,
                // 行末那根空柱子没有字：`label` 是 null，整块字连盒子一起收起来。
                label: block.label && {
                    text: item.unit.text,
                    // 字盒按面装好（宽、高、字号同比例），这里照抄，不再另外放大缩小。
                    width: block.label.width,
                    height: block.label.height,
                    fontSize: block.label.fontSize,
                    // 贴面：这个面的 2D 矩阵把整块字错切到面上（顶面/正面/侧面），
                    // 矩阵的平移项把字盒的**中心**放到面心；
                    // 「上方」那一档不做变换，屏幕正立浮在柱顶中心的正上方。
                    transform: block.label.transform,
                    color: palette.text,
                    fontFamily: palette.fontFamily,
                    fontWeight: palette.fontWeight,
                    // 字自己的亮度：只跟着行的主次走，不吃柱面的浓淡。
                    opacity: rowFade,
                },
            });
        });
        /*
         * 交给舞台的必须**就是上面那一遍排好的顺序**：DOM 顺序即绘制顺序。
         * 拿未排序的 `placed` 过去，`listing` 的次序（上一行 → 当前行 → 下一行、
         * 行内 0 → n）就成了绘制次序——屏幕上方那几行（更远）最后画，
         * 于是远处的柱子盖住近处的柱子；柱子全调成不透明时一眼就能看出来。
         */
        stage.arrange(painted.map((item) => item.entry).filter(Boolean));

        /*
         * 小人此刻在哪一格都由时间直接推出来，三种状态：
         *   1. 跨行那一跳：上一行唱完到这一行开口之间，他自己从上一行最后一根跳过来；
         *   2. 行内的某一跳：这块词开唱之前一个滞空起跳、开唱那一刻落在它上面；
         *   3. 都不在：站在自己那一行已经落地的那根柱子上——下一条词开口前的那零点几秒
         *      他不走（也含「还没轮到他」的第一根）。
         */
        /*
         * 按**块号**排序：`placed` 是按屏幕上下（画家算法）排过的，不能拿来当行内的顺序，
         * 否则跨行那一跳会从小人脚下那块、而不是这一行第一块起跳。
         */
        const inOrder = (item) => item.unitIndex;
        const current = placed.filter((item) => item.role === 'current').sort((a, b) => inOrder(a) - inOrder(b));
        const previous = placed.filter((item) => item.role === 'prev').sort((a, b) => inOrder(a) - inOrder(b));
        const next = placed.filter((item) => item.role === 'next').sort((a, b) => inOrder(a) - inOrder(b));
        const lastOfPrevious = previous[previous.length - 1];
        /*
         * 谁算「他此刻正在这一屏上跳」，只有一个答案（`hopper`）：
         *   - `shift`：跨行那一跳。窗口见下（`shiftSpans`），与镜头末段的 `tailSpan` 同一个终点；
         *   - `inline`：行内几跳，由这一行自己的时间表给。
         *
         * 以前这里只问 `rows.phase < 1`，而 `jumpBoard` 在**唱完那一刻**就把这一行交给了
         * 下一行：收尾窗里相位是 1，`resolveRunnerState` 又因为他还没到起跳时刻而判「站着」，
         * 于是人被钉在末块上、下一行首块谁也不去——跨行那一跳整个漏掉，看起来就是
         * 「行末直接跳到新行的第二个字」。
         *
         * 起点用 `current` 的末块而不是「上一行」：他在收尾窗里跨过去的时候屏幕上只有这一行
         * （`prev` 那一行要等真的交出去了才挂上来），第 0 行更是根本没有上一行。
         */
        /*
         * 窗口以 `gapShift`（唱完那一刻 → 落地）为准，排不出正宽度时才退回 `tailSpan`：
         * 末块落地之后他还得站着把最后几个字唱完，那之前脚下就是这一行的末块
         * （柱子被压着、人跟着一起沉）；一落地就判「在路上」的话，末块会在落点那一刻
         * 弹回来，踩下去那一下还没压完就被抬起来。
         * 但 `gapShift` 排不出正宽度时（没有下一行开口可依——**第一行**就是这样：
         * `writeEnd` 被 `renderEndTime` 夹到与收尾同刻），绝不能退回「站着」：
         * 那正是「收尾窗里人钉在末块上、下一个字直接瞬移过去」的老毛病。
         * 这种时候按 `tailSpan`（末块落点 → 开口）走，宁可早一点上路。
         *
         * 落地之后到下一行开口之间（`shiftHold`）**也归这一跳**：他站在下一行首块上把间奏
         * 等完，位置与落地那一刻相同（`progress` 停在 1）。交回行内那几段的话，行内只认
         * 这一行的块，会把已经站在下一行首块上的他拽回这一行的末块——间奏里看上去就是
         * 「跳过去又弹回来」。
         */
        const shiftGap = timeline?.gapShift;
        const tailSpan = timeline?.tailSpan;
        const shiftSpans = shiftGap && shiftGap.end > shiftGap.begin
            ? shiftGap
            : { begin: tailSpan?.begin, end: tailSpan?.end };
        const shiftAir = resolveShiftAirborne({ ...shiftSpans, time: timeSec });
        const runner = resolveRunnerState({ timeline, time: timeSec });
        const tailFrom = current[current.length - 1];
        const canCross = Boolean(tailFrom) && next.length > 0;
        // 入场那一跳的窗口：开口之前一个滞空起跳、开口那一刻落回原地。
        const entranceAir = hasEntrance
            ? resolveTailAirborne({ begin: openingAt - entranceLead, end: openingAt, time: timeSec })
            : null;
        const entrancing = Boolean(entranceAir?.airborne) && Boolean(current[0]);
        const hopper = shiftAir?.airborne && canCross
            ? { kind: 'shift', from: tailFrom, to: next[0], progress: shiftAir.phase }
            : waiting && canCross
                // 已经站在下一行首块上：位置就是落地那一刻，只是不再腾空。
                ? { kind: 'shift', from: tailFrom, to: next[0], progress: 1 }
                : entrancing
                    // 原地起跳：两端是同一块，只有抛物线那一下在动。
                    ? { kind: 'entrance', from: current[0], to: current[0], progress: entranceAir.phase }
                    : { kind: 'inline', from: current[runner.from], to: current[runner.to], progress: runner.progress };
        const hopping = hopper.kind === 'shift';
        const fromUnit = hopper.from;
        const toUnit = hopper.to;
        const airProgress = hopper.progress;
        // 真在空中（腾空那一截）才做挤压：站着的帧（含等间奏那一截）不该被压扁。
        const airborne = Boolean(shiftAir?.airborne) || entrancing || runner.airborne;

        /*
         * 镜头：把「小人走到路上第几格」钉到画面的锚点上。
         *
         * 锚点横向留一点前瞻（往路的反方向偏），前面那几根还没跳到的柱子才看得全；
         * 跨行时这一笔也在两行的朝向之间平滑换过去，不会出现「跳一下、画面横甩一次」。
         * 纵向的份额由 buildBoard 的预算给：底下装得下上一行，头顶装得下下一行。
         */
        const fallback = lastOfPrevious ?? placed[placed.length - 1];

        /*
         * 镜头走**自己**那一条线，不跟着小人的跳（见 jumpTimeline.resolveCameraPath）：
         * 小人落地之后站着不动，照他的曲线走就是「走一截、停一截」，节奏一快画面就在抖。
         * 行内因此匀速；跨行要拐角，那一跳照旧「起步慢、落定稳」。
         */
        const camera = resolveCameraPath({ timeline, time: timeSec });
        /*
         * 末段：从**这一行末块**走到**下一行首块**。两条路的夹角可能是九十度，
         * 走直线会把拐点切掉，所以沿折线走（三段权重见 `resolvePathWeights`）。
         *
         * 它的窗口是 `cameraTail`（镜头到站末块那一刻 → 小人落地那一刻），**不是**小人的
         * `tailSpan`：小人站在末块上一直唱到最后一刻才起跳，镜头的到站却在他那段停留的
         * 中点。按自己的窗口走，行内最后一段才与它首尾相接：镜头一到站末块，末段就从同一个
         * 点、同一个时刻接出去。终点与小人跨行那一跳的落地严丝合缝——间奏里那一跳只占空档
         * 的头一截，镜头跟着一起到站，之后停在他身上（不等开口，否则整段间奏镜头都在
         * 半路上慢慢挪，人却在下一行首块上站着）。
         *
         * 于是「拍到最后一个字到下一行第一个字」这一截里画面一直在走：镜头到站那一刻就
         * 上路，不再先冻住一段、再忽然跳到一个已经走了半程的相位上。
         *
         * 窗口与端点都取自**这一行自己**的排版（`timeline` / `current` 的末块），
         * 不看「上一行」：收尾窗里这一行还在手上（`rows.rowIndex` 仍是它），
         * 那一刻画面上根本没有「刚唱完的那一行」可依。第 0 行也照样适用——它没有上一行，
         * 却有下一行要跨。
         */
        const cameraTail = timeline?.cameraTail ?? null;
        const tailFlight = current.length > 0 && next.length > 0 && cameraTail
            ? resolveTailAirborne({
                begin: cameraTail.begin,
                end: cameraTail.end,
                time: timeSec,
            })
            : null;
        /*
         * 末段还在走——或者已经走完、只是这一行还没交出去（间奏里他站在下一行首块上等，
         * 相位停在 1）。这一屏上除了它没有别的镜头可走（行内那几段都已经过去了），
         * 交回行内的话镜头会退回这一行的末块，整屏往回跳一下。
         * 起点就是镜头自己到站末块的那一刻，所以到站即可接手——中间不留空档：
         * 以前要等到这一行唱完才接手，那一截里行内那几段的首尾都夹在末块上，画面就停住了。
         */
        const tailing = Boolean(tailFlight)
            && timeSec >= (cameraTail?.begin ?? Number.POSITIVE_INFINITY)
            && timeSec < (tailSpan?.end ?? Number.POSITIVE_INFINITY);
        const camFrom = hopping || tailing
            ? current[current.length - 1]
            : current[Math.min(camera.index, current.length - 1)];
        const camTo = hopping || tailing
            ? next[0]
            : current[Math.min(camera.index + 1, current.length - 1)];
        // 末段排不出窗口时（时刻挤到一起的场合）按「已经到站」算：镜头停在他落地的那一块上。
        const camProgress = hopping || tailing ? (tailFlight?.phase ?? 1) : camera.progress;
        let focus = alongRoad((camFrom ?? fallback)?.top, (camTo ?? fallback)?.top, camProgress);
        if ((hopping || tailing) && camFrom && camTo) {
            /*
             * 折线：起点 → 拐点（两行的接头）→ 终点。
             * 小人在路上时起点就是他脚下那块，镜头于是**钉着他**；他还站在末块上时
             * （末块落地到起跳之间）这条折线照样在走，正好把那一截填平。
             *
             * 两条腿按**路程**分时间（见 `cornerShareOf`）：只差那么半块的头一腿不该
             * 跟「跨到下一行行首」那一腿平分整段空档，否则镜头先在拐角前慢慢蹭、
             * 过了拐角又猛地窜出去——句末看着就是「停一下、忽然移动」。
             */
            const corner = board.placeCorner(camFrom.lineIndex) ?? camFrom.top;
            const weights = resolvePathWeights(camProgress, cornerShareOf(camFrom.top, corner, camTo.top));
            focus = weightedFocus([
                [camFrom.top, weights.first],
                [corner, weights.mid],
                [camTo.top, weights.second],
            ]);
        }
        /*
         * 前瞻那一笔要跟着路的走向换：跨行那一截在两行的朝向之间插值。
         * 末段里「正在写的这一行」还没换手（`tailing`）——那时前瞻仍按**这一行**的朝向给，
         * 否则换手那一帧会横跳一格。
         */
        const lookDir = hopping || tailing
            ? (camFrom?.direction ?? 1) + (((camTo?.direction ?? camFrom?.direction ?? 1) - (camFrom?.direction ?? 1)) * camProgress)
            : (current[0]?.direction ?? lastOfPrevious?.direction ?? 1);
        stage.moveCanvas(
            size.width / 2 - lookDir * board.projection.half * LOOK_AHEAD_CELLS - focus.x,
            size.height - board.anchorBelowPx - focus.y,
        );

        if (!fromUnit || !toUnit) {
            stage.paintRunner(null);
        } else {
            stage.paintRunner({
                feet: runnerFeet({
                    from: fromUnit,
                    to: toUnit,
                    progress: airProgress,
                    arc: arcPx,
                    // 人踩在柱顶上：柱子沉下去（弹回来）多少，他的脚就跟着走多少，
                    // 否则柱子一沉他就悬在半空、柱子一弹他就被顶穿。
                    sinkFrom: fromUnit.sinkPx ?? 0,
                    sinkTo: toUnit.sinkPx ?? 0,
                }),
                // 同一时刻落在线路上的那一点（不含腾空）：影子留在那里，不跟着人飞。
                ground: runnerFeet({
                    from: fromUnit,
                    to: toUnit,
                    progress: airProgress,
                    arc: 0,
                    sinkFrom: fromUnit.sinkPx ?? 0,
                    sinkTo: toUnit.sinkPx ?? 0,
                }),
                // 小人比一个字高一点：跳一跳里人是主角，但不能高到盖住两行。
                // 他是世界里竖直的东西，所以和柱身一样按 `lift` 换算（俯角越大越矮）。
                height: projection.lift * RUNNER_RATIO * knobs.runnerScale,
                color: palette.accent,
                squash: airborne ? resolveHopSquash(airProgress) : 1,
                // 柱顶在屏幕上的扁度：影子照它压扁，才像躺在斜面上而不是浮在半空。
                groundSquash: projection.sin,
            });
        }

        stage.drawTrail(trailSegments({
            placed: current,
            timeline,
            time: timeSec,
            arc: arcPx,
            color: palette.accent,
            opacity: knobs.trail * 0.8,
        }));
        /*
         * 起跳与落地那一瞬：脚下 / 落点上铺开一圈环（落地再溅几粒尘）。
         * 时刻都是时间表里现成的那一秒，所以特效同样不累加：
         * 拖进度、暂停、导出都不会留下半开的环。
         */
        const landings = [];
        /*
         * 起跳那一圈：从**脚下这一块**蹬开，于是每一跳的两端（落下来、跳出去）各有一圈。
         * 它比落地那圈小一点、淡一点、也不带尘；隔 `TAKEOFF_RING_MIN_GAP` 太近就不画，
         * 免得同一根柱子上前后脚铺开两圈糊成一团。
         */
        const takeOffRing = (block, liftTime, landedAt) => {
            if (!block || !(liftTime - landedAt >= TAKEOFF_RING_MIN_GAP)) return;
            landings.push({
                landTime: liftTime,
                top: block.top,
                sink: block.sinkPx ?? 0,
                scale: TAKEOFF_RING_SCALE,
                fade: TAKEOFF_RING_FADE,
                dust: false,
            });
        };
        (timeline?.hops ?? []).forEach((hop) => {
            const target = current[hop.to];
            // 环贴在**此刻**的柱顶上：柱子正在往下沉，环跟着它一起沉，不然会脱开一截。
            if (target) landings.push({ landTime: hop.landTime, top: target.top, sink: target.sinkPx ?? 0 });
            takeOffRing(current[hop.from], hop.liftTime, hop.start);
        });
        /*
         * 跨行那一跳落地之后等间奏的那一截：他站在**下一行首块**上，落地那一刻已经过去了
         * ——这一帧还在上一行手里（要等开口才交班），环得由它自己铺出来。
         */
        if (waiting && next[0]) {
            landings.push({ landTime: hold.begin, top: next[0].top, sink: next[0].sinkPx ?? 0 });
        }
        /*
         * 跨行那一跳的落地时刻：上一行自己算出来的。上一行行末立了空柱子时它就是这一行
         * 开口那一刻；没有时是「唱完 + 一个滞空」，空档短的场合同样是开口那一刻，
         * 而间奏里它比开口早得多——那时人早站上来了，环也已经在前一屏铺过了，
         * 不能等到开口再铺一次。
         */
        const crossedAt = Number.isFinite(lastOfPrevious?.timeline?.shiftLand)
            ? lastOfPrevious.timeline.shiftLand
            : windows[rows.rowIndex]?.writeStart;
        /*
         * 跨行那一跳的落地，以及入场那一跳的落地（第一个字开口那一刻）
         * ——两处都是「他真的从空中落下来」，所以都铺一圈环。
         * 挤不出入场一跳时（`sinklessOpening`）不铺：那一帧没有落地这回事。
         */
        if (!sinklessOpening && Number.isFinite(crossedAt) && current[0]
            && ((rows.rowIndex > 0 && !debutRow) || hasEntrance)) {
            landings.push({ landTime: crossedAt, top: current[0].top, sink: current[0].sinkPx ?? 0 });
        }
        /*
         * 跨行那一跳的**起跳**：从行末那根空柱子（没有它时是这一行的末块）上蹬开。
         * 与上面行内那一跳同一条规矩（同一个 `TAKEOFF_RING_MIN_GAP`）：
         * 他刚落到那块上就走时只画落地那一圈。
         */
        if (Number.isFinite(shiftSpans?.begin)) {
            takeOffRing(
                tailFrom,
                shiftSpans.begin,
                timeline?.landings?.[timeline.landings.length - 1] ?? Number.NEGATIVE_INFINITY,
            );
        }
        stage.drawImpact(impactStamps({
            landings,
            time: timeSec,
            /*
             * 环铺到略大于柱顶就停：再大就把相邻那根的落点也圈进去了，
             * 太小又只是脚下一圈看不清的印子（柱顶那半格字的宽度是 0.7 格左右）。
             */
            radius: Math.max(10, cellPx * 0.8),
            squash: projection.sin,
            color: palette.accent,
            // 跟着「跳跃轨迹」那个旋钮一起淡：想要干净的画面就把两者一起关掉。
            opacity: 0.35 + 0.65 * knobs.trail,
        }));
        /*
         * 屏幕正中那块译文：这一句的注解，不跟唱（只换句时淡进来）。它的显示与浓淡
         * 全由时间算出来，所以拖进度、暂停、导出走的是同一帧。
         */
        stage.paintTranslation(translationLayoutOf(timeSec, size, ctx.getDisplay?.()));
        // 宿主关掉歌词文字时只藏柱顶那块字，场景照旧跳（见 jumpStage.setTextVisible）。
        stage.setTextVisible(ctx.getDisplay()?.showText);
    };

    /**
     * 几个点按权重加权：跨行那一段沿折线走，位置就是「起点 / 拐点 / 终点」的加权和。
     * 权重由 jumpTimeline 的 `resolvePathWeights` 给（和恒为 1），所以两头必然精确落在块上；
     * 小人与镜头用的是同一把尺子，他跳过的路和镜头绕过的拐角是同一条折线。
     */
    const weightedFocus = (entries) => {
        let x = 0;
        let y = 0;
        let total = 0;
        entries.forEach(([point, weight]) => {
            const w = Number.isFinite(weight) ? weight : 0;
            if (!point || w <= 0) return;
            x += point.x * w;
            y += point.y * w;
            total += w;
        });
        return total > 0 ? { x: x / total, y: y / total } : { x: 0, y: 0 };
    };

    /**
     * 拐点把整段折路分成两条腿，各自在屏幕上多长 → 它占路程的几成。
     *
     * 这个数拿去给 `jumpTimeline.resolvePathWeights` 分时间：按**路程**分，两条腿的速度
     * 才一样。头一腿（末块 → 拐点）通常只有半个块那么短，第二腿要一路走到下一行的行首，
     * 平分时间的话镜头就先在短腿上磨蹭、过了拐点再猛窜出去，句末看着像卡了一帧再跳一下。
     */
    const cornerShareOf = (startPoint, cornerPoint, endPoint) => {
        const reach = (pointA, pointB) => Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
        const first = reach(startPoint, cornerPoint);
        const second = reach(cornerPoint, endPoint);
        const total = first + second;
        return total > 1e-6 ? first / total : 0.5;
    };

    /** 两点之间按 `progress` 取一点：镜头锚的是「它在路上走到哪儿」，不含抛物线那一下。 */
    const alongRoad = (from, to, progress) => {
        const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
        if (!from || !to) return from ?? to ?? { x: 0, y: 0 };
        return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    };

    /**
     * 小人脚下那一点：两块柱顶之间插值，空中再抬一个抛物线（都在屏幕坐标里算）。
     *
     * `sinkFrom` / `sinkTo` 是这两根柱子此刻沉下去的像素：脚下那一点跟着柱子一起动，
     * 起跳时从「压着的柱顶」离地、落地时落到「还没沉的柱顶」上再随它沉下去。
     */
    const runnerFeet = ({ from, to, progress, arc, sinkFrom = 0, sinkTo = 0 }) => {
        const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
        const sink = (Number(sinkFrom) || 0) + ((Number(sinkTo) || 0) - (Number(sinkFrom) || 0)) * t;
        return {
            x: from.top.x + (to.top.x - from.top.x) * t,
            y: from.top.y + (to.top.y - from.top.y) * t - arc * Math.sin(t * Math.PI) + sink,
        };
    };

    /**
     * 跳跃轨迹：已经跳过的拱线 + 落点的小坑。
     *
     * 只画「这一行自己落过地」的那几跳；未落地的那一跳交给小人自己表达。
     * 拱线用一串小圆点画，不用「旋转的细长条」：细长条一旦角度算错就会连成一片。
     *
     * 已经跳过的那几跳**按过了多久淡下来**（`resolveTrailFade`）：最近那一跳最实，
     * 往前依次变淡，老远的只剩一层影子——走过的路是看得出来的，但不会一直全亮地挂着。
     */
    const trailSegments = ({ placed, timeline, time, arc, color, opacity }) => {
        if (opacity <= 0.01 || !timeline) return [];
        const segments = [];
        (timeline.hops ?? []).forEach((hop) => {
            const from = placed[hop.from];
            const to = placed[hop.to];
            if (!from || !to || time < hop.landTime) return;
            const fade = resolveTrailFade({ timeline, time, landTime: hop.landTime });
            const points = [];
            const steps = 8;
            for (let step = 0; step <= steps; step += 1) {
                const t = step / steps;
                points.push(runnerFeet({ from, to, progress: t, arc }));
            }
            segments.push({ kind: 'path', points, color, opacity: opacity * 0.45 * fade });
            segments.push({
                kind: 'ellipse',
                x: to.top.x,
                y: to.top.y,
                rx: 5,
                ry: 2.5,
                color,
                opacity: opacity * 0.3 * fade,
            });
        });
        return segments;
    };

    /**
     * 落地那一瞬的特效（一圈环 + 几粒尘）：`landings` 是这一行（外加跨行那一跳）的落点与时刻。
     *
     * 只把「刚刚落地」的那一下画出来（`resolveLandingBurst` 之外的时间返回 null），
     * 于是这一层绝大多数帧是空的；每一份特效也都只由时刻算出来，不累加。
     */
    const impactStamps = ({ landings, time, radius, squash, color, opacity }) => {
        if (opacity <= 0.02) return [];
        const stamps = [];
        (landings ?? []).forEach((stop) => {
            const burst = resolveLandingBurst({ time, landTime: stop.landTime, seconds: IMPACT_SECONDS });
            if (!burst || !stop.top) return;
            // 落点跟着柱子沉：环与尘画在**当下**的柱顶上。
            const sink = Number(stop.sink) || 0;
            /*
             * 起跳那一圈比落地那圈小、也淡，还不带尘（见 paintFrame 的 `TAKEOFF_*`）；
             * 落地那圈两个乘数都是 1，也就是原样。
             */
            const scale = Number.isFinite(stop.scale) ? stop.scale : 1;
            const fade = Number.isFinite(stop.fade) ? stop.fade : 1;
            const ring = radius * scale;
            stamps.push({
                x: stop.top.x,
                y: stop.top.y + sink,
                radius: ring * burst.ring.radius,
                squash,
                color,
                opacity: opacity * burst.ring.opacity * fade,
                dotSize: Math.max(1.6, ring * 0.09),
                // 尘往外飞的方向由 jumpCourse 给（归一化），纵向照柱顶的扁度压一下。
                dust: stop.dust === false ? [] : burst.dust.map((dot) => ({
                    x: stop.top.x + dot.x * ring,
                    y: stop.top.y + sink + dot.y * ring * squash,
                    opacity: dot.opacity * fade,
                })),
            });
        });
        return stamps;
    };

    /*
     * 静态模式（宿主的「静止模式」，OBS 的静态配置也是它）：契约要求画 `staticLineIndex`
     * 那一行的**一帧**，之后不再动。宿主在静态模式下给的歌词时钟照旧在走（主窗口与 OBS
     * 都每帧写它），所以静态时不能订阅时间——订阅了「静止」对这个特效等于没开，还白烧一屏
     * 等距重排。取景时刻改用那一行自己的进度，拿不到行才退回当前时刻。
     */
    const still = Boolean(ctx.staticMode);
    /** 定格在行内六成处：块基本写完、人也在行内，和宿主给别的样式定格的取法一致。 */
    const STILL_LINE_RATIO = 0.6;
    const stillTime = () => {
        const index = ctx.staticLineIndex ?? ctx.getLineIndex?.() ?? -1;
        const line = index >= 0 ? (ctx.lines ?? [])[index] : null;
        const span = line && Number.isFinite(line.endTime) ? line.endTime - line.startTime : 0;
        return line ? line.startTime + (span > 0 ? span * STILL_LINE_RATIO : 0) : ctx.lyricTime.get();
    };
    const nowTime = () => (still ? stillTime() : ctx.lyricTime.get());

    let paintedTime = Number.NaN;
    let failedOnce = false;

    /**
     * 画一帧。`force` 给「播放时间一步没走、但输入变了」的那些场合：拖旋钮、换主题、改尺寸。
     */
    const paint = (timeSec, force = false) => {
        if (!Number.isFinite(timeSec)) return;
        // 同一个时刻不画第二遍：`lyricTime` 在一帧里可能被写好几次，repaint 也会来一脚。
        if (!force && timeSec === paintedTime) return;
        paintedTime = timeSec;
        try {
            paintFrame(timeSec);
        } catch (error) {
            // 一帧抛异常不能带走订阅链：冻住的整屏比「这一帧没画」糟得多。
            // 但也别每帧都喊——一个稳定的异常就是一秒六十条日志。
            if (!failedOnce) {
                failedOnce = true;
                if (typeof folium?.log?.warn === 'function') folium.log.warn('jump visualizer frame failed', error);
            }
        }
    };

    const repaint = () => {
        const next = readKnobs(ctx.getSettings());
        // 旋钮变了要重排：块数、间距、高度都跟着变，缓存的排版、方块与整屏几何直接作废。
        if (Object.keys(next).some((key) => next[key] !== knobs[key])) {
            layoutCache.clear();
            blockCache.clear();
            // 译文的排版也跟着旋钮走（字号、行数、透视都进键）：整表作废，重排一次。
            translationCache.clear();
            boardEpoch += 1;
        }
        knobs = next;
        if (windows.length !== (ctx.lines?.length ?? 0)) {
            windows = buildWriteWindows(ctx.lines ?? []);
            layoutCache.clear();
            blockCache.clear();
            translationCache.clear();
            boardEpoch += 1;
        }
        palette = resolveJumpPalette(ctx.getTheme(), folium);
        paint(nowTime(), true);
    };

    /*
     * 尺寸变化不再逐帧去量，改由 ResizeObserver 报一次：
     * 回调里只翻标记（在回调里量尺寸会抖），真正取值是在下一次 paint 的 `readMetrics` 里。
     * 顺手踢一脚强制重画：尺寸变了画面必须重排，而播放时间一步没走，
     * 普通 paint 会被「同一时刻」那道去重挡住。
     */
    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            metricsDirty = true;
            paint(nowTime(), true);
        })
        : null;
    resizeObserver?.observe(container);

    paint(nowTime());
    // 静态模式不订阅时间：那一帧画完就收工，换哪一行由宿主重新挂载来说。
    const offTime = still ? null : ctx.onLyricTime((value) => paint(value));
    const offChanges = ctx.onChange(repaint);

    return () => {
        offTime?.();
        offChanges();
        // 观察器不断开的话，它会一直强引用着已经脱离文档的整棵子树（cinerama 踩过同一个坑）。
        resizeObserver?.disconnect();
        layoutCache.clear();
        blockCache.clear();
        translationCache.clear();
        clearTranslationMeasureCache();
        stage.dispose();
    };
};

export default function activate(folium) {
    folium.registries.visualizers.register({
        id: 'jump-course',
        label: { 'zh-CN': '跳一跳', en: 'Hopscotch' },
        order: 440,
        settings: JUMP_SETTINGS_SCHEMA,
        mount: (container, ctx) => mountJump(folium, container, ctx),
    });
}
