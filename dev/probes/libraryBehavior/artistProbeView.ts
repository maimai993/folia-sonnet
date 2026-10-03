import ArtistGridView from '../../../src/library/suites/grid/artist/ArtistGridView';
import { ArtistGridInfoCutInPanel } from '../../../src/library/suites/grid/artist/ArtistGridInfoCutInPanel';
import { SidePanelList } from '../../../src/components/shared/SidePanelList';
import { GridListSearchButton } from '../../../src/components/shared/GridListSearchButton';
import { useAppViewStore } from '../../../src/stores/useAppViewStore';
import { getPlaybackSongKey } from '../../../src/utils/appPlaybackGuards';
import { isSongUnavailable } from '../../../src/services/onlineMusic/songAvailability';
import type { LibraryArtistResource, LibraryArtistSnapshot } from '../../../src/library/core/contracts/artist';
import type { LibraryCollectionDescriptor } from '../../../src/library/core/contracts/collection';
import { artistAlbumLink, filterArtistAlbums } from '../../../src/library/core/model/artistModel';
import { findPresentComponent, firstHostElement, propsOf, type ProbeFiber } from '../homeBehavior/reactFiberProbe';
import type { ProbeArtistAlbum, ProbeArtistView } from './probeApi';

// dev/probes/libraryBehavior/artistProbeView.ts
// 歌手页的语义视图（`__libraryProbe.artist()`）与几个歌手页动作。P4.1 起歌手数据在宿主持有的歌手资源里：
// artist() 找到在场（不在退场中）的歌手页，读它收到的资源（`resource` prop，宿主交给 surface 的同一个对象）
// 的快照，再按当前的命令筛选用 core 的 filterArtistAlbums 算出「当前显示的专辑」，专辑的链接提示用 core 的
// artistAlbumLink（网格专辑卡带的就是它）。面板开合仍从组件树上读。签名与 P4.0 相同，status 多了 error。

/** 歌手页（ArtistGridView）上探针要读的两个 prop。 */
type ArtistViewProps = { collection?: LibraryCollectionDescriptor; resource?: LibraryArtistResource | null };

/** 在场（不在退场中）的歌手页实例。 */
const artistFiber = (): ProbeFiber | null => findPresentComponent(ArtistGridView);

/** 在场歌手页的资源（宿主持有的那一个）。 */
export const presentArtistResource = (): LibraryArtistResource | null => (
    propsOf<ArtistViewProps>(artistFiber())?.resource ?? null
);

const statusOf = (snapshot: LibraryArtistSnapshot): ProbeArtistView['status'] => {
    if (snapshot.status === 'idle' || snapshot.status === 'loading') return 'loading';
    if (snapshot.status === 'error') return 'error';
    if (!snapshot.detail) return 'empty';
    const sync = snapshot.albumSync;
    if (sync.state === 'syncing' || (sync.state === 'interrupted' && sync.reason === 'paused')) return 'syncing';
    if (sync.state === 'interrupted') return 'interrupted';
    return 'ready';
};

/** 当前在场歌手页的语义视图；没有歌手页时为 null。 */
export const readArtistView = (): ProbeArtistView | null => {
    const fiber = artistFiber();
    if (!fiber) return null;
    const props = propsOf<ArtistViewProps>(fiber);
    const collection = props?.collection;
    const snapshot = props?.resource?.getSnapshot() ?? null;
    const query = useAppViewStore.getState().commandFilter?.getQuery() ?? null;
    const detail = snapshot?.status === 'ready' ? snapshot.detail : null;
    const songs = detail ? snapshot!.topSongs : [];
    // 网格只在有详情时摆卡片；专辑按当前筛选。
    const shownAlbums = detail ? filterArtistAlbums(snapshot!.albums, query ?? '') : [];
    const albums: ProbeArtistAlbum[] = shownAlbums.map(album => {
        const link = artistAlbumLink(album, {
            source: collection?.source ?? 'online',
            providerId: collection?.source === 'online' ? collection.providerId : undefined,
        });
        return {
            id: String(link.id),
            name: String(link.name ?? ''),
            link: { source: link.source, providerId: link.providerId, type: link.type },
        };
    });

    const cutIn = propsOf<{ isOpen: boolean }>(findPresentComponent(ArtistGridInfoCutInPanel, fiber));
    const sidePanel = propsOf<{ isOpen: boolean }>(findPresentComponent(SidePanelList, fiber));

    return {
        name: collection?.name ?? '',
        status: snapshot ? statusOf(snapshot) : 'loading',
        detail: detail
            ? { name: detail.name, cover: detail.coverUrl ?? null, hasBio: Boolean(detail.description) }
            : null,
        topSongIds: songs.map(getPlaybackSongKey),
        playableTopSongIds: songs.filter(song => !isSongUnavailable(song)).map(getPlaybackSongKey),
        albumIds: albums.map(album => album.id),
        albums,
        query,
        panels: { sidePanel: Boolean(sidePanel?.isOpen), cutIn: Boolean(cutIn?.isOpen) },
    };
};

/** 让在场歌手页的资源从头重新加载（与错误态的重试同一个入口）；没有歌手页时返回 false。 */
export const reloadArtist = (): boolean => {
    const resource = presentArtistResource();
    if (!resource) return false;
    resource.reload();
    return true;
};

type GridItemLike = {
    id: string | number;
    rawCollection?: Record<string, unknown> & { id: string | number; name?: string };
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
