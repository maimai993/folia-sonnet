// mods/visualizer-jump/jumpProject.mjs
// 唯一的投影：世界 (x, y, z) → 屏幕。纯计算，不碰 DOM。
//
// 为什么要有这一层：以前三个角度是三份互不相干的常量——柱子的面是写死的 SVG 多边形、
// 路的走向是另一个写死的步长、字又是 `rotate(45deg)`，于是字既不贴顶面也不沿路（这就是
// 「文字和柱子有夹角」）。现在**一切都从这一套投影推出来**：面的多边形、柱子的位置、
// 贴面的文字矩阵，全是它的函数，夹角自然消失。
//
// 相机：方位固定 45°（两条世界轴在屏幕上一左一右、对称），俯角 θ 由旋钮给；正交，
// 没有近大远小。正交是**仿射**的——任何一个平面上的文字都能用一个 2D 矩阵精确贴上去，
// 这正是「字跟着面走」不需要真 3D 引擎的原因（真透视才有除法，那时才需要 WebGL）。
//
// 一个「格」= 边长 1 的立方体，它的顶面在屏幕上是个菱形，菱形的宽度就是 `cell` 像素。
// 于是三个世界轴的屏幕位移（屏幕 y **向下**为正，所以「抬」是负的）：
//   +X 往左上、+Y 往右上：横向各走半个格宽，纵向各抬 (sinθ/2) 个格宽；
//   +Z 往上：抬 (cosθ/√2) 个格宽。
// 顶面菱形因此是 `cell` 宽、`cell·sinθ` 高——30° 时正好 2:1，与柱子的高矮无关
// （旧版顶面会被「柱子高度」旋钮拉变形，就是因为没有这一层）。

const DEG = Math.PI / 180;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * 建一套投影。`pitch` 是俯角（度），`cell` 是一个格在屏幕上的宽度（像素）。
 */
export const createProjection = (options = {}) => {
    const pitch = clamp(Number(options.pitch) || 30, 5, 85);
    const cell = Math.max(1, Number(options.cell) || 100);
    const sin = Math.sin(pitch * DEG);
    const cos = Math.cos(pitch * DEG);
    const half = cell / 2;
    // 竖直方向：世界里的 1 格在屏幕上抬这么多（√2 来自 45° 方位下的对角缩短）。
    const lift = (cell / Math.SQRT2) * cos;
    const axisX = { x: -half, y: -half * sin };
    const axisY = { x: half, y: -half * sin };
    const axisZ = { x: 0, y: -lift };
    const axisOf = (name) => (name === 'x' ? axisX : axisY);
    return {
        pitch,
        cell,
        sin,
        cos,
        half,
        lift,
        axisX,
        axisY,
        axisZ,
        axisOf,
        /** 世界坐标 → 屏幕坐标（画布自己的平移不在这里，由调用方加）。 */
        project: (x, y, z) => ({
            x: axisX.x * x + axisY.x * y,
            y: axisX.y * x + axisY.y * y + axisZ.y * z,
        }),
    };
};

const boundsOf = (points) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    });
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
};

/**
 * 一个盒子在屏幕上的样子：三个可见面的多边形 + 每个面的「文字框架」。
 *
 * 盒子自己的局部坐标：沿路 u ∈ [0, len]，横向 w ∈ [0, depth]，高 z ∈ [0, height]；
 * `along` 说明哪条世界轴是「沿路」的那条。返回的坐标全部以**盒底中心**为原点
 * （也就是柱子节点的原点），屏幕 y 向下为正。
 *
 * 它永远是一个**实心盒子**：顶面就是柱身的截面（`len × depth`），端头那面就是柱身的一个面。
 * 上一版允许「顶面横向」与「柱身厚度」分成两个数，于是顶面比柱身宽出一截、
 * 那两段斜边悬在柱子侧上方（「柱子旁边有多余的线」）。要让字装得下，就整个柱子一起长——
 * 那正是「柱子跟着字变」（见 jumpShape），不该靠一块悬空的顶面。
 *
 * 相机的方位固定 45°：世界里面对镜头的永远是那块「长得像等边四边形」的墙面，
 * 沿路那条边在屏幕上朝一个斜上方、横向那条边朝另一个斜上方。于是：
 *   - 顶面是 `len × depth` 的平行四边形；
 *   - 正面（沿路的长条面）是 `len × height`；
 *   - 侧面（端头面）是 `depth × height`。
 * 哪一面落在屏幕左下、哪一面落在右下，随这一行的朝向（along）交替——明暗按屏幕位置给，
 * 不按正/侧给，否则两行的受光会一明一暗地闪。
 */
export const boxFaces = (projection, options = {}) => {
    const along = options.along === 'x' ? 'x' : 'y';
    const len = Math.max(0.1, Number(options.len) || 1);
    const depth = Math.max(0.1, Number(options.depth) || 1);
    const height = Math.max(0, Number(options.height) || 0);
    const axisAlong = projection.axisOf(along);
    const axisCross = projection.axisOf(along === 'x' ? 'y' : 'x');
    /*
     * 竖直面上的「下」：从柱顶到柱底。世界里 +Z 是往上、屏幕 y 向下为正，
     * 所以「下」是 `axisZ` 的反向——它的 y 为正，字才从上往下排。
     */
    const down = { x: -projection.axisZ.x, y: -projection.axisZ.y };

    const at = (u, w, z) => {
        const point = along === 'x' ? { x: u, y: w } : { x: w, y: u };
        return projection.project(point.x, point.y, z);
    };
    // 原点取「沿路居中 × 块厚居中」：柱子摆在哪里是 client 的事，这里只管面相对自己。
    const center = at(len / 2, depth / 2, 0);
    const rel = (point) => ({ x: point.x - center.x, y: point.y - center.y });
    const quad = (...corners) => corners.map(([u, w, z]) => rel(at(u, w, z)));

    const top = quad([0, 0, height], [len, 0, height], [len, depth, height], [0, depth, height]);
    const front = quad([0, 0, height], [len, 0, height], [len, 0, 0], [0, 0, 0]);
    const side = quad([0, 0, height], [0, depth, height], [0, depth, 0], [0, 0, 0]);

    /*
     * 文字框架：面上一个 2D 坐标系——`origin` 是本地 (0,0) 落在屏幕上的哪一点，
     * `u` / `v` 是**每格**的屏幕向量（字的横排方向 / 字的「下」方向），
     * `uSpan` / `vSpan` 是这个面在这两个方向上各有几格。贴面的矩阵就是这四样东西。
     *
     * 一条底线：`v`（字的「下」）的 y 分量为正——字必须从上往下读，不能立反。
     * 这条守不住就会一起翻掉两块：`u` 与 `v` 同时反 = 字转了 180°，在正方格里看不出来，
     * 两个字并排就整块是倒的（Issue #42 的「一行正常、一行镜像」）。
     */
    const frame = (corner, u, v, uSpan, vSpan) => ({
        origin: rel(at(corner[0], corner[1], corner[2])),
        u,
        v,
        uSpan,
        vSpan,
    });

    return {
        bbox: boundsOf([...top, ...front, ...side]),
        faces: { top, front, side },
        frames: {
            // 顶面：字沿路读，「下」朝向镜头（从远的横向边到近的横向边）。
            top: frame([0, depth, height], axisAlong, { x: -axisCross.x, y: -axisCross.y }, len, depth),
            // 正面（长条面）：字沿路读，「下」是柱顶到柱底。
            front: frame([0, 0, height], axisAlong, down, len, height),
            /*
             * 侧面（端头面）：字沿横向读，「下」同样是柱顶到柱底。
             * 起点在 w = depth 那个上角，`u` 朝 −`axisCross`（也就是往 w = 0 那头读）：
             * 这样 origin + uSpan·u 正好落在这一面的另一个上角上，字盒才真的在这面墙里。
             * 顺带也把「下」定对了——`v` 一翻，字就整个转 180°，正方格里看不出来。
             */
            side: frame([0, depth, height], { x: -axisCross.x, y: -axisCross.y }, down, depth, height),
            /*
             * 悬浮：不贴任何面，屏幕正立。`origin` 取柱顶中心；
             * 房间按这块顶面在**屏幕上**的横向占宽给（换算成「一格 = cell 像素」的格数）。
             * 纵向取柱顶横向那一条（`depth`）：悬浮的字不被错切，同样一个字盒高在屏幕上
             * 看着比贴在顶面上的大（顶面那一份要乘 cos/√2 的投影缩短），房间跟着柱顶横向
             * 走，这一档的字才和顶面上的一样高，字号在四档之间才是同一把尺子。
             */
            above: frame(
                [len / 2, depth / 2, height],
                { x: projection.cell, y: 0 },
                { x: 0, y: projection.cell },
                (len * Math.hypot(axisAlong.x, axisAlong.y)) / projection.cell,
                depth,
            ),
        },
    };
};

/**
 * 一根**圆柱**在屏幕上的样子：柱顶一个椭圆 + 柱身的两半（行末那根无字的歇脚柱用它）。
 *
 * 与 `boxFaces` 同一套坐标（以柱底中心为原点，屏幕 y 向下为正）、同一个投影。
 * 方位固定 45°、正交：世界里一个直径 `diameter` 的圆，投到屏幕上正好是一个
 * **轴对齐的椭圆** —— 横半轴 `cell·d·√2/4`、纵半轴再乘 `sin`（正因为它是轴对齐的，
 * 柱身的左右两端就是椭圆的左右两端，柱身只需从这两点往下走 `height` 格）。
 *
 * 柱身在最下面那个点分成左右两半：那一处正是方料上「正面 / 侧面」两块墙的交线，
 * 明暗（见 client 的 `lit` / `shade`）于是与同一行的方块是同一套。
 */
export const cylinderFaces = (projection, options = {}) => {
    const diameter = Math.max(0.1, Number(options.diameter) || 1);
    const height = Math.max(0, Number(options.height) || 0);
    const rx = (projection.cell * diameter * Math.SQRT2) / 4;
    const ry = rx * projection.sin;
    // 柱顶中心（柱底中心在原点）：世界里 +Z 往上，屏幕 y 向下为正，所以是负的。
    const lift = projection.lift * height;
    const cy = -lift;
    const f = (value) => value.toFixed(2);
    /*
     * 两半柱身：左半从椭圆最左 → 柱底最左 → 底弧（鼓向下）→ 中缝 → 顶弧回到最左。
     * 弧的 sweep：屏幕 y 向下时「θ 增大」是顺时针（SVG 的 sweep = 1），
     * 于是底弧从最左走到最下是 θ 减小（sweep = 0），顶弧从最下走回最左是 θ 增大（sweep = 1）。
     */
    const arc = (x, y, sweep) => `A ${f(rx)} ${f(ry)} 0 0 ${sweep} ${f(x)} ${f(y)}`;
    const half = (side) => {
        const edge = side * rx;
        const down = side < 0 ? 0 : 1;
        return [
            `M ${f(edge)} ${f(cy)}`,
            `L ${f(edge)} 0`,
            arc(0, ry, down),
            `L 0 ${f(cy + ry)}`,
            arc(edge, cy, 1 - down),
            'Z',
        ].join(' ');
    };
    return {
        bbox: { x: -rx, y: cy - ry, width: 2 * rx, height: lift + 2 * ry },
        disc: { cx: 0, cy, rx, ry },
        halves: { left: half(-1), right: half(1) },
    };
};

/**
 * 一块字贴面上的**唯一**量法：先把这块字的长宽比按格数缩到面里，再换成本地像素。
 *
 * 两件事一起做，是因为它们本来就只能一起定：
 *   1. 字盒只有一种形状（宽 ÷ 高 = `aspect`），面给它的窗是 `room`（格）；
 *   2. 面再长、格子再大，字盒都只有这一份比例——于是「字心落在面心」是一个算得出来的点，
 *      不用为每一档面各写一遍。
 *
 * 装不下时**按同一比例缩小整个字盒**（宽、高、字号一起），不单独压扁一条边：
 * 于是字永远不出框，只是变小一点，不会被压成另一个比例。
 * `scale` 是「装好之后再整体放大 / 缩小」（现在没人用它，缺省 1）：装完之后如果出框，
 * 就按同一比例整体缩回去——所以调大顶多顶到面的上限（字不会出框），调小确实变小。
 * 返回的 `width` / `height` 是本地像素（本地一格 = `cell` 像素），`fontSize` 取字盒高。
 */
export const resolveTypeBox = (room, options = {}) => {
    const cell = Math.max(1e-6, Number(options.cell) || 1);
    const aspect = Math.max(0.05, Number(options.aspect) || 1);
    const fill = Math.max(0.05, Math.min(1, Number(options.fill) || 0.78));
    const scale = Math.max(0.1, Math.min(4, Number(options.scale) || 1));
    // 房间是「面」给的规格：字盒只在这间房里铺，面不让步（`fill` 也一样）。
    const roomW = Math.max(0.05, Number(room?.width) || 0.05) * fill;
    const roomH = Math.max(0.05, Number(room?.height) || 0.05) * fill;
    /*
     * 按长宽比铺满面（两条边取「谁先顶满」），再乘 `scale`；
     * **乘完之后**如果出框，就按同一比例整体缩回去——只缩一条边会把字盒压成
     * 另一个比例（屏幕上就是「字被压扁」）。
     */
    const base = roomW / aspect <= roomH
        ? { width: roomW, height: roomW / aspect }
        : { width: roomH * aspect, height: roomH };
    const want = { width: base.width * scale, height: base.height * scale };
    const fit = Math.min(1, roomW / want.width, roomH / want.height);
    const glyph = { width: want.width * fit, height: want.height * fit };
    return {
        width: glyph.width * cell,
        height: glyph.height * cell,
        fontSize: glyph.height * cell,
    };
};

/**
 * 这个面的字会不会被镜像（在屏幕上左右反着读）。
 *
 * 贴面矩阵是 `[u/cell, v/cell]` 两列，它的行列式就是这面在屏幕上还剩多少朝向：
 * 只要有朝向，行列式就不为 0；两面同时满足「横轴朝屏幕右」「竖轴朝屏幕下」时为正，
 * 差一个为负、差两个又为正。**为负就是镜像**：字是一行行从右往左铺的。
 *
 * 为什么这次两侧又崩了：两行沿世界的不同轴走（`along` 一奇一偶），同一档面在屏幕上的
 * 朝向就跟着换过来——按「哪个角当起点」逐个修，等于两行各修一次、换面档位再各修一次。
 * 所以这里不再逐个修，而是**算出来**；镜像的那些面由 `fitBoxIntoFace` 翻横轴——
 * 不换面，因为换面会让同一行里一半的字在顶面、一半在正面。
 */
export const faceMirrored = (projection, frame) => {
    const cell = Math.max(1e-6, Number(projection?.cell) || 1);
    const u = frame?.u ?? { x: 0, y: 0 };
    const v = frame?.v ?? { x: 0, y: 0 };
    return (u.x / cell) * (v.y / cell) - (u.y / cell) * (v.x / cell) < 0;
};

/**
 * 一块字贴在某面上：给盒子尺寸、字号与贴面 `transform`。
 *
 * 摆在**面心**：面心取四个角的平均（`faces[name]`），不是「一块再切一刀」的 `bbox`——
 * 那两者的中心本来就偏（端头墙挂在盒子的横向正中，顶面那条边也有自己的中点）。
 * 字盒是本地坐标里 `0…width × 0…height` 的一张纸，矩阵把它错切成面上那块平行四边形，
 * 于是「字盒中心」就是四个角的平均：把这个中心平移到面心，字盒就正正落在面的正中。
 * 这一步与面朝哪、翻不翻横轴都无关，所以不用为镜像再修一次位置。
 */
export const fitBoxIntoFace = (projection, box, options = {}) => {
    const named = options.frame ?? options.face;
    const frame = box?.frames?.[named] ?? box?.frames?.top;
    const quad = box?.faces?.[named] ?? box?.faces?.top;
    const boxOfType = resolveTypeBox(
        { width: frame?.uSpan, height: frame?.vSpan },
        { cell: projection?.cell, aspect: options.aspect, fill: options.fill, scale: options.scale },
    );
    const cell = Math.max(1e-6, Number(projection?.cell) || 1);
    /*
     * 面朝镜头背着时只翻横轴：同一个面、同样的字号，字从右往左铺才读得通。
     * 翻只是把本地 x 取反，中心仍在 `width / 2`，所以中心那一步不受影响。
     */
    const mirrored = faceMirrored(projection, frame);
    const sign = mirrored ? -1 : 1;
    const u = { x: (sign * frame.u.x) / cell, y: (sign * frame.u.y) / cell };
    const v = { x: frame.v.x / cell, y: frame.v.y / cell };
    const center = {
        x: quad.reduce((sum, point) => sum + point.x, 0) / Math.max(1, quad.length),
        y: quad.reduce((sum, point) => sum + point.y, 0) / Math.max(1, quad.length),
    };
    const halfW = boxOfType.width / 2;
    const halfH = boxOfType.height / 2;
    const e = center.x - (u.x * halfW + v.x * halfH);
    const f = center.y - (u.y * halfW + v.y * halfH);
    return {
        ...boxOfType,
        transform: `matrix(${u.x.toFixed(5)}, ${u.y.toFixed(5)}, ${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${e.toFixed(2)}, ${f.toFixed(2)})`,
    };
};

/**
 * 悬浮那一档：不贴任何面，屏幕正立浮在柱顶中心的上方，字号与贴面几档同一把尺子。
 *
 * 柱顶是一个平行四边形，它的中心就是四个顶点的平均（不是外接框的中心：那会随着
 * 块变长往一边偏）；底面**居中**在这个中心上，只往上留四分之一字高的缝。
 */
export const fitBoxAbove = (projection, box, options = {}) => {
    const cell = Math.max(1e-6, Number(projection?.cell) || 1);
    const frame = box?.frames?.above;
    const boxOfType = resolveTypeBox(
        { width: frame?.uSpan, height: frame?.vSpan },
        { cell, aspect: options.aspect, fill: options.fill, scale: options.scale },
    );
    const quad = Array.isArray(options.quad) ? options.quad : null;
    const center = quad && quad.length > 0
        ? {
            x: quad.reduce((sum, point) => sum + point.x, 0) / quad.length,
            y: quad.reduce((sum, point) => sum + point.y, 0) / quad.length,
        }
        : { x: frame?.origin?.x ?? 0, y: frame?.origin?.y ?? 0 };
    return {
        ...boxOfType,
        transform: `translate3d(${(center.x - boxOfType.width / 2).toFixed(2)}px, ${(center.y - boxOfType.height * 1.25).toFixed(2)}px, 0)`,
    };
};

/**
 * 把一块字放进旋钮选定的那一档。
 *
 * 只有一件事要调用方说清楚：这块字的长宽比（`aspect`）。面给的字盒比例由它反推，
 * 于是「字心对准面心」对每一档面都成立——不用再传第二份投影、也不用为侧面那档
 * 换一套轴（换轴量出来的房间与贴面矩阵量出来的不是同一个方向，字就歪在墙的一边）。
 */
export const placeText = (projection, box, options = {}) => {
    const named = typeof options.frame === 'string' ? options.frame : options.face;
    const aspect = Math.max(0.05, Number(options.aspect) || 1);
    const fill = Number(options.fill) || 0.78;
    const scale = Number(options.scale) || 1;
    if (!named || named === 'above') {
        return fitBoxAbove(projection, box, { aspect, fill, scale, quad: box?.faces?.top });
    }
    return fitBoxIntoFace(projection, box, { frame: named, aspect, fill, scale });
};
