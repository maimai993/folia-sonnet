import type { Theme, UnifiedSong } from '../../types';
import type { ProviderCollection } from '../../types/onlineMusic';
import type { LxWorkspaceTab } from '../../stores/useLxWorkspaceStore';
import type { LxPublicPlatform } from '../../services/onlineMusic/lxmusic/lxPublicApi';

// src/components/lxmusic/LxWorkspaceModel.ts
// 工作台的页签表、平台提示、分页大小与几个共用类型。LxWorkspace 只留数据流与渲染，
// 这些不随界面变化的东西放在这里（文件也有 800 行的上限，拆出去正好）。

export const PILLS: ReadonlyArray<{ key: LxWorkspaceTab; label: string }> = [
    { key: 'playlist', label: '歌单' },
    { key: 'radio', label: '电台' },
    { key: 'album', label: '专辑' },
    { key: 'chart', label: '榜单' },
    { key: 'mine', label: '我的' },
    { key: 'local', label: '本地' },
    { key: 'search', label: '搜索' },
];

/** 这两页不分平台，平台按钮跟着藏起来。 */
export const GLOBAL_TABS: ReadonlyArray<LxWorkspaceTab> = ['mine', 'search', 'local', 'source'];

/** 浮层里每家一句「这页能读到什么」：省得点进去才发现这家没有电台或新碟。 */
export const PLATFORM_HINTS: Record<LxPublicPlatform, string> = {
    wy: '歌单 · 新碟 · 电台',
    tx: '歌单 · 新碟（没有电台）',
    kg: '歌单 · 新碟（没有电台）',
    kw: '只有歌单广场',
    mg: '歌单广场 · 分类 · 搜索',
    qs: '场景分类 · 推荐 · 搜索',
};

// 一页 30：其中一家的歌单广场接口固定每页 30 条，页大小对不上的话翻页会漏歌。
export const PAGE_SIZE = 30;
export const TRACK_PAGE_SIZE = 60;
/** 搜索时每个平台各取多少（四家交替，一屏大概 4 倍条数）。 */
export const SEARCH_PAGE_SIZE = 24;

export type DetailView = {
    kind: 'playlist' | 'album';
    platform: LxPublicPlatform;
    id: string;
    title: string;
    subtitle?: string;
    coverUrl?: string;
};

export type LxWorkspaceProps = {
    theme: Theme;
    isDaylight: boolean;
    onClose: () => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddToQueue: (track: UnifiedSong) => void;
};

export const platformOfCollection = (collection: ProviderCollection, fallback: LxPublicPlatform): LxPublicPlatform => {
    const raw = collection.providerData?.platform;
    if (raw === 'wy' || raw === 'kg' || raw === 'kw' || raw === 'tx' || raw === 'mg' || raw === 'qs') return raw;
    return fallback;
};
