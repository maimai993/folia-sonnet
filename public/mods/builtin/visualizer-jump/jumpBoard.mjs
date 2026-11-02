// mods/visualizer-jump/jumpBoard.mjs
// 「两行一条路」的世界坐标与换行时刻。纯计算，不碰 DOM。
//
// 一条规矩：**全局行号 k 决定一切**，换行就是 k 加一——
//   1. 偶数行沿世界 +Y、奇数行沿 +X（`k % 2`），两条方向在世界里恒为 90°；
//   2. 屏幕上怎么走不归这里管：方位 45°、俯角 θ 的正交投影在 jumpProject，
//      那里给出每条世界轴的屏幕向量（+Y 往右上、+X 往左上，都按 sinθ 抬）；
//   3. 第 k+1 行从第 k 行的**拐点**起步，而且要让开上一行的**柱身**：拐点 = 上一行末块的外沿
//      + 半个 gap，下一行首块再往外让 `maxDepth / 2`（上一行最宽那根的横向半宽）——
//      只让半个 gap 的话，它越过了末块的沿路端点、却还插在末块的横向范围里，两行在拐角上叠一截；
//   4. 换行只判一个相位 `resolveShiftPhase`（0…1），由「第 k 行不再写、第 k+1 行开始写」推出来。
//
// 一条路，一直在往上铺（accumulateRowRoad / client 的 buildBoard）
//   块按**自己的字宽**排（`lens`，格），块之间空 `gap` 格，行尾留半个 gap。
//   所以长词是一块长条、短词是一块短条，同一行的柱子不再一样长——但一样厚、一样高。
//   关键是每一块的位置只由 (行号, 块号) 决定，跟「现在轮到第几行」无关：
//   镜头怎么样都不会让任何一块挪窝，屏幕上动的只有镜头自己。
//
// 小人跳一块 = 镜头走一段（resolveShiftPhase / client 的 paintFrame）
//   行内：往本行朝向跳到下一块；换行：上一行**唱完那一刻**起跳、飞一个滞空就落地
//   （见 jumpTimeline.resolveShiftFly），所以他不会站在末块上等；比这一跳更长的那截空档
//   他站着歇——行末立了空柱子就歇在柱子上，没有就站在下一行首块上——这一段**有意是静的**
//   （间奏里没有在唱的东西，以前撑画面的「呼吸」那一层已经去掉）。
//   镜头大致钉住小人踩着的那块，但**不照他的曲线走**：他落地后站着不动，
//   镜头照他走就会「走一截、停一截」，所以行内由镜头自己匀速走（见 jumpTimeline.resolveCameraPath），
//   跨行那一段沿折线走（末块 → 拐点 → 下一行首块，见 jumpTimeline.resolvePathWeights），
//   不会把拐角切掉。

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** 平滑进出：换行那一下要「起步慢、落定稳」，不能是匀速的平移。 */
const smooth = (t) => {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
};

/** 行号 → 0 或 1：负数也按「离 0 几行」算，重播到第 0 行之前不会翻向。 */
const parity = (lineIndex) => Math.abs(lineIndex) % 2;

/**
 * 这一行沿哪条世界轴铺：偶数行 +Y（屏幕上往右上），奇数行 +X（往左上）。
 * 两条轴在 45° 方位下互为 90°，于是相邻两行的夹角恒为 90°。
 */
export const rowAxis = (lineIndex) => (parity(lineIndex) === 0 ? 'y' : 'x');

/** 这一行在屏幕上是往右（+1）还是往左（−1）：镜头的前瞻量要用。 */
export const rowDirection = (lineIndex) => (parity(lineIndex) === 0 ? 1 : -1);

/**
 * 跨行那一跳的窗口（秒）：`{ anchor, window }` —— 从 `anchor` 起跳、`lineStart` 落地。
 *
 * 窗口铺满**整段空档**（上一行唱完到下一行开口）：起跳点是上一行唱完那一刻，
 * 于是任何时候都不会出现「人还站在末块上等着，下一个字一开口才瞬移过去」。以前只在开口前
 * `duration + overlap` 那么长的一截里起跳，前面整段间奏里人和镜头都不动
 * ——「唱完一行最后一个字到下一行第一个字之间一动不动」说的就是那一截。
 *
 * 真正画出来的那一跳**不占满这个窗口**：间奏几十秒的话，照窗口走就成了几十秒的慢动作，
 * 所以滞空由 jumpTimeline 按秒给（`resolveShiftFly`），剩下的空档他**站着等**——
 * 行末立了空柱子就歇在柱子上，没有就站在下一行首块上；这一段画面是静的。
 * 这里只用它判「换行的相位走到几成」（`resolveShiftPhase`），与画出来的那一跳无关。
 */
export const resolveShiftAnchor = (options = {}) => {
    const prevEnd = Number.isFinite(options.prevEnd) ? options.prevEnd : null;
    const lineStart = Number.isFinite(options.lineStart) ? options.lineStart : null;
    if (prevEnd === null || lineStart === null || lineStart <= prevEnd) return null;
    // 窗口就是整段空档：唱完那一刻起跳、下一行开口那一刻落地。
    // 跳跃感（滞空占这一跳几成）由 jumpTimeline 按秒给，不靠缩窗口。
    return { anchor: prevEnd, window: lineStart - prevEnd };
};

/**
 * 换行相位 0…1：上一行唱完到这一行开口之间，小人从上一行最后一根跳到这一行第一根。
 *
 * 窗口落在「上一行唱完、这一行开口」之间——上一行要留在原地唱完，不能边唱边被拖走。
 * 相位按时间算、不累加：拖动进度、暂停、导出走的是同一条链。
 */
export const resolveShiftPhase = (options = {}) => {
    const time = Number.isFinite(options.time) ? options.time : 0;
    const span = resolveShiftAnchor(options);
    if (!span) return 0;
    return smooth((time - span.anchor) / Math.max(0.05, span.window));
};

/**
 * 整首歌那条折线的**绝对**坐标：每一行起点的世界坐标 + 这一行每块沿路的偏移。
 *
 * 单位是「格」（`client` 侧按投影一次性换成像素）。一条底线：
 *   位置只由 (行号, 每块多长, 每块多宽) 决定，跟「现在轮到第几行在写」一点关系都没有——
 *   于是画几行、镜头怎么摇，都不会让任何一块挪窝，「无限画布」才立得住。
 *
 * 块按字宽排：第一块从行首让位处起步，之后每块接在前一块后面 `gap` 格，
 * 行尾留半个 `gap`——**那个行尾点就是拐点**，下一行从它开始沿自己的轴继续铺。
 *
 * 拐角要让开上一行的**柱身**，不是只让开它的沿路端点：
 *   上一行的块都躺在它自己中心线两侧各 `maxDepth / 2` 之内，下一行的行首若只退半个 `gap`，
 *   它虽然越过了末块的沿路端点，却仍插在末块的横向范围里——两行于是**在拐角上互相插入**，
 *   末块宽一点就叠掉半个字（「行尾和新行行首的两根柱子有时会重叠」）。
 *   所以行首让位取 `maxDepth / 2 + gap`：越过上一行最宽的那根柱身再留一个 `gap`，
 *   拐角上两块的垂直空当就和行内相邻两块一样，都是 `gap`。
 */
export const accumulateRowRoad = (options = {}) => {
    const rows = Array.isArray(options.rows) ? options.rows : [];
    const gap = Math.max(0, Number.isFinite(options.gap) ? options.gap : 0);
    const road = [];
    let x = 0;
    let y = 0;
    // 行首让位（格）：第 0 行没有上一行要让，只留半个 `gap`。
    let lead = gap / 2;
    rows.forEach((row, index) => {
        const lens = (row?.lens ?? []).map((value) => Math.max(0.1, Number(value) || 0.1));
        // 每块柱身的横向宽度（格）：拐角要让开的就是它的一半。
        const depths = (row?.depths ?? []).map((value) => Math.max(0.1, Number(value) || 0.1));
        const offsets = [];
        // 这个游标记的是**块内沿**：从行首让位处起步，块心还要再往前半个块长。
        let cursor = lead;
        lens.forEach((len) => {
            // 存的是**块心**（内沿 + 半个块长）：`rowBlockCenter` 直接拿它当年坐标。
            offsets.push(cursor + len / 2);
            // 游标停在下一块的内沿：这一块走完再加一个 `gap`。
            cursor += len + gap;
        });
        // 去掉多算的那个 gap，拐点就落在最后一块外沿 + 半个 gap 处。
        const length = lens.length > 0 ? cursor - gap + gap / 2 : 0;
        road.push({ index, along: rowAxis(index), direction: rowDirection(index), lens, offsets, length, x, y });
        if (rowAxis(index) === 'y') y += length;
        else x += length;
        if (lens.length > 0) {
            /*
             * 下一行的行首让位按本行**最宽**的那根柱身算，不按末块：侧面那一档每块宽度
             * 都不一样，末块窄、前面有一块宽的话，下一行照样会插进那块宽的肚子里。
             * 没有 `depths`（只按长度调用的场合）时按老样子留半个 `gap`。
             */
            const widest = depths.length > 0 ? Math.max(...depths) : 0;
            lead = widest > 0 ? widest / 2 + gap : gap / 2;
        }
    });
    return road;
};

/**
 * 第 `unitIndex` 块**块心**的世界坐标（格）：沿本行的轴走 `offsets`，横向落在这一行的中心线上。
 *
 * `offsets` 存的就是块心（`accumulateRowRoad` 已经把半个块长算进去了），调用方**不要再补半个块长**：
 * 补了的话相邻两块的空当会变成 `gap + (下一块 − 这一块) / 2`——长词后面跟一个短词就叠一截，
 * 反过来又拉出一道空，屏幕上就是「间距有大有小、甚至重叠」。
 */
export const rowBlockCenter = (row, unitIndex) => {
    const x = Number(row?.x) || 0;
    const y = Number(row?.y) || 0;
    const middle = Number(row?.offsets?.[unitIndex]) || 0;
    return row?.along === 'x' ? { x: x + middle, y } : { x, y: y + middle };
};

/**
 * 此刻轮到哪一行在写，以及跨行那一跳走到了几成。
 *
 * 主轴只有一条时间：每行从 `writeStart` 开始写、写到 `writeEnd` 为止。
 * 接手时刻取**上一行的 `writeEnd`**：行还在唱就把镜头拽走，最后那几个字会被跳过。
 * 下一行用不着「提前登台」——它一直摆在路上，只是还没轮到小人跳过去。
 *
 * `phase` 是跨行那一跳的进度：0 = 还站在上一行最后一根上，1 = 已经站到这一行第一根上。
 * 两者都由时间直接推出来、不累加，所以拖动进度、暂停、导出看到的是同一帧。
 */
export const resolveBoardRows = (options = {}) => {
    const windows = Array.isArray(options.windows) ? options.windows : [];
    const time = Number.isFinite(options.time) ? options.time : 0;
    if (windows.length === 0) return { rowIndex: -1, phase: 0 };

    /*
     * 「这一行什么时候唱完」看 `afterEnd`（收尾窗的起头），不是 `writeEnd`：
     * 后者就是下一行开口，按它交接的话整段空档里相位永远是 1——人和镜头都不动，
     * 正是「唱完一行到下一行开口之间画面停住」。
     */
    const releaseOf = (window) => (Number.isFinite(window?.afterEnd) ? window.afterEnd : window?.writeEnd);
    const startOf = (window) => (Number.isFinite(window?.writeStart) ? window.writeStart : window?.afterEnd);

    let rowIndex = 0;
    windows.forEach((window, index) => {
        if (index === 0) return;
        const handover = releaseOf(windows[index - 1]);
        if (Number.isFinite(handover) && time >= handover) rowIndex = index;
    });

    const previous = rowIndex > 0 ? windows[rowIndex - 1] : null;
    const prevEnd = releaseOf(previous);
    const lineStart = startOf(windows[rowIndex]);
    /*
     * 时刻排得莫名其妙时（两行同一个 startTime、下一行比上一行的收尾还早），
     * 宁可当这一行已经接手了——相位停在 0 会让小人在上一行最后一根上一直站着，唱不了新词。
     */
    const windowed = Number.isFinite(prevEnd) && Number.isFinite(lineStart) && lineStart > prevEnd;
    const phase = windowed ? resolveShiftPhase({ prevEnd, lineStart, time }) : 1;
    return { rowIndex, phase };
};
