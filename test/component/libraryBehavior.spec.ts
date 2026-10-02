import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { GridSurfaceActionId } from '../../src/types/gridCommandSurface';
import { GRID_SURFACE_ACTION_SOURCES } from '../../src/library/core/model/collectionSurface';
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
    PROBE_FIRST_PAGE,
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
//
// 与渲染形态无关的场景对网格和 TUI 各跑一遍（标题前缀 [grid] / [tui]）：两套 UI 共享同一份请求、
// 结果、筛选和动作，这批用例就是验收。只有网格才有的交互（卡片按钮、侧栏、编辑、嵌套专辑）只跑网格。

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
/** 一个条目在任一 renderer 里的 DOM：网格卡片或 TUI 行（条目键是同一种格式）。 */
const entrySelector = (itemKey: string, occurrence = 0) => (
    `${cardSelector(itemKey, occurrence)}, [data-library-entry="${itemKey}-${occurrence}"]`
);

/**
 * 参数化用的 suite 列表（R3 之前叫 renderer）。Node 侧的用例 import 不了 registry（eager glob + React），
 * 所以写成常量，由下面「suites」里的用例与探针页里真实 registry 的列表核对。
 */
const RENDERERS = ['grid', 'tui'] as const;
type Renderer = typeof RENDERERS[number];

const mountProbe = async (mount: (id: string) => Promise<unknown>, page: Page, renderer: Renderer = 'grid') => {
    await mount('libraryBehavior');
    await expect.poll(() => page.evaluate(() => window.__libraryProbe?.ready() ?? false)).toBe(true);
    if (renderer !== 'grid') {
        await page.evaluate(id => window.__libraryProbe!.setSuite(id), renderer);
    }
};
const setRenderer = (page: Page, renderer: Renderer) => page.evaluate(id => window.__libraryProbe!.setSuite(id), renderer);
const waitForRenderer = (page: Page, renderer: Renderer) => (
    expect(page.locator(`[data-library-renderer="${renderer}"]`)).toHaveCount(1)
);

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
    await expect(page.locator('[data-library-renderer]')).toHaveCount(0);
};

/**
 * 等筛选真正提交到网格上。surface 读到的可能是还没提交的那次（可打断的）渲染：这时按键会落在旧网格上，
 * 随后「筛选变化回到第一张」又把焦点拉回去。以一张不在筛选结果里的卡消失为准。
 */
const waitForFilteredGrid = async (page: Page, hiddenKey: string) => {
    await expect(page.locator(entrySelector(hiddenKey))).toHaveCount(0);
    await page.waitForTimeout(300);
};

/** 键盘事件要落在 body 上：网格的键盘处理会忽略按钮、输入框里的按键。 */
const pressOnGrid = async (page: Page, key: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(key);
};

for (const renderer of RENDERERS) {
test.describe(`[${renderer}] online paging and cache`, () => {
    test('opens with a 150-track first page and fills the rest in the background', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);

        expect(await distinctOffsets(page, 'probe-a:playlist:big')).toEqual(['0+150', '150+1000']);
        expect(await playFilteredIds(page)).toEqual(bigKeys());
        expect(await stack(page)).toEqual(['Big Playlist']);
    });

    test('keeps first-page duplicates and de-duplicates later pages by playback key', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
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
        await mountProbe(mount, page, renderer);
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
        await mountProbe(mount, page, renderer);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await expect.poll(async () => (await surface(page))?.availableActions.includes('reload-online-collection')).toBe(true);
        await clearLog(page);

        expect(await runSurface(page, 'reload-online-collection')).toBe(true);
        await expect.poll(() => distinctOffsets(page, 'probe-a:playlist:big')).toEqual(['0+150', '150+1000']);
        await waitForScope(page, bigKeys().length);
    });

    test('a page that fails once is retried and the playlist completes', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
        await open(page, 'online-flaky');
        const expected = expectedPlayableIndexes(fixture['online-flaky'].rawIndexes);
        await waitForScope(page, expected.length);

        const atOffset = (await requests(page, 'playlistTracks', 'probe-a:playlist:flaky')).filter(request => request.offset === 150);
        expect(atOffset.map(request => request.outcome)).toEqual(['error', 'ok']);
    });

    test('an interrupted background sync shows a retry that resumes from the failed offset', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
        await open(page, 'online-broken');
        const firstPage = expectedPlayableIndexes(fixture['online-broken'].rawIndexes.slice(0, 150));
        await waitForScope(page, firstPage.length);

        // 1 次首发 + 3 次退避（0.5s / 1.5s / 4s）后才算中断。
        const retry = page.getByRole('button', { name: /Interrupted at 150 \/ 400.*Retry/ });
        await expect(retry).toBeVisible({ timeout: 15_000 });
        await clearLog(page);

        await retry.click();
        await waitForScope(page, expectedPlayableIndexes(fixture['online-broken'].rawIndexes).length);
        const resumed = await requests(page, 'playlistTracks', 'probe-a:playlist:broken');
        expect(resumed[0]?.offset).toBe(150);
        await expect(retry).toBeHidden();
    });

    test('a private playlist says so instead of showing an empty grid; an empty one shows no error', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
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
        await mountProbe(mount, page, renderer);
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
        await mountProbe(mount, page, renderer);
        await open(page, 'online-slow');
        await page.waitForTimeout(300);
        await back(page);
        await page.waitForTimeout(4_000);
        const later = (await requests(page, 'playlistTracks', 'probe-a:playlist:slow')).filter(request => (request.offset ?? 0) > 0);
        expect(later).toEqual([]);
    });
});

test.describe(`[${renderer}] filter, play and enqueue`, () => {
    test('the filter scope drives play-filtered and enqueue-filtered, and skips unavailable songs', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
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
        await mountProbe(mount, page, renderer);
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

    test('a side-panel row plays with the unfiltered playable list as the queue', async ({ mount, page }) => {
        test.skip(renderer !== 'grid', 'only the grid has a track side panel');
        await mountProbe(mount, page, renderer);
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

    test('queueing the focused song routes online, local and Navidrome songs to their own enqueue path', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
        // 网格点卡片上的入队按钮；TUI 对焦点行按 Shift+Enter。两者都落到同一个播放端口。
        const enqueueFocused = async (entryKey: string) => {
            if (renderer === 'grid') {
                await page.locator(cardSelector(entryKey)).getByTitle('Add to Queue').click();
            } else {
                await expect(page.locator(entrySelector(entryKey))).toHaveAttribute('aria-selected', 'true');
                await pressOnGrid(page, 'Shift+Enter');
            }
        };

        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        const onlineKey = onlinePlaybackKey(PROBE_PROVIDER_A, 'big-0');
        await enqueueFocused(onlineKey);
        await expect.poll(async () => (await lastCall(page, 'addSongToQueue'))?.ids).toEqual([onlineKey]);

        await backAndSettle(page);
        await open(page, 'local-all');
        await waitForScope(page, 8);
        await enqueueFocused(localKey(1));
        await expect.poll(async () => (await lastCall(page, 'addLocalSongToQueue'))?.ids).toEqual([localSongId(1)]);

        await backAndSettle(page);
        await open(page, 'navi-album');
        await waitForScope(page, 6);
        await enqueueFocused('navidrome:navi-song-1');
        await expect.poll(async () => (await lastCall(page, 'addNavidromeSongsToQueue'))?.ids).toEqual(['navi-song-1']);
    });

    test('local All Songs sorting changes the play order and persists the choice', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
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
        await mountProbe(mount, page, renderer);
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

    // P0.1 之前：集合身份不含 provider，两个 provider 下同 id 的歌单共用一个视图实例，
    // 后打开的那个显示的是前一个的曲目。
    test('two providers with the same playlist id never share tracks', async ({ mount, page }) => {
        await mountProbe(mount, page, renderer);
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
}

test.describe('[grid] edits', () => {
    const enterEditMode = async (page: Page) => {
        await expect.poll(async () => (await surface(page))?.availableActions.includes('toggle-edit-mode')).toBe(true);
        expect(await runSurface(page, 'toggle-edit-mode')).toBe(true);
        await expect.poll(async () => (await surface(page))?.isEditMode).toBe(true);
    };
    const clickRemove = (page: Page, itemKey: string, occurrence = 0) => (
        page.locator(cardSelector(itemKey, occurrence)).locator('button.bg-red-500').click()
    );
    const removeFocusedCard = async (page: Page, itemKey: string) => {
        await enterEditMode(page);
        await clickRemove(page, itemKey);
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

    // P2.2 之前网格按显示下标删，并用 `${playbackKey}-${显示下标}` 藏卡片：删过一首之后显示下标与资源里的
    // 原始下标错开，第二次删的卡藏不掉，第三次就把上游的另一首删了。
    test('removing Navidrome entries one after another sends the current raw index each time', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'navi-playlist');
        await waitForScope(page, 5);
        await enterEditMode(page);

        const removeAndSettle = async (songId: string, remaining: number) => {
            await clickRemove(page, `navidrome:${songId}`);
            await waitForScope(page, remaining);
            await expect(page.locator(cardSelector(`navidrome:${songId}`))).toHaveCount(0);
        };
        await removeAndSettle('navi-song-11', 4);
        await removeAndSettle('navi-song-13', 3);
        await removeAndSettle('navi-song-14', 2);
        expect((await requests(page, 'updatePlaylist')).map(request => request.ids)).toEqual([['0'], ['1'], ['1']]);

        // 重新打开从服务器取：上游剩下的正是界面上剩下的。
        await backAndSettle(page);
        await open(page, 'navi-playlist');
        await waitForScope(page, 2);
        expect(await playFilteredIds(page)).toEqual(['navidrome:navi-song-12', 'navidrome:navi-song-15']);
    });

    // P1 的已知缺口：网格删本地歌单曲目之后，资源要等曲库刷新才变，TUI 在那之前还看得到它。
    test('a local playlist removal made in the grid shows in the TUI at once', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await page.evaluate(() => window.__libraryProbe!.holdRefresh('refreshLocalSongs'));
        await open(page, 'local-playlist');
        await waitForScope(page, 6);
        await removeFocusedCard(page, localKey(1));
        // 删除确认、提交给资源之后才去刷新曲库；刷新被按住，资源是唯一的来源。
        await expect.poll(() => calls(page, 'refreshLocalSongs')).not.toEqual([]);

        await setRenderer(page, 'tui');
        await waitForRenderer(page, 'tui');
        await waitForScope(page, 5, 2_000);
        await expect(page.locator(entrySelector(localKey(1)))).toHaveCount(0);
        expect(await playFilteredIds(page)).not.toContain(localKey(1));

        await page.evaluate(() => window.__libraryProbe!.releaseRefresh('refreshLocalSongs'));
        await page.waitForTimeout(300);
        expect(await scopeCount(page)).toBe(5);
        expect(await playFilteredIds(page)).not.toContain(localKey(1));
    });

    test('a background page arriving during the removal animation does not bring the removed song back', async ({ mount, page }) => {
        const rule = fixture['online-owned-dupes'];
        const target = 'probe-a:playlist:owned-dupes';
        const removedKey = onlinePlaybackKey(PROBE_PROVIDER_A, onlineSongId(rule.prefix, 0));
        const expectedAfter = expectedPlayableIndexes(expectedLoadedIndexes(rule.rawIndexes).filter(index => index !== 0));

        await mountProbe(mount, page);
        // 后台分页在删除之前就按当时的上游生成（里面还有第一首的重复条目），删除之后才送达；
        // 账户刷新也按住，免得在线集合因版本变化从第一页重拉，掩盖晚到的那一页。
        await page.evaluate(() => window.__libraryProbe!.holdPages('online-owned-dupes'));
        await page.evaluate(() => window.__libraryProbe!.holdRefresh('refreshUser'));
        await open(page, 'online-owned-dupes');
        await waitForScope(page, expectedPlayableIndexes(rule.rawIndexes.slice(0, PROBE_FIRST_PAGE)).length);
        await expect.poll(async () => (await requests(page, 'playlistTracks', target)).some(request => request.offset === PROBE_FIRST_PAGE)).toBe(true);

        await removeFocusedCard(page, removedKey);
        await expect.poll(() => requests(page, 'updatePlaylistTracks:del', target)).toHaveLength(1);
        // 退出动画还在播（展示被按住）时送达。
        await page.evaluate(() => window.__libraryProbe!.releasePages('online-owned-dupes'));

        await waitForScope(page, expectedAfter.length);
        await expect(page.locator(cardSelector(removedKey))).toHaveCount(0);
        expect(await playFilteredIds(page)).toEqual(keysOf(PROBE_PROVIDER_A, rule.prefix, expectedAfter));

        await page.evaluate(() => window.__libraryProbe!.releaseRefresh('refreshUser'));
        await expect.poll(() => calls(page, 'refreshUser')).not.toEqual([]);
        await page.waitForTimeout(500);
        await waitForScope(page, expectedAfter.length);
        expect(await playFilteredIds(page)).toEqual(keysOf(PROBE_PROVIDER_A, rule.prefix, expectedAfter));
    });

    // 改名经变更控制器；宿主的集合描述（导航栈里那份）不再被就地改写，标题来自控制器记下的新名字。
    test('renaming a Navidrome playlist goes upstream once and shows the new title', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'navi-playlist');
        await waitForScope(page, 5);
        expect(await runSurface(page, 'toggle-info-panel')).toBe(true);
        await enterEditMode(page);
        await clearLog(page);

        const input = page.locator('.theme-glass-panel input');
        await expect(input).toHaveValue('Navi Playlist');
        await input.fill('Renamed Navi');
        await input.press('Enter');
        await expect.poll(async () => (await surface(page))?.isEditMode).toBe(false);
        expect(await requests(page, 'updatePlaylist')).toHaveLength(1);
        await expect(page.locator('h2', { hasText: 'Renamed Navi' })).toBeVisible();
        expect(await stack(page)).toEqual(['Navi Playlist']);
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
});

test.describe('renderer switch', () => {
    test('switching keeps the filter, the scope, the focused song and the play queue, and never refetches', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await setQuery(page, 'cedar');
        await waitForScope(page, bigKeys('cedar').length);
        await waitForFilteredGrid(page, onlinePlaybackKey(PROBE_PROVIDER_A, 'big-0'));
        await pressOnGrid(page, 'ArrowRight');
        await page.waitForTimeout(400);
        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        const focusedKey = (await lastCall(page, 'playSong'))!.ids[0];
        expect(focusedKey).not.toBe(bigKeys('cedar')[0]);
        await clearLog(page);

        await setRenderer(page, 'tui');
        await waitForRenderer(page, 'tui');
        expect(await getQuery(page)).toBe('cedar');
        await waitForScope(page, bigKeys('cedar').length);
        expect(await playFilteredIds(page)).toEqual(bigKeys('cedar'));
        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(1);
        expect(await lastCall(page, 'playSong')).toMatchObject({ ids: [focusedKey], queueIds: bigKeys('cedar') });

        await setRenderer(page, 'grid');
        await waitForRenderer(page, 'grid');
        await expect(page.locator('[data-library-renderer="tui"]')).toHaveCount(0);
        await page.waitForTimeout(400);
        await pressOnGrid(page, 'Enter');
        await expect.poll(() => calls(page, 'playSong')).toHaveLength(2);
        expect((await lastCall(page, 'playSong'))?.ids).toEqual([focusedKey]);
        expect(await requests(page, 'playlistTracks')).toEqual([]);
    });

    test('a local sort chosen in one renderer orders the other', async ({ mount, page }) => {
        await mountProbe(mount, page);
        await open(page, 'local-all');
        await waitForScope(page, 8);
        await runSurface(page, 'sort-modified-date');
        await expect.poll(() => playFilteredIds(page)).toEqual(LOCAL_SORT_ORDERS.modifiedAsc.map(localKey));

        await setRenderer(page, 'tui');
        await waitForRenderer(page, 'tui');
        await expect.poll(() => playFilteredIds(page)).toEqual(LOCAL_SORT_ORDERS.modifiedAsc.map(localKey));
        await expect(page.locator('[data-tui-row="0"]')).toHaveAttribute('data-library-entry', `${localKey(8)}-0`);
    });

    test('[tui] Escape clears the filter first, then leaves without a reverse transition', async ({ mount, page }) => {
        await mountProbe(mount, page, 'tui');
        await open(page, 'online-big');
        await waitForScope(page, bigKeys().length);
        await setQuery(page, 'cedar');
        await waitForScope(page, bigKeys('cedar').length);

        await pressOnGrid(page, 'Escape');
        await expect.poll(() => getQuery(page)).toBe('');
        expect(await stack(page)).toEqual(['Big Playlist']);
        await pressOnGrid(page, 'Escape');
        await expect.poll(() => stack(page)).toEqual([]);
        await expect(page.locator('[data-folia-collection-morph]')).toHaveCount(0);
    });

    test('[tui] keeps the DOM bounded on a big playlist and End reaches the last row', async ({ mount, page }) => {
        await mountProbe(mount, page, 'tui');
        await open(page, 'online-slow');
        const total = fixture['online-slow'].rawIndexes.length;
        await waitForScope(page, expectedPlayableIndexes(fixture['online-slow'].rawIndexes).length, 20_000);
        expect(await page.locator('[data-tui-row]').count()).toBeLessThan(80);

        await pressOnGrid(page, 'End');
        await expect(page.locator(`[data-tui-row="${total - 1}"]`)).toHaveAttribute('aria-selected', 'true');
        expect(await page.locator('[data-tui-row]').count()).toBeLessThan(80);
    });
});

test.describe('suites', () => {
    test("the parameterised suite list is the registry's, and the old renderer names still work", async ({ mount, page }) => {
        await mountProbe(mount, page);
        expect(await page.evaluate(() => window.__libraryProbe!.suites())).toEqual([...RENDERERS]);
        await open(page, 'local-all');
        await waitForRenderer(page, 'grid');
        await page.evaluate(() => window.__libraryProbe!.setRenderer('tui'));
        await waitForRenderer(page, 'tui');
        expect(await page.evaluate(() => window.__libraryProbe!.renderer())).toBe('tui');
        expect(await page.evaluate(() => window.__libraryProbe!.suite())).toBe('tui');
    });

    test('[tui] an artist page falls back to the grid, and going back returns to the TUI', async ({ mount, page }) => {
        await mountProbe(mount, page, 'tui');
        await open(page, 'local-all');
        await waitForRenderer(page, 'tui');
        await waitForScope(page, 8);
        expect(await page.evaluate(() => window.__libraryProbe!.resolveSurface('artist'))).toMatchObject({ suiteId: 'grid', isFallback: true });

        expect(await page.evaluate(() => window.__libraryProbe!.pushArtist())).toBe(true);
        await expect(page.locator('[data-library-surface="artist"][data-library-renderer="grid"]')).toHaveCount(1);
        await expect(page.locator('[data-library-renderer="tui"]')).toHaveCount(0);
        expect(await page.evaluate(() => window.__libraryProbe!.suite())).toBe('tui');

        await back(page);
        await waitForRenderer(page, 'tui');
        await expect(page.locator('[data-library-surface="artist"]')).toHaveCount(0);
        await waitForScope(page, 8);
        expect(await playFilteredIds(page)).toHaveLength(8);
    });

    for (const renderer of RENDERERS) {
        test(`[${renderer}] the command surface offers only actions the suite declares`, async ({ mount, page }) => {
            await mountProbe(mount, page, renderer);
            await open(page, 'local-folder');
            await waitForRenderer(page, renderer);
            await expect.poll(async () => (await surface(page))?.availableActions.length ?? 0).toBeGreaterThan(0);

            const { declaredActions } = await page.evaluate(() => window.__libraryProbe!.resolveSurface('collection'));
            const available = (await surface(page))!.availableActions;
            const undeclared = available.filter(action => {
                const source = GRID_SURFACE_ACTION_SOURCES[action];
                return 'action' in source
                    ? !declaredActions.actions.includes(source.action)
                    : !declaredActions.extraActions.includes(source.extra);
            });
            expect(undeclared).toEqual([]);
            expect(available).toEqual(expect.arrayContaining(['play-filtered', 'enqueue-filtered', 'sort-file-name']));
            // 本地文件夹在网格上有重扫、整理和两个面板；TUI 没声明它们，命令面板里也就没有。
            const gridOnly: GridSurfaceActionId[] = ['resync-folder', 'organize-song-info', 'toggle-info-panel', 'toggle-track-list'];
            if (renderer === 'grid') expect(available).toEqual(expect.arrayContaining(gridOnly));
            else expect(available.filter(action => gridOnly.includes(action))).toEqual([]);
        });
    }
});
