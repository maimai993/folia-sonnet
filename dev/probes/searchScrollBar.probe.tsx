import React, { useEffect } from 'react';
import { motionValue } from 'framer-motion';
import '../../src/i18n/config';
import i18n from '../../src/i18n/config';
import SearchWorkspace from '../../src/components/app/search/SearchWorkspace';
import FloatingPlayerControls from '../../src/components/FloatingPlayerControls';
import { useSearchNavigationStore } from '../../src/stores/useSearchNavigationStore';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import { PlayerState, type UnifiedSong } from '../../src/types';
import type { ProbeDefinition } from './definition';
// dev/probes/searchScrollBar.probe.tsx

const currentTime = motionValue(42);

/** `?nobar=1`：只滚动、不接播放条收起，用来把「滚动的成本」和「位移的成本」分开量。 */
const BAR_HIDING_DISABLED = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('nobar') === '1';

/**
 * 造一屏能滚起来的结果：行数够多，「查看更多」才会落到列表下方、被胶囊压住。
 *
 * 探针不接真实平台（没有登录态、也不该打网络），字段只按 SearchResultRow 读到的那些凑齐。
 */
const PROBE_TRACKS = Array.from({ length: 24 }, (_, index) => ({
    id: `probe-${index}`,
    name: `探针曲目 ${index + 1}`,
    artists: [{ id: `probe-artist-${index}`, name: `歌手 ${index + 1}` }],
    album: { id: `probe-album-${index}`, name: `专辑 ${index + 1}` },
    durationMs: 200_000,
})) as unknown as UnifiedSong[];

/**
 * 搜索页往下滚时底部播放条收到屏幕下面的实际效果。
 *
 * 真正要**看**的是两件事，都只在真实浏览器里成立：胶囊是不是整条落到视口外（而不是剩半条压着
 * 「查看更多」），以及往上滚回来时它是不是回到原位。滚动的方向判定与接线走的是产品代码：
 * SearchWorkspace → SearchResultsList → store 的 isResultsBarHidden，探针只把这份状态接到胶囊上
 * （等同 buildAppOverlaysModel 里那行 isScrollHidden）。
 */
const SearchScrollBarProbe: React.FC = () => {
    const isBarHidden = useSearchNavigationStore(state => state.isResultsBarHidden);

    useEffect(() => {
        void i18n.changeLanguage('zh-CN');
        useSearchNavigationStore.setState({
            searchQuery: '探针',
            searchSourceTab: 'local',
            searchResults: PROBE_TRACKS,
            isSearchOpen: true,
            isSearching: false,
            isLoadingMore: false,
            searchError: null,
            searchAuthExpiredProvider: null,
            hasMore: true,
            scrollTop: 0,
            isResultsBarHidden: false,
        });
    }, []);

    return (
        <div className="fixed inset-0" data-probe-bar-hidden={isBarHidden ? '1' : '0'}>
            <SearchWorkspace
                theme={DEFAULT_THEME}
                isDaylight={false}
                onClose={() => { }}
                onSubmitSearch={() => { }}
                onLoadMore={() => { }}
                onPlayTrack={() => { }}
                onAddTrackToQueue={() => { }}
                onOpenArtist={() => { }}
                onOpenAlbum={() => { }}
                onOpenCollection={() => { }}
                hasLocalSongs
            />

            <FloatingPlayerControls
                currentSong={{ name: '探针曲目' }}
                playerState={PlayerState.PLAYING}
                currentTime={currentTime}
                duration={200}
                loopMode="all"
                currentView="home"
                audioSrc="probe://audio"
                canTogglePlay
                lyrics={null}
                onSeek={() => { }}
                onTogglePlay={() => { }}
                onToggleLoop={() => { }}
                onNavigateToPlayer={() => { }}
                noTrackText="无曲目"
                isDaylight={false}
                // 上游把「往下滚收起胶囊」这一项从 FloatingPlayerControls 的 props 里拿掉了：胶囊只剩
                // isHidden 一条淡出。探针仍按 store 的 isResultsBarHidden 开关它，接的还是同一份状态。
                isHidden={BAR_HIDING_DISABLED ? false : isBarHidden}
                slotPrimary="loop"
                slotSecondary="lyrics-timeline"
                slotContext={{
                    onShuffle: () => { },
                    canShuffle: true,
                    onLike: () => { },
                    isLiked: false,
                    likeDisabled: false,
                    invokeCommandById: () => { },
                    canInvokeCommandById: () => true,
                }}
                onCommitBottomBarOffset={() => { }}
            />
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'searchScrollBar',
    title: '搜索页 · 列表滚动收起底部播放条',
    description: '往下滚把胶囊收到屏幕下面，往上滚放回来；「查看更多」不再被压住。',
    Component: SearchScrollBarProbe,
};

export default definition;
