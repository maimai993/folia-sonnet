import i18n from '../../../src/i18n/config';
import type { SongResult } from '../../../src/types';
import ArtistGridView from '../../../src/library/suites/grid/artist/ArtistGridView';
import { ArtistGridInfoCutInPanel } from '../../../src/library/suites/grid/artist/ArtistGridInfoCutInPanel';
import { SidePanelList } from '../../../src/components/shared/SidePanelList';
import { GridListSearchButton } from '../../../src/components/shared/GridListSearchButton';
import { useAppViewStore } from '../../../src/stores/useAppViewStore';
import { getPlaybackSongKey } from '../../../src/utils/appPlaybackGuards';
import { isSongUnavailable } from '../../../src/services/onlineMusic/songAvailability';
import { findPresentComponent, firstHostElement, propsOf, type ProbeFiber } from '../homeBehavior/reactFiberProbe';
import type { ProbeArtistAlbum, ProbeArtistView } from './probeApi';

// dev/probes/libraryBehavior/artistProbeView.ts
// 歌手页的语义视图（`__libraryProbe.artist()`）与几个歌手页动作。P4.0 时歌手页还没有 core 资源：数据是
// ArtistGridView 组件里的 state，所以这里从已提交的 fiber 上读——找到 ArtistGridView 的 gridItems（useMemo，
// 第一项固定是 id 为 `__artist_avatar__` 的头像），状态再从它的 DOM 里分辨（初次加载的转圈、空态文案、
// 后台分页的「加载中 / 重试」按钮）。P4.1 有了宿主持有的歌手资源之后，artist() 改读资源快照，签名不变。

type GridItemLike = {
    id: string | number;
    name?: unknown;
    coverUrl?: string;
    description?: string;
    rawTrack?: SongResult;
    rawCollection?: Record<string, unknown> & { id: string | number; name?: string };
};

type HookNode = { memoizedState: unknown; next: HookNode | null };

const AVATAR_ID = '__artist_avatar__';
const BIO_ID = '__artist_bio__';

/** 在场（不在退场中）的歌手页实例。 */
const artistFiber = (): ProbeFiber | null => findPresentComponent(ArtistGridView);

// 沿 hook 链找 gridItems：useMemo 的 memoizedState 是 [value, deps]，value 的第一项是头像卡。
const readGridItems = (fiber: ProbeFiber): GridItemLike[] => {
    let hook = (fiber as unknown as { memoizedState: HookNode | null }).memoizedState;
    while (hook) {
        const state = hook.memoizedState;
        if (Array.isArray(state) && state.length === 2 && Array.isArray(state[0])) {
            const value = state[0] as GridItemLike[];
            if (value[0]?.id === AVATAR_ID) return value;
        }
        hook = hook.next;
    }
    return [];
};

const buttonTexts = (root: HTMLElement | null): string[] => (
    root ? [...root.querySelectorAll('button')].map(button => (button.textContent ?? '').trim()) : []
);

const toAlbum = (item: GridItemLike): ProbeArtistAlbum => ({
    id: String(item.rawCollection!.id),
    name: String(item.rawCollection!.name ?? item.name ?? ''),
    link: {
        source: item.rawCollection!.source as string | undefined,
        providerId: item.rawCollection!.providerId as string | undefined,
        type: item.rawCollection!.type as string | undefined,
    },
});

/** 当前在场歌手页的语义视图；没有歌手页时为 null。 */
export const readArtistView = (): ProbeArtistView | null => {
    const fiber = artistFiber();
    if (!fiber) return null;
    const root = firstHostElement(fiber);
    const items = readGridItems(fiber);
    const avatar = items.find(item => item.id === AVATAR_ID);
    const bio = items.find(item => item.id === BIO_ID);
    const songs = items.filter(item => item.rawTrack).map(item => item.rawTrack!);
    const albums = items.filter(item => item.rawCollection).map(toAlbum);
    const texts = buttonTexts(root);
    const rootText = root?.textContent ?? '';

    let status: ProbeArtistView['status'];
    if (items.length === 0) {
        status = rootText.includes(i18n.t('home.loadingLibrary')) ? 'empty' : 'loading';
    } else if (texts.includes(i18n.t('ui.retry'))) {
        status = 'interrupted';
    } else if (texts.includes(i18n.t('playlist.loading'))) {
        status = 'syncing';
    } else {
        status = 'ready';
    }

    const cutIn = propsOf<{ isOpen: boolean }>(findPresentComponent(ArtistGridInfoCutInPanel, fiber));
    const sidePanel = propsOf<{ isOpen: boolean }>(findPresentComponent(SidePanelList, fiber));
    const collection = propsOf<{ collection: { name: string } }>(fiber)?.collection;

    return {
        name: collection?.name ?? '',
        status,
        detail: bio
            ? {
                name: typeof bio.name === 'string' ? bio.name : String(bio.name ?? ''),
                cover: avatar?.coverUrl ?? null,
                hasBio: Boolean(bio.description),
            }
            : null,
        topSongIds: songs.map(getPlaybackSongKey),
        playableTopSongIds: songs.filter(song => !isSongUnavailable(song)).map(getPlaybackSongKey),
        albumIds: albums.map(album => album.id),
        albums,
        query: useAppViewStore.getState().commandFilter?.getQuery() ?? null,
        panels: { sidePanel: Boolean(sidePanel?.isOpen), cutIn: Boolean(cutIn?.isOpen) },
    };
};

type SidePanelProps = {
    items: GridItemLike[];
    renderItem: (item: GridItemLike, index: number, style: Record<string, unknown>) => { props: { onClick?: () => void } };
};

/** 从专辑侧栏打开一张专辑（与点侧栏那一行同一个回调：先把相机挪过去，320ms 后压栈）。 */
export const openArtistAlbum = (albumId: string): boolean => {
    const fiber = artistFiber();
    const panel = propsOf<SidePanelProps>(findPresentComponent(SidePanelList, fiber));
    if (!panel) return false;
    const index = panel.items.findIndex(item => String(item.rawCollection?.id ?? item.id) === albumId);
    if (index < 0) return false;
    const row = panel.renderItem(panel.items[index], index, {});
    if (!row.props.onClick) return false;
    row.props.onClick();
    return true;
};

/** 打开歌手页的专辑侧栏或信息面板（侧栏按钮的回调；标题是一个可点的按钮）。 */
export const openArtistPanel = (panel: 'side' | 'cut-in'): boolean => {
    const fiber = artistFiber();
    if (!fiber) return false;
    if (panel === 'side') {
        const button = propsOf<{ onOpenList: () => void }>(findPresentComponent(GridListSearchButton, fiber));
        if (!button) return false;
        button.onOpenList();
        return true;
    }
    const title = firstHostElement(fiber)?.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!title) return false;
    title.click();
    return true;
};
