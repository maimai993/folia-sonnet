import { beforeEach, describe, expect, it } from 'vitest';
import {
    getActiveGridViewCollection,
    useCollectionNavigationStore,
} from '@/stores/useCollectionNavigationStore';
import type { GridViewCollectionDescriptor } from '@/components/app/home/gridViewCollectionAdapters';

// test/unit/stores/collectionNavigationStore.test.ts
// 导航栈「不许压一份当前层的副本」这条规则：详情页里的卡片带着自己所属集合的入口
// （专辑详情的曲目卡片有专辑链接、歌手页有歌手链接），照旧压栈的话每点一次多一层，
// 画面没变但返回要按好几次才退得出去。

const album = (id: string | number): GridViewCollectionDescriptor => ({
    source: 'online',
    providerId: 'netease',
    id,
    name: `Album ${id}`,
    type: 'album',
} as unknown as GridViewCollectionDescriptor);

const artist = (id: string | number): GridViewCollectionDescriptor => ({
    source: 'online',
    providerId: 'netease',
    id,
    name: `Artist ${id}`,
    type: 'artist',
} as unknown as GridViewCollectionDescriptor);

describe('collection navigation store', () => {
    beforeEach(() => {
        useCollectionNavigationStore.setState({ snapshot: null });
    });

    it('pushes a different collection onto the stack', () => {
        useCollectionNavigationStore.getState().openRoot(album('a1'), 'home');
        const snapshot = useCollectionNavigationStore.getState().push(artist('ar1'));

        expect(snapshot?.stack).toHaveLength(2);
        expect(getActiveGridViewCollection(snapshot)?.type).toBe('artist');
    });

    // 回归点：专辑详情里点曲目卡片上的专辑链接 = 点自己。
    it('refuses to stack a copy of the collection already being viewed', () => {
        useCollectionNavigationStore.getState().openRoot(album('a1'), 'home');
        const pushed = useCollectionNavigationStore.getState().push(album('a1'));

        // null 表示「什么都没发生」：调用方（useAppNavigation）据此不再写一条浏览器历史。
        expect(pushed).toBeNull();
        expect(useCollectionNavigationStore.getState().snapshot?.stack).toHaveLength(1);
    });

    it('compares ids as strings, because one path may carry a number and another a string', () => {
        useCollectionNavigationStore.getState().openRoot(album(42), 'home');
        expect(useCollectionNavigationStore.getState().push(album('42'))).toBeNull();
    });

    it('still pushes a different type or a different source that happens to share the id', () => {
        useCollectionNavigationStore.getState().openRoot(album('shared'), 'home');

        expect(useCollectionNavigationStore.getState().push(artist('shared'))?.stack).toHaveLength(2);
        useCollectionNavigationStore.getState().push({
            source: 'local',
            id: 'shared',
            name: 'Local',
            type: 'album',
        } as unknown as GridViewCollectionDescriptor);
        expect(useCollectionNavigationStore.getState().snapshot?.stack).toHaveLength(3);
    });

    // 有意只拦「当前这一层」：跳到栈里更早访问过的专辑仍然算一次正常导航，
    // 把它改成「弹回那一层」会连带丢掉中间层级，是另一件事。
    it('still allows navigating to a collection that sits deeper in the stack', () => {
        useCollectionNavigationStore.getState().openRoot(album('a1'), 'home');
        useCollectionNavigationStore.getState().push(album('a2'));

        expect(useCollectionNavigationStore.getState().push(album('a1'))?.stack).toHaveLength(3);
    });

    it('does nothing without an open root', () => {
        expect(useCollectionNavigationStore.getState().push(album('a1'))).toBeNull();
    });
});
