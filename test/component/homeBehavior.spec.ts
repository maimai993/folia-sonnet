import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { ProbeCallKind } from '../../dev/probes/libraryBehavior/probeLog';
import {
    HOME_FAVORITE_ALBUM_COUNTS,
    HOME_FM_COUNT,
    HOME_FM_PREFIX,
    HOME_PLAYLIST_FIXTURES,
    HOME_RECOMMENDED_COUNTS,
    homeFavoriteAlbumIds,
    homeRecommendedId,
    localSongTitle,
    NAVIDROME_HOME_ALBUMS,
    NAVIDROME_HOME_ARTISTS,
    NAVIDROME_NEWEST_ALBUM_IDS,
    NAVIDROME_RANDOM_SONGS,
    NAVIDROME_RECENT_ALBUM_IDS,
    NAVIDROME_STARRED_SONGS,
    ONLINE_FIXTURES,
    onlinePlaybackKey,
    onlineSongId,
    PROBE_PROVIDER_A,
    PROBE_PROVIDER_B,
} from '../../dev/probes/libraryBehavior/fixtureRules';
import {
    HOME_ALL_SONGS_ID,
    HOME_LOCAL_FOLDER_IDS,
    HOME_LOCAL_IGNORED_FOLDER,
    HOME_LOCAL_PLAYLIST,
    HOME_LOCAL_SONGS,
    homeFolderId,
    homeLocalSongId,
    homeLocalSongIds,
    homeLocalSongsIn,
} from '../../dev/probes/homeBehavior/homeFixtureRules';
import { buildServiceStubModule, LOCAL_MUSIC_SERVICE_ROUTE } from '../../dev/probes/homeBehavior/serviceStubModule';
import type { HomeBatchAction, HomeHiddenView, HomeTabKey } from '../../dev/probes/homeBehavior/probeApi';
import '../../dev/probes/homeBehavior/probeApi';

// test/component/homeBehavior.spec.ts
// 首页与目录（GridMap）的行为回归闸门（Library Core P3 期间每一步都跑，和 libraryBehavior 一起）。
//
// 断言的是语义：宿主收到的集合描述（provider-aware key）、上游请求账、播放 / 入队回调、本地曲库服务调用账
// （经 serviceStubModule 的转接模块记下）、隐藏表。探针接口（window.__homeProbe）按语义命名，当前由网格实现；
// P3.4 给 TUI 首页实现同一套接口后，标题前缀为 `[grid]` 的那批用例改为对两个 suite 参数化。
// `[grid-only]` 的用例点的是网格专属的 DOM（地图按钮、卡片、批量面板按钮、确认框、Escape 阶梯）。
//
// 探针页开着 StrictMode：首页挂载时的请求会出现两次，分页断言看去重后的 offset 序列。
// test.fixme 记录的是现状缺陷，注释里写明由哪一步转正。

const SUITES = ['grid'] as const;
const A = PROBE_PROVIDER_A;
const B = PROBE_PROVIDER_B;

const playlistIds = (providerId: string) => HOME_PLAYLIST_FIXTURES[providerId].map(id => ONLINE_FIXTURES[id].collectionId);
const localKeys = (indexes: readonly number[]) => homeLocalSongIds(indexes).map(id => `local:${id}`);
const localFilePath = (index: number) => {
    const rule = HOME_LOCAL_SONGS.find(song => song.index === index)!;
    return `${rule.folder}/${String(index).padStart(2, '0')} - ${localSongTitle(index)}.mp3`;
};

const mountHome = async (mount: (id: string) => Promise<unknown>, page: Page) => {
    // 本地曲库服务换成转接模块：需要目录句柄的函数走探针替身，其余放行到真实现（都记账）。
    await page.route(LOCAL_MUSIC_SERVICE_ROUTE, route => route.fulfill({
        contentType: 'text/javascript',
        body: buildServiceStubModule(),
    }));
    await mount('homeBehavior');
    await expect.poll(() => page.evaluate(() => window.__homeProbe?.ready() ?? false), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => itemIds(page)).toEqual(['public', 'cloud', 'owned', 'big', 'same']);
};

const setTab = (page: Page, tab: HomeTabKey) => page.evaluate(key => window.__homeProbe!.setTab(key), tab);
const setSection = (page: Page, id: string) => page.evaluate(section => window.__homeProbe!.setSection(section), id);
const activeSection = async (page: Page) => (
    (await page.evaluate(() => window.__homeProbe!.sections())).find(section => section.active)?.id
);
const items = (page: Page) => page.evaluate(() => window.__homeProbe!.items());
const itemIds = async (page: Page) => (await items(page)).map(item => item.id);
const itemById = async (page: Page, id: string) => (await items(page)).find(item => item.id === id);
const visibleIds = (page: Page) => page.evaluate(() => window.__homeProbe!.visibleItems());
const scope = (page: Page) => page.evaluate(() => window.__homeProbe!.scope());
const open = (page: Page, id: string) => page.evaluate(itemId => window.__homeProbe!.open(itemId), id);
const opened = (page: Page) => page.evaluate(() => window.__homeProbe!.opened());
const lastOpened = async (page: Page) => (await opened(page)).at(-1);
const stack = (page: Page) => page.evaluate(() => window.__homeProbe!.stack());
const openMap = (page: Page) => page.evaluate(() => window.__homeProbe!.openMap());
const closeMap = (page: Page) => page.evaluate(() => window.__homeProbe!.closeMap());
const isMapOpen = (page: Page) => page.evaluate(() => window.__homeProbe!.isMapOpen());
const mapItems = (page: Page) => page.evaluate(() => window.__homeProbe!.mapItems());
const mapIds = async (page: Page) => (await mapItems(page)).map(item => item.id);
const setQuery = (page: Page, query: string) => page.evaluate(value => window.__homeProbe!.setQuery(value), query);
const getQuery = (page: Page) => page.evaluate(() => window.__homeProbe!.getQuery());
const openPanel = (page: Page) => page.evaluate(() => window.__homeProbe!.openPanel());
const batchScope = (page: Page) => page.evaluate(() => window.__homeProbe!.batchScope());
const batchSelect = (page: Page, ids: string[], selected = true) => (
    page.evaluate(([itemIdsToSelect, value]) => window.__homeProbe!.batchSelect(itemIdsToSelect, value), [ids, selected] as const)
);
const batchSelectAll = (page: Page, selected = true) => page.evaluate(value => window.__homeProbe!.batchSelectAll(value), selected);
const runBatch = (page: Page, action: HomeBatchAction, arg?: string) => (
    page.evaluate(([batchAction, value]) => window.__homeProbe!.runBatch(batchAction, value), [action, arg] as const)
);
const toggleHidden = (page: Page, id: string) => page.evaluate(itemId => window.__homeProbe!.toggleHidden(itemId), id);
const setHiddenView = (page: Page, view: HomeHiddenView) => page.evaluate(value => window.__homeProbe!.setHiddenView(value), view);
const storedHidden = (page: Page) => page.evaluate(() => window.__homeProbe!.storedHidden());
const switchProvider = (page: Page, providerId: string) => page.evaluate(id => window.__homeProbe!.switchProvider(id), providerId);
const clearLog = (page: Page) => page.evaluate(() => window.__homeProbe!.clearLog());
const calls = (page: Page, kind: ProbeCallKind) => (
    page.evaluate(callKind => window.__homeProbe!.calls().filter(call => call.kind === callKind), kind)
);
const serviceCalls = async (page: Page) => (await calls(page, 'service')).map(call => ({ name: call.key, args: call.detail }));
const requests = (page: Page, op: string, target?: string) => page.evaluate(([requestOp, requestTarget]) => (
    window.__homeProbe!.requests().filter(request => (
        request.op === requestOp && (requestTarget === undefined || request.target === requestTarget)
    ))
), [op, target] as const);
const distinctPages = async (page: Page, op: string, target: string) => (
    [...new Set((await requests(page, op, target)).map(request => `${request.offset}+${request.limit}`))]
);
const localSongIds = (page: Page) => page.evaluate(() => window.__homeProbe!.localSongIds());
const localPlaylists = (page: Page) => page.evaluate(() => window.__homeProbe!.localPlaylists());

/**
 * 关掉打开的集合，并等集合 surface 真正卸载（AnimatePresence 退场期间同一个 key 再进场会复用旧实例）。
 * 先等集合层挂上并稳定一小会儿：打开的同一帧里就关掉会留下一个卡住的透明集合层（见 fixme 用例）。
 */
const closeCollection = async (page: Page) => {
    await expect(page.locator('[data-library-renderer]')).toHaveCount(1);
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__homeProbe!.closeCollection());
    await expect(page.locator('[data-library-renderer]')).toHaveCount(0);
};

/** 打开某个页签 / section 并等列表到位。 */
const showList = async (page: Page, tab: HomeTabKey, section?: string) => {
    await setTab(page, tab);
    if (section) {
        await expect.poll(() => setSection(page, section)).toBe(true);
        await expect.poll(() => activeSection(page)).toBe(section);
    }
    await expect.poll(async () => (await items(page)).length).toBeGreaterThan(0);
};

/** 打开 GridMap 并等它在场；有批量配置时再打开批量面板。 */
const showMap = async (page: Page) => {
    await expect.poll(() => openMap(page)).toBe(true);
    await expect.poll(() => isMapOpen(page)).toBe(true);
    await expect.poll(() => getQuery(page)).toBe('');
};
const showBatch = async (page: Page) => {
    await showMap(page);
    expect(await openPanel(page)).toBe(true);
    await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([]);
};

const hideMap = async (page: Page) => {
    expect(await closeMap(page)).toBe(true);
    await expect.poll(() => isMapOpen(page)).toBe(false);
};

for (const suite of SUITES) {
test.describe(`[${suite}] online tabs`, () => {
    test('the playlist tab lists the account playlists with the cloud drive second', async ({ mount, page }) => {
        await mountHome(mount, page);
        const list = await items(page);
        expect(list.map(item => [item.id, item.type])).toEqual([
            ['public', 'playlist'],
            ['cloud', 'cloud'],
            ['owned', 'playlist'],
            ['big', 'playlist'],
            ['same', 'playlist'],
        ]);
        expect(list.every(item => item.hideable && !item.hidden)).toBe(true);
        expect(await scope(page)).toBe(`online:${A}`);
        expect(await distinctPages(page, 'userPlaylists', `${A}:userPlaylists`)).toEqual(['0+50']);
        expect((await requests(page, 'cloudCollection', `${A}:cloud`)).length).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.__homeProbe!.tabs().map(tab => [tab.key, tab.disabled]))).toEqual([
            ['playlist', false],
            ['radio', false],
            ['albums', false],
            ['local', false],
            ['navidrome', false],
        ]);
    });

    test('favorite albums load every page in upstream order', async ({ mount, page }) => {
        await mountHome(mount, page);
        await setTab(page, 'albums');
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(A));
        expect(HOME_FAVORITE_ALBUM_COUNTS[A]).toBe(120);
        expect(await distinctPages(page, 'userAlbums', `${A}:userAlbums`)).toEqual(['0+50', '50+50', '100+50']);
        expect((await items(page)).every(item => item.type === 'album' && !item.hideable)).toBe(true);
    });

    test('the favorite-albums refresh event re-reads the list from the first page', async ({ mount, page }) => {
        await mountHome(mount, page);
        await setTab(page, 'albums');
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(A));
        await clearLog(page);

        await page.evaluate(() => window.dispatchEvent(new Event('folia-refresh-favorite-albums')));
        await expect.poll(() => distinctPages(page, 'userAlbums', `${A}:userAlbums`)).toEqual(['0+50', '50+50', '100+50']);
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(A));
    });

    test('the radio tab puts Personal FM and Daily Recommendations ahead of the recommended playlists', async ({ mount, page }) => {
        await mountHome(mount, page);
        await setTab(page, 'radio');
        const expected = [
            ['personal_fm', 'radio'],
            ['daily_recommendations', 'daily_recommendations'],
            ...Array.from({ length: HOME_RECOMMENDED_COUNTS[A] }, (_, index) => [homeRecommendedId(A, index), 'playlist']),
        ];
        await expect.poll(async () => (await items(page)).map(item => [item.id, item.type])).toEqual(expected);
        expect((await itemById(page, 'daily_recommendations'))?.trackCount).toBe(ONLINE_FIXTURES['online-daily'].rawIndexes.length);
        for (const op of ['personalFm', 'dailySongs', 'recommendedCollections']) {
            expect((await requests(page, op)).length, op).toBeGreaterThan(0);
        }
    });

    test('opening a playlist, an album and the daily recommendations hands the host provider-aware descriptors', async ({ mount, page }) => {
        await mountHome(mount, page);
        expect(await open(page, 'owned')).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`online:${A}:playlist:owned`);
        expect(await lastOpened(page)).toMatchObject({ source: 'online', providerId: A, type: 'playlist', id: 'owned', name: 'Owned Playlist' });
        await expect.poll(() => stack(page)).toEqual(['Owned Playlist']);
        await closeCollection(page);

        await setTab(page, 'albums');
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(A));
        expect(await open(page, homeFavoriteAlbumIds(A)[3])).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`online:${A}:album:${homeFavoriteAlbumIds(A)[3]}`);
        await closeCollection(page);

        await setTab(page, 'radio');
        await expect.poll(() => itemIds(page)).toContain('daily_recommendations');
        expect(await open(page, 'daily_recommendations')).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key)
            .toBe(`online:${A}:daily_recommendations:daily_recommendations`);
        expect(await opened(page)).toHaveLength(3);
    });

    test('Personal FM plays straight away and opens no collection', async ({ mount, page }) => {
        await mountHome(mount, page);
        await setTab(page, 'radio');
        await expect.poll(() => itemIds(page)).toContain('personal_fm');
        await clearLog(page);

        expect(await open(page, 'personal_fm')).toBe(true);
        const fmKeys = Array.from({ length: HOME_FM_COUNT }, (_, index) => onlinePlaybackKey(A, onlineSongId(HOME_FM_PREFIX, index)));
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        expect((await calls(page, 'playSong'))[0]).toMatchObject({ ids: [fmKeys[0]], queueIds: fmKeys, isFm: true });
        expect(await requests(page, 'personalFm', `${A}:fm`)).toHaveLength(1);
        expect(await opened(page)).toEqual([]);
        expect(await stack(page)).toEqual([]);
    });

    // 现状缺陷（不属于 P3 的某一步，宿主 / 网格转场；建议 P3.5 收尾时单独修）：从首页打开集合后，在集合层挂上的
    // 同一帧里就关掉（导航栈刚出现就清掉），集合层的退场永远完成不了——它停在 opacity 0、仍是 fixed inset-0 z-[110]，
    // 挡住首页中央的点击。稍等几十毫秒再关就正常（closeCollection 因此先等 250ms）。复现率与歌单有关（big 不复现）。
    test.fixme('closing a collection in the frame it opened does not leave an invisible layer over the home', async ({ mount, page }) => {
        await mountHome(mount, page);
        expect(await open(page, 'owned')).toBe(true);
        await expect.poll(() => stack(page)).toEqual(['Owned Playlist']);
        await page.evaluate(() => window.__homeProbe!.closeCollection());
        await expect(page.locator('[data-library-renderer]')).toHaveCount(0);
    });

    test('the same playlist id under two providers opens two different collections', async ({ mount, page }) => {
        await mountHome(mount, page);
        expect(await open(page, 'same')).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`online:${A}:playlist:same`);
        await closeCollection(page);

        expect(await switchProvider(page, B)).toBe(true);
        await expect.poll(() => itemIds(page)).toEqual(playlistIds(B));
        expect(await scope(page)).toBe(`online:${B}`);
        expect(await open(page, 'same')).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`online:${B}:playlist:same`);
        expect((await opened(page)).map(descriptor => descriptor.name)).toEqual(['Same Id (A)', 'Same Id (B)']);
    });
});

test.describe(`[${suite}] provider switch`, () => {
    test('a slow favorite-albums response from the previous provider never lands in the new list', async ({ mount, page }) => {
        await mountHome(mount, page);
        await page.evaluate(target => window.__homeProbe!.setLatency(target, { first: 1500 }), `${A}:userAlbums`);
        await setTab(page, 'albums');
        await page.waitForTimeout(200);

        expect(await switchProvider(page, B)).toBe(true);
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(B));
        // A 的首页应答在切换之后才回来（omni 按 provider / generation 丢弃它）；之后列表仍是 B 的。
        await expect.poll(() => requests(page, 'userAlbums', `${A}:userAlbums`), { timeout: 5_000 }).toHaveLength(1);
        await page.waitForTimeout(500);
        expect(await itemIds(page)).toEqual(homeFavoriteAlbumIds(B));
    });

    // 现状缺陷（P3.3 修，转正）：收藏专辑 / 电台的加载 effect 先于「切 provider 清空」的 effect 执行，判断
    // `favoriteAlbums.length === 0` 时读到的还是上一个 provider 的列表，于是不加载；随后清空 effect 把列表
    // 置空，依赖不再变化，新 provider 的收藏专辑一直不出现（直到切走页签再切回来）。
    test.fixme('switching provider after the albums tab has loaded shows the new provider\'s albums', async ({ mount, page }) => {
        await mountHome(mount, page);
        await setTab(page, 'albums');
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(A));

        expect(await switchProvider(page, B)).toBe(true);
        await expect.poll(() => itemIds(page)).toEqual(homeFavoriteAlbumIds(B));
    });

    // 同一个缺陷的电台版本（P3.3 修，转正）。
    test.fixme('switching provider after the radio tab has loaded shows the new provider\'s feed', async ({ mount, page }) => {
        await mountHome(mount, page);
        await setTab(page, 'radio');
        await expect.poll(() => itemIds(page)).toContain(homeRecommendedId(A, 0));

        expect(await switchProvider(page, B)).toBe(true);
        await expect.poll(() => itemIds(page)).toContain(homeRecommendedId(B, 0));
    });
});

test.describe(`[${suite}] local tab`, () => {
    test('the four sections list folders (with the virtual All Songs), albums, artists and playlists', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        expect(await page.evaluate(() => window.__homeProbe!.sections())).toEqual([
            { id: 'folders', active: true },
            { id: 'albums', active: false },
            { id: 'artists', active: false },
            { id: 'playlists', active: false },
        ]);
        expect(await scope(page)).toBe('local');

        const folders = await items(page);
        expect(folders.map(item => item.id)).toEqual(HOME_LOCAL_FOLDER_IDS);
        expect(folders.every(item => item.type === 'folder' && !item.hideable)).toBe(true);
        expect(folders[0].trackIds).toEqual(homeLocalSongIds(HOME_LOCAL_SONGS.map(song => song.index)));
        for (const folder of ['Extra', 'Music/Alpha', 'Music/Alpha/Live', 'Music/Beta']) {
            expect(folders.find(item => item.id === homeFolderId(folder))?.trackIds, folder).toEqual(homeLocalSongIds(homeLocalSongsIn(folder)));
        }

        const grouped = (rows: { name: string; trackIds?: string[] }[]) => Object.fromEntries(
            rows.map(row => [row.name, [...(row.trackIds ?? [])].sort()]),
        );
        const byField = (field: 'album' | 'artist') => {
            const result: Record<string, string[]> = {};
            HOME_LOCAL_SONGS.forEach(song => {
                (result[song[field]] ??= []).push(homeLocalSongId(song.index));
            });
            Object.values(result).forEach(ids => ids.sort());
            return result;
        };

        await showList(page, 'local', 'albums');
        expect((await items(page)).every(item => item.type === 'album' && !item.hideable)).toBe(true);
        expect(grouped(await items(page))).toEqual(byField('album'));

        await showList(page, 'local', 'artists');
        expect((await items(page)).every(item => item.type === 'artist' && !item.hideable)).toBe(true);
        expect(grouped(await items(page))).toEqual(byField('artist'));

        await showList(page, 'local', 'playlists');
        const playlists = await items(page);
        // 「我喜欢」是本地曲库自带的收藏歌单（读歌单时自动建出），排在自建歌单前面。
        expect(playlists.map(item => [item.name, item.type, item.hideable])).toEqual([
            ['Liked Songs', 'playlist', true],
            [HOME_LOCAL_PLAYLIST.name, 'playlist', true],
        ]);
        expect(playlists[0].trackIds).toEqual([]);
        expect(playlists[1].trackIds).toEqual(homeLocalSongIds(HOME_LOCAL_PLAYLIST.songs));
    });

    test('opening local entries hands the host local descriptors (All Songs is virtual)', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        expect(await open(page, HOME_ALL_SONGS_ID)).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`local:folder:${HOME_ALL_SONGS_ID}`);
        expect(await lastOpened(page)).toMatchObject({
            source: 'local',
            type: 'folder',
            isVirtual: true,
            songIds: homeLocalSongIds(HOME_LOCAL_SONGS.map(song => song.index)),
        });
        await closeCollection(page);

        expect(await open(page, homeFolderId('Music/Beta'))).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`local:folder:${homeFolderId('Music/Beta')}`);
        expect((await lastOpened(page))?.songIds).toEqual(homeLocalSongIds(homeLocalSongsIn('Music/Beta')));
        await closeCollection(page);

        await showList(page, 'local', 'albums');
        const album = (await items(page)).find(item => item.name === 'Alpha Album')!;
        expect(await open(page, album.id)).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`local:album:${album.id}`);
        expect((await lastOpened(page))?.entityId).toBe(album.id);
        await closeCollection(page);

        await showList(page, 'local', 'playlists');
        const playlist = (await items(page)).find(item => item.name === HOME_LOCAL_PLAYLIST.name)!;
        expect(await open(page, playlist.id)).toBe(true);
        await expect.poll(async () => (await lastOpened(page))?.key).toBe(`local:playlist:${playlist.id}`);
        expect((await lastOpened(page))?.songIds).toEqual(homeLocalSongIds(HOME_LOCAL_PLAYLIST.songs));
    });
});

test.describe(`[${suite}] navidrome tab`, () => {
    test('sections come from the overview requests, with virtual Random and Favorites playlists', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'navidrome');
        expect(await activeSection(page)).toBe('albums');
        expect(await scope(page)).toBe('navidrome');
        expect(await itemIds(page)).toEqual(NAVIDROME_HOME_ALBUMS.map(album => album.id));

        await showList(page, 'navidrome', 'recently-added');
        expect(await itemIds(page)).toEqual(NAVIDROME_NEWEST_ALBUM_IDS);
        await showList(page, 'navidrome', 'recently-played');
        expect(await itemIds(page)).toEqual(NAVIDROME_RECENT_ALBUM_IDS);
        await showList(page, 'navidrome', 'artists');
        expect(await itemIds(page)).toEqual(NAVIDROME_HOME_ARTISTS.map(artist => artist.id));

        await showList(page, 'navidrome', 'playlists');
        const playlists = await items(page);
        expect(playlists.map(item => [item.id, item.type, item.hideable])).toEqual([
            ['__navi_random__', 'playlist', true],
            ['__navi_favorites__', 'playlist', true],
            ['navi-pl-1', 'playlist', true],
            ['navi-pl-2', 'playlist', true],
        ]);
        expect(playlists[0].trackCount).toBe(NAVIDROME_RANDOM_SONGS.length);
        expect(playlists[1].trackCount).toBe(NAVIDROME_STARRED_SONGS.length);

        expect([...new Set((await requests(page, 'getAlbumList2')).map(request => `${request.target}:${request.offset}+${request.limit}`))])
            .toEqual(['alphabeticalByName:0+500', 'newest:0+500', 'recent:0+500']);
        for (const op of ['getPlaylists', 'getArtists', 'getRandomSongs', 'getStarred2']) {
            expect((await requests(page, op)).length, op).toBeGreaterThan(0);
        }
    });

    test('opening Navidrome entries resolves album, random, favorites, playlist and artist descriptors', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'navidrome');
        const openAndClose = async (id: string, key: string) => {
            expect(await open(page, id)).toBe(true);
            await expect.poll(async () => (await lastOpened(page))?.key).toBe(key);
            await closeCollection(page);
        };
        await openAndClose('navi-al-1', 'navidrome:album:navi-al-1');
        await showList(page, 'navidrome', 'playlists');
        await openAndClose('__navi_random__', 'navidrome:random:__navi_random__');
        await openAndClose('__navi_favorites__', 'navidrome:favorites:__navi_favorites__');
        await openAndClose('navi-pl-1', 'navidrome:playlist:navi-pl-1');
        expect(await lastOpened(page)).toMatchObject({ editable: true });
        await showList(page, 'navidrome', 'artists');
        await openAndClose('navi-ar-1', 'navidrome:artist:navi-ar-1');
    });

    test('the last section is remembered under folia_navidrome_last_section across remounts', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'navidrome', 'playlists');
        expect(await page.evaluate(() => localStorage.getItem('folia_navidrome_last_section'))).toBe('playlists');

        await page.evaluate(() => window.__homeProbe!.remount());
        await expect.poll(() => activeSection(page)).toBe('playlists');
        await expect.poll(() => itemIds(page)).toContain('__navi_random__');
    });
});

test.describe(`[${suite}] directory filter`, () => {
    test('the query filters the map by name or path; every term has to match; empty shows all', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showMap(page);
        expect(await mapIds(page)).toEqual(HOME_LOCAL_FOLDER_IDS);

        expect(await setQuery(page, 'alpha')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual([homeFolderId('Music/Alpha'), homeFolderId('Music/Alpha/Live')]);
        expect(await setQuery(page, 'music live')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual([homeFolderId('Music/Alpha/Live')]);
        expect(await setQuery(page, 'nothing-matches')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual([]);
        expect(await setQuery(page, '')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual(HOME_LOCAL_FOLDER_IDS);
        // 筛选只作用于地图：滑条上的列表不变。
        expect(await visibleIds(page)).toEqual(HOME_LOCAL_FOLDER_IDS);
    });

    test('closing the map drops the query; reopening starts unfiltered', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        expect(await setQuery(page, 'owned')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual(['owned']);

        await hideMap(page);
        await expect.poll(() => getQuery(page)).toBeNull();
        await showMap(page);
        expect(await mapIds(page)).toEqual(['public', 'cloud', 'owned', 'big', 'same']);
    });
});

test.describe(`[${suite}] directory batch`, () => {
    test('the batch scope starts empty and follows card order, not click order', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        expect(await batchScope(page)).toMatchObject({
            selectionType: 'folders',
            itemIds: [],
            trackIds: [],
            totalItemCount: HOME_LOCAL_FOLDER_IDS.length,
            actions: ['play', 'enqueue', 'create-playlist', 'remove', 'rescan-root', 'remove-root', 'clear-ignore'],
        });

        await batchSelect(page, [homeFolderId('Music/Beta')]);
        await batchSelect(page, [homeFolderId('Extra')]);
        const expectedTracks = homeLocalSongIds([...homeLocalSongsIn('Extra'), ...homeLocalSongsIn('Music/Beta')]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Extra'), homeFolderId('Music/Beta')]);
        expect((await batchScope(page))?.trackIds).toEqual(expectedTracks);

        await clearLog(page);
        expect(await runBatch(page, 'play')).toBe(true);
        expect(await runBatch(page, 'enqueue')).toBe(true);
        expect((await calls(page, 'playAll')).map(call => call.ids)).toEqual([expectedTracks.map(id => `local:${id}`)]);
        expect((await calls(page, 'addAllToQueue')).map(call => call.ids)).toEqual([expectedTracks.map(id => `local:${id}`)]);

        await batchSelect(page, [homeFolderId('Extra')], false);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Music/Beta')]);
    });

    test('overlapping selections are de-duplicated and keep the first occurrence', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await batchSelect(page, [homeFolderId('Music/Alpha'), HOME_ALL_SONGS_ID]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([HOME_ALL_SONGS_ID, homeFolderId('Music/Alpha')]);
        expect((await batchScope(page))?.trackIds).toEqual(homeLocalSongIds(HOME_LOCAL_SONGS.map(song => song.index)));

        await clearLog(page);
        await runBatch(page, 'play');
        expect((await calls(page, 'playAll'))[0].ids).toEqual(localKeys(HOME_LOCAL_SONGS.map(song => song.index)));
    });

    test('select-all takes only the filtered cards, and the selection outlives the query', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await setQuery(page, 'alpha');
        await expect.poll(() => mapIds(page)).toEqual([homeFolderId('Music/Alpha'), homeFolderId('Music/Alpha/Live')]);

        await batchSelectAll(page);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Music/Alpha'), homeFolderId('Music/Alpha/Live')]);
        expect(await batchScope(page)).toMatchObject({
            trackIds: homeLocalSongIds([...homeLocalSongsIn('Music/Alpha'), ...homeLocalSongsIn('Music/Alpha/Live')]),
            totalItemCount: 2,
        });

        await setQuery(page, '');
        await expect.poll(async () => (await batchScope(page))?.totalItemCount).toBe(HOME_LOCAL_FOLDER_IDS.length);
        expect((await batchScope(page))?.itemIds).toEqual([homeFolderId('Music/Alpha'), homeFolderId('Music/Alpha/Live')]);

        await batchSelectAll(page, false);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([]);
    });

    test('create playlist writes a local playlist with the scope\'s songs in order', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await batchSelect(page, [homeFolderId('Music/Beta'), homeFolderId('Extra')]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toHaveLength(2);
        await clearLog(page);

        expect(await runBatch(page, 'create-playlist', 'Batch Mix')).toBe(true);
        expect(await calls(page, 'refreshLocalSongs')).toHaveLength(1);
        await expect.poll(async () => (await localPlaylists(page)).find(playlist => playlist.name === 'Batch Mix')?.songIds)
            .toEqual(homeLocalSongIds([...homeLocalSongsIn('Extra'), ...homeLocalSongsIn('Music/Beta')]));

        await hideMap(page);
        await showList(page, 'local', 'playlists');
        await expect.poll(async () => (await items(page)).map(item => item.name)).toContain('Batch Mix');
    });

    test('albums and artists offer play, enqueue and create playlist only; playlists have no batch', async ({ mount, page }) => {
        await mountHome(mount, page);
        for (const section of ['albums', 'artists'] as const) {
            await showList(page, 'local', section);
            await showBatch(page);
            expect(await batchScope(page)).toMatchObject({ selectionType: section, actions: ['play', 'enqueue', 'create-playlist'] });
            expect(await page.evaluate(() => window.__homeProbe!.directoryNodes())).toEqual([]);
            await hideMap(page);
        }
        await showList(page, 'local', 'playlists');
        expect(await page.evaluate(() => window.__homeProbe!.batchAvailable())).toBe(false);
        await showList(page, 'local', 'albums');
        await showBatch(page);
        const [first, second] = await mapIds(page);
        await batchSelect(page, [second, first]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([first, second]);
    });

    test('removing a folder whose subfolders are not selected deletes only its own songs', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await batchSelect(page, [homeFolderId('Music/Alpha')]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Music/Alpha')]);
        await clearLog(page);

        expect(await runBatch(page, 'remove')).toBe(true);
        expect(await serviceCalls(page)).toEqual([
            { name: 'deleteSongsByIds', args: [homeLocalSongIds(homeLocalSongsIn('Music/Alpha'))] },
        ]);
        await expect.poll(() => localSongIds(page)).toEqual(homeLocalSongIds([4, 5, 6, 7, 8]));
    });

    test('removing a folder together with all its subfolders removes the top folder', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await batchSelect(page, [homeFolderId('Music/Alpha'), homeFolderId('Music/Alpha/Live')]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toHaveLength(2);
        await clearLog(page);

        expect(await runBatch(page, 'remove')).toBe(true);
        expect(await serviceCalls(page)).toEqual([
            { name: 'deleteFolderSongs', args: ['Music/Alpha'] },
            { name: 'deleteSongsByIds', args: [homeLocalSongIds([1, 2, 3, 4, 5])] },
        ]);
        await expect.poll(() => localSongIds(page)).toEqual(homeLocalSongIds([6, 7, 8]));
        // 删掉的子目录在扫描快照里记为忽略，目录树里能「恢复并重扫」。
        await expect.poll(async () => (await page.evaluate(() => window.__homeProbe!.directoryNodes()))
            .find(node => node.path === 'Music/Alpha')?.ignored).toBe(true);
    });

    test('All Songs is never removed as a folder; its songs are removed by id', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await batchSelect(page, [HOME_ALL_SONGS_ID]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([HOME_ALL_SONGS_ID]);
        await clearLog(page);

        expect(await runBatch(page, 'remove')).toBe(true);
        expect(await serviceCalls(page)).toEqual([
            { name: 'deleteSongsByIds', args: [homeLocalSongIds(HOME_LOCAL_SONGS.map(song => song.index))] },
        ]);
        await expect.poll(() => localSongIds(page)).toEqual([]);
    });

    test('a fully selected top-level folder is removed through its root path', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await batchSelect(page, [homeFolderId('Extra')]);
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Extra')]);
        await clearLog(page);

        expect(await runBatch(page, 'remove')).toBe(true);
        expect(await serviceCalls(page)).toEqual([
            { name: 'deleteFolderSongs', args: ['Extra'] },
            { name: 'deleteSongsByIds', args: [homeLocalSongIds(homeLocalSongsIn('Extra'))] },
        ]);
        await expect.poll(() => localSongIds(page)).toEqual(homeLocalSongIds([1, 2, 3, 4, 5, 6, 7]));
        await expect.poll(async () => (await page.evaluate(() => window.__homeProbe!.directoryNodes())).map(node => node.path))
            .not.toContain('Extra');
    });

    test('rescan root, remove root and clear ignore reach their services and refresh the library', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        expect((await page.evaluate(() => window.__homeProbe!.directoryNodes())).filter(node => node.depth === 0).map(node => node.path))
            .toEqual(['Extra', 'Music']);
        expect((await page.evaluate(() => window.__homeProbe!.directoryNodes())).find(node => node.path === HOME_LOCAL_IGNORED_FOLDER)?.ignored)
            .toBe(true);
        await clearLog(page);

        expect(await runBatch(page, 'rescan-root', 'Music')).toBe(true);
        expect(await serviceCalls(page)).toEqual([{ name: 'resyncFolder', args: ['Music'] }]);
        expect(await calls(page, 'refreshLocalSongs')).toHaveLength(1);
        await clearLog(page);

        expect(await runBatch(page, 'clear-ignore', HOME_LOCAL_IGNORED_FOLDER)).toBe(true);
        expect(await serviceCalls(page)).toEqual([{ name: 'clearFolderIgnore', args: [HOME_LOCAL_IGNORED_FOLDER] }]);
        expect(await calls(page, 'refreshLocalSongs')).toHaveLength(1);
        await clearLog(page);

        expect(await runBatch(page, 'remove-root', 'Music')).toBe(true);
        expect((await serviceCalls(page))[0]).toEqual({ name: 'removeImportedRoot', args: ['Music'] });
        expect(await calls(page, 'refreshLocalSongs')).toHaveLength(1);
        await expect.poll(() => localSongIds(page)).toEqual(homeLocalSongIds(homeLocalSongsIn('Extra')));
    });
});

test.describe(`[${suite}] hidden items`, () => {
    test('a hidden playlist leaves the slider, the map and map search; unhiding restores it', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        expect(await toggleHidden(page, 'owned')).toBe(true);

        await expect.poll(() => visibleIds(page)).toEqual(['public', 'cloud', 'big', 'same']);
        expect(await itemById(page, 'owned')).toMatchObject({ hidden: true, hideable: true });
        await expect.poll(() => mapIds(page)).toEqual(['public', 'cloud', 'big', 'same']);
        expect(await storedHidden(page)).toEqual({ [`online:${A}`]: ['owned'] });
        await setQuery(page, 'owned');
        await expect.poll(() => mapIds(page)).toEqual([]);
        await setQuery(page, '');

        expect(await toggleHidden(page, 'owned')).toBe(true);
        await expect.poll(() => visibleIds(page)).toEqual(['public', 'cloud', 'owned', 'big', 'same']);
        await expect.poll(() => mapIds(page)).toEqual(['public', 'cloud', 'owned', 'big', 'same']);
        expect(await storedHidden(page)).toEqual({ [`online:${A}`]: [] });
    });

    test('a hidden card cannot be opened from the slider', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        await toggleHidden(page, 'owned');
        await expect.poll(() => visibleIds(page)).not.toContain('owned');
        await hideMap(page);
        expect(await open(page, 'owned')).toBe(false);
        expect(await opened(page)).toEqual([]);
    });

    test('the manage view shows everything with hidden flags, or only the hidden ones', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        await toggleHidden(page, 'owned');
        await toggleHidden(page, 'big');
        await expect.poll(() => mapIds(page)).toEqual(['public', 'cloud', 'same']);

        expect(await setHiddenView(page, 'manage')).toBe(true);
        await expect.poll(async () => (await mapItems(page)).map(item => [item.id, item.hidden])).toEqual([
            ['public', false],
            ['cloud', false],
            ['owned', true],
            ['big', true],
            ['same', false],
        ]);
        expect(await setHiddenView(page, 'manage-hidden-only')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual(['owned', 'big']);
        expect(await setHiddenView(page, 'browse')).toBe(true);
        await expect.poll(() => mapIds(page)).toEqual(['public', 'cloud', 'same']);
    });

    test('hidden ids are scoped per provider, local library and Navidrome', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        await toggleHidden(page, 'same');
        await expect.poll(() => visibleIds(page)).not.toContain('same');
        await hideMap(page);

        expect(await switchProvider(page, B)).toBe(true);
        await expect.poll(() => itemIds(page)).toEqual(playlistIds(B));
        expect(await visibleIds(page)).toEqual(['same']);
        expect(await itemById(page, 'same')).toMatchObject({ hidden: false });

        await showList(page, 'local', 'playlists');
        const localPlaylists = await items(page);
        const localPlaylistId = localPlaylists.find(item => item.name === HOME_LOCAL_PLAYLIST.name)!.id;
        await showMap(page);
        expect(await toggleHidden(page, localPlaylistId)).toBe(true);
        await expect.poll(() => visibleIds(page)).toEqual(localPlaylists.filter(item => item.id !== localPlaylistId).map(item => item.id));
        await hideMap(page);

        await showList(page, 'navidrome', 'playlists');
        await showMap(page);
        expect(await toggleHidden(page, '__navi_random__')).toBe(true);
        await expect.poll(() => visibleIds(page)).toEqual(['__navi_favorites__', 'navi-pl-1', 'navi-pl-2']);
        await hideMap(page);

        expect(await storedHidden(page)).toEqual({
            [`online:${A}`]: ['same'],
            local: [localPlaylistId],
            navidrome: ['__navi_random__'],
        });

        await setTab(page, 'playlist');
        expect(await switchProvider(page, A)).toBe(true);
        await expect.poll(() => visibleIds(page)).toEqual(['public', 'cloud', 'owned', 'big']);
    });

    test('hiding survives a remount; folders, albums and artists cannot be hidden', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        await toggleHidden(page, 'owned');
        await expect.poll(() => visibleIds(page)).not.toContain('owned');
        await hideMap(page);

        await page.evaluate(() => window.__homeProbe!.remount());
        await expect.poll(() => itemIds(page)).toEqual(['public', 'cloud', 'owned', 'big', 'same']);
        await expect.poll(() => visibleIds(page)).toEqual(['public', 'cloud', 'big', 'same']);

        for (const section of ['folders', 'albums', 'artists']) {
            await showList(page, 'local', section);
            await showMap(page);
            const [first] = await mapIds(page);
            expect(await toggleHidden(page, first), section).toBe(false);
            await hideMap(page);
        }
        expect(await storedHidden(page)).toEqual({ [`online:${A}`]: ['owned'] });
    });

    test('batch-capable sections have nothing hideable and hideable lists have no batch', async ({ mount, page }) => {
        await mountHome(mount, page);
        expect(await page.evaluate(() => window.__homeProbe!.batchAvailable())).toBe(false);
        for (const section of ['folders', 'albums', 'artists']) {
            await showList(page, 'local', section);
            expect(await page.evaluate(() => window.__homeProbe!.batchAvailable()), section).toBe(true);
            expect((await items(page)).some(item => item.hideable), section).toBe(false);
        }
        await showList(page, 'navidrome', 'playlists');
        expect(await page.evaluate(() => window.__homeProbe!.batchAvailable())).toBe(false);
    });
});

test.describe(`[${suite}] imports`, () => {
    test('folder import calls the import service and refreshes the library', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await clearLog(page);

        expect(await page.evaluate(() => window.__homeProbe!.runAction('import-folder'))).toBe(true);
        await expect.poll(() => serviceCalls(page)).toEqual([{ name: 'importFolder', args: [] }]);
        await expect.poll(() => calls(page, 'refreshLocalSongs')).toHaveLength(1);
        await expect.poll(() => itemIds(page)).toContain(homeFolderId('Imported'));
    });

    test('refresh re-syncs all roots and refreshes the library', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await clearLog(page);

        expect(await page.evaluate(() => window.__homeProbe!.runAction('refresh-folders'))).toBe(true);
        await expect.poll(() => serviceCalls(page)).toEqual([{ name: 'resyncAllFolders', args: [] }]);
        await expect.poll(() => calls(page, 'refreshLocalSongs')).toHaveLength(1);
    });

    test('a playlist file import creates a playlist from matching paths and reports the result', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local', 'playlists');
        await clearLog(page);
        const importFile = (name: string, lines: string[]) => page.evaluate(
            ([fileName, text]) => window.__homeProbe!.importPlaylistFile(fileName, text),
            [name, ['#EXTM3U', ...lines].join('\n')] as const,
        );

        expect(await importFile('road.m3u8', ['#PLAYLIST:Road Trip', localFilePath(6), localFilePath(1)])).toBe(true);
        expect((await calls(page, 'statusMessage')).map(call => call.status)).toEqual(['success']);
        expect((await calls(page, 'statusMessage'))[0].text).toContain('Road Trip');
        expect(await calls(page, 'refreshLocalSongs')).toHaveLength(1);
        await expect.poll(async () => (await localPlaylists(page)).find(playlist => playlist.name === 'Road Trip')?.songIds)
            .toEqual(homeLocalSongIds([6, 1]));
        await expect.poll(async () => (await items(page)).map(item => item.name)).toContain('Road Trip');
        await clearLog(page);

        expect(await importFile('partial.m3u8', ['#PLAYLIST:Partial', localFilePath(2), 'Missing/nowhere.mp3'])).toBe(true);
        expect((await calls(page, 'statusMessage')).map(call => call.status)).toEqual(['info']);
        await clearLog(page);

        expect(await importFile('none.m3u8', ['Missing/nowhere.mp3'])).toBe(true);
        expect((await calls(page, 'statusMessage')).map(call => call.status)).toEqual(['error']);
        expect(await calls(page, 'refreshLocalSongs')).toHaveLength(0);
    });
});
}

test.describe('[grid-only] directory interactions', () => {
    test('the map button opens GridMap; Escape clears the query before it closes the map', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await page.getByRole('button', { name: 'All', exact: true }).click();
        await expect.poll(() => isMapOpen(page)).toBe(true);
        await expect.poll(() => getQuery(page)).toBe('');

        await setQuery(page, 'alpha');
        await expect.poll(() => mapIds(page)).toHaveLength(2);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('Escape');
        await expect.poll(() => getQuery(page)).toBe('');
        expect(await isMapOpen(page)).toBe(true);
        await page.keyboard.press('Escape');
        await expect.poll(() => isMapOpen(page)).toBe(false);
    });

    test('in batch mode the tree checkbox and a card click select, and the panel button plays the scope', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showMap(page);
        await page.locator('button[class*="group/grid-title"]').click();
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([]);

        await page.locator('button[role="checkbox"][title="Music/Beta"]').click();
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Music/Beta')]);
        // 卡片在批量面板下面露出的部分不一定能点到中心：直接派发 click（卡片的 onClick 就是批选切换）。
        await page.locator('[data-ponder-page-scope="local-grid-map-page"] .theme-polaroid-card', { hasText: 'Extra' }).dispatchEvent('click');
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Extra'), homeFolderId('Music/Beta')]);

        await clearLog(page);
        await page.getByRole('button', { name: 'Play 3 songs' }).click();
        await expect.poll(async () => (await calls(page, 'playAll')).map(call => call.ids))
            .toEqual([localKeys([...homeLocalSongsIn('Extra'), ...homeLocalSongsIn('Music/Beta')])]);
    });

    test('removing from the panel and removing a root both ask for confirmation first', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showList(page, 'local');
        await showBatch(page);
        await page.locator('button[role="checkbox"][title="Music/Beta"]').click();
        await expect.poll(async () => (await batchScope(page))?.itemIds).toEqual([homeFolderId('Music/Beta')]);
        await clearLog(page);

        await page.getByRole('button', { name: 'Remove from library' }).click();
        await page.waitForTimeout(300);
        expect(await serviceCalls(page)).toEqual([]);
        await page.getByRole('button', { name: 'Remove from library' }).last().click();
        await expect.poll(() => serviceCalls(page)).toEqual([
            { name: 'deleteFolderSongs', args: ['Music/Beta'] },
            { name: 'deleteSongsByIds', args: [homeLocalSongIds(homeLocalSongsIn('Music/Beta'))] },
        ]);
        await clearLog(page);

        await page.locator('button[title="Remove imported root"]').first().click();
        await page.waitForTimeout(300);
        expect(await serviceCalls(page)).toEqual([]);
        await page.getByRole('button', { name: 'Remove imported root' }).last().click();
        await expect.poll(async () => (await serviceCalls(page))[0]).toEqual({ name: 'removeImportedRoot', args: ['Extra'] });
    });

    test('the eye button on a card hides it while the hide editor is on', async ({ mount, page }) => {
        await mountHome(mount, page);
        await showMap(page);
        expect(await setHiddenView(page, 'manage')).toBe(true);
        await page.locator('.theme-polaroid-card', { hasText: 'Owned Playlist' }).getByTitle('Hide playlist').click();
        await expect.poll(() => storedHidden(page)).toEqual({ [`online:${A}`]: ['owned'] });
        await expect.poll(async () => (await mapItems(page)).find(item => item.id === 'owned')?.hidden).toBe(true);
        expect(await visibleIds(page)).not.toContain('owned');
    });
});
