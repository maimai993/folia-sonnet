// src/components/collectionOpenMorph/morphGeometry.ts
// 「移形换影」的共享词汇表：它搬运的矩形、各阶段交换的载荷，以及飞行背后的纯几何。
//
// 这个文件不碰 DOM 也不碰 store，所以可以单独单测。放在这里的原因是三处曾经各自抄了
// 一份同样的数学：`reach`（视口对角线）在 overlay / GridView / ArtistGridView 各写一次，
// 确定性抖动的字符串 hash 在 GridView 与 ArtistGridView 各写一次，径向飞入的错峰公式
// 也是两份。抽到这里之后调参只有一个入口，两侧的入场才不会漂移。

export interface CollectionMorphRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 每个形变阶段都认得的矩形集合：卡片外框、封面、标题行，以及它们的文案。
 * `title` 只在「被点击的卡片还没有标题行」时为 null；从真实元素量出来的目标一定有标题。
 */
export interface CollectionMorphGeometry {
    frame: CollectionMorphRect;
    cover: CollectionMorphRect;
    coverUrl: string | null;
    title: CollectionMorphRect | null;
    titleText: string;
}

/** 完整的目标矩形集合：标题一定存在（量自真实元素）。 */
export type CollectionMorphTarget = CollectionMorphGeometry & { title: CollectionMorphRect };

/** Navigation state captured when a click gesture began. */
export interface CollectionMorphNavSnapshot {
    /** Whether a collection snapshot existed when the gesture began. */
    wasOpen: boolean;
    /** Navigation stack depth when the gesture began. */
    depth: number;
}

export interface CollectionMorphPending extends CollectionMorphGeometry {
    /**
     * Stable DOM handle of the clicked card (`grid3d:<index>` for home slider
     * cards, `item:<id>` for detail grid cards). On back-out the home card is
     * re-measured through it, so the reverse flight always lands on the card's
     * CURRENT position even if the home surface re-laid-out while hidden.
     */
    sourceKey: string | null;
    /**
     * Navigation state when this click's gesture began — the pointerdown
     * signature when one preceded the click (a click-driven open changes the
     * nav store only AFTER the click; comparing against the gesture START
     * covers both orderings). The overlay launches a flight only when the
     * CURRENT navigation shows an open this gesture caused; a card click that
     * merely plays/centers never changes the signature and never morphs.
     */
    navAtGestureStart: CollectionMorphNavSnapshot;
    capturedAt: number;
}

export interface CollectionMorphHeroMeasured extends CollectionMorphTarget {
    /**
     * 这个测量来自哪个元素（网格卡片的 item id，或歌手页 intro 的固定标记）。
     * 轮询用它判断「连续两次量到的是同一张卡」—— 网格恢复滚动的那一刻卡片还在滑，
     * 只按「离中心最近」接受目标会让飞行半路改道到一张正在移动的卡上。
     */
    key: string;
    /**
     * False while the hero's cover <img> is still in flight (network/blob
     * decode). The overlay holds its composite over the hero until the cover
     * finished — loaded OR failed — so the reveal never uncovers an empty
     * frame; that wait is what makes the morph a load cover.
     */
    coverReady: boolean;
    /**
     * True when this measurement came from the artist page's circular avatar
     * (see probeArtistIntroTargets): the overlay animates its flying cover's
     * border radius toward a circle for these landings.
     */
    round?: boolean;
}

/**
 * 交给 GridView / ArtistGridView 的入场计划。它同时决定「详情页的 hero 要不要先藏起来」，
 * 所以必须区分两种来源，而不是拿一个恒为 0 的索引当开关：
 *
 * - `morph`：overlay 正用合成层盖在这个 grid 的 hero 位置上（首页卡片展开、嵌套 push
 *   落到新 grid 的 hero），hero 藏起来、等形变淡出时再揭示。
 * - `cascade`：只有卡片级联，没有合成层盖着（从搜索/播放器 origin 进来的 push、嵌套返回
 *   后重新挂载的上一层）。此时 hero 必须立刻可见 —— 藏 340ms 会留下一块空白。
 */
export interface CollectionMorphPlan {
    kind: 'morph' | 'cascade';
}

/** A single surrounding card snapshot for the reverse flight's scatter. */
export interface CollectionMorphSquadGhost {
    rect: CollectionMorphRect;
    coverUrl: string | null;
    titleText: string;
}

/** Reverse-flight payload: hero → home card, armed right before backing out. */
export interface CollectionMorphExit {
    /** Live measurement of the detail hero card the overlay currently covers. */
    from: CollectionMorphHeroMeasured;
    /** The original home card rectangles to morph back onto; null for a nested
     * back (album → playlist), where the hero shrinks into nothing or retargets
     * onto the card this level was pushed from. */
    to: CollectionMorphPending | null;
    /** Every other visible card with its cover + title, captured the instant
     * back is pressed — replayed as real-looking ghost cards that scatter
     * outward, the reverse of the fly-in. */
    squad: CollectionMorphSquadGhost[];
    /** True when this back returns to the previous collection instead of home. */
    nested: boolean;
    /**
     * For nested backs: the sourceKey (`item:<id>`) of the card this level was
     * pushed FROM. The previous grid remounts underneath only AFTER back is
     * pressed, so the destination cannot be measured at arm time — the overlay
     * polls for this card and retargets the hero onto it once it renders.
     * Null when no trustworthy source exists (async push whose capture was
     * discarded): the hero falls back to the in-place shrink.
     */
    sourceKey: string | null;
    armedAt: number;
}

/** 确定性抖动的输入：一次飞入里同时给位移、旋转和延迟用。 */
export interface CollectionMorphFlyIn {
    x: number;
    y: number;
    rotate: number;
    delay: number;
}

// zIndex sits above the detail backdrop (z-[49]) so the flying elements ride in
// front of it while the backdrop fades in underneath. It is below the detail
// grids' own z-index (GridView z-[110] / ArtistGridView z-50) on purpose: the
// overlay is portalled to <body> while the whole home surface sits inside the
// home mount point's `z-10` stacking context, so the composite still paints
// above the detail view. Raising this constant past the home mount point would
// put the flight on top of the app chrome instead.
export const COLLECTION_MORPH_Z_INDEX = 50;
export const COLLECTION_MORPH_MIN_RECT_WIDTH = 48;
export const COLLECTION_MORPH_OBSERVATION_WINDOW_MS = 450;
// A fly-in plan auto-expires after the entrance window so a stale plan can
// never re-trigger entrances on later grid mounts. Generous enough to cover a
// remounting previous grid whose data restore takes a moment. Note that it only
// bounds how long a plan may START an entrance — the overlay's own lifecycle is
// deliberately independent of it (see CollectionMorphOverlay's finishLifecycle).
export const COLLECTION_MORPH_PLAN_TTL_MS = 2400;

/** Card frames closer than this to the viewport centre count as the hero. */
const SQUAD_HERO_EXCLUSION_RADIUS = 100;

/** 视口对角线派生出的飞行距离：保证入场从屏幕外开始。 */
export const collectionMorphReach = (width: number, height: number): number => (
    Math.hypot(width, height) * 0.62 + 160
);

/** 确定性的字符串种子（0..1），跨 render 稳定，所以卡片不会每次重渲染都换一个歪角。 */
export const collectionMorphSeed = (key: string): number => {
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return (hash % 1000) / 1000;
};

/** 反向四散用的矩形种子：整数部分留给 rotate 的正负与档位。 */
export const collectionMorphRectSeed = (rect: CollectionMorphRect): number => (
    ((Math.round(rect.x) * 73856093) ^ (Math.round(rect.y) * 19349663)) >>> 0
);

/**
 * 一张卡片从屏外径向飞入到网格槽位所需的 transform 与错峰。
 *
 * 距离越远启动越晚（ease-out 归一化），再叠加一点确定性抖动，让入场读起来像一次呼吸
 * 的级联而不是机械横扫。`rotate` 限制在 ±3.2°：会歪，但不会看起来是坏的。
 */
export const collectionMorphFlyIn = (
    card: { x: number; y: number },
    origin: { x: number; y: number },
    spacing: number,
    reach: number,
    seed: number,
): CollectionMorphFlyIn => {
    const dx = card.x - origin.x;
    const dy = card.y - origin.y;
    const distance = Math.hypot(dx, dy);
    const direction = distance > 1
        ? { x: dx / distance, y: dy / distance }
        : { x: 0, y: -1 };
    const normalized = Math.min(distance / (spacing * 14), 1);
    const eased = normalized * normalized * (3 - 2 * normalized);
    return {
        x: direction.x * reach,
        y: direction.y * reach,
        rotate: (seed - 0.5) * 6.4,
        delay: Math.min(0.04 + eased * 0.38 + seed * 0.1, 0.46),
    };
};

// FLIP with a center origin: the element renders at its START rect (static
// style) and animates a pure translate+scale onto the destination — a
// compositor-only path, so no frame of the flight forces layout or repaint
// (animating left/top/width/height re-layouts every frame). Center origin
// keeps rotation arcs identical to the pre-FLIP version, and expressing the
// destination as transform VALUES means a mid-flight retarget from the hero
// poll simply hands the springs new numbers to converge on — same curve,
// zero discontinuity.
export const flipTo = (start: CollectionMorphRect, target: CollectionMorphRect) => ({
    x: target.x + target.width / 2 - (start.x + start.width / 2),
    y: target.y + target.height / 2 - (start.y + start.height / 2),
    scaleX: start.width > 0 ? target.width / start.width : 1,
    scaleY: start.height > 0 ? target.height / start.height : 1,
});

// Transform values that pin an element (rendered at its `base` rect) onto the
// on-screen `rect` it occupied at fast-forward time — the compressed replay
// continues from exactly where the spring was, with no rewind to the start.
export const flipFromRect = (rect: CollectionMorphRect, base: CollectionMorphRect) => ({
    x: rect.x + rect.width / 2 - (base.x + base.width / 2),
    y: rect.y + rect.height / 2 - (base.y + base.height / 2),
    scaleX: base.width > 0 ? rect.width / base.width : 1,
    scaleY: base.height > 0 ? rect.height / base.height : 1,
});

// First estimated destination while the track list is still loading: the
// viewport centre sized like the strip's typical centered card.
export const estimateCenterTarget = (viewport: { width: number; height: number }): CollectionMorphRect => {
    const size = Math.min(Math.max(viewport.width * 0.18, 160), 280);
    return {
        x: viewport.width / 2 - size / 2,
        y: viewport.height / 2 - size * 0.58,
        width: size,
        height: size * 1.16,
    };
};

/** 目标卡片是否离视口中心足够近，近到应当算作 hero（反向四散要跳过它）。 */
export const isNearViewportCenter = (
    rect: CollectionMorphRect,
    viewport: { width: number; height: number },
): boolean => {
    const dx = rect.x + rect.width / 2 - viewport.width / 2;
    const dy = rect.y + rect.height / 2 - viewport.height / 2;
    return dx * dx + dy * dy < SQUAD_HERO_EXCLUSION_RADIUS * SQUAD_HERO_EXCLUSION_RADIUS;
};

/**
 * 这次量到的落点和上次是不是「同一张卡、同一个位置」。
 *
 * 网格恢复滚动/焦点是挂载后若干帧才做的：刚挂上时卡片还在滑，只按「离屏幕中心最近」取目标
 * 会让飞行半路改道到一张正在移动的卡上（看起来就是飞行中途拐弯）。要求连续两次是同一个
 * 元素、矩形几乎不动，才允许把它当成落点 —— 用稳定性替代一个拍脑袋的等待毫秒数。
 */
export const isMorphTargetSettled = (
    previous: { key: string; frame: CollectionMorphRect; cover: CollectionMorphRect; title: CollectionMorphRect } | null,
    next: { key: string; frame: CollectionMorphRect; cover: CollectionMorphRect; title: CollectionMorphRect },
    tolerancePx: number,
): boolean => {
    if (!previous) {
        return false;
    }
    // 读不到标识（卡片没带 data 属性）时不当作致命：矩形稳定本身就是很强的证据，
    // 两张不同的卡片不可能在同一帧占据同一个矩形。有无标识都不影响判据。
    if (previous.key && next.key && previous.key !== next.key) {
        return false;
    }
    const near = (a: CollectionMorphRect, b: CollectionMorphRect) => (
        Math.abs(a.x - b.x) < tolerancePx
        && Math.abs(a.y - b.y) < tolerancePx
        && Math.abs(a.width - b.width) < tolerancePx
        && Math.abs(a.height - b.height) < tolerancePx
    );
    return near(previous.frame, next.frame)
        && near(previous.cover, next.cover)
        && near(previous.title, next.title);
};

/**
 * 圆形落点的圆角必须写成 `50%`，不能换算成 px。
 *
 * 形变层渲染在**起点**的盒子里（例如 200×260 的首页卡片），靠 scaleX/scaleY 缩放到目标
 * （例如 240×240 的歌手头像）。百分比圆角是跟着盒子缩放走的：0.5 × 盒宽 × scaleX 恰好等于
 * 0.5 × 目标宽，两个方向都等于目标的一半，所以目标方就是正圆。换成 `min(w,h)/2` px 之后，
 * 圆角作用在起点的盒子上再被非等比缩放，横竖半径变成 (120×1.2, 120×0.923) —— 一个被拉长的
 * 圆角矩形，也就是「白框变成了圆角方框」。
 */
export const MORPH_CIRCLE_RADIUS = '50%';

/** 落回卡片时用的圆角（与 GridView/ArtistGridView 的卡片圆角一致）。 */
export const MORPH_CARD_FRAME_RADIUS = '16px';
export const MORPH_CARD_COVER_RADIUS = '12px';
