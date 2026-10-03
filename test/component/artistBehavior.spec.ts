import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { ProbeCallKind } from '../../dev/probes/libraryBehavior/probeLog';
import type { ArtistFixtureId } from '../../dev/probes/libraryBehavior/fixtureRules';
import type { ProbeFault } from '../../dev/probes/libraryBehavior/fakeProviders';
import {
    ARTIST_ALBUM_PAGE_SIZE,
    artistAlbumIds,
    artistAlbumIdsMatching,
    artistAlbumName,
    isProbeUnavailable,
    LOCAL_ALBUM_NAMES,
    LOCAL_ARTIST_NAME,
    localSongId,
    NAVIDROME_ALBUM_TRACKS,
    NAVIDROME_ARTIST_ALBUMS,
    NAVIDROME_HOME_ARTISTS,
    ONLINE_ARTISTS,
    onlineArtistTarget,
    onlinePlaybackKey,
    onlineSongId,
    PROBE_ALBUM,
    PROBE_PROVIDER_A,
    range,
} from '../../dev/probes/libraryBehavior/fixtureRules';
import '../../dev/probes/libraryBehavior/probeApi';

// test/component/artistBehavior.spec.ts
// 歌手页与它的嵌套入口的行为基线（P4.0；P4.1 起把歌手数据挪进宿主持有的 core 资源，这批用例就是验收）。
//
// 用的是 libraryBehavior 探针页（同一个假宿主、假 provider、Navidrome 垫片、本地 fixture），驱动接口是
// window.__libraryProbe 上的歌手页部分：openArtist / artist() / openArtistAlbum / openArtistPanel，以及故障、
// 延迟、按住应答。artist() 现在从网格歌手页的已提交组件树上读（见 dev/probes/libraryBehavior/artistProbeView.ts），
// 断言只用它给出的语义字段，所以 P4.1 换数据源、P4.3 加 TUI 歌手页之后同一批断言原样成立。
//
// 目前只有网格实现了歌手页（TUI 回退网格，那两条回退用例在 libraryBehavior.spec.ts 里），所以用例标 [grid]。
// test.fixme 记录的是已知缺陷（P4.1 转正）；test.fail 记录的是本分支引入、下一个提交修掉的回归。
//
// 探针页开着 StrictMode，而且歌手页自己的本地曲库 catalog 就绪时会再加载一遍：同一个请求可能出现多次，
// 分页断言看「去重后的 offset 序列」。

const main = ONLINE_ARTISTS['artist-main'];
const guest = ONLINE_ARTISTS['artist-guest'];
const mainTarget = onlineArtistTarget(main);
const guestTarget = onlineArtistTarget(guest);

const topKeys = (rule: typeof main, playableOnly = false) => rule.topSongIndexes
    .filter(index => !playableOnly || !isProbeUnavailable(index))
    .map(index => onlinePlaybackKey(rule.providerId, onlineSongId(rule.topSongPrefix, index)));
const naviKey = (songId: string) => `navidrome:${songId}`;
const naviTopKeys = (artistId: string) => NAVIDROME_ARTIST_ALBUMS[artistId]
    .slice(0, 5)
    .flatMap(albumId => NAVIDROME_ALBUM_TRACKS[albumId])
    .slice(0, 10)
    .map(naviKey);
const localKey = (index: number) => `local:${localSongId(index)}`;

const mountProbe = async (mount: (id: string) => Promise<unknown>, page: Page) => {
    await mount('libraryBehavior');
    await expect.poll(() => page.evaluate(() => window.__libraryProbe?.ready() ?? false)).toBe(true);
};

const openArtist = async (page: Page, id: ArtistFixtureId) => {
    expect(await page.evaluate(fixtureId => window.__libraryProbe!.openArtist(fixtureId), id)).toBe(true);
};
const artist = (page: Page) => page.evaluate(() => window.__libraryProbe!.artist());
const back = (page: Page) => page.evaluate(() => window.__libraryProbe!.back());
const stack = (page: Page) => page.evaluate(() => window.__libraryProbe!.stack());
const topDescriptor = async (page: Page) => (await page.evaluate(() => window.__libraryProbe!.stackDescriptors())).at(-1);
const setQuery = (page: Page, query: string) => page.evaluate(value => window.__libraryProbe!.setQuery(value), query);
const getQuery = (page: Page) => page.evaluate(() => window.__libraryProbe!.getQuery());
const clearLog = (page: Page) => page.evaluate(() => window.__libraryProbe!.clearLog());
const addFault = (page: Page, fault: ProbeFault) => page.evaluate(value => window.__libraryProbe!.addFault(value), fault);
const clearFaults = (page: Page, target?: string) => page.evaluate(value => window.__libraryProbe!.clearFaults(value), target);
const calls = (page: Page, kind: ProbeCallKind) => (
    page.evaluate(callKind => window.__libraryProbe!.calls().filter(call => call.kind === callKind), kind)
);
const lastCall = async (page: Page, kind: ProbeCallKind) => (await calls(page, kind)).at(-1);
const requests = (page: Page, op: string, target?: string) => page.evaluate(([requestOp, requestTarget]) => (
    window.__libraryProbe!.requests().filter(request => (
        request.op === requestOp && (requestTarget === undefined || request.target === requestTarget)
    ))
), [op, target] as const);
const distinctAlbumOffsets = async (page: Page, target: string) => (
    [...new Set((await requests(page, 'artistAlbums', target)).map(request => `${request.offset}+${request.limit}`))]
);
const scopeCount = async (page: Page) => (await page.evaluate(() => window.__libraryProbe!.surface()))?.filteredTrackCount ?? -1;

/** 等歌手页落定：状态是 ready、专辑数到达期望值。 */
const waitForArtist = async (page: Page, albumCount: number, timeout = 15_000) => {
    await expect.poll(async () => {
        const view = await artist(page);
        return view ? `${view.status}:${view.albumIds.length}` : 'none';
    }, { timeout }).toBe(`ready:${albumCount}`);
};

/** 键盘事件要落在 body 上：网格的键盘处理会忽略按钮、输入框里的按键。 */
const pressOnGrid = async (page: Page, key: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(key);
};

const artistLayer = (page: Page) => page.locator('[data-library-surface="artist"]');

/** 记下歌手页上是否出现过空态文案（「No content」）：MutationObserver 能看到只存在一帧的状态。 */
const watchEmptyState = (page: Page) => page.evaluate(() => {
    const flag = window as unknown as { __artistEmptySeen?: boolean };
    flag.__artistEmptySeen = false;
    new MutationObserver(() => {
        if (document.querySelector('[data-library-surface="artist"]')?.textContent?.includes('No content')) {
            flag.__artistEmptySeen = true;
        }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
});
const emptyStateSeen = (page: Page) => page.evaluate(() => Boolean((window as unknown as { __artistEmptySeen?: boolean }).__artistEmptySeen));
const songCard = (page: Page, songId: string) => artistLayer(page).locator(`[data-folia-grid-item-id="${songId}"]`);

test.describe('[grid] online artist', () => {
    test('loads the detail, the top songs and every album page', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);

        const view = (await artist(page))!;
        expect(view.detail).toEqual({ name: main.name, cover: main.coverUrl, hasBio: true });
        expect(view.topSongIds).toEqual(topKeys(main));
        expect(view.playableTopSongIds).toEqual(topKeys(main, true));
        expect(view.albumIds).toEqual(artistAlbumIds(main));
        expect(await distinctAlbumOffsets(page, mainTarget)).toEqual(
            range(Math.ceil(main.albumCount / ARTIST_ALBUM_PAGE_SIZE)).map(index => `${index * ARTIST_ALBUM_PAGE_SIZE}+${ARTIST_ALBUM_PAGE_SIZE}`),
        );
        expect((await requests(page, 'artistSongs', mainTarget)).every(request => request.offset === 0 && request.limit === 10)).toBe(true);
        expect(await stack(page)).toEqual([main.name]);
    });

    test('an album page that fails shows a retry that resumes from the failed offset', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await addFault(page, { op: 'artistAlbums', target: mainTarget, offset: ARTIST_ALBUM_PAGE_SIZE, remaining: 99 });
        await openArtist(page, 'artist-main');
        await expect.poll(async () => {
            const view = await artist(page);
            return view ? `${view.status}:${view.albumIds.length}` : 'none';
        }).toBe(`interrupted:${ARTIST_ALBUM_PAGE_SIZE}`);

        await clearFaults(page, mainTarget);
        await clearLog(page);
        await artistLayer(page).getByRole('button', { name: 'Retry' }).click();
        await waitForArtist(page, main.albumCount);
        expect(await distinctAlbumOffsets(page, mainTarget)).toEqual([`${ARTIST_ALBUM_PAGE_SIZE}+50`, `${ARTIST_ALBUM_PAGE_SIZE * 2}+50`]);
        expect((await artist(page))!.albumIds).toEqual(artistAlbumIds(main));
        // 重试只续专辑：详情与热门歌曲不重新请求。
        expect(await requests(page, 'artistDetail')).toEqual([]);
        expect(await requests(page, 'artistSongs')).toEqual([]);
    });

    test('a slow artist that was left never lands in the next one', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await page.evaluate(target => window.__libraryProbe!.setLatency(target, { first: 1500, rest: 1500 }), mainTarget);
        await openArtist(page, 'artist-main');
        await page.waitForTimeout(100);
        await openArtist(page, 'artist-guest');
        await waitForArtist(page, guest.albumCount);

        // 等 A 的应答真的回来（请求在延迟之后才记账），再看 B 有没有被它改写。
        await expect.poll(() => requests(page, 'artistDetail', mainTarget), { timeout: 10_000 }).not.toEqual([]);
        await page.waitForTimeout(500);
        const view = (await artist(page))!;
        expect(view.detail?.name).toBe(guest.name);
        expect(view.topSongIds).toEqual(topKeys(guest));
        expect(view.albumIds).toEqual(artistAlbumIds(guest));
        expect(await stack(page)).toEqual([guest.name]);
        // 离开的歌手不再翻专辑页。
        expect((await requests(page, 'artistAlbums', mainTarget)).filter(request => (request.offset ?? 0) > 0)).toEqual([]);
    });

    test('album pages of an artist left for a nested one never land in it', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await page.evaluate(target => window.__libraryProbe!.holdPagesOf(target), mainTarget);
        await openArtist(page, 'artist-main');
        await expect.poll(async () => {
            const view = await artist(page);
            return view ? `${view.status}:${view.albumIds.length}` : 'none';
        }).toBe(`syncing:${ARTIST_ALBUM_PAGE_SIZE}`);

        // 热门歌曲 21 带着客座歌手：点卡片上的歌手名压入它的歌手页。
        await songCard(page, onlineSongId(main.topSongPrefix, 21)).getByText(guest.name, { exact: true }).dispatchEvent('click');
        await expect.poll(() => stack(page)).toEqual([main.name, guest.name]);
        expect(await topDescriptor(page)).toEqual({ source: 'online', providerId: PROBE_PROVIDER_A, type: 'artist', id: guest.artistId, name: guest.name });
        await waitForArtist(page, guest.albumCount);

        await page.evaluate(target => window.__libraryProbe!.releasePagesOf(target), mainTarget);
        await page.waitForTimeout(800);
        const view = (await artist(page))!;
        expect(view.detail?.name).toBe(guest.name);
        expect(view.albumIds).toEqual(artistAlbumIds(guest));

        // 返回落回 A：A 的歌手页重新加载完整（现状：没有缓存，重新请求）。
        await back(page);
        await expect.poll(() => stack(page)).toEqual([main.name]);
        await waitForArtist(page, main.albumCount);
        expect((await artist(page))!.detail?.name).toBe(main.name);
    });
});

test.describe('[grid] Navidrome and local artists', () => {
    test('a Navidrome artist loads its albums and the first albums\' songs as top songs', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'navi-artist');
        await waitForArtist(page, NAVIDROME_ARTIST_ALBUMS['navi-ar-1'].length);
        const first = (await artist(page))!;
        expect(first.detail).toMatchObject({ name: NAVIDROME_HOME_ARTISTS[0].name });
        expect(first.albumIds).toEqual(NAVIDROME_ARTIST_ALBUMS['navi-ar-1']);
        expect(first.topSongIds).toEqual(naviTopKeys('navi-ar-1'));
        expect(first.albums.every(album => album.link.source === 'navidrome' && album.link.type === 'album')).toBe(true);

        await back(page);
        await expect(artistLayer(page)).toHaveCount(0);
        await openArtist(page, 'navi-artist-2');
        await waitForArtist(page, NAVIDROME_ARTIST_ALBUMS['navi-ar-2'].length);
        const second = (await artist(page))!;
        expect(second.detail).toMatchObject({ name: NAVIDROME_HOME_ARTISTS[1].name });
        expect(second.albumIds).toEqual(NAVIDROME_ARTIST_ALBUMS['navi-ar-2']);
        expect(second.topSongIds).toEqual(naviTopKeys('navi-ar-2'));
    });

    test('a local artist loads its own songs and albums from the catalog', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'local-artist');
        await waitForArtist(page, LOCAL_ALBUM_NAMES.length);
        const view = (await artist(page))!;
        expect(view.detail).toMatchObject({ name: LOCAL_ARTIST_NAME, hasBio: true });
        expect(view.albums.map(album => album.name)).toEqual([...LOCAL_ALBUM_NAMES]);
        expect(view.albums.every(album => album.link.source === 'local' && album.link.type === 'album')).toBe(true);
        expect(view.topSongIds).toEqual(range(8, 1).map(localKey));
    });

    // 加载期间不出现空态：在线与 Navidrome 现在就是这样（本地那一闪是已知缺陷，见文件末尾的 fixme）。
    for (const [id, albums] of [['artist-main', main.albumCount], ['navi-artist', NAVIDROME_ARTIST_ALBUMS['navi-ar-1'].length]] as const) {
        test(`${id} never shows the empty state while it loads`, async ({ mount, page }) => {
            await mountProbe(mount, page);
            await watchEmptyState(page);
            await openArtist(page, id);
            await waitForArtist(page, albums);
            expect(await emptyStateSeen(page)).toBe(false);
        });
    }
});

test.describe('[grid] filter, play and enqueue', () => {
    test('the filter narrows the albums by name and leaves the top songs alone', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);

        expect(await setQuery(page, 'cedar')).toBe(true);
        await expect.poll(async () => (await artist(page))?.albumIds).toEqual(artistAlbumIdsMatching(main, 'cedar'));
        const view = (await artist(page))!;
        expect(view.query).toBe('cedar');
        expect(view.topSongIds).toEqual(topKeys(main));
        // 筛选只看专辑名：一个只出现在歌名里的词筛不出专辑，热门歌曲也不受影响。
        expect(await setQuery(page, 'track')).toBe(true);
        await expect.poll(async () => (await artist(page))?.albumIds).toEqual([]);
        expect((await artist(page))!.topSongIds).toEqual(topKeys(main));
        expect(await setQuery(page, artistAlbumName(7))).toBe(true);
        await expect.poll(async () => (await artist(page))?.albumIds).toEqual([`${main.albumPrefix}-7`]);
    });

    test('Enter on a top song plays it with the playable top songs as the queue', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);
        await page.waitForTimeout(400);

        await pressOnGrid(page, 'ArrowUp');
        await page.waitForTimeout(400);
        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        const played = (await lastCall(page, 'playSong'))!;
        expect(topKeys(main)).toContain(played.ids[0]);
        expect(played.queueIds).toEqual(topKeys(main, true));
    });

    test('a song card\'s play button plays with the playable top songs; its queue button enqueues through the port', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);
        const songId = onlineSongId(main.topSongPrefix, 22);

        await songCard(page, songId).getByTitle('Play', { exact: true }).dispatchEvent('click');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        expect(await lastCall(page, 'playSong')).toMatchObject({
            ids: [onlinePlaybackKey(PROBE_PROVIDER_A, songId)],
            queueIds: topKeys(main, true),
        });

        await songCard(page, songId).getByTitle('Add to Queue', { exact: true }).dispatchEvent('click');
        await expect.poll(() => calls(page, 'addSongToQueue')).toHaveLength(1);
        expect((await lastCall(page, 'addSongToQueue'))?.ids).toEqual([onlinePlaybackKey(PROBE_PROVIDER_A, songId)]);
    });

    // 正确行为（main 369c34e6：歌手页直接拿应用的 addAllToQueue）：歌手页要求静默，队列不弹自己的提示；
    // 歌手页的提示报的是队列真正收下的条数（队列里已有的不算）。b0bea643 起播放端口的 enqueueAll 丢了
    // { suppressToast: true } 和返回的数量——下一个提交修复，届时去掉 test.fail。
    test('queueing the top songs asks the queue to stay quiet and reports how many it took', async ({ mount, page }) => {
        test.fail(true, 'regression since b0bea643: LibraryPlaybackPort.enqueueAll drops suppressToast and the accepted count');
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);
        const playable = topKeys(main, true);
        await page.evaluate(keys => window.__libraryProbe!.seedQueue(keys), playable.slice(0, 2));
        await clearLog(page);

        await artistLayer(page).getByRole('button', { name: 'Queue top songs' }).click();
        await expect.poll(() => calls(page, 'addAllToQueue')).toHaveLength(1);
        expect(await lastCall(page, 'addAllToQueue')).toMatchObject({ ids: playable, suppressToast: true, accepted: playable.length - 2 });
        await expect.poll(async () => (await calls(page, 'toast')).map(call => call.text)).toEqual([
            `Added ${playable.length - 2} top songs to the play queue`,
        ]);
    });
});

test.describe('[grid] nested opens', () => {
    test('an album card opens the provider album, and going back returns to the artist', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);
        const album = (await artist(page))!.albums[3];
        expect(album.link).toEqual({ source: 'online', providerId: PROBE_PROVIDER_A, type: 'album' });

        expect(await page.evaluate(id => window.__libraryProbe!.openArtistAlbum(id), album.id)).toBe(true);
        await expect.poll(() => stack(page)).toEqual([main.name, artistAlbumName(3)]);
        expect(await topDescriptor(page)).toEqual({ source: 'online', providerId: PROBE_PROVIDER_A, type: 'album', id: album.id, name: album.name });
        await expect(artistLayer(page)).toHaveCount(0);
        await expect.poll(() => requests(page, 'albumTracks', `${PROBE_PROVIDER_A}:album:${album.id}`)).not.toEqual([]);

        await back(page);
        await expect.poll(() => stack(page)).toEqual([main.name]);
        await waitForArtist(page, main.albumCount);
        expect((await artist(page))!.detail?.name).toBe(main.name);
    });

    test('a song card\'s album link opens that album with its tracks', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);

        await songCard(page, onlineSongId(main.topSongPrefix, 22)).getByText(PROBE_ALBUM.name, { exact: true }).dispatchEvent('click');
        await expect.poll(() => stack(page)).toEqual([main.name, PROBE_ALBUM.name]);
        expect(await topDescriptor(page)).toMatchObject({ source: 'online', providerId: PROBE_PROVIDER_A, type: 'album', id: PROBE_ALBUM.id });
        await expect.poll(() => scopeCount(page)).toBe(PROBE_ALBUM.rawIndexes.length);

        await back(page);
        await waitForArtist(page, main.albumCount);
    });

    test('a Navidrome album card opens the Navidrome album', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'navi-artist');
        await waitForArtist(page, NAVIDROME_ARTIST_ALBUMS['navi-ar-1'].length);

        expect(await page.evaluate(() => window.__libraryProbe!.openArtistAlbum('navi-al-3'))).toBe(true);
        await expect.poll(async () => (await topDescriptor(page))?.id).toBe('navi-al-3');
        expect(await topDescriptor(page)).toMatchObject({ source: 'navidrome', type: 'album', id: 'navi-al-3' });
        await expect.poll(() => scopeCount(page)).toBe(NAVIDROME_ALBUM_TRACKS['navi-al-3'].length);

        await back(page);
        await waitForArtist(page, NAVIDROME_ARTIST_ALBUMS['navi-ar-1'].length);
    });

    test('a local album card opens the album entity with its songs', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'local-artist');
        await waitForArtist(page, LOCAL_ALBUM_NAMES.length);
        const beta = (await artist(page))!.albums.find(album => album.name === 'Beta Album')!;

        expect(await page.evaluate(id => window.__libraryProbe!.openArtistAlbum(id), beta.id)).toBe(true);
        await expect.poll(() => stack(page)).toEqual([LOCAL_ARTIST_NAME, 'Beta Album']);
        expect(await topDescriptor(page)).toMatchObject({ source: 'local', type: 'album', id: beta.id, entityId: beta.id });
        await expect.poll(() => scopeCount(page)).toBe(4);

        await back(page);
        await waitForArtist(page, LOCAL_ALBUM_NAMES.length);
    });
});

test.describe('[grid] artist page panels', () => {
    test('editing a local artist opens the host entity dialog', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'local-artist');
        await waitForArtist(page, LOCAL_ALBUM_NAMES.length);

        expect(await page.evaluate(() => window.__libraryProbe!.openArtistPanel('cut-in'))).toBe(true);
        await expect.poll(async () => (await artist(page))?.panels.cutIn).toBe(true);
        await artistLayer(page).getByRole('button', { name: 'Artist Info' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect.poll(async () => (await artist(page))?.panels.cutIn).toBe(false);
    });

    test('an online artist offers no entity editing', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);
        expect(await page.evaluate(() => window.__libraryProbe!.openArtistPanel('cut-in'))).toBe(true);
        await expect.poll(async () => (await artist(page))?.panels.cutIn).toBe(true);
        await expect(artistLayer(page).getByRole('button', { name: 'Artist Info' })).toHaveCount(0);
    });

    test('Escape clears the filter, then closes the album list, then the info panel, then leaves', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'artist-main');
        await waitForArtist(page, main.albumCount);
        expect(await setQuery(page, 'cedar')).toBe(true);
        await expect.poll(async () => (await artist(page))?.albumIds.length).toBe(artistAlbumIdsMatching(main, 'cedar').length);
        expect(await page.evaluate(() => window.__libraryProbe!.openArtistPanel('side'))).toBe(true);
        await expect.poll(async () => (await artist(page))?.panels.sidePanel).toBe(true);

        await pressOnGrid(page, 'Escape');
        await expect.poll(() => getQuery(page)).toBe('');
        expect((await artist(page))!.panels.sidePanel).toBe(true);

        await pressOnGrid(page, 'Escape');
        await expect.poll(async () => (await artist(page))?.panels.sidePanel).toBe(false);

        expect(await page.evaluate(() => window.__libraryProbe!.openArtistPanel('cut-in'))).toBe(true);
        await expect.poll(async () => (await artist(page))?.panels.cutIn).toBe(true);
        await pressOnGrid(page, 'Escape');
        await expect.poll(async () => (await artist(page))?.panels.cutIn).toBe(false);
        expect(await stack(page)).toEqual([main.name]);

        await pressOnGrid(page, 'Escape');
        await expect.poll(() => stack(page)).toEqual([]);
        await expect(artistLayer(page)).toHaveCount(0);
    });
});

// 已知缺陷（P4 现状速记），P4.1 的 core 歌手资源修掉之后转正。每条都在当前代码上确认过会失败。
test.describe('[grid] known artist page defects', () => {
    // ArtistGridView 的 Navidrome 分支在 getArtist 回来之后直接 setArtistInfo，没有比对 generation：
    // 同一个歌手页重新加载（本地曲库刷新会让它重载）时，先发出、晚回来的那次会把旧的详情写回来。
    test.fixme('a late Navidrome artist response from a superseded load does not overwrite the current detail', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await openArtist(page, 'navi-artist');
        await waitForArtist(page, NAVIDROME_ARTIST_ALBUMS['navi-ar-1'].length);
        const renamed = 'Navi Artist Renamed';

        await page.evaluate(() => window.__libraryProbe!.holdNavidrome('getArtist'));
        await clearLog(page);
        // 第一次重载：请求按改名前的上游生成，被按住。
        await page.evaluate(() => window.__libraryProbe!.refreshLocal());
        await expect.poll(() => page.evaluate(() => window.__libraryProbe!.heldNavidrome('getArtist'))).toBeGreaterThan(0);
        const staleCount = await page.evaluate(() => window.__libraryProbe!.heldNavidrome('getArtist'));
        // 上游改名，第二次重载：它的应答先放行。
        await page.evaluate(name => window.__libraryProbe!.renameNavidromeArtist('navi-ar-1', name), renamed);
        await page.evaluate(() => window.__libraryProbe!.refreshLocal());
        await expect.poll(() => page.evaluate(() => window.__libraryProbe!.heldNavidrome('getArtist'))).toBeGreaterThan(staleCount);
        await page.evaluate(() => window.__libraryProbe!.releaseNavidrome('getArtist', 'newest'));
        await expect.poll(async () => (await artist(page))?.detail?.name).toBe(renamed);
        await waitForArtist(page, NAVIDROME_ARTIST_ALBUMS['navi-ar-1'].length);

        // 先发出的那次晚到。
        await page.evaluate(() => window.__libraryProbe!.releaseNavidrome('getArtist', 'all'));
        await page.waitForTimeout(500);
        expect((await artist(page))?.detail?.name).toBe(renamed);
    });

    // 本地歌手页用自己的 catalog 实例，catalog 就绪之前那次加载直接返回，页面先显示空态（「No content」），
    // 就绪后才出内容。正确的表现是加载中，而不是先说「没有内容」。（在线、Navidrome 没有这一闪，见下一条。）
    test.fixme('a local artist never shows the empty state while its catalog is still loading', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await watchEmptyState(page);
        await openArtist(page, 'local-artist');
        await waitForArtist(page, LOCAL_ALBUM_NAMES.length);
        expect(await emptyStateSeen(page)).toBe(false);
    });

    // 详情请求失败时只打 console，页面落到空态（「No content」，即 home.loadingLibrary），没有错误态，也没有重试。
    test.fixme('a failed artist load shows an error state with a retry instead of the empty text', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await addFault(page, { op: 'artistDetail', target: mainTarget, remaining: 99 });
        await openArtist(page, 'artist-main');
        await expect.poll(async () => (await artist(page))?.status, { timeout: 10_000 }).toBe('error');
        await expect(artistLayer(page).getByText('No content')).toHaveCount(0);
        await expect(artistLayer(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    });
});

// 守住探针本身：artist() 读到的是在场的那一层（退场中的歌手页不算）。
test('[grid] the artist view follows the top of the stack', async ({ mount, page }) => {
    await mountProbe(mount, page);
    expect(await artist(page)).toBeNull();
    await openArtist(page, 'artist-guest');
    await waitForArtist(page, guest.albumCount);
    expect((await artist(page))!.name).toBe(guest.name);
    await back(page);
    await expect.poll(() => artist(page)).toBeNull();
    expect(await requests(page, 'artistDetail', guestTarget)).not.toEqual([]);
});
