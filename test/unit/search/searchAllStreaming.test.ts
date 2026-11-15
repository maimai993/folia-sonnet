import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSong } from '@/types';
import type { ProviderPage } from '@/types/onlineMusic';
import { useSearchNavigationStore } from '@/stores/useSearchNavigationStore';

/**
 * 「全部」的流式行为：谁先搜完谁先出，不等最后一家。
 *
 * 单开一个文件是因为要自己接 `omni`（原来那个文件里的用例走 neteaseApi 那条路，
 * 把 omni 换掉会连坐）。
 */
const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getProviderSummaries: () => [{ providerId: 'netease' }, { providerId: 'qq' }],
        getProviderCapabilities: () => ({ search: true }),
        // 搜索种类（v0.7.26 起 submitSearch 会先问一次）：这两家只搜单曲。
        getProviderSearchKinds: () => ['song'],
        searchProviderSongs: searchMock,
    },
}));

vi.mock('@/services/navidromeService', () => ({
    getNavidromeConfig: () => null,
    navidromeApi: { search: vi.fn(), toNavidromeSong: vi.fn() },
}));

const pending = <T>() => {
    let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
    const promise = new Promise<T>((resolve, reject) => {
        settle = { resolve, reject };
    });
    return { promise, ...settle };
};

const song = (name: string, artist = name) => ({
    id: name,
    name,
    artists: [{ id: artist, name: artist }],
    album: { id: 'album', name: 'album' },
    durationMs: 1000,
}) as unknown as UnifiedSong;

const page = (songs: UnifiedSong[], hasMore = false): ProviderPage<UnifiedSong> => ({
    items: songs,
    hasMore,
    nextOffset: songs.length,
});

const deps = {
    localSongs: [],
    t: (_key: string, fallback?: string) => fallback || '',
};

/** 让 store 里那一串 await 都跑完：微任务几轮 + 一个宏任务兜底。 */
const flush = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
};

describe('「全部」搜索是流式的', () => {
    beforeEach(() => {
        searchMock.mockReset();
        useSearchNavigationStore.setState({
            searchQuery: '',
            searchSourceTab: 'all',
            searchResults: null,
            isSearching: false,
            isLoadingMore: false,
            searchError: null,
            requestId: 0,
            offset: 0,
            limit: 30,
            hasMore: false,
            scrollTop: 0,
            searchCache: {},
        });
    });

    it('第一家回来就出结果，不用等第二家', async () => {
        const netease = pending<ProviderPage<UnifiedSong>>();
        const qq = pending<ProviderPage<UnifiedSong>>();
        searchMock.mockImplementation((providerId: string) => (
            providerId === 'netease' ? netease.promise : qq.promise
        ));

        const done = useSearchNavigationStore.getState()
            .submitSearch({ query: 'folio', sourceTab: 'all', deps });
        await flush();
        expect(searchMock).toHaveBeenCalledTimes(2);

        netease.resolve(page([song('a0'), song('a1')], true));
        await flush();

        // 已经有两行，但「还在搜」仍然成立 —— 转圈交给界面按有没有结果来判断。
        const mid = useSearchNavigationStore.getState();
        expect(mid.searchResults?.map(item => item.name)).toEqual(['a0', 'a1']);
        expect(mid.isSearching).toBe(true);
        expect(mid.hasMore).toBe(true);

        qq.resolve(page([song('b0'), song('b1')]));
        await done;
        await flush();

        const end = useSearchNavigationStore.getState();
        expect(end.isSearching).toBe(false);
        // 轮着插：A0 B0 A1 B1，而不是先看完一整页网易云。
        expect(end.searchResults?.map(item => item.name)).toEqual(['a0', 'b0', 'a1', 'b1']);
    });

    it('同一首几家都有时只留先到的那一份', async () => {
        const netease = pending<ProviderPage<UnifiedSong>>();
        const qq = pending<ProviderPage<UnifiedSong>>();
        searchMock.mockImplementation((providerId: string) => (
            providerId === 'netease' ? netease.promise : qq.promise
        ));

        const done = useSearchNavigationStore.getState()
            .submitSearch({ query: 'folio', sourceTab: 'all', deps });
        await flush();

        netease.resolve(page([song('same', 'someone')]));
        qq.resolve(page([song('same', 'someone')]));
        await done;
        await flush();

        expect(useSearchNavigationStore.getState().searchResults?.map(item => item.name))
            .toEqual(['same']);
    });

    it('换了词之后，晚到的那一家不再往新结果里插', async () => {
        const netease = pending<ProviderPage<UnifiedSong>>();
        const qq = pending<ProviderPage<UnifiedSong>>();
        // 只有第一次（folio）挂着不回；换词那次给个空页，好让它先落地。
        searchMock.mockImplementation((providerId: string, query: string) => {
            if (query !== 'folio') return Promise.resolve(page([]));
            return providerId === 'netease' ? netease.promise : qq.promise;
        });

        const first = useSearchNavigationStore.getState()
            .submitSearch({ query: 'folio', sourceTab: 'all', deps });
        await flush();

        // 第一次还没回来就换了词：requestId 变了，旧那批不许再写进来。
        await useSearchNavigationStore.getState()
            .submitSearch({ query: 'other', sourceTab: 'all', deps });
        await flush();

        netease.resolve(page([song('stale')]));
        qq.resolve(page([song('stale-qq')]));
        await first;
        await flush();

        expect(useSearchNavigationStore.getState().searchResults?.map(item => item.name))
            .toEqual([]);
    });
});
