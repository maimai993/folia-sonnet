import { create } from 'zustand';
import { collectionKey, type GridViewCollectionDescriptor } from '../components/app/home/gridViewCollectionAdapters';

// src/stores/useCollectionNavigationStore.ts

export type CollectionNavigationOrigin = 'home' | 'search' | 'player';

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
