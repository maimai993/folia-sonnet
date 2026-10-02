import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { GridSurfaceActionId } from '../../src/types/gridCommandSurface';
import type { ProbeCallKind } from '../../dev/probes/libraryBehavior/probeLog';
import type { ProbeFixtureId } from '../../dev/probes/libraryBehavior/fixtureRules';
import {
    expectedLoadedIndexes,
    expectedPlayableIndexes,
    LOCAL_SORT_ORDERS,
    localSongId,
    ONLINE_FIXTURES,
    onlinePlaybackKey,
    onlineSongId,
    PROBE_ALBUM,
    PROBE_PROVIDER_A,
    PROBE_PROVIDER_B,
} from '../../dev/probes/libraryBehavior/fixtureRules';
import '../../dev/probes/libraryBehavior/probeApi';

// test/component/libraryBehavior.spec.ts
// 集合详情的行为回归闸门（Library Core 重构期间每一步都跑）。
//
// 断言的是语义，不是像素：上游请求账（假 provider / Navidrome 垫片）、宿主收到的播放与入队回调、
// 以及命令面板同一条通道读到的 surface 状态。这样换 renderer 时，同一批场景可以原样再跑一遍。
//
// 探针页开着 StrictMode，挂载 effect 会跑两遍，所以首页请求可能出现两次：分页断言看「去重后的
// offset 序列」，不数总次数。test.fixme 记录的是已知缺陷，修它的那一步把它转正。

const fixture = ONLINE_FIXTURES;
const keysOf = (providerId: string, prefix: string, indexes: number[]) => (
    indexes.map(index => onlinePlaybackKey(providerId, onlineSongId(prefix, index)))
);
const bigKeys = (query = '') => keysOf(
    PROBE_PROVIDER_A,
    'big',
    expectedPlayableIndexes(expectedLoadedIndexes(fixture['online-big'].rawIndexes), query),
);
const localKey = (index: number) => `local:${localSongId(index)}`;
const cardSelector = (itemKey: string, occurrence = 0) => `[data-folia-grid-item-id="${itemKey}-${occurrence}"]`;

const mountProbe = async (mount: (id: string) => Promise<unknown>, page: Page) => {
    await mount('libraryBehavior');
    await expect.poll(() => page.evaluate(() => window.__libraryProbe?.ready() ?? false)).toBe(true);
};

const open = (page: Page, id: ProbeFixtureId) => page.evaluate(fixtureId => window.__libraryProbe!.open(fixtureId), id);
const back = (page: Page) => page.evaluate(() => window.__libraryProbe!.back());
const stack = (page: Page) => page.evaluate(() => window.__libraryProbe!.stack());
const surface = (page: Page) => page.evaluate(() => window.__libraryProbe!.surface());
const scopeCount = async (page: Page) => (await surface(page))?.filteredTrackCount ?? -1;
const runSurface = (page: Page, action: GridSurfaceActionId) => (
    page.evaluate(id => window.__libraryProbe!.runSurface(id), action)
);
const setQuery = (page: Page, query: string) => page.evaluate(value => window.__libraryProbe!.setQuery(value), query);
const getQuery = (page: Page) => page.evaluate(() => window.__libraryProbe!.getQuery());
const clearLog = (page: Page) => page.evaluate(() => window.__libraryProbe!.clearLog());
const calls = (page: Page, kind: ProbeCallKind) => (
    page.evaluate(callKind => window.__libraryProbe!.calls().filter(call => call.kind === callKind), kind)
);
const lastCall = async (page: Page, kind: ProbeCallKind) => (await calls(page, kind)).at(-1);
const requests = (page: Page, op: string, target?: string) => page.evaluate(([requestOp, requestTarget]) => (
    window.__libraryProbe!.requests().filter(request => (
        request.op === requestOp && (requestTarget === undefined || request.target === requestTarget)
    ))
), [op, target] as const);
const distinctOffsets = async (page: Page, target: string) => (
    [...new Set((await requests(page, 'playlistTracks', target)).map(request => `${request.offset}+${request.limit}`))]
);

/** 等某个集合加载完成：surface 里的可播放数量到达期望值。 */
const waitForScope = (page: Page, count: number, timeout = 15_000) => (
    expect.poll(() => scopeCount(page), { timeout }).toBe(count)
);

/** 读当前 play-filtered 会交给播放器的歌（通过真实 surface 动作）。 */
const playFilteredIds = async (page: Page) => {
    expect(await runSurface(page, 'play-filtered')).toBe(true);
    return (await lastCall(page, 'playAll'))?.ids ?? [];
};

/**
 * 返回并等上一层真正卸载。AnimatePresence 退场期间如果同一个 key 再次进场，会直接复用那个正在
 * 退场的实例（不重新挂载、不重新加载），所以「退出再进」的场景必须等它走完。
 */
const backAndSettle = async (page: Page) => {
    await back(page);
    await expect(page.locator('[data-ponder-page-scope="grid-view-page"]')).toHaveCount(0);
};

/**
 * 等筛选真正提交到网格上。surface 读到的可能是还没提交的那次（可打断的）渲染：这时按键会落在旧网格上，
 * 随后「筛选变化回到第一张」又把焦点拉回去。以一张不在筛选结果里的卡消失为准。
 */
const waitForFilteredGrid = async (page: Page, hiddenKey: string) => {
    await expect(page.locator(cardSelector(hiddenKey))).toHaveCount(0);
    await page.waitForTimeout(300);
};

/** 键盘事件要落在 body 上：网格的键盘处理会忽略按钮、输入框里的按键。 */
const pressOnGrid = async (page: Page, key: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(key);
};

test.describe('online paging and cache', () => {
    test('opens with a 150-track first page and fills the rest in the background', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);

        expect(await distinctOffsets(page, 'probe-a:playlist:big')).toEqual(['0+150', '150+1000']);
        expect(await playFilteredIds(page)).toEqual(bigKeys());
        expect(await stack(page)).toEqual(['Big Playlist']);
    });

    test('keeps first-page duplicates and de-duplicates later pages by playback key', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-dupes');
        const expected = keysOf(
            PROBE_PROVIDER_A,
            'dupes',
            expectedPlayableIndexes(expectedLoadedIndexes(fixture['online-dupes'].rawIndexes)),
        );
        await waitForScope(page, expected.length);
        expect(await playFilteredIds(page)).toEqual(expected);
    });

    test('re-entering a cached playlist makes no track requests', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await backAndSettle(page);
        await clearLog(page);

        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await page.waitForTimeout(500);
        expect(await requests(page, 'playlistTracks')).toEqual([]);
    });

    test('reload bypasses the cache and starts again from the first page', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await expect.poll(async () => (await surface(page))?.availableActions.includes('reload-online-collection')).toBe(true);
        await clearLog(page);

        expect(await runSurface(page, 'reload-online-collection')).toBe(true);
        await expect.poll(() => distinctOffsets(page, 'probe-a:playlist:big')).toEqual(['0+150', '150+1000']);
        await waitForScope(page, bigKeys().length);
    });

    test('a page that fails once is retried and the playlist completes', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-flaky');
        const expected = expectedPlayableIndexes(fixture['online-flaky'].rawIndexes);
        await waitForScope(page, expected.length);

        const atOffset = (await requests(page, 'playlistTracks', 'probe-a:playlist:flaky')).filter(request => request.offset === 150);
        expect(atOffset.map(request => request.outcome)).toEqual(['error', 'ok']);
    });

    test('an interrupted background sync shows a retry that resumes from the failed offset', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-broken');
        const firstPage = expectedPlayableIndexes(fixture['online-broken'].rawIndexes.slice(0, 150));
        await waitForScope(page, firstPage.length);

        // 1 次首发 + 3 次退避（0.5s / 1.5s / 4s）后才算中断。
        const retry = page.getByRole('button', { name: /Interrupted at 150 \/ 400\s*Retry/ });
        await expect(retry).toBeVisible({ timeout: 15_000 });
        await clearLog(page);

        await retry.click();
        await waitForScope(page, expectedPlayableIndexes(fixture['online-broken'].rawIndexes).length);
        const resumed = await requests(page, 'playlistTracks', 'probe-a:playlist:broken');
        expect(resumed[0]?.offset).toBe(150);
        await expect(retry).toBeHidden();
    });

    test('a private playlist says so instead of showing an empty grid; an empty one shows no error', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-private');
        await expect(page.getByText('This playlist is not public, so the current music source cannot read its contents')).toBeVisible();
        expect(await scopeCount(page)).toBe(0);

        await back(page);
        await open(page, 'online-empty');
        await expect.poll(() => requests(page, 'playlistTracks', 'probe-a:playlist:empty')).not.toEqual([]);
        await expect(page.getByText('No content')).toBeVisible();
        await expect(page.getByText(/not public|Failed to load/)).toHaveCount(0);
    });

    test('a slow first page from a closed playlist never lands in the next one', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-slow');
        await page.waitForTimeout(100);
        await back(page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await page.waitForTimeout(1_500);

        expect(await stack(page)).toEqual(['Big Playlist']);
        const ids = await playFilteredIds(page);
        expect(ids.some(id => id.includes(':slow-'))).toBe(false);
        expect(ids).toEqual(bigKeys());
    });

    // P1.3 之前：首页在网格卸载之后才返回时，补页循环自己换了一代，卸载时的取消拦不住它，
    // 关掉的歌单会在后台继续分页并写缓存。现在请求归属在资源上，释放即停。
    test('closing a playlist before its first page lands stops all further paging', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-slow');
        await page.waitForTimeout(300);
        await back(page);
        await page.waitForTimeout(4_000);
        const later = (await requests(page, 'playlistTracks', 'probe-a:playlist:slow')).filter(request => (request.offset ?? 0) > 0);
        expect(later).toEqual([]);
    });
});

test.describe('filter, play and enqueue', () => {
    test('the filter scope drives play-filtered and enqueue-filtered, and skips unavailable songs', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);

        for (const query of ['cedar', 'amber', 'guest', 'second', 'kite', '译名', 'track 1', 'probe artist']) {
            expect(await setQuery(page, query)).toBe(true);
            await waitForScope(page, bigKeys(query).length);
            expect((await surface(page))?.isFilterActive).toBe(true);
            expect(await playFilteredIds(page)).toEqual(bigKeys(query));
        }

        await setQuery(page, 'cedar');
        await waitForScope(page, bigKeys('cedar').length);
        expect(await runSurface(page, 'enqueue-filtered')).toBe(true);
        expect((await lastCall(page, 'addAllToQueue'))?.ids).toEqual(bigKeys('cedar'));

        await setQuery(page, '');
        await waitForScope(page, bigKeys().length);
        expect((await surface(page))?.isFilterActive).toBe(false);
    });

    test('Enter plays the focused card with the filtered songs as the queue', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await setQuery(page, 'cedar');
        await waitForScope(page, bigKeys('cedar').length);
        await waitForFilteredGrid(page, onlinePlaybackKey(PROBE_PROVIDER_A, 'big-0'));

        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        const played = await lastCall(page, 'playSong');
        expect(played?.ids).toEqual([bigKeys('cedar')[0]]);
        expect(played?.queueIds).toEqual(bigKeys('cedar'));
    });

    test('[grid] a side-panel row plays with the unfiltered playable list as the queue', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await setQuery(page, 'cedar');
        await waitForScope(page, bigKeys('cedar').length);

        expect(await runSurface(page, 'toggle-track-list')).toBe(true);
        const panel = page.locator('[data-testid="side-panel-list"]');
        await panel.getByText('Track 7 Cedar', { exact: true }).click();
        const played = await lastCall(page, 'playSong');
        expect(played?.ids).toEqual([onlinePlaybackKey(PROBE_PROVIDER_A, 'big-7')]);
        // 现状：侧栏忽略筛选，队列是整张歌单的可播放曲目。
        expect(played?.queueIds).toEqual(bigKeys());
    });

    test('[grid] the card queue button routes online, local and Navidrome songs to their own enqueue path', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        const onlineKey = onlinePlaybackKey(PROBE_PROVIDER_A, 'big-0');
        await page.locator(cardSelector(onlineKey)).getByTitle('Add to Queue').click();
        expect((await lastCall(page, 'addSongToQueue'))?.ids).toEqual([onlineKey]);

        await back(page);
        await open(page, 'local-all');
        await waitForScope(page, 8);
        await page.locator(cardSelector(localKey(1))).getByTitle('Add to Queue').click();
        expect((await lastCall(page, 'addLocalSongToQueue'))?.ids).toEqual([localSongId(1)]);

        await back(page);
        await open(page, 'navi-album');
        await waitForScope(page, 6);
        await page.locator(cardSelector('navidrome:navi-song-1')).getByTitle('Add to Queue').click();
        expect((await lastCall(page, 'addNavidromeSongsToQueue'))?.ids).toEqual(['navi-song-1']);
    });

    test('local All Songs sorting changes the play order and persists the choice', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'local-all');
        await waitForScope(page, 8);
        const order = (indexes: readonly number[]) => indexes.map(localKey);

        expect(await playFilteredIds(page)).toEqual(order(LOCAL_SORT_ORDERS.fileNameAsc));
        await runSurface(page, 'sort-modified-date');
        await expect.poll(() => playFilteredIds(page)).toEqual(order(LOCAL_SORT_ORDERS.modifiedAsc));
        await runSurface(page, 'sort-toggle-direction');
        await expect.poll(() => playFilteredIds(page)).toEqual(order(LOCAL_SORT_ORDERS.modifiedDesc));
        await runSurface(page, 'sort-album-track');
        await expect.poll(() => playFilteredIds(page)).toEqual(order(LOCAL_SORT_ORDERS.albumTrackDesc));
        await runSurface(page, 'sort-toggle-direction');
        await expect.poll(() => playFilteredIds(page)).toEqual(order(LOCAL_SORT_ORDERS.albumTrackAsc));

        expect(await page.evaluate(() => [
            localStorage.getItem('local_track_sort_field'),
            localStorage.getItem('local_track_sort_direction'),
        ])).toEqual(['albumTrack', 'asc']);
    });

    test('local folder, album entity and Navidrome playlist load their own track sets', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'local-folder');
        await waitForScope(page, 5);
        expect([...await playFilteredIds(page)].sort()).toEqual([1, 2, 3, 4, 5].map(localKey).sort());

        await back(page);
        await open(page, 'local-album');
        await waitForScope(page, 4);
        expect([...await playFilteredIds(page)].sort()).toEqual([1, 2, 3, 4].map(localKey).sort());

        await back(page);
        await open(page, 'navi-playlist');
        await waitForScope(page, 5);
        expect(await requests(page, 'getPlaylist')).not.toEqual([]);
    });
});

test.describe('[grid] edits', () => {
    const removeFocusedCard = async (page: Page, itemKey: string) => {
        await expect.poll(async () => (await surface(page))?.availableActions.includes('toggle-edit-mode')).toBe(true);
        expect(await runSurface(page, 'toggle-edit-mode')).toBe(true);
        await expect.poll(async () => (await surface(page))?.isEditMode).toBe(true);
        await page.locator(cardSelector(itemKey)).locator('button.bg-red-500').click();
    };

    test('removing a song from an owned online playlist updates upstream, the grid and the cache', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-owned');
        await waitForScope(page, 12);
        await clearLog(page);
        await removeFocusedCard(page, onlinePlaybackKey(PROBE_PROVIDER_A, 'owned-0'));

        await expect.poll(() => requests(page, 'updatePlaylistTracks:del')).toHaveLength(1);
        expect((await requests(page, 'updatePlaylistTracks:del'))[0]?.ids).toEqual(['owned-0']);
        await waitForScope(page, 11);
        await expect.poll(() => calls(page, 'refreshUser')).not.toEqual([]);
        // 现状：账户刷新带回新的 trackCount，网格据此从第一页重拉，并把缓存写回有效的快照。
        await expect.poll(() => distinctOffsets(page, 'probe-a:playlist:owned')).toEqual(['0+150']);

        await backAndSettle(page);
        await clearLog(page);
        await open(page, 'online-owned');
        await waitForScope(page, 11);
        await page.waitForTimeout(500);
        expect(await requests(page, 'playlistTracks')).toEqual([]);
        expect(await playFilteredIds(page)).not.toContain(onlinePlaybackKey(PROBE_PROVIDER_A, 'owned-0'));
    });

    test('removing a song from a local playlist persists it and refreshes the library', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'local-playlist');
        await waitForScope(page, 6);
        await removeFocusedCard(page, localKey(1));

        await waitForScope(page, 5);
        await expect.poll(() => calls(page, 'refreshLocalSongs')).not.toEqual([]);
        expect(await playFilteredIds(page)).not.toContain(localKey(1));
    });

    test('removing a song from a Navidrome playlist sends its index', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'navi-playlist');
        await waitForScope(page, 5);
        await removeFocusedCard(page, 'navidrome:navi-song-11');

        await expect.poll(() => requests(page, 'updatePlaylist')).toHaveLength(1);
        expect((await requests(page, 'updatePlaylist'))[0]?.ids).toEqual(['0']);
        await waitForScope(page, 4);
    });

    test('disliking a daily recommendation replaces it in place', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-daily');
        await waitForScope(page, 10);
        expect(await requests(page, 'dailySongs')).not.toEqual([]);
        await removeFocusedCard(page, onlinePlaybackKey(PROBE_PROVIDER_A, 'daily-0'));

        await expect.poll(() => requests(page, 'dislikeSong')).toHaveLength(1);
        await expect.poll(async () => (await playFilteredIds(page))[0]).toBe(onlinePlaybackKey(PROBE_PROVIDER_A, 'daily-r-0'));
        expect(await scopeCount(page)).toBe(10);
    });

    test('subscribing to a public playlist goes upstream and refreshes the account', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-public');
        await waitForScope(page, expectedPlayableIndexes(fixture['online-public'].rawIndexes).length);
        expect(await runSurface(page, 'toggle-info-panel')).toBe(true);

        await page.getByTitle('Subscribe Playlist').click();
        await expect.poll(() => requests(page, 'subscribePlaylist')).toHaveLength(1);
        await expect(page.getByTitle('Unsubscribe Playlist')).toBeVisible();
        await expect.poll(() => calls(page, 'refreshUser')).not.toEqual([]);
    });
});

test.describe('navigation', () => {
    test('[grid] a nested album opens once, and going back restores the filter and the focused card', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await setQuery(page, 'cedar');
        await waitForScope(page, bigKeys('cedar').length);
        await waitForFilteredGrid(page, onlinePlaybackKey(PROBE_PROVIDER_A, 'big-0'));

        // 先把焦点挪离第一张，恢复才有区分度。
        await pressOnGrid(page, 'ArrowRight');
        await page.waitForTimeout(400);
        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        const focusedKey = (await lastCall(page, 'playSong'))!.ids[0];
        expect(focusedKey).not.toBe(bigKeys('cedar')[0]);

        await page.locator(cardSelector(focusedKey)).getByText(PROBE_ALBUM.name, { exact: true }).click();
        await expect.poll(() => stack(page)).toEqual(['Big Playlist', PROBE_ALBUM.name]);
        await waitForScope(page, PROBE_ALBUM.rawIndexes.length);

        // 专辑里的曲目卡片指回同一张专辑：再点不压栈。
        const albumCard = cardSelector(onlinePlaybackKey(PROBE_PROVIDER_A, `${PROBE_ALBUM.prefix}-0`));
        await page.locator(albumCard).getByText(PROBE_ALBUM.name, { exact: true }).click();
        await page.waitForTimeout(300);
        expect(await stack(page)).toEqual(['Big Playlist', PROBE_ALBUM.name]);

        await back(page);
        await expect.poll(() => stack(page)).toEqual(['Big Playlist']);
        await waitForScope(page, bigKeys('cedar').length);
        expect(await getQuery(page)).toBe('cedar');
        await page.waitForTimeout(400);
        await clearLog(page);
        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        expect((await lastCall(page, 'playSong'))?.ids).toEqual([focusedKey]);
    });

    // P0.1 之前：集合身份不含 provider，两个 provider 下同 id 的歌单共用一个网格实例，
    // 后打开的那个显示的是前一个的曲目。
    test('two providers with the same playlist id never share tracks', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'collide-a');
        await waitForScope(page, 5);
        expect(await playFilteredIds(page)).toEqual(keysOf(PROBE_PROVIDER_A, 'ca', fixture['collide-a'].rawIndexes));

        await open(page, 'collide-b');
        await expect.poll(() => stack(page)).toEqual(['Same Id (B)']);
        await expect.poll(() => requests(page, 'playlistTracks', 'probe-b:playlist:same')).not.toEqual([]);
        await waitForScope(page, 5);
        expect(await playFilteredIds(page)).toEqual(keysOf(PROBE_PROVIDER_B, 'cb', fixture['collide-b'].rawIndexes));
    });
});
