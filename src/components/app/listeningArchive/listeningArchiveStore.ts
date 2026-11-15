import { create } from 'zustand';
import type {
    ArchiveGranularity,
    ArchiveRankKind,
    ArchiveRankSort,
} from '../../../services/listeningArchive/types';

// src/components/app/listeningArchive/listeningArchiveStore.ts
// 听歌档案界面自己的状态：开到哪个页签、排行怎么排、看哪一段时间、聚焦了哪张封面。
// 只给这个功能用，所以放在功能目录里；采集设置值在 src/stores/useListeningArchiveSettingsStore.ts，
// 播放记录本身由 services/listeningArchive 读写。

/** 四个页签。 */
export type ListeningArchiveTab = 'rankings' | 'timeline' | 'song' | 'settings';

/** 时间范围档位：最近一周 / 一月 / 一季 / 一年 / 全部。 */
export type ArchiveRangePreset = 'week' | 'month' | 'quarter' | 'year' | 'all';

/** 放大看的封面：图片地址与它说明的是哪一首歌。 */
export type ArchiveFocusedCover = {
    url: string;
    title: string;
    subtitle: string;
};

type ListeningArchiveState = {
    isOpen: boolean;
    tab: ListeningArchiveTab;
    rankKind: ArchiveRankKind;
    rankSort: ArchiveRankSort;
    /** 排行页的搜索词。 */
    query: string;
    range: ArchiveRangePreset;
    granularity: ArchiveGranularity;
    /** 单曲轨迹在看哪一首（songKey）；null 时由界面自己挑当前排第一的那首。 */
    trajectorySongKey: string | null;
    /** 正在放大看的封面；null 表示没有开着。 */
    focusedCover: ArchiveFocusedCover | null;
    /** 时间轴上被点开的那一段（桶键）；null 表示没有开着。 */
    focusedBucketKey: string | null;
    open: (tab?: ListeningArchiveTab) => void;
    close: () => void;
    setTab: (tab: ListeningArchiveTab) => void;
    setRankKind: (kind: ArchiveRankKind) => void;
    setRankSort: (sort: ArchiveRankSort) => void;
    setQuery: (query: string) => void;
    setRange: (range: ArchiveRangePreset) => void;
    setGranularity: (granularity: ArchiveGranularity) => void;
    setTrajectorySongKey: (songKey: string | null) => void;
    setFocusedCover: (cover: ArchiveFocusedCover | null) => void;
    setFocusedBucketKey: (bucketKey: string | null) => void;
    /** 从排行点进某一首的轨迹：换页签并把那首歌带上。 */
    openTrajectory: (songKey: string) => void;
};

export const useListeningArchiveStore = create<ListeningArchiveState>((set) => ({
    isOpen: false,
    tab: 'rankings',
    rankKind: 'song',
    rankSort: 'plays',
    query: '',
    range: 'month',
    granularity: 'day',
    trajectorySongKey: null,
    focusedCover: null,
    focusedBucketKey: null,
    open: (tab) => set((state) => ({
        isOpen: true,
        tab: tab ?? state.tab,
        // 关着的时候不可能有弹层，开着再进来也一样：不留上次的封面对焦和段落。
        focusedCover: null,
        focusedBucketKey: null,
    })),
    close: () => set({ isOpen: false, focusedCover: null, focusedBucketKey: null }),
    setTab: (tab) => set({ tab }),
    setRankKind: (rankKind) => set({ rankKind }),
    setRankSort: (rankSort) => set({ rankSort }),
    setQuery: (query) => set({ query }),
    setRange: (range) => set({ range }),
    setGranularity: (granularity) => set({ granularity }),
    setTrajectorySongKey: (trajectorySongKey) => set({ trajectorySongKey }),
    setFocusedCover: (focusedCover) => set({ focusedCover }),
    setFocusedBucketKey: (focusedBucketKey) => set({ focusedBucketKey }),
    openTrajectory: (songKey) => set({ trajectorySongKey: songKey, tab: 'song' }),
}));
