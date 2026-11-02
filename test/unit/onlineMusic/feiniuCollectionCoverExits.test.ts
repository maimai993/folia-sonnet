import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/feiniuCollectionCoverExits.test.ts
// 飞牛「集合」封面要换成原生代理地址才取得到字节（issue #204）：歌单 / 专辑的库列表
// （feiniuLibrary）已经修了，这里看剩下三条出口 —— 电台页签的推荐集合、专辑页、
// 歌手列表 —— 出来的 coverUrl 都必须是换过代理的，并且预热过那批地址。

const requestMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const coverUrlMock = vi.hoisted(() => vi.fn());
const prewarmMock = vi.hoisted(() => vi.fn());
const resolveMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/feiniuTransport', () => ({
    feiniuRequest: requestMock,
    feiniuList: listMock,
    pickFeiniuList: (data: unknown) => (Array.isArray(data) ? data : []),
    pickFeiniuTotal: (data: unknown) => (Array.isArray(data) ? data.length : 0),
    feiniuCoverUrl: coverUrlMock,
    feiniuStreamUrl: vi.fn(() => ''),
    feiniuPasswordLogin: vi.fn(),
    clearFeiniuSession: vi.fn(),
    getFeiniuDeviceId: vi.fn(() => 'device-id'),
    feiniuResourceHeaders: vi.fn(() => null),
    getFeiniuServerUrl: vi.fn(() => ''),
    getFeiniuTransportAvailability: vi.fn(() => ({ state: 'available' })),
    feiniuFnIdFromServerUrl: vi.fn(() => ''),
    readFeiniuUser: vi.fn(() => null),
    rememberFeiniuUser: vi.fn(),
    syncFeiniuGatewayCredentials: vi.fn(),
    feiniuServerUrlFromFnId: vi.fn(() => ''),
    normalizeFeiniuServerUrl: vi.fn(() => ''),
}));

vi.mock('@/services/onlineMusic/onlineCoverFallback', () => ({
    backfillSongCovers: async <T>(songs: T[]) => songs,
    prewarmCollectionCovers: prewarmMock,
    resolveProxiedCollectionCover: resolveMock,
}));

import { feiniuProvider } from '@/services/onlineMusic/feiniuProvider';
import { feiniuAlbumPage, feiniuArtistPage } from '@/services/onlineMusic/feiniuCatalog';

const rawCover = (coverId: string) => `http://nas.lan:5666/music/api/v1/static/cover?coverId=${coverId}&size=480`;

const record = (guid: string, coverId: string) => ({ guid, name: `条目 ${guid}`, coverId, trackCount: 3 });

describe('feiniu collection cover proxy exits', () => {
    beforeEach(() => {
        requestMock.mockReset();
        listMock.mockReset();
        prewarmMock.mockReset().mockResolvedValue(undefined);
        resolveMock.mockReset().mockImplementation((url: string | null | undefined) => (url ? `proxy:${url}` : String(url ?? '')));
        coverUrlMock.mockReset().mockImplementation((coverId?: string | null) => (coverId ? rawCover(coverId) : ''));
    });

    it('电台页签的推荐集合：预热封面并换出代理地址', async () => {
        requestMock.mockResolvedValueOnce([record('p1', 'c1'), record('p2', 'c2')]);

        const collections = await feiniuProvider.recommendations!.getRecommendedCollections!(2);

        expect(requestMock).toHaveBeenCalledWith('/playlist/list', { query: { page: 1, size: 2 } });
        expect(prewarmMock).toHaveBeenCalledWith([rawCover('c1'), rawCover('c2')]);
        expect(resolveMock).toHaveBeenCalledWith(rawCover('c1'));
        expect(collections.map(item => item.coverUrl)).toEqual([`proxy:${rawCover('c1')}`, `proxy:${rawCover('c2')}`]);
    });

    it('推荐集合失败时照旧回空列表，不再叠加封面错误', async () => {
        requestMock.mockRejectedValueOnce(new Error('network'));
        await expect(feiniuProvider.recommendations!.getRecommendedCollections!(5)).resolves.toEqual([]);
        expect(prewarmMock).not.toHaveBeenCalled();
    });

    it('专辑页：预热封面并换出代理地址', async () => {
        listMock.mockResolvedValueOnce({ items: [record('a1', 'c1')], total: 1 });

        const page = await feiniuAlbumPage(0, 20);

        expect(prewarmMock).toHaveBeenCalledWith([rawCover('c1')]);
        expect(page.items.map(item => item.coverUrl)).toEqual([`proxy:${rawCover('c1')}`]);
    });

    it('歌手列表：预热封面并换出代理地址', async () => {
        listMock.mockResolvedValueOnce({ items: [record('r1', 'c1'), record('r2', '')], total: 2 });

        const page = await feiniuArtistPage(0, 20);

        expect(prewarmMock).toHaveBeenCalledWith([rawCover('c1'), '']);
        expect(page.items.map(item => item.coverUrl)).toEqual([`proxy:${rawCover('c1')}`, '']);
    });
});
