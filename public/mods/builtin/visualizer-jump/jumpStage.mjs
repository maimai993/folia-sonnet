// mods/visualizer-jump/jumpStage.mjs
// 跳一跳的舞台：一层「画布」（换行时整体平移）+ 里面三种节点——柱子、落地特效、小人。
//
// 柱子是三块 SVG 多边形：顶面（菱形）、正面（沿路的长条面）、侧面（端头那面）。
// 三个面的顶点都由 jumpProject 从同一套投影算出来，所以它们的棱天然对齐、
// 顶面比例也不会被「柱子高度」带歪（旧版是写死的单位方块，改高度会把顶面一起拉变形）。
// 为什么用 SVG 而不是 `div` 拼 `clip-path`：`div` 一改 `clip-path` 就会把斜边切掉，
// 屏幕上于是出现「柱子坏掉」（只剩半块、柱身歪、字压在棱上）。
//
// 每个 SVG 的 `viewBox` 就是它自己外接框的像素尺寸（1 单位 = 1 像素），所以画面不会被
// 二次缩放——面的形状是什么样，画出来就是什么样。
//
// 这一层只建节点、写样式，不做几何判断：面的顶点、位置与时刻都由上层算好传进来。
//
// 另外还有一层**屏幕正中那块译文**（`paintTranslation`）：它不是柱子，不跟镜头走，
// 位置只跟容器尺寸与旋钮有关。行数与字号由上层（jumpTranslation）算好，这一层做三件事：
//   1. 把这一句铺成几行（可选「逐字密排」：每个字自己一格，镜头俯角那档的透视于是逐字生效）；
//   2. 换句时淡淡地落定（不透明度由时间算出来，见 jumpTimeline.resolveTranslationReveal）；
//   3. 「垫一层底」时按这块字的包围盒铺一圈柔和的暗/亮底，柱子从字缝里透出来但字读得清。

const SVG_NS = 'http://www.w3.org/2000/svg';

const createPillarNode = () => {
    const node = document.createElement('div');
    node.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:0', 'height:0',
        'pointer-events:none', 'will-change:transform',
    ].join(';');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;overflow:visible;pointer-events:none;';

    const front = document.createElementNS(SVG_NS, 'polygon');
    const side = document.createElementNS(SVG_NS, 'polygon');
    const top = document.createElementNS(SVG_NS, 'polygon');
    /*
     * 圆柱（行末那根无字的歇脚柱）用同一副壳：一个顶面椭圆 + 柱身的左右两半。
     * 两者永远只画一套（画圆柱时那三个多边形收起来），所以池子里的节点是通用的。
     */
    const disc = document.createElementNS(SVG_NS, 'ellipse');
    const left = document.createElementNS(SVG_NS, 'path');
    const right = document.createElementNS(SVG_NS, 'path');
    [front, side, top, disc, left, right].forEach((face) => face.setAttribute('stroke-linejoin', 'round'));
    [disc, left, right].forEach((face) => { face.style.display = 'none'; });
    // 侧面在后、正面压过它、顶面最后：三者只在棱上相接，顺序只影响描边压线。
    // 圆柱两半在前、顶面椭圆压在它们上面（柱身的两条竖棱被椭圆盖住，才像一根圆的）。
    svg.append(side, front, top, left, right, disc);

    const label = document.createElement('div');
    label.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'pointer-events:none',
        /*
         * 字盒就是一块字本身：不折行、行高 1、居中。
         * 不能再让 flex / padding 参与排版——贴面矩阵假设「盒子 = 字」，
         * 一旦盒子比字大或比字小，字就不在面心（`placeText` 量出来的中心对不上）。
         *
         * `text-align:center` 兜住「盒子比字宽」的那一档：字宽按字身系数估（拉丁字母 0.58 格、
         * 实际笔画只有半个字宽），盒子于是比这一行字宽出一截。靠左铺就会把字推到柱子的一头，
         * 居中之后字心才真的落在面心（CJK 那块本来就铺满，居中看不出差别）。
         */
        'white-space:pre', 'line-height:1', 'text-align:center', 'margin:0', 'padding:0', 'border:0',
        'overflow:visible', 'transform-origin:0 0', 'will-change:transform',
    ].join(';');

    node.append(svg, label);
    return { node, svg, front, side, top, disc, left, right, label };
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/**
 * 把一个 `rgba(r, g, b, a)` 拆成「不透明的那一层」+ 它自己的 alpha。
 *
 * 面色的 alpha 一直留在颜色里（正面 0.17、侧面 0.08、棱线 0.42），而 SVG 的
 * `fill-opacity` / `stroke-opacity` 是**另乘**上去的。于是「柱子透明度」拉到 100%
 * 也只画出一块 17% 的浅色——面板上写着不透明，画面上仍是一层灰，压住的译文字照样清楚，
 * 这跟「柱子要能遮住译文」是冲突的。
 *
 * 所以先把面色自身的 alpha 折进 `fill-opacity` / `stroke-opacity`：`opacity = own × 旋钮`。
 * 100% 就是 `1`，字面意义上的不透明；80%（默认档）时面仍偏透、译文照样读得出来。
 * 认不出来的颜色（命名色、`#rgb`）原样返回、alpha 当 1。
 */
/**
 * 旋钮的档位 → 屏幕上真正的 alpha。
 *
 * 面色的 alpha（正面 0.17、侧面 0.08）在这种画法里本来就是「这一层有多实」的一部分，
 * 旋钮只是在这之上再乘一份。所以旋钮 100% 时不能只是「原来的 0.17 × 1」——
 * 那还是 0.17。这里把旋钮当作**对满值的插值**：
 *
 *     alpha = own · t + (1 − own) · t³
 *
 * 两段各有分工：线性那段（`own · t`）保住这一面原本的轻重——侧面照旧比正面淡一档，
 * 三根滑杆推到同一个数时它们也不会糊成一样；三次那段（`(1 − own) · t³`）负责推满，
 * t = 1 时正好是 1（字面意义上的不透明）。两头都对得上：t = 1 是实心，
 * **t = 0 就一点不剩**——以前最低 0.05，而那一档仍留着 `own` 那一份底色，滑到底面上还有一层雾，
 * 想「只留轮廓」「只留字」做不到。
 */
const resolveFaceOpacity = (mix, own) => {
    const t = clamp01(Number(mix) || 0);
    const base = clamp01(Number.isFinite(own) ? own : 1);
    return clamp01(base * t + (1 - base) * t * t * t);
};

const splitAlpha = (color) => {
    const text = typeof color === 'string' ? color.trim() : '';
    const match = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(text);
    if (!match) return { color: text, alpha: 1 };
    const alpha = clamp01(Number(match[4]));
    return { color: `rgb(${match[1]}, ${match[2]}, ${match[3]})`, alpha };
};
const px = (value) => `${value.toFixed(2)}px`;

/**
 * 译文那一块字的 `text-shadow`：一条软影 + 一圈辉光。
 *
 * 辉光走 `text-shadow` 而不是背后垫一块渐变底：`text-shadow` 跟着字形走，
 * 光只从笔画周围晕开，柱子从字缝里看得见；垫一块底则是整块矩形，压上去像贴了一张纸。
 * 两圈半径一近一远（大一半的那个更淡），晕出去才像光，而不是一圈描边。
 * 半径跟着字号走，字号拧大时光不会显得变小。
 */
const buildTranslationShadow = (layout) => {
    const layers = [];
    if (layout.textShadow) layers.push(layout.textShadow);
    const glow = clamp01(layout.glowOpacity ?? 0);
    if (layout.glow && glow > 0.02 && layout.glowColor) {
        const size = Math.max(1, Number(layout.sizePx) || 1);
        /*
         * 光色本身带 alpha（调色板给的是实色），这里按旋钮乘一份：
         * 旋钮 0.35 的默认值 → 三圈各 0.35 / 0.24 / 0.14，叠起来是一圈刚好看得见的光。
         */
        const tint = (share) => withGlowAlpha(layout.glowColor, glow * share);
        layers.push(`0 0 ${(size * 0.12).toFixed(1)}px ${tint(1)}`);
        layers.push(`0 0 ${(size * 0.26).toFixed(1)}px ${tint(0.7)}`);
        layers.push(`0 0 ${(size * 0.55).toFixed(1)}px ${tint(0.4)}`);
    }
    return layers.length > 0 ? layers.join(', ') : 'none';
};

/** 把 `rgba(r, g, b, a)` 的 alpha 改成给定的值（调色板给的都是 rgba，认不出来就原样返回）。 */
const withGlowAlpha = (color, alpha) => {
    const match = /^rgba\(([^)]+)\)$/.exec(String(color ?? ''));
    if (!match) return color;
    const parts = match[1].split(',').map((part) => part.trim());
    if (parts.length < 3) return color;
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamp01(alpha).toFixed(3)})`;
};

/**
 * 屏幕正中那块译文的壳：一层定位用的 `node` + 一块居中、可整体透视的 `body`。
 *
 * 辉光不是垫在字后面的一个节点，而是 `body` 上的 `text-shadow`（见 buildTranslationShadow）：
 * 光跟着字形走，柱子从字缝里看得见。
 *
 * 为什么一层的字要拆成「每字一格」（见 writeTranslationRows）：浏览器只对**矩阵**做
 * 真透视，对一整段 `white-space:pre` 的文字不做——那样整块字是一张平面的图，
 * 只能一起压扁。每个字自己一格（`inline-block`）之后，字仍然按行排，透视却逐字生效：
 * 靠上的字被压得更扁、更往里收，整块才像铺在地上的一行行字。
 */
const createTranslationLayer = () => {
    const node = document.createElement('div');
    node.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
        'pointer-events:none', 'visibility:hidden', 'will-change:opacity',
    ].join(';');
    /*
     * `body` 的原点放在锚点上，块的尺寸由字自己撑开。`translate(-50%, Y%)` 里的那个 `Y`
     * 由对齐方式给（顶对齐 `0%`、居中 `-50%`、底对齐 `-100%`，见 jumpTranslation 的
     * resolveTranslationAnchor）：`Y` 就是「块的哪一头钉在锚点上」。
     *
     * 透视矩阵加在这一层，所以它是这块字的**唯一**坐标参考；`transform-origin` 也跟着
     * 对齐方式换（顶对齐从顶边压、底对齐从底边压），压扁才是从字所在的那一头朝中心收，
     * 而不是一律从底边往里塌。
     */
    const body = document.createElement('div');
    body.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:max-content', 'max-width:none',
        'transform-origin:50% 100%', 'text-align:center', 'white-space:nowrap',
        'transform-style:flat', 'will-change:transform',
    ].join(';');
    node.append(body);
    return { node, body, state: { key: null, look: null, transform: null, alpha: null, shown: false } };
};

/**
 * 把这一句的字码进那块译文：一句一换（`key` 变了才走这里），所以每行一个 `div`、
 * 每个字一个 `span` 是可以接受的开销——译文一次只露一句，几十个字。
 *
 * 逐字那一档（`perGlyph`）顺手给每个字算好它自己的透视矩阵：它们是**这一句的**属性，
 * 换句才变，所以写在这里而不是每帧写（逐帧写等于每帧几十次 `style.transform`）。
 */
const writeTranslationRows = (translation, rows, layout) => {
    const glyphs = Boolean(layout?.perGlyph);
    const tilt = layout?.glyphTilt ?? null;
    const lineCount = Math.max(1, rows.length);
    // 空行不占位：逐字那一档若是被行数上限截掉几行，剩下的行之间才不留空档。
    const nodes = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => (Array.isArray(row) ? row.length > 0 : Boolean(row)))
        .map(({ row, rowIndex }) => {
            const line = document.createElement('div');
            line.style.cssText = 'display:block;white-space:nowrap;';
            /*
             * 不逐字那一档（或者这一行是字符串）就整行一段文字：一块平面，同一个矩阵一起变换。
             * 逐字那一档才铺出一个个字格（见下面）。
             */
            if (!glyphs || typeof row === 'string') {
                line.textContent = Array.isArray(row) ? row.join('') : row;
                return line;
            }
            /*
             * 这一行在整块里离底边多远：靠上的行离镜头更远，收得更多。
             * `tilt.height` 是整块的高度，所以 `offset` 在 0（最下面一行）到
             * 「块高 − 行高」（最上面一行）之间。
             */
            const offset = Math.max(0, (lineCount - 1 - rowIndex)) * (Number(tilt?.lineHeight) || 0);
            // 一行一个字格：每个字吃的是**这一行**自己的矩阵（靠上的行收得更紧）。
            const matrix = layout.glyphTilt?.glyphMatrix?.(offset) ?? null;
            row.forEach((char) => {
                const span = document.createElement('span');
                span.textContent = char;
                /*
                 * 每个字自己一格、自己一个透视原点：矩阵于是在字这一级生效（见上面的说明）。
                 * 空格不加格子：它由 `white-space:pre` 撑开，加了反而会多出一段行内盒的高度。
                 */
                span.style.cssText = 'display:inline-block;transform-origin:50% 100%;white-space:pre;';
                if (matrix) span.style.transform = matrix;
                line.append(span);
            });
            return line;
        });
    translation.body.replaceChildren(...nodes);
};

/**
 * 挤压时横向补多少：竖直压掉（或拉出）的那一份乘这个系数再补到横向上。
 *
 * 不是「体积守恒」的 1:1（`2 − squash`）：原版的棋子被压矮时只是略胖一点，
 * 1:1 补回来会把它压成一张饼。0.5 是「看得出来、不过头」。
 */
const SQUASH_WIDTH_GAIN = 0.5;

export const createJumpStage = (container) => {
    const root = document.createElement('div');
    /*
     * `contain`：这一层是自成一套的子树（里面的节点全是 absolute，撑不动外面），
     * 加了它，每次写了一堆样式之后失效就只在这层内部结算，不往宿主的布局树上冒泡。
     * 只写 layout / paint / style，**不写 `size`**——宽高由 `inset:0` 给出，
     * 带上 `size` 的话 `clientWidth` 会永远量到 0。
     */
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:layout paint style;';

    /*
     * `canvas` 就是「镜头里那一块」。换行时只动它一个 `translateY`，
     * 屏幕上的内容是**整体滑下去**的，而不是两行各自淡入淡出。
     */
    const canvas = document.createElement('div');
    canvas.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
        'pointer-events:none', 'will-change:transform',
    ].join(';');
    const trail = document.createElement('div');
    trail.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    const scene = document.createElement('div');
    scene.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    /*
     * 落地特效是 `scene` 里的一层：夹在柱子与小人**之间**——
     * 环铺在柱顶上（要盖住柱子，不然被柱顶的填充吃掉），又不该压在小人身上。
     * 它跟着 `arrange` 每次重排时挂回去，所以永远在柱子之后、小人之前。
     */
    const impact = document.createElement('div');
    impact.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    // 轨迹层夹在画布最底下：拱线不该压在柱子正面。
    canvas.append(trail, scene);

    /*
     * 译文层挂在 `root` 上、`canvas` 之外：它不跟镜头平移，位置只跟容器尺寸与旋钮有关。
     * 里面的节点都在一个居中的「块」里（`translation.body`），透视与缩放大权交给那一层
     * 的 `transform`——换句只是换字，矩阵可以原地改。
     *
     * 它挂在 `canvas` **之前**，于是柱子、小人、轨迹都压在它上面：译文是浮在画面中部的注解，
     * 柱子从它前面经过，而不是被它盖住。远景那几根柱子先画、近景后画，整片台阶于是像一页
     * 摊开的字墙立在译文前面。
     */
    const translation = createTranslationLayer();
    root.append(translation.node, canvas);
    container.append(root);

    const pillars = [];
    /** 现在画不画柱顶那块字（宿主的 `getDisplay().showText`）；见 `setTextVisible`。 */
    let textVisible = true;
    let runner = null;
    // 上一次真正重排过的顺序（见 arrange）：没变就一个节点都不动。
    let arrangeKey = null;
    // 轨迹层那几十个点 / 椭圆也像柱子一样池化复用（见 drawTrail）。
    const trailDots = [];
    const trailRings = [];

    /** 取（必要时新建）第 `index` 根柱子的壳。池子只增不减，多出来的藏起来。 */
    const acquirePillar = (index) => {
        const slot = Math.max(0, Math.round(index));
        while (pillars.length <= slot) {
            const entry = createPillarNode();
            entry.slot = pillars.length;
            // 池子里新取的柱子也要跟上「现在画不画字」：关掉字之后才登场的柱子不能带着字出场。
            entry.label.style.visibility = textVisible ? '' : 'hidden';
            scene.append(entry.node);
            pillars.push(entry);
        }
        return pillars[slot];
    };

    /**
     * 只留下这批柱子，按给定顺序重排：后 append 的盖住先 append 的。
     * 顺序即绘制顺序（画家算法），不用 z-index——它会被 `contain` / `isolate` 切断。
     */
    const arrange = (entries) => {
        const ordered = Array.isArray(entries) ? entries.filter(Boolean) : [];
        /*
         * 顺序（也就是队列里的柱子是哪几个）在绝大多数帧里是不变的：
         * 只有换行的那一两帧才会真的变。变了再动 DOM——`append` 是子节点重排，
         * 顺带把兄弟链上的样式一起作废，每帧做一遍太贵。
         */
        const key = ordered.map((entry) => entry.slot).join(' ');
        if (key === arrangeKey) return ordered;
        arrangeKey = key;
        const visible = new Set(ordered);
        pillars.forEach((entry) => {
            const hidden = !visible.has(entry);
            if (entry.hidden === hidden) return;
            entry.hidden = hidden;
            entry.node.style.display = hidden ? 'none' : '';
        });
        ordered.forEach((entry) => scene.append(entry.node));
        /*
         * 落地 / 起跳的那一圈环夹在小人的**影子之上、身子之下**：
         * 环本来就铺在他落下的那一点上，而影子是一团压在那一点上的暗底
         * （`radial-gradient`，0.38 的浓度）。挂在影子下面时，刚落地那几帧环还小，
         * 正好整圈藏进影子那块暗斑里——「落地环看不见了」就是这么来的。
         */
        if (runner) scene.append(runner.shadow);
        scene.append(impact);
        // 小人的身子永远压在最上面。
        if (runner) scene.append(runner.node);
        return ordered;
    };

    /**
     * 镜头：整块画布在画面里的平移量（正数 = 内容往右/往下走）。
     * 行内的每一次跳、行与行之间的每一次换手，都只落在这个平移上——
     * 柱子自己的位置从来不动，于是「小人每跳一次，镜头走一格」。
     */
    const moveCanvas = (offsetX, offsetY) => {
        canvas.style.transform = `translate3d(${px(offsetX)}, ${px(offsetY)}, 0)`;
    };

    /**
     * 写一根柱子。
     *
     * `base` 是盒底中心在屏幕上的位置；`box` 是 jumpProject.boxFaces 算好的三个面
     * （坐标以盒底中心为原点，像素）。`label.transform` 是贴面的矩阵（或「上方」那一档的
     * 平移），由 jumpProject.placeText 算好——这一层不再自己摆字。
     *
     * `faceAlpha` 是**正面 / 顶面**的浓淡（就是「柱子透明度」那一根），`sideAlpha` 是
     * **侧面填充**的浓淡（「侧面填充透明度」），`edgeAlpha` 是棱线，各管各的。
     * `rowFade` 是行与行的主次（「其他行浓淡」）：它乘在这三样**算出来的 alpha** 上，
     * 而不是再去参与插值——旋钮写多少，其他行就是当前行的几成，面板上说得清。
     * `opacity` 只管这一行登场时整块的淡入——与 `rowFade` 分开是因为字不能跟着柱面一起被压暗
     * （见 `label.opacity`），侧面也不能跟着正面的浓度走（见下面的 `paintFace`）。
     */
    const paintPillar = (entry, options) => {
        const { base, box, cylinder, colors, opacity, faceAlpha, sideAlpha, edgeAlpha, rowFade, label } = options;
        // 方料与圆柱共用这一根壳：两套几何自带同一个 `bbox`，画哪一套由 `cylinder` 说。
        const shape = cylinder ?? box;
        const bbox = shape?.bbox ?? { x: 0, y: 0, width: 1, height: 1 };
        const state = entry.state ?? (entry.state = {});

        /*
         * 几何（三个面的顶点 / 椭圆与柱身的两半、外接框）是上层缓存出来的**同一个对象**：
         * 身份没变就什么都不用写。一屏里柱子纹丝不动的那些帧（也就是大多数帧）
         * 于是连一次 `setAttribute` 都没有。
         */
        if (state.shape !== shape) {
            state.shape = shape;

            // viewBox 与像素尺寸 1:1：面算出来是什么形状，画出来就是什么形状。
            entry.svg.setAttribute(
                'viewBox',
                `${bbox.x.toFixed(2)} ${bbox.y.toFixed(2)} ${bbox.width.toFixed(2)} ${bbox.height.toFixed(2)}`,
            );
            entry.svg.style.left = px(bbox.x);
            entry.svg.style.top = px(bbox.y);
            entry.svg.style.width = px(bbox.width);
            entry.svg.style.height = px(bbox.height);

            const show = (node, on) => { node.style.display = on ? '' : 'none'; };
            const writePoints = (node, points) => {
                node.setAttribute('points', points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '));
            };
            show(entry.side, !cylinder);
            show(entry.front, !cylinder);
            show(entry.top, !cylinder);
            show(entry.left, Boolean(cylinder));
            show(entry.right, Boolean(cylinder));
            show(entry.disc, Boolean(cylinder));
            if (cylinder) {
                const disc = cylinder.disc;
                entry.disc.setAttribute('cx', disc.cx.toFixed(2));
                entry.disc.setAttribute('cy', disc.cy.toFixed(2));
                entry.disc.setAttribute('rx', disc.rx.toFixed(2));
                entry.disc.setAttribute('ry', disc.ry.toFixed(2));
                entry.left.setAttribute('d', cylinder.halves.left);
                entry.right.setAttribute('d', cylinder.halves.right);
            } else {
                writePoints(entry.side, box.faces.side);
                writePoints(entry.front, box.faces.front);
                writePoints(entry.top, box.faces.top);
            }
        }

        /*
         * 「长相」与几何是两回事：同一副几何在换角色（正在写 / 上下两行）或换主题时
         * 颜色全变，反过来几何换了长相也可能一模一样。所以长相自己拼一个短键比一次，
         * 省下每帧二十来次样式写入与一次 Text 节点的重建——`textContent` 哪怕写得一样，
         * 也会换掉整个 Text 节点，把这一块字重新排一遍。
         */
        const look = [
            colors.top, colors.front, colors.side, colors.edge, faceAlpha, sideAlpha, edgeAlpha, rowFade,
            label?.text ?? '', label?.width, label?.height, label?.fontSize, label?.transform,
            label?.color, label?.fontFamily, label?.fontWeight, label?.opacity,
        ].join('|');
        if (state.look !== look) {
            state.look = look;
            /*
             * 浓淡走 `fill-opacity` / `stroke-opacity`，不再整根柱子共用一个 `opacity`：
             * 那样字会被柱面那份浓度一起乘掉（`label` 是 `node` 的子节点）。
             * 五种面各自的 base alpha（棱线 0.42、正面 0.17、侧面 0.08…）留在颜色里，
             * 这里只叠旋钮给出的那几份。
             *
             * 正面 / 顶面与**侧面**各拿一份浓度：侧面本来就比正面淡（base 0.08 vs 0.17），
             * 再一起调淡就彻底无痕——柱子看着断成「一片正面的墙 + 一条没有侧壁的边」。
             * 所以侧面单独一档（「侧面填充透明度」），棱线也自己一档，三者互不连坐。
             */
            const faceMix = String(clamp01(faceAlpha ?? 1));
            const sideMix = String(clamp01(sideAlpha ?? faceAlpha ?? 1));
            /*
             * 棱线自己一档：面调淡时全靠描边勾出柱子的轮廓，所以它比面留得多一点，
             * 但也不许被正面那份浓度绑住（那正是「调到 100% 也看不出柱子遮住译文」的一半原因：
             * 面实了线也跟着实，柱子整体仍是一片几乎看不见的雾）。
             * 描边自己的 alpha 留在颜色里（`colors.edge` 带 0.42），这里只叠旋钮那一份。
             */
            const edgeMix = String(clamp01(edgeAlpha ?? 1));
            /*
             * 行的主次乘在**最终 alpha** 上，不乘进插值系数：那种乘法只在「插值」这一段
             * 生效，旋钮写 30% 时画面里仍留着 `own·t³` 那一份底色，看着还是三成多。
             * 乘在结果上，旋钮写多少就是几成。
             */
            const fade = clamp01(rowFade ?? 1);
            const paintFace = (node, fill, mix) => {
                const face = splitAlpha(fill);
                const edge = splitAlpha(colors.edge);
                node.setAttribute('fill', face.color);
                node.setAttribute('fill-opacity', String(clamp01(resolveFaceOpacity(mix, face.alpha) * fade)));
                node.setAttribute('stroke', edge.color);
                node.setAttribute('stroke-opacity', String(clamp01(resolveFaceOpacity(edgeMix, edge.alpha) * fade)));
                node.setAttribute('stroke-width', '1.2');
            };
            if (cylinder) {
                /*
                 * 圆柱：柱顶一枚椭圆；柱身的左右两半就是方料上「正面 / 侧面」那两块墙
                 * （方料的交线在屏幕最下那个点上，圆柱就从那里分成两半），
                 * 明暗于是与同一行的方块一致。
                 */
                paintFace(entry.left, colors.front, faceMix);
                paintFace(entry.right, colors.side, sideMix);
                paintFace(entry.disc, colors.top, faceMix);
            } else {
                paintFace(entry.side, colors.side, sideMix);
                paintFace(entry.front, colors.front, faceMix);
                paintFace(entry.top, colors.top, faceMix);
            }

            /*
             * 行末那根空柱子没有字：`label` 是 null，整块字连盒子一起收起来
             * （留着的话它会把上一次的字留在这根柱子上）。
             */
            if (label) {
                entry.label.style.display = '';
                entry.label.textContent = label.text ?? '';
                // 本地盒子：`width × height` 像素，再被 `transform` 错切到面上。
                entry.label.style.width = px(label.width);
                entry.label.style.height = px(label.height);
                entry.label.style.fontSize = px(label.fontSize);
                entry.label.style.color = label.color;
                entry.label.style.fontFamily = label.fontFamily;
                entry.label.style.fontWeight = String(label.fontWeight);
                entry.label.style.transform = label.transform;
                // 字的亮度自己一份：只跟行的主次走，不吃柱面的浓淡（它再乘上节点的登场淡入）。
                entry.label.style.opacity = String(clamp01(label?.opacity ?? 1));
            } else {
                entry.label.style.display = 'none';
            }
        }

        // 下面两样是逐帧真的会变的：柱子在沉 / 在升，以及这一行登场的淡入。
        const alpha = clamp01(opacity).toFixed(3);
        if (state.alpha !== alpha) {
            state.alpha = alpha;
            entry.node.style.opacity = alpha;
        }
        entry.node.style.transform = `translate3d(${px(base.x)}, ${px(base.y)}, 0)`;
    };

    /**
     * 小人：照跳一跳原版那一枚「棋子」——一颗头 + 一个胶囊身子，**没有手脚**。
     * 原版里他就是这么一个棋子：蓄力时压矮、腾空时拉长，靠挤压本身表达动作。
     *
     * 尺寸一律写在 `em` 里（`fontSize` 就是他的像素高），于是整只人跟着「小人尺寸」旋钮
     * 一起放大缩小、比例不变；盒子是 `0.62em × 1em`，`transform-origin: 50% 100%`
     * 就是脚下那一点——挤压只从脚往上压，人不会陷进柱子里。
     *
     * 影子是**另一个节点**：它留在柱顶，不跟着人飞，所以不能挂在人身上被一起挤压；
     * 它画在小人之前，压不到人身上。
     */
    const createRunner = () => {
        const shadow = document.createElement('div');
        shadow.style.cssText = [
            'position:absolute', 'left:0', 'top:0', 'display:none',
            'border-radius:50%', 'pointer-events:none', 'will-change:transform',
            // 软边：柱顶是一块斜面，硬边椭圆看着像贴上去的一块斑。
            'background:radial-gradient(50% 50% at 50% 50%, rgba(6,10,22,0.62), rgba(6,10,22,0) 70%)',
        ].join(';');

        const node = document.createElement('div');
        node.style.cssText = [
            'position:absolute', 'left:0', 'top:0', 'width:0.62em', 'height:1em',
            'transform-origin:50% 100%', 'pointer-events:none', 'display:none', 'will-change:transform',
        ].join(';');

        const part = (extra) => {
            const el = document.createElement('div');
            el.style.cssText = `position:absolute;${extra}`;
            return el;
        };
        /*
         * 高光固定打在左上：头与身子才有体积，不至于是一块纯色剪影。
         * 身子底下再压暗一档（`linear-gradient` 那层）：棋子才像立在柱顶上，而不是浮着。
         */
        const gloss = [
            'background-color:currentColor',
            'background-image:radial-gradient(circle at 32% 24%, rgba(255,255,255,0.5), rgba(255,255,255,0) 62%)',
        ].join(';');
        const skin = [
            'background-color:currentColor',
            'background-image:'
                + 'radial-gradient(circle at 32% 22%, rgba(255,255,255,0.5), rgba(255,255,255,0) 62%),'
                + 'linear-gradient(rgba(6,10,22,0) 52%, rgba(6,10,22,0.2))',
        ].join(';');
        const head = part(`left:0.14em;top:0;width:0.34em;height:0.34em;border-radius:50%;${gloss}`);
        /*
         * 身子是一枚胶囊：上头半圆（圆角 = 半个宽）、底下略收一点圆角，坐在柱顶上。
         * 头压在它上面一档，两者交叠 0.02em——不留脖子缝隙。
         */
        const body = part([
            'left:0.05em', 'top:0.32em', 'width:0.52em', 'height:0.68em',
            'border-radius:0.26em 0.26em 0.14em 0.14em', skin,
        ].join(';'));
        node.append(body, head);
        scene.append(shadow, node);
        return { node, shadow };
    };

    /**
     * 画小人。
     *
     * `feet` 是此刻脚下那一点的屏幕坐标（含腾空那一下），`ground` 是同一时刻落在线路上的
     * 那一点（不含腾空）——人踩 `feet`、影子留在 `ground`。`squash` 是竖直方向的缩放
     * （1 原样、<1 压矮、>1 拉长，见 jumpCourse），横向按它补回来；
     * `groundSquash` 是柱顶在屏幕上的扁度（影子的椭圆照它压）。
     */
    const paintRunner = (options) => {
        if (!runner) runner = createRunner();
        const state = runner.state ?? (runner.state = {});
        if (!options) {
            if (state.shown !== false) {
                state.shown = false;
                runner.node.style.display = 'none';
                runner.shadow.style.display = 'none';
            }
            return;
        }
        const { feet, ground, height, color, squash, groundSquash } = options;
        const size = Math.max(6, height);
        // 离地多高（0…1，站着是 0）：只用来缩影子。
        const air = clamp01((ground.y - feet.y) / Math.max(1, size * 0.55));

        if (state.shown !== true) {
            state.shown = true;
            runner.node.style.display = '';
            runner.shadow.style.display = '';
        }
        /*
         * 个子、配色、影子的大小都只跟旋钮 / 主题 / 屏幕有关：
         * 它们不随时间变，所以只在那一串签名变了的时候才写（站住不动的那些帧于是零写入）。
         */
        const look = `${size.toFixed(2)}|${groundSquash}|${color}`;
        if (state.look !== look) {
            state.look = look;
            runner.node.style.fontSize = `${size.toFixed(2)}px`;
            runner.node.style.color = color;
            // 影子留在柱顶：比身子宽一圈，站着时它才不会整个人被盖住。收缩走 `scale`（而不改宽高）。
            const rx = size * 0.42;
            const ry = rx * Math.max(0.16, Number(groundSquash) || 0.5) * 0.8;
            runner.shadow.style.width = px(rx * 2);
            runner.shadow.style.height = px(ry * 2);
        }
        // 压矮就略胖、拉长就略瘦：横向只补 `SQUASH_WIDTH_GAIN` 那一份，不按体积 1:1 补。
        const wide = 1 + (1 - squash) * SQUASH_WIDTH_GAIN;
        const bodyTransform = [
            `translate3d(${px(feet.x)}, ${px(feet.y)}, 0)`,
            'translate(-50%, -100%)',
            `scale(${wide.toFixed(3)}, ${squash.toFixed(3)})`,
        ].join(' ');
        if (state.bodyTransform !== bodyTransform) {
            state.bodyTransform = bodyTransform;
            runner.node.style.transform = bodyTransform;
        }
        // 影子不跟着人飞：它留在落点上，飞得越高越小越淡。
        const shadowOpacity = (0.38 * (1 - 0.5 * air)).toFixed(3);
        if (state.shadowOpacity !== shadowOpacity) {
            state.shadowOpacity = shadowOpacity;
            runner.shadow.style.opacity = shadowOpacity;
        }
        const shrink = (1 - 0.35 * air).toFixed(3);
        const shadowTransform = [
            `translate3d(${px(ground.x)}, ${px(ground.y)}, 0)`,
            'translate(-50%, -50%)',
            `scale(${shrink}, ${shrink})`,
        ].join(' ');
        if (state.shadowTransform !== shadowTransform) {
            state.shadowTransform = shadowTransform;
            runner.shadow.style.transform = shadowTransform;
        }
        // 影子先、人后（人压在自己的影子上）：这一对的前后顺序只在 arrange 里校正，
        // 每帧重新 append 等于每一帧都重排一次子节点。
    };

    /**
     * 跳跃轨迹：已经跳过的拱线 + 落点的小坑。
     *
     * 拱线用一串小圆点画，不用「旋转的细长条」：细长条一旦角度算错就会连成一片，
     * 看起来像地面被划花了。圆点只吃位置，画不歪。
     *
     * 这一层的节点是**池化复用**的（见 takeTrailSlot）：内容在同一行里几乎不动，
     * 每帧推倒重来纯属浪费。
     */

    /*
     * 轨迹层的节点只建一次，以后按序号取用，多余的藏起来。
     *
     * 以前每帧 `createElement` + `replaceChildren`：一条已跳过的拱线是八个点、一个落点椭圆，
     * 一行最多四跳 = 四十来个节点每帧建了又扔，每个还要重新解析一遍 `cssText`。
     * 而这些点在**同一行里是静态的**——坐标来自柱子的绝对位置与固定的跳跃高度，
     * 镜头那一层位移由父节点的 transform 承担——多数帧这层的内容压根没变。
     */
    const takeTrailSlot = (pool, index, kind) => {
        let slot = pool[index];
        if (!slot) {
            const node = document.createElement('div');
            node.style.cssText = kind === 'ring'
                ? 'position:absolute;left:0;top:0;display:none;box-sizing:border-box;border-radius:50%;border-style:solid;'
                : 'position:absolute;left:0;top:0;display:none;border-radius:50%;';
            trail.append(node);
            slot = { node, shown: false, styles: Object.create(null) };
            pool[index] = slot;
        }
        return slot;
    };

    /** 写一样式前先比一次：值没变就不要去碰 CSSOM（这一层可能有几十个节点在复用）。 */
    const writeTrailStyle = (slot, prop, value) => {
        if (slot.styles[prop] === value) return;
        slot.styles[prop] = value;
        slot.node.style[prop] = value;
    };

    const showTrailSlot = (slot) => {
        if (slot.shown) return;
        slot.shown = true;
        slot.node.style.display = '';
    };

    const hideTrailSlot = (slot) => {
        if (!slot.shown) return;
        slot.shown = false;
        slot.node.style.display = 'none';
    };

    const drawTrail = (segments) => {
        let dots = 0;
        let rings = 0;
        (segments ?? []).forEach((segment) => {
            const color = segment.color ?? '#8fc7ff';
            if (segment.kind === 'ellipse') {
                const slot = takeTrailSlot(trailRings, rings, 'ring');
                rings += 1;
                showTrailSlot(slot);
                writeTrailStyle(slot, 'width', px(segment.rx * 2));
                writeTrailStyle(slot, 'height', px(segment.ry * 2));
                writeTrailStyle(slot, 'borderWidth', '1px');
                writeTrailStyle(slot, 'borderColor', color);
                writeTrailStyle(slot, 'opacity', String(clamp01(segment.opacity)));
                writeTrailStyle(
                    slot,
                    'transform',
                    `translate3d(${px(segment.x - segment.rx)}, ${px(segment.y - segment.ry)}, 0)`,
                );
                return;
            }
            const points = segment.points ?? [];
            points.forEach((point, index) => {
                if (index === 0) return;
                const dotSize = 2.4;
                const slot = takeTrailSlot(trailDots, dots, 'dot');
                dots += 1;
                showTrailSlot(slot);
                writeTrailStyle(slot, 'width', `${dotSize}px`);
                writeTrailStyle(slot, 'height', `${dotSize}px`);
                writeTrailStyle(slot, 'background', color);
                // 越靠近落点越实，远处的拱看起来是慢慢淡出去的。
                writeTrailStyle(
                    slot,
                    'opacity',
                    String(clamp01(segment.opacity * (0.3 + 0.7 * (index / Math.max(1, points.length - 1))))),
                );
                writeTrailStyle(
                    slot,
                    'transform',
                    `translate3d(${px(point.x - dotSize / 2)}, ${px(point.y - dotSize / 2)}, 0)`,
                );
            });
        });
        // 这一帧用不到的存货只是藏起来：留着下一帧继续用，不删也不重建。
        for (let index = dots; index < trailDots.length; index += 1) hideTrailSlot(trailDots[index]);
        for (let index = rings; index < trailRings.length; index += 1) hideTrailSlot(trailRings[index]);
    };

    /**
     * 落地那一瞬：每个落点上一圈铺开的环 + 几粒飞散的尘。
     *
     * 环与尘都画成圆 / 椭圆：柱顶是一块斜面，纵向照 `squash` 压扁才像摊在顶面上。
     * 这一层每帧整批换掉（`replaceChildren`）——特效只在落地后那零点几秒里有内容，
     * 平时是空的，留着节点不动反而会在拖动进度时留下上一帧的环。
     */
    const drawImpact = (stamps) => {
        const nodes = [];
        (stamps ?? []).forEach((stamp) => {
            const color = stamp.color ?? '#8fc7ff';
            const alpha = clamp01(stamp.opacity);
            if (alpha <= 0.004) return;
            const rx = Math.max(1, Number(stamp.radius) || 1);
            const ry = Math.max(1, rx * (Number(stamp.squash) || 0.5));
            const ring = document.createElement('div');
            ring.style.cssText = [
                'position:absolute', 'left:0', 'top:0', 'box-sizing:border-box',
                `width:${px(rx * 2)}`, `height:${px(ry * 2)}`,
                // 2px：柱顶那块面本身是半透明的，1.6px 的细线压在上面几乎化掉。
                `border:2px solid ${color}`, 'border-radius:50%',
                `opacity:${alpha.toFixed(3)}`,
                `transform:translate3d(${px(stamp.x - rx)}, ${px(stamp.y - ry)}, 0)`,
            ].join(';');
            nodes.push(ring);
            (stamp.dust ?? []).forEach((dot) => {
                const size = Math.max(1.4, Number(stamp.dotSize) || 2.2);
                const dotAlpha = clamp01(alpha * clamp01(dot.opacity));
                if (dotAlpha <= 0.004) return;
                const grain = document.createElement('div');
                grain.style.cssText = [
                    'position:absolute', 'left:0', 'top:0', 'border-radius:50%',
                    `width:${px(size)}`, `height:${px(size)}`, `background:${color}`,
                    `opacity:${dotAlpha.toFixed(3)}`,
                    `transform:translate3d(${px(dot.x - size / 2)}, ${px(dot.y - size / 2)}, 0)`,
                ].join(';');
                nodes.push(grain);
            });
        });
        /*
         * 这一层绝大多数帧是空的（只在落地后那零点几秒里有内容）：
         * 空对空就什么都不做——`replaceChildren` 每帧都要抛一次子节点变化的通知。
         */
        if (nodes.length === 0 && impact.childElementCount === 0) return;
        impact.replaceChildren(...nodes);
    };

    /**
     * 屏幕正中那块译文。`layout` 是上层算好的一整块（行、字号、贴哪、透视、浓淡）：
     *
     * ```js
     * { key, rows, sizePx, lineHeight, fontFamily, fontWeight, color, glow, glowColor,
     *   glowOpacity, opacity, tilt, textShadow, anchor: { x, y }, scaleX, scaleY }
     * ```
     *
     * `rows` 是「一行的字符串」或「一行的字数组」（数组就逐字密排，透视逐字生效）。
     * 一切都由上层算好：这一层只管把字码到节点上、把矩阵写进 `transform`。
     */
    const paintTranslation = (layout) => {
        if (!layout) {
            hideTranslation();
            return;
        }
        const state = translation.state;
        const key = String(layout.key ?? '');
        const rows = Array.isArray(layout.rows) ? layout.rows
            : (Array.isArray(layout.rows?.lines) ? layout.rows.lines : []);
        if (state.key !== key) {
            state.key = key;
            writeTranslationRows(translation, rows, layout);
        }
        /*
         * 长相与位置分开写：字型、颜色、辉光只跟主题与旋钮走，换句时才有一次；
         * 位置（锚点、缩放、透视、浓淡）每帧都可能变（淡入那零点几秒 + 窗口尺寸）。
         */
        const look = [
            layout.sizePx, layout.lineHeight, layout.fontFamily, layout.fontWeight,
            layout.color, layout.textShadow, layout.strokeColor,
            layout.glow ? 1 : 0, layout.glowColor ?? '', layout.glowOpacity ?? '',
            layout.scaleX, layout.scaleY,
        ].join('|');
        if (state.look !== look) {
            state.look = look;
            translation.body.style.fontSize = px(layout.sizePx);
            translation.body.style.lineHeight = px(layout.lineHeight);
            translation.body.style.fontFamily = layout.fontFamily ?? 'sans-serif';
            translation.body.style.fontWeight = String(layout.fontWeight ?? 500);
            translation.body.style.color = layout.color ?? '#ffffff';
            /*
             * 描边：主题底色的细边，压在柱子群正中时字才分得开（`text-shadow` 盖不住笔画之间）。
             * 写属性名而不是 `setProperty`：极简 DOM 桩里没有那一个方法，逐帧抛异常会把整屏冻住。
             */
            translation.body.style.webkitTextStroke = layout.strokeColor ? `1px ${layout.strokeColor}` : '0';
            translation.body.style.textShadow = buildTranslationShadow(layout);
        }
        /*
         * 块的哪一头钉在锚点上：顶对齐钉顶边（`0%`）、居中钉块心（`-50%`）、
         * 底对齐钉底边（`-100%`）。所以换个对齐方式只是换这个百分比，锚点本身仍在同一段范围里。
         */
        const anchorPercent = Number.isFinite(layout.anchor?.anchorPercent) ? layout.anchor.anchorPercent : -100;
        const transformOrigin = `50% ${anchorPercent === 0 ? '0%' : anchorPercent === -50 ? '50%' : '100%'}`;
        if (state.origin !== transformOrigin) {
            state.origin = transformOrigin;
            translation.body.style.transformOrigin = transformOrigin;
        }
        const transform = [
            `translate3d(${px(layout.anchor?.x ?? 0)}, ${px(layout.anchor?.y ?? 0)}, 0)`,
            `translate(-50%, ${anchorPercent}%)`,
            `scale(${(Number(layout.scaleX) || 1).toFixed(4)}, ${(Number(layout.scaleY) || 1).toFixed(4)})`,
            layout.tilt ?? '',
        ].join(' ');
        if (state.transform !== transform) {
            state.transform = transform;
            translation.body.style.transform = transform;
        }
        const alpha = clamp01(layout.opacity ?? 1).toFixed(3);
        if (state.alpha !== alpha) {
            state.alpha = alpha;
            translation.node.style.opacity = alpha;
        }
        if (state.shown !== true) {
            state.shown = true;
            translation.node.style.visibility = '';
        }
    };

    /** 这一帧没有译文可画（间奏、前奏、整行没有译文）：整层收起来，一个节点都不留。 */
    const hideTranslation = () => {
        const state = translation.state;
        if (state.shown === false) return;
        state.shown = false;
        translation.node.style.visibility = 'hidden';
        state.key = null;
        state.look = null;
    };

    /*
     * 宿主说「现在不该画歌词」（`getDisplay().showText` 为 false，比如设置窗口盖住播放页）
     * 时只藏字：柱子、小人、轨迹照旧画，和内置模式一致。
     *
     * 藏的是字盒的 `visibility`，不是把字换成空串——柱子的块长由这块字推出来（jumpShape /
     * jumpProject），换了字整条路的排版就跟着变，来回切一次画面要跳一次。
     * 它只跟 display 变，不跟时间变，所以值没动就一个节点都不写。
     */
    const setTextVisible = (visible) => {
        const next = visible !== false;
        if (next === textVisible) return;
        textVisible = next;
        pillars.forEach((entry) => {
            entry.label.style.visibility = next ? '' : 'hidden';
        });
    };

    return {
        root,
        acquirePillar,
        arrange,
        moveCanvas,
        paintPillar,
        paintRunner,
        drawTrail,
        drawImpact,
        paintTranslation,
        setTextVisible,
        dispose: () => {
            root.remove();
            pillars.length = 0;
            trailDots.length = 0;
            trailRings.length = 0;
            arrangeKey = null;
            runner = null;
            translation.state.key = null;
            translation.state.look = null;
        },
    };
};
