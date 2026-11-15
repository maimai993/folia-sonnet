// mods/visualizer-jump/jumpFrame.mjs
// 一格多少像素、镜头钉在哪：取景的全部算术，纯计算，不碰 DOM。
//
// 为什么单独一层：以前「格子多大」是**由当前俯角反解**出来的——俯角小，同样的路在屏幕上
// 抬得少，纵向预算一收缩，格子就跟着放大。于是拖俯角滑杆时画面在整体缩放，用户看到的
// 是「调角度 = 变焦」。这里把两件事拆开：
//
//   1. 俯角只决定**投影形状**（地面铺多开、柱子和小人在屏幕上多高）；
//   2. 缩放由「镜头距离」单独给，且帧率取景以一个**固定参照俯角**封顶。
//
// 参照俯角是面板的默认值（`REFERENCE_PITCH`）。取景预算在「当前俯角」与「参照俯角」
// 之间取**小的那一份**——所以俯角变小不再放大（被参照那一份夹住），俯角变大时仍然会
// 缩一点（纵向确实铺得更开，不缩就装不下），但那是装得下的必要代价，且方向单一、
// 幅度小。想让画面更大 / 更小，用「镜头距离」，它乘在取景上，与俯角无关。

import { FACE_SPAN_CELLS, TEXT_FILL } from './jumpShape.mjs';
import { createProjection } from './jumpProject.mjs';

const DEG = Math.PI / 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * 取景的参照俯角（度）：面板上「俯角」的默认值。
 *
 * 它就是「这个模组长什么样」的那一版取景。俯角往下调时画面不再跟着放大，
 * 调上去时仍然会缩——于是这一个数就是缩放曲线的拐点。
 */
export const REFERENCE_PITCH = 34;

/** 一条路最多占画面宽的多少：留边给柱顶的字、小人与侧面那块柱身。 */
export const LANE_WIDTH_SHARE = 0.82;

/** 一屏之中允许被路占掉的高度份额（剩下的留给边框、柱子与小人）。 */
export const FIT_SHARE = 0.92;

/**
 * 一格最小这么多像素：可视区再矮，格子也不会缩到看不见，
 * 小人的落点也不会跑出画面底边（跑出去就只剩半个身子）。
 *
 * 它会跟着「镜头距离」一起缩：拉远时允许格子真的变小，否则拉到尽头也没反应。
 */
export const CELL_FLOOR_PX = 26;

/** 柱顶的字与边框之间留多少空（占柱宽的比例）：算进最坏情况，画面才不会一屏一屏地变。 */
export const FRAME_PAD_CELLS = 0.7;

/**
 * 一行最多几根柱子：再长就把「每块几个字」往粗里放宽（client 的 `MAX_CHUNK_CHARS`）。
 * 一行 3–4 根最像跳一跳（每一跳都看得清），长句只会让柱子变小、不会跳得更快。
 */
export const MAX_CHUNKS_PER_ROW = 5;

/** 「每块几个字」放宽到这么粗就停：再粗就不像跳一跳了，宁可多几根柱子。 */
export const MAX_CHUNK_CHARS = 10;

/**
 * 纵向预算按多长的一行算（格）：取「最多几块」再加两块余量。
 * 这个数固定下来，短句与长句才是同一把尺子，换一行整屏不会缩一下。
 */
export const BUDGET_ROW_CELLS = MAX_CHUNKS_PER_ROW + 2;

/** 柱高（格）= 面板里的「柱子高度」× 这个数；投影里竖直 1 格抬 cosθ/√2 个格宽。 */
export const PILLAR_RATIO = 1;

/** 小人身高（格）÷ 面板里的「小人尺寸」：人也是竖直的，走同一条 `lift`。 */
export const RUNNER_RATIO = 2.6;

/** 「镜头距离」的范围与默认值（与面板 schema 同一份数）。 */
export const CAMERA_DISTANCE_MIN = 0.6;
export const CAMERA_DISTANCE_MAX = 1.8;

/**
 * 一个俯角下的取景预算（单位：格宽）。
 *
 * - `belowCells` / `aboveCells`：小人脚下、头顶各要装下多少；
 * - `roadSpread`：整条路在屏幕上横着占多宽（三行接起来算）；
 * - `crossCells` / `risePerCell`：只有横向那一份用得上，留给调用方核对。
 */
export const resolveFrameBudget = (options = {}) => {
    const pitch = clamp(Number(options.pitch) || REFERENCE_PITCH, 5, 85);
    const heightCells = Math.max(0.2, Number(options.heightCells) || 0.2);
    const widestDepth = Math.max(0.1, Number(options.widestDepth) || 0.1);
    const widestCross = Math.max(0.1, Number(options.widestCross) || FACE_SPAN_CELLS);
    const spacing = Math.max(0.05, Number(options.spacing) || 0.05);
    const runnerScale = Math.max(0.1, Number(options.runnerScale) || 1);
    const arc = Math.max(0, Number(options.arc) || 0);
    const textFace = options.textFace === 'side' ? 'side' : 'face';

    const sin = Math.sin(pitch * DEG);
    const cos = Math.cos(pitch * DEG);
    // 一格路在屏幕上抬多少：沿世界轴走一格 = 横向半格宽、纵向抬 sinθ/2 个格宽。
    const risePerCell = sin / 2;
    /*
     * 纵向预算按**块数上限**算，不按这一行真正排出来多长：短句排得短，格子就被放得更大，
     * 长句一来格子又缩回去——同一首歌一换行，整屏就呼吸一次。预算是「最坏情况」，
     * 而最坏就是一行装满上限那么多块，一行最多也就这么长（长句多出来的部分出画）。
     */
    const climbCells = (BUDGET_ROW_CELLS + widestDepth) * risePerCell;
    const laneCells = (BUDGET_ROW_CELLS + spacing) * risePerCell;
    // 柱顶那一块在屏幕上占多高（见 client 的注释：侧面那一档是立起来的字）。
    const pillarCells = heightCells * cos / Math.SQRT2;
    const crownCells = textFace === 'side'
        ? pillarCells + widestDepth * cos / Math.SQRT2
        : TEXT_FILL * FACE_SPAN_CELLS;
    /*
     * 头顶还要装下**小人自己**：他站在柱顶上，腾空时再抬一整个跳跃高度。
     * 两个都是世界里竖直的一段，和柱身一样按 `cosθ/√2` 换成格宽。
     */
    const runnerCells = RUNNER_RATIO * runnerScale * cos / Math.SQRT2;
    const arcCells = arc * cos / Math.SQRT2;
    // 「上方」那一档的字浮在柱顶之上，连它一起算进头顶的预算。
    const crownTopCells = crownCells
        + Math.max(TEXT_FILL, runnerCells + arcCells)
        + FRAME_PAD_CELLS / 2;
    const belowCells = 2 * climbCells + laneCells + crownCells + FRAME_PAD_CELLS / 2;
    const aboveCells = 2 * climbCells + laneCells + crownTopCells + FRAME_PAD_CELLS / 2;
    /*
     * 柱顶那块面在屏幕上的**横宽**：沿路那条边与横向那条边各投成一条斜线，
     * 横向各占 1/√2——顶面横宽 = (块长 + 柱身横向) / √2。预算按最坏一根算。
     */
    const crossCells = (widestDepth + widestCross) / Math.SQRT2;
    /*
     * 视野里同时铺着三行，一右一左地折，合起来的横宽差不多是三行接起来那么多
     * （每行在屏幕上一边走半边，所以除以 √2）。
     */
    const roadSpread = Math.max(
        (3 * BUDGET_ROW_CELLS) / Math.SQRT2,
        (BUDGET_ROW_CELLS + 2 * widestDepth) / Math.SQRT2,
        (BUDGET_ROW_CELLS + widestDepth) * risePerCell + crossCells,
    );
    return { pitch, belowCells, aboveCells, crossCells, roadSpread };
};

/**
 * 这一个俯角、这块屏幕下，格子最大能有多大（不夹地板、不乘镜头距离）。
 *
 * 取四条约束里最小的那一条：纵向两份预算之和、横向的路宽、以及「一格不超过半屏高、
 * 不超过三分之一屏宽」这两条——句子很短时预算会放得很大，压一层上限，
 * 别让一块比一行字还高。
 */
export const resolveFitCell = (size, budget) => {
    const width = Math.max(1, Number(size?.width) || 1);
    const height = Math.max(1, Number(size?.height) || 1);
    const frameCells = budget.belowCells + budget.aboveCells;
    return Math.min(
        (height * FIT_SHARE) / frameCells,
        (width * LANE_WIDTH_SHARE) / Math.max(1, budget.roadSpread),
        height / 2.8,
        width / 3,
    );
};

/**
 * 一屏的取景：格子多少像素、投影、小人脚下留多高。
 *
 * 缩放由**两件事**决定，别的都不许再改它：
 *   - 取景封顶：`min(当前俯角的取景, 参照俯角的取景)`——俯角变小不再放大画面；
 *   - 镜头距离：乘在取景上（`÷ distance`），远处看整条路、近处看这一句。
 *
 * 「镜头距离」只缩放**场景**（柱子、小人、路）。译文那一层不跟它走：它浮在画面上，
 * 量字号的尺子是 `referenceProjection`（距离 = 1 那一版取景），于是拖距离时柱子变大变小
 * 而译文字号纹丝不动，只有俯角能改它（俯角压得越平，取的格子越小，字也跟着小一档）。
 *
 * `belowCells` 仍取**当前俯角**那一份：它是构图（小人钉在画面往下的第几成），
 * 不是缩放。俯角压低时画面下方能装的内容少，他也不该被推得那么高。
 */
export const resolveJumpFrame = (options = {}) => {
    const size = { width: Number(options.size?.width) || 0, height: Number(options.size?.height) || 0 };
    const pitch = clamp(Number(options.pitch) || REFERENCE_PITCH, 18, 60);
    // 没给值（旧版本存下的设置里没有这个键）按 1 走；给了但过分的值夹回范围内。
    const asked = Number(options.cameraDistance);
    const distance = Number.isFinite(asked) && asked > 0
        ? clamp(asked, CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX)
        : 1;
    const geometry = {
        heightCells: options.heightCells,
        widestDepth: options.widestDepth,
        widestCross: options.widestCross,
        spacing: options.spacing,
        runnerScale: options.runnerScale,
        arc: options.arc,
        textFace: options.textFace,
    };
    const budget = resolveFrameBudget({ ...geometry, pitch });
    const reference = resolveFrameBudget({ ...geometry, pitch: REFERENCE_PITCH });
    /*
     * 封顶：俯角变小（预算更宽松）时用参照那一份，画面**不再放大**；
     * 俯角变大时当前那一份更小，照它缩——纵向确实铺得更开，不缩就装不下。
     */
    const fit = Math.min(resolveFitCell(size, budget), resolveFitCell(size, reference));
    // 参照取景（距离 = 1）的格子：地板也算在它前面，所以它只由俯角与屏幕决定。
    const referenceCellPx = Math.max(CELL_FLOOR_PX, fit);
    const cellPx = referenceCellPx / distance;
    const projection = createProjection({ pitch, cell: cellPx });
    return {
        pitch,
        distance,
        cellPx,
        fitCellPx: fit,
        referenceCellPx,
        /*
         * 距离 = 1 那一版投影：几何一模一样，只是不乘镜头距离。
         * 给**不跟镜头缩放**的那一层用（译文号以柱顶的字为尺子，却不该被镜头推远推近）。
         */
        referenceProjection: createProjection({ pitch, cell: referenceCellPx }),
        projection,
        belowCells: budget.belowCells,
        aboveCells: budget.aboveCells,
        // 小人脚下留给上一行的那块高度：镜头把他钉在离画面底边这么高的地方。
        anchorBelowPx: budget.belowCells * cellPx,
    };
};
