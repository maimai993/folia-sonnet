import type { GridItem } from './polaroidCardParts';

// src/components/folia-grid/gridViewRestore.ts
// 「这个网格恢复后会聚焦到哪张卡片」的唯一真源。
//
// 这条规则现在有两个消费者：恢复滚动/焦点的 effect，和移形换影入场的 hero 判定（扇形的
// 放射原点必须是真正被居中的那张卡，从 index 0 放射会让整个级联歪掉）。两处各写一遍的
// 后果是它们对 searchQuery / focusedTrackId 的处理会慢慢分叉，而分叉的表现只是「偶尔歪
// 一点」，不会报错。所以索引解析放在这里，各自的时序守卫留在各自调用点。

export type StoredGridViewNavigationState = {
    focusedIndex: number;
    focusedTrackId?: string | number;
    dragX: number;
    dragY: number;
    searchQuery: string;
};

/** 持久化状态里决定焦点的那几个字段；sessionStorage 里读到的是不完整的 JSON。 */
export type StoredFocusFields = Pick<Partial<StoredGridViewNavigationState>, 'focusedIndex' | 'focusedTrackId'>;

/**
 * 解出恢复后的焦点索引，必然落在 `[0, items.length - 1]`；无法确定时返回 -1。
 *
 * 优先用 `focusedTrackId`（曲目可能在两次会话之间重排/增删，索引会漂），回退到
 * `focusedIndex` 并夹紧。注意它**不**判断 searchQuery：过滤生效之前 items 还是未过滤的
 * 全集，只有调用方知道自己是否已经等到过滤应用（见 GridView 的两个调用点）。
 */
export const resolveStoredFocusIndex = (
    stored: StoredFocusFields | null | undefined,
    items: GridItem[],
): number => {
    if (!stored || items.length === 0) {
        return -1;
    }
    const trackIndex = stored.focusedTrackId === undefined
        ? -1
        : items.findIndex((item) => String(item.rawTrack?.id) === String(stored.focusedTrackId));
    const raw = trackIndex >= 0
        ? trackIndex
        : (Number.isFinite(stored.focusedIndex) ? Number(stored.focusedIndex) : 0);
    const clamped = Math.max(0, Math.min(raw, items.length - 1));
    return Number.isFinite(clamped) ? clamped : -1;
};

/**
 * 首次定位（把相机放到介绍卡上）只允许发生一次，而且必须没有会话要恢复。
 *
 * 为什么需要单独一条判据：触发它的 effect 依赖 `items.length`，而歌手页的专辑列表是
 * **分页追加**的 —— 用户点开某张卡、相机已经移过去之后，下一页数据落地会改变 length，
 * effect 再跑一次就把相机瞬移回介绍卡（表现就是「点完卡片过一会自己跳回歌手介绍」）。
 * 所以这里看的是「定位过没有」，而不是 length 变没变。
 *
 * `restoreApplied` 为真时也不该再定位：那一刻相机位置来自 sessionStorage，覆盖它等于把
 * 用户上次的浏览位置丢掉。
 */
export const shouldApplyInitialGridFocus = (state: {
    itemCount: number;
    /** 已经做过一次初始定位。 */
    hasAppliedInitialFocus: boolean;
    /** 会话恢复已经应用。 */
    restoreApplied: boolean;
    /** 有待恢复的会话但还没应用（例如过滤条件还没到位）。 */
    restorePending: boolean;
}): boolean => (
    state.itemCount > 0
    && !state.hasAppliedInitialFocus
    && !state.restoreApplied
    && !state.restorePending
);
