import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, useListRef } from 'react-window';
import type { UnifiedSong } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import SearchResultRow from './SearchResultRow';
import { createSearchBarScrollState, resolveSearchBarScrollState } from './searchBarScroll';

// src/components/app/search/SearchResultsList.tsx

type SearchResultsListProps = {
    tracks: UnifiedSong[];
    scrollTop: number;
    isDaylight: boolean;
    onScrollTopChange: (scrollTop: number) => void;
    /** 往下滚收起底部播放条、往上滚放回来（见 searchBarScroll）。 */
    onScrollBarHiddenChange: (hidden: boolean) => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddTrackToQueue: (track: UnifiedSong) => void;
    onOpenArtist: (track: UnifiedSong, artistName: string, artistId?: MediaId, entityId?: string) => void;
    onOpenAlbum: (track: UnifiedSong, albumName: string, albumId?: MediaId, entityId?: string) => void;
    /**
     * 接在最后一行后面的那一行（「加载更多」、「重试」、还有平台没回来的提示）。
     *
     * 放进列表本身而不是压在列表下面：它是「这一批结果的结尾」，跟着结果一起滚才对；
     * 钉在屏幕底部时它会永远占着一条，还和浮在上面的播放条抢同一块地方。
     */
    trailingRow?: React.ReactNode;
};

type RowProps = Omit<SearchResultsListProps, 'scrollTop' | 'onScrollTopChange' | 'onScrollBarHiddenChange' | 'trailingRow'> & {
    /** 每行的稳定身份（见 buildRowKeys）：react-window 认它不认下标，行挪位置时组件不会被顶掉。 */
    rowKeys: string[];
    /** 这一轮**新出现**的那些行的身份：只有它们播入场动画。 */
    enterKeys: ReadonlySet<string>;
    /** 末尾那一行（下标越过 tracks 时画它）。 */
    trailingRow: React.ReactNode;
};

/**
 * 行的稳定身份。
 *
 * react-window 默认拿下标当 key —— 于是「全部」流式插入时，下标 3 上一帧还是 A 平台那首、
 * 这一帧成了 B 平台那首，组件被复用、入场动画不会播，而被挤下去的老行反而跟着重播一遍。
 * 给了身份之后，新歌才是真的新组件，老歌只是往下让一格。
 *
 * 末尾那个计数是给「同一首跨页重复」兜底的：翻页不做跨页去重，真撞上了两个 key 会打架。
 */
const buildRowKeys = (tracks: UnifiedSong[]): string[] => {
    const counts = new Map<string, number>();
    return tracks.map(track => {
        const base = `${(track.isNavidrome ? track.navidromeData?.id : track.id) ?? ''}|${
            (track.name ?? '').trim().toLowerCase()}`;
        const seen = counts.get(base) ?? 0;
        counts.set(base, seen + 1);
        return seen === 0 ? base : `${base}#${seen}`;
    });
};

/** 行的位置是 react-window 写在 `transform: translateY()` 上的，给它加个过渡就是「老行往下让位」。 */
const ROW_SHIFT_TRANSITION = 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)';

const Row = ({
    index,
    style,
    tracks,
    rowKeys,
    enterKeys,
    trailingRow,
    ...props
}: { index: number; style: React.CSSProperties } & RowProps) => {
    const key = rowKeys[index] ?? String(index);
    /*
     * 只在挂载这一刻判一次「我是不是刚被插进来的」。
     *
     * 之后这一行被挤到哪儿都还是同一首歌，不该再播一次入场 —— 所以用 `useRef` 把挂载那一刻的
     * 结果钉住，而不是每次渲染都去查 `enterKeys`（那样下一批到达时整屏都会重播一遍）。
     */
    const entering = useRef(enterKeys.has(key)).current;
    return (
        <div style={{ ...style, transition: ROW_SHIFT_TRANSITION }}>
            {index < tracks.length
                ? <SearchResultRow track={tracks[index]} entering={entering} {...props} />
                : trailingRow}
        </div>
    );
};

const SearchResultsList: React.FC<SearchResultsListProps> = ({
    tracks,
    scrollTop,
    onScrollTopChange,
    onScrollBarHiddenChange,
    trailingRow,
    ...rowProps
}) => {
    const listRef = useListRef(null);
    const latestScrollTopRef = useRef(scrollTop);
    /** 方向判定的基准与当前收起状态，只在认下新方向时更新（见 searchBarScroll）。 */
    const barScrollStateRef = useRef(createSearchBarScrollState(scrollTop));
    const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stableRowProps = useMemo(
        () => ({ tracks, trailingRow, ...rowProps }),
        [rowProps, tracks, trailingRow],
    );
    const rowKeys = useMemo(() => buildRowKeys(tracks), [tracks]);
    const rowCount = tracks.length + (trailingRow ? 1 : 0);

    /*
     * 这一轮新出现的行。认的是**整份 tracks** 里见没见过，不是「这一行渲染过没有」——
     * 所以往下滚时新挂载的那几行不算新（它们早就在 tracks 里了），不会一滚就淡入一片。
     *
     * 「上一轮看过谁」放在 state 里而不是 ref 里：StrictMode 会把渲染函数跑两遍，
     * 边跑边往 ref 里塞的话第二遍就一个都不新了，动画在开发环境直接消失。
     */
    const [seenRowKeys, setSeenRowKeys] = useState<readonly string[]>([]);
    const enterKeys = useMemo(() => {
        const seen = new Set(seenRowKeys);
        const fresh = new Set<string>();
        rowKeys.forEach(key => {
            if (seen.has(key)) return;
            fresh.add(key);
        });
        return fresh;
        // 故意不认 seenRowKeys：那是「上一轮结束时的名单」，跟着它变会把刚算出的 fresh 冲掉。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rowKeys]);

    useEffect(() => {
        if (rowKeys.length > 0) setSeenRowKeys(rowKeys);
    }, [rowKeys]);

    const rowKey = useCallback((index: number, data: RowProps) => data.rowKeys[index] ?? index, []);

    useEffect(() => {
        const element = listRef.current?.element;
        if (element && Math.abs(element.scrollTop - scrollTop) > 1) {
            element.scrollTop = scrollTop;
        }
        latestScrollTopRef.current = scrollTop;
    }, [listRef, scrollTop, tracks]);

    useEffect(() => () => {
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
        }
        onScrollTopChange(latestScrollTopRef.current);
        // 列表没了（换源、关页面、结果被清空）就没有「正在滚」这件事，播放条必须露回来。
        onScrollBarHiddenChange(false);
    }, [onScrollBarHiddenChange, onScrollTopChange]);

    return (
        <List
            listRef={listRef}
            rowCount={rowCount}
            rowHeight={76}
            rowComponent={Row as any}
            rowProps={{ ...stableRowProps, rowKeys, enterKeys } as any}
            rowKey={rowKey}
            overscanCount={6}
            className="custom-scrollbar"
            style={{ height: '100%', width: '100%' }}
            onScroll={(event) => {
                const nextScrollTop = event.currentTarget.scrollTop;
                latestScrollTopRef.current = nextScrollTop;
                // 只写 ref、只在方向翻过来时回调一次：onScroll 是高频事件，不能每次都进 React。
                const nextBarScrollState = resolveSearchBarScrollState(barScrollStateRef.current, nextScrollTop);
                if (nextBarScrollState !== barScrollStateRef.current) {
                    const hiddenChanged = nextBarScrollState.isBarHidden !== barScrollStateRef.current.isBarHidden;
                    barScrollStateRef.current = nextBarScrollState;
                    if (hiddenChanged) {
                        onScrollBarHiddenChange(nextBarScrollState.isBarHidden);
                    }
                }
                if (commitTimerRef.current) {
                    clearTimeout(commitTimerRef.current);
                }
                commitTimerRef.current = setTimeout(() => {
                    onScrollTopChange(latestScrollTopRef.current);
                }, 120);
            }}
        />
    );
};

export default SearchResultsList;
