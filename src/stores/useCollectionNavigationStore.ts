import { create } from 'zustand';
import type { CollectionNavigationOrigin, GridViewCollectionDescriptor } from '../library/core/contracts/collection';
import { collectionKey } from '../library/core/model/collectionIdentity';

// src/stores/useCollectionNavigationStore.ts
// 集合的导航栈（根集合从哪里打开、压了几层）。弹栈有两条路：应用内返回（宿主先让 suite 安排转场，再走历史后退）
// 与浏览器后退（popstate 直接恢复历史里的栈）。后者绕过宿主，所以弹栈在这里有一个「将要弹栈」的通知
// （notifyCollectionPop）：历史后退与没有历史记录时的返回在改 store 之前调用它，宿主据此让 suite 跑 beforeBack。

export type { CollectionNavigationOrigin };

export type CollectionNavigationSnapshot = {
    origin: CollectionNavigationOrigin;
    stack: GridViewCollectionDescriptor[];
};

type CollectionNavigationState = {
    snapshot: CollectionNavigationSnapshot | null;
    openRoot: (collection: GridViewCollectionDescriptor, origin: CollectionNavigationOrigin) => CollectionNavigationSnapshot;
    push: (collection: GridViewCollectionDescriptor) => CollectionNavigationSnapshot | null;
    restore: (snapshot: CollectionNavigationSnapshot | null) => void;
    clear: () => void;
};

export const useCollectionNavigationStore = create<CollectionNavigationState>((set, get) => ({
    snapshot: null,
    openRoot: (collection, origin) => {
        const snapshot = { origin, stack: [collection] };
        set({ snapshot });
        return snapshot;
    },
    push: (collection) => {
        const current = get().snapshot;
        if (!current) {
            return null;
        }
        // 已经在看的那一层不再压一份副本。
        //
        // 详情页里的卡片带着「自己所属的那个集合」的入口：专辑详情的曲目卡片有专辑链接、
        // 歌手页的曲目卡片有歌手链接。它们指的就是当前这一层，照旧压栈的话每点一次就多一层
        // 一模一样的视图 —— 画面看着没变，返回却要按好几次才退得出去（浏览器历史也一起被塞满）。
        // 拦在这里而不是各个调用点：所有 push 都经过这一处，漏一条分支就会重现。
        const active = current.stack[current.stack.length - 1];
        if (active && collectionKey(active) === collectionKey(collection)) {
            return null;
        }
        const snapshot = {
            ...current,
            stack: [...current.stack, collection],
        };
        set({ snapshot });
        return snapshot;
    },
    restore: (snapshot) => set({ snapshot }),
    clear: () => set({ snapshot: null }),
}));

export const getActiveGridViewCollection = (
    snapshot: CollectionNavigationSnapshot | null,
): GridViewCollectionDescriptor | null => snapshot?.stack[snapshot.stack.length - 1] || null;

/** 「将要弹栈」的监听者：from 是弹栈前的快照（store 此刻仍是它），to 是弹完之后的（null 表示整个关掉）。 */
export type CollectionPopListener = (from: CollectionNavigationSnapshot, to: CollectionNavigationSnapshot | null) => void;

const popListeners = new Set<CollectionPopListener>();

/** 订阅「将要弹栈」，返回注销函数。 */
export const subscribeCollectionPop = (listener: CollectionPopListener): (() => void) => {
    popListeners.add(listener);
    return () => {
        popListeners.delete(listener);
    };
};

/**
 * to 是不是 from 弹掉若干层之后的样子：整个关掉，或者同一个根、更浅、而且每一层都是原来那一层。
 * 前进（压栈）、换成别的集合、只换视图（栈不变）都不算。
 */
export const isCollectionPop = (
    from: CollectionNavigationSnapshot | null,
    to: CollectionNavigationSnapshot | null,
): from is CollectionNavigationSnapshot => {
    if (!from || from.stack.length === 0) return false;
    if (!to) return true;
    return to.origin === from.origin
        && to.stack.length < from.stack.length
        && to.stack.every((collection, index) => collectionKey(collection) === collectionKey(from.stack[index]));
};

/**
 * 在 store 弹栈之前调用（历史后退的 popstate、没有历史记录时的应用内返回、探针的「浏览器后退」）：
 * 当前快照到 to 是一次弹栈时通知监听者。监听者在 store 还没变的时候运行，界面也还是弹栈前的样子。
 */
export const notifyCollectionPop = (to: CollectionNavigationSnapshot | null): void => {
    const from = useCollectionNavigationStore.getState().snapshot;
    if (!isCollectionPop(from, to)) return;
    popListeners.forEach(listener => listener(from, to));
};
