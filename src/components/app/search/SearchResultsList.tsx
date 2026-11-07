import React, { useEffect, useMemo, useRef, useState } from 'react';
import { List, useListRef } from 'react-window';
import { useTranslation } from 'react-i18next';
import type { UnifiedSong } from '../../../types';
import type { MediaId, OmniCollection } from '../../../types/onlineMusic';
import SearchResultRow from './SearchResultRow';
import SearchCollectionRow from './SearchCollectionRow';
import { Button } from '../../ui';
import { createSearchBarScrollState, resolveSearchBarScrollState } from './searchBarScroll';

// src/components/app/search/SearchResultsList.tsx

/** 结果到了之后这么久，行的入场动画放完：再滚出来的行不再滑入（search.css 的 data-search-entered）。 */
const ROW_REVEAL_MS = 1000;

type SongHandlers = {
    onPlayTrack: (track: UnifiedSong) => void;
    onAddTrackToQueue: (track: UnifiedSong) => void;
    onCollectTrack?: (track: UnifiedSong) => void;
    canSaveTrackToPlaylist?: (track: UnifiedSong) => boolean;
    onSaveTrackToPlaylist?: (track: UnifiedSong) => void;
    onOpenArtist: (track: UnifiedSong, artistName: string, artistId?: MediaId, entityId?: string) => void;
    onOpenAlbum: (track: UnifiedSong, albumName: string, albumId?: MediaId, entityId?: string) => void;
};

type SearchResultsListProps = SongHandlers & {
    /** 单曲结果；搜专辑、歌单时给 collections。 */
    tracks?: UnifiedSong[];
    collections?: OmniCollection[];
    /** 换了这组结果（来源、种类或词变了）就再放一次入场动画。 */
    revealKey: string;
    scrollTop: number;
    onScrollTopChange: (scrollTop: number) => void;
    /** 往下滚收起底部播放条、往上滚放回来（见 searchBarScroll）。 */
    onScrollBarHiddenChange: (hidden: boolean) => void;
    onOpenCollection: (collection: OmniCollection) => void;
    /** 还有更多结果：列表末尾那颗「加载更多」跟着最后一行滚出来，而不是钉在屏幕上。 */
    hasMore?: boolean;
    isLoadingMore?: boolean;
    onLoadMore?: () => void;
};

type SongRowProps = SongHandlers & { tracks: UnifiedSong[] };
type CollectionRowProps = { collections: OmniCollection[]; onOpenCollection: (collection: OmniCollection) => void };

const LOAD_MORE_ROW_HEIGHT = 64;

/** 列表末尾那颗「加载更多」：作为最后一行跟着结果滚出来，不是钉在屏幕底部的固定条。 */
const LoadMoreRow = ({ index, style, isLoadingMore, onLoadMore }: {
    index: number;
    style: React.CSSProperties;
    isLoadingMore: boolean;
    onLoadMore: () => void;
}) => {
    const { t } = useTranslation();
    return (
        <div style={style}>
            <div
                className="flex h-full items-center justify-center"
                style={{ '--search-row-order': index } as React.CSSProperties}
            >
                <Button
                    variant="bare"
                    disabled={isLoadingMore}
                    onClick={onLoadMore}
                    className="search-flat-button"
                >
                    {isLoadingMore ? t('localMusic.searching') : t('home.loadMore')}
                </Button>
            </div>
        </div>
    );
};

const SongRow = ({ index, style, tracks, ...handlers }: { index: number; style: React.CSSProperties } & SongRowProps) => (
    <SearchResultRow track={tracks[index]} index={index} style={style} {...handlers} />
);

const CollectionRow = ({ index, style, collections, onOpenCollection }: { index: number; style: React.CSSProperties } & CollectionRowProps) => (
    <SearchCollectionRow collection={collections[index]} index={index} style={style} onOpenCollection={onOpenCollection} />
);

/**
 * 行分发器：最后一行是「加载更多」，其余按结果种类分发到歌曲行 / 集合行。
 * react-window 的 rowProps 是一份对象，两种行共用一个 rowComponent 就得在这里自己拆。
 */
const DispatchRow = ({ index, style, resultCount, isCollectionList, loadMore, songRowProps, collectionRowProps }: {
    index: number;
    style: React.CSSProperties;
    /** 结果行数（不含「加载更多」那行）。 */
    resultCount: number;
    isCollectionList: boolean;
    loadMore: { isLoadingMore: boolean; onLoadMore: () => void } | null;
    songRowProps: SongRowProps;
    collectionRowProps: CollectionRowProps;
}) => {
    if (loadMore && index >= resultCount) {
        return <LoadMoreRow index={index} style={style} isLoadingMore={loadMore.isLoadingMore} onLoadMore={loadMore.onLoadMore} />;
    }
    return isCollectionList
        ? <CollectionRow index={index} style={style} {...collectionRowProps} />
        : <SongRow index={index} style={style} {...songRowProps} />;
};

const SearchResultsList: React.FC<SearchResultsListProps> = ({
    tracks,
    collections,
    revealKey,
    scrollTop,
    onScrollTopChange,
    onScrollBarHiddenChange,
    onPlayTrack,
    onAddTrackToQueue,
    onCollectTrack,
    canSaveTrackToPlaylist,
    onSaveTrackToPlaylist,
    onOpenArtist,
    onOpenAlbum,
    onOpenCollection,
    hasMore,
    isLoadingMore,
    onLoadMore,
}) => {
    const listRef = useListRef(null);
    const latestScrollTopRef = useRef(scrollTop);
    const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 方向判定的基准与当前收起状态，只在认下新方向时更新（见 searchBarScroll）。 */
    const barScrollStateRef = useRef(createSearchBarScrollState(scrollTop));
    // 入场放完的是哪一组结果：换组的那一次渲染里就不相等，行从第一帧起带着动画。
    const [enteredKey, setEnteredKey] = useState<string | null>(null);
    const isCollectionList = Boolean(collections);
    const showLoadMoreRow = Boolean(hasMore && onLoadMore);
    // 「加载更多」是接在结果后面的额外一行；没有它时行数就是结果数。
    const rowCount = (collections ? collections.length : tracks?.length ?? 0) + (showLoadMoreRow ? 1 : 0);
    // react-window 要求行高恒定：两种行不同高，用可变行高数组（其余行统一 84 / 76）。
    const baseRowHeight = isCollectionList ? 84 : 76;
    const rowHeight = (index: number) => (
        showLoadMoreRow && index === rowCount - 1 ? LOAD_MORE_ROW_HEIGHT : baseRowHeight
    );
    const songRowProps = useMemo<SongRowProps>(() => ({
        tracks: tracks ?? [],
        onPlayTrack,
        onAddTrackToQueue,
        onCollectTrack,
        canSaveTrackToPlaylist,
        onSaveTrackToPlaylist,
        onOpenArtist,
        onOpenAlbum,
    }), [canSaveTrackToPlaylist, onAddTrackToQueue, onCollectTrack, onOpenAlbum, onOpenArtist, onPlayTrack, onSaveTrackToPlaylist, tracks]);
    const collectionRowProps = useMemo<CollectionRowProps>(() => ({
        collections: collections ?? [],
        onOpenCollection,
    }), [collections, onOpenCollection]);
    /** 有「加载更多」行时传给行分发器的参数；加载态变化时引用变化让那一行重画。 */
    const dispatchRowProps = useMemo(() => ({
        resultCount: isCollectionList ? collectionRowProps.collections.length : songRowProps.tracks.length,
        isCollectionList,
        loadMore: showLoadMoreRow
            ? { isLoadingMore: Boolean(isLoadingMore), onLoadMore: onLoadMore as () => void }
            : null,
        songRowProps,
        collectionRowProps,
    }), [collectionRowProps, isCollectionList, isLoadingMore, onLoadMore, showLoadMoreRow, songRowProps]);

    /** 上一次见过的结果组：只在换了组（换词 / 换来源 / 换种类）时才把播放条放回来。 */
    const lastRevealKeyRef = useRef<string | null>(null);    useEffect(() => {
        const element = listRef.current?.element;
        if (element && Math.abs(element.scrollTop - scrollTop) > 1) {
            element.scrollTop = scrollTop;
        }
        latestScrollTopRef.current = scrollTop;
        // 只在换组结果时复位播放条与滚动基准。scrollTop 变化（滚动提交 120ms 后回来那一次）
        // 会经过这里 —— 不能在这一步把播放条放回去，否则刚往下滚收起的播放条松手就弹回来了。
        if (lastRevealKeyRef.current !== revealKey) {
            lastRevealKeyRef.current = revealKey;
            barScrollStateRef.current = createSearchBarScrollState(scrollTop);
            onScrollBarHiddenChange(false);
        }
    }, [listRef, scrollTop, tracks, collections, revealKey, onScrollBarHiddenChange]);

    useEffect(() => {
        const timer = setTimeout(() => setEnteredKey(revealKey), ROW_REVEAL_MS);
        return () => clearTimeout(timer);
    }, [revealKey]);

    useEffect(() => () => {
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
        }
        onScrollTopChange(latestScrollTopRef.current);
        // 只在收起时发复位：store 的 setter 相等时原样返回，但少一次多余的调用总是更稳。
        if (barScrollStateRef.current.isBarHidden) {
            onScrollBarHiddenChange(false);
        }
    }, [onScrollTopChange, onScrollBarHiddenChange]);

    const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
        latestScrollTopRef.current = event.currentTarget.scrollTop;
        // 只写 ref、只在方向翻过来时回调一次：onScroll 是高频事件，不能每次都进 React。
        const nextBarScrollState = resolveSearchBarScrollState(barScrollStateRef.current, latestScrollTopRef.current);
        if (nextBarScrollState !== barScrollStateRef.current) {
            barScrollStateRef.current = nextBarScrollState;
            onScrollBarHiddenChange(nextBarScrollState.isBarHidden);
        }
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
        }
        commitTimerRef.current = setTimeout(() => {
            onScrollTopChange(latestScrollTopRef.current);
        }, 120);
    };

    return (
        <div className="search-list h-full w-full" data-search-entered={enteredKey === revealKey ? '' : undefined}>
            <List
                listRef={listRef}
                rowCount={rowCount}
                rowHeight={rowHeight}
                rowComponent={DispatchRow as any}
                rowProps={dispatchRowProps}
                overscanCount={6}
                className="custom-scrollbar"
                style={{ height: '100%', width: '100%' }}
                onScroll={handleScroll}
            />
        </div>
    );
};

export default SearchResultsList;
