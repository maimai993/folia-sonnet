import type React from 'react';
import type { MotionValue } from 'framer-motion';
import type FloatingPlayerControls from '../../FloatingPlayerControls';
import type SearchWorkspace from '../search/SearchWorkspace';
import type ListeningArchive from '../listeningArchive/ListeningArchive';
import { useListeningArchiveStore } from '../listeningArchive/listeningArchiveStore';
import type DevDebugOverlay from '../../DevDebugOverlay';
import type MemoryMonitorWindow from '../../debug/MemoryMonitorWindow';
import type NowPlayingToast from './NowPlayingToast';
import { PlayerState } from '../../../types';
import type { SongResult, UnifiedSong, LyricData } from '../../../types';
import { resolvePlaybackNeighbors } from '../../../utils/playbackNeighbors';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { getSongAlbumLabel, getSongArtistLabel } from '../../../services/onlineMusic/songMetadata';
import { setPlayerState } from '../../../stores/usePlaybackStore';
import { locatePlayingSongOnWall } from '../lattice/wallLocate';
import { setIsDevDebugOverlayVisible, setIsMemoryMonitorVisible } from '../../../stores/useAppChromeStore';
import type { SlotContextFromApp } from '../../FloatingPlayerControls';
import type { PlayerControlSlotActionId } from '../../../types/playerControlSlots';

// src/components/app/overlays/buildAppOverlaysModel.ts

type SearchOverlayProps = React.ComponentProps<typeof SearchWorkspace>;
type ListeningArchiveProps = React.ComponentProps<typeof ListeningArchive>;
type FloatingControlsProps = React.ComponentProps<typeof FloatingPlayerControls>;
type DebugOverlayProps = React.ComponentProps<typeof DevDebugOverlay>;
type MemoryMonitorProps = React.ComponentProps<typeof MemoryMonitorWindow>;
type NowPlayingToastProps = React.ComponentProps<typeof NowPlayingToast>;

export type AppOverlaysModel = {
    searchOverlay?: SearchOverlayProps | null;
    listeningArchiveOverlay?: ListeningArchiveProps | null;
    /** 洛雪工作台（歌单 / 榜单 / 搜索 / 音源）：开合在 useLxWorkspaceStore，这里只放播放器回调。 */
    lxWorkspace?: {
        theme: any;
        isDaylight: boolean;
        onPlayTrack: (track: UnifiedSong) => void;
        onAddToQueue: (track: UnifiedSong) => void;
    } | null;
    debugOverlay?: DebugOverlayProps | null;
    memoryMonitor?: MemoryMonitorProps | null;
    floatingControls?: FloatingControlsProps | null;
    nowPlayingToast?: NowPlayingToastProps | null;
};

// What the model needs that this file can read for itself: store state, the per-frame motion
// signals, and its own translated labels. Keeping these out of the caller's argument list is the
// whole point of useAppOverlaysModel below - App.tsx had to name all 25 of them.
type AppOverlaysAmbient = {

    currentView: FloatingControlsProps['currentView'];
    isSearchOpen: boolean;
    /** 搜索页列表往下滚时播放条收起（见 SearchWorkspace 的滚动方向判定）。 */
    isSearchResultsBarHidden: boolean;
    isListeningArchiveOpen: boolean;
    isDaylight: boolean;
    isDevDebugOverlayVisible: boolean;
    isMemoryMonitorVisible: boolean;
    memoryMonitorShortcutLabel: string;
    currentTime: MotionValue<number>;
    lyricCurrentTime: MotionValue<number>;
    currentSong: SongResult | null;
    playerState: PlayerState;
    duration: number;
    audioSrc: string | null;
    lyrics: LyricData | null;
    activePlaybackContext: 'main' | 'stage';
    isPlayerChromeHidden: boolean;
    noTrackText: string;
    playQueue: SongResult[];
    isFmMode: boolean;
    prevTrackLabel: string;
    nextTrackLabel: string;
    /**
     * now playing 卡片（playing-toast 样式）的封面。
     *
     * 混音期间必须和上面的 `currentSong` 描述同一首歌，所以调用方传的是冻结画面里的那张，不是实时的。
     * 也不要在这儿补 `cachedCoverUrl` 兜底：混音中冻结封面为 null 是「这首歌本来就没有封面」的合法
     * 取值，退回实时缓存等于把下一首的封面贴到上一首的标题下面。
     */
    coverUrl: string | null;
    stageTrackPillMode: 'auto' | 'always' | 'never';
    stageTrackPillTimeoutSec: number;
    /** 卡片上的两种动作各自的无障碍名字 */
    stageTrackPillOpenPlayerLabel: string;
    stageTrackPillOpenSongCardLabel: string;
    stageTrackPillFocusLatticeLabel: string;
    playerControlSlotPrimary: PlayerControlSlotActionId;
    playerControlSlotSecondary: PlayerControlSlotActionId;
    playerControlSlotContext: SlotContextFromApp;
    onCommitPlayerBottomBarOffset: (offsetPx: number) => void;
};

// What only the caller can supply: controller callbacks and values App.tsx computes.
export type AppOverlaysDeps = {
    theme: any;
    closeSearchView: () => void;
    handleSearchOverlaySubmit: SearchOverlayProps['onSubmitSearch'];
    handleSearchLoadMore: () => Promise<void>;
    handleSearchResultPlay: (track: UnifiedSong) => void;
    handleSearchResultAddToQueue: (track: UnifiedSong) => void;
    handleSearchResultArtistOpen: SearchOverlayProps['onOpenArtist'];
    handleSearchResultAlbumOpen: SearchOverlayProps['onOpenAlbum'];
    handleSearchResultCollectionOpen: SearchOverlayProps['onOpenCollection'];
    /** 搜索结果按当前本地曲库目录重算展示（见 SearchWorkspace 的同名 prop）。 */
    resolveSearchResultDisplay: NonNullable<SearchOverlayProps['resolveTrackDisplay']>;
    /** 本地曲库里有没有歌（搜索页据此列不列「本地」来源）。 */
    hasLocalSongs: boolean;
    devDebugSnapshot: any;
    effectiveLoopMode: 'off' | 'all' | 'one' | 'shuffle';
    canToggleCurrentPlayback: boolean;
    isNowPlayingControlDisabled: boolean;
    stageActiveEntryKind: string | null;
    syncStageLyricsClock: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    stageLyricsClockRef: React.MutableRefObject<{ startTimeSec: number }>;
    togglePlay: FloatingControlsProps['onTogglePlay'];
    toggleLoop: FloatingControlsProps['onToggleLoop'];
    navigateToPlayer: () => void;
    navigateFromPlayerCapsule: () => void;
    shouldHidePlayerProgressBar: boolean;
    onSeekMainAudio: (time: number) => void;
    onStagePlayerSeek: () => Promise<unknown>;
    isNowPlayingStageActive: boolean;
    handlePrevTrack: () => void;
    handleNextTrack: () => void;
    shuffleQueue: () => void;
    handleLike: () => void;
    isDisplaySongLiked: boolean;
    invokeCommandById: (commandId: string) => void;
    canInvokeCommandById: (commandId: string) => boolean;
    /** 自动切歌预览（下一首）；isNextUp 时整卡展示它 */
    stageNextUp: { title: string; artist: string | null; coverUrl: string | null; album?: string | null } | null;
    /** 预览态：接下来播放标签 + 挂起 auto 隐藏计时 */
    stageIsNextUp: boolean;
    /** 当前页面 + 显示模式允许卡片在场（歌词页总是，首页看设置）；App 里算好的单一来源 */
    stageTrackPillOnScreen: boolean;
    /** 点卡片时展开右侧面板的歌曲卡片（切到 cover 页并打开） */
    openSongCardPanel: () => void;
};

type BuildAppOverlaysModelParams = AppOverlaysAmbient & AppOverlaysDeps;

// Builds the full overlay model, including detail overlays and floating playback controls.
export const buildAppOverlaysModel = ({
    currentView,
    isSearchOpen,
    isSearchResultsBarHidden,
    isListeningArchiveOpen,
    theme,
    isDaylight,
    closeSearchView,
    handleSearchOverlaySubmit,
    handleSearchLoadMore,
    handleSearchResultPlay,
    handleSearchResultAddToQueue,
    handleSearchResultArtistOpen,
    handleSearchResultAlbumOpen,
    handleSearchResultCollectionOpen,
    resolveSearchResultDisplay,
    hasLocalSongs,
    isDevDebugOverlayVisible,
    isMemoryMonitorVisible,
    memoryMonitorShortcutLabel,
    devDebugSnapshot,
    currentTime,
    lyricCurrentTime,
    currentSong,
    playerState,
    duration,
    effectiveLoopMode,
    audioSrc,
    canToggleCurrentPlayback,
    isNowPlayingControlDisabled,
    lyrics,
    activePlaybackContext,
    stageActiveEntryKind,
    syncStageLyricsClock,
    stageLyricsClockRef,
    togglePlay,
    toggleLoop,
    navigateToPlayer,
    navigateFromPlayerCapsule,
    isPlayerChromeHidden,
    shouldHidePlayerProgressBar,
    onSeekMainAudio,
    onStagePlayerSeek,
    noTrackText,
    playQueue,
    isFmMode,
    isNowPlayingStageActive,
    handlePrevTrack,
    handleNextTrack,
    prevTrackLabel,
    nextTrackLabel,
    coverUrl,
    stageTrackPillMode,
    stageTrackPillTimeoutSec,
    stageNextUp,
    stageIsNextUp,
    stageTrackPillOnScreen,
    openSongCardPanel,
    stageTrackPillOpenPlayerLabel,
    stageTrackPillOpenSongCardLabel,
    stageTrackPillFocusLatticeLabel,
    playerControlSlotPrimary,
    playerControlSlotSecondary,
    playerControlSlotContext,
    onCommitPlayerBottomBarOffset,
}: BuildAppOverlaysModelParams): AppOverlaysModel => {
    // Gated on stageTrackPillOnScreen (computed in App: display mode plus which page allows the
    // card) rather than on the view directly, so the countdown that feeds the "up next" preview
    // and the card that shows it can never disagree about where the card lives.
    const nowPlayingToast: NowPlayingToastProps | null = stageTrackPillOnScreen && currentSong
        ? {
            song: {
                title: currentSong.name || '',
                artist: getSongArtistLabel(currentSong) || null,
                coverUrl: coverUrl || null,
                album: getSongAlbumLabel(currentSong) || null,
            },
            trackKey: getPlaybackSongKey(currentSong),
            isDaylight,
            mode: stageTrackPillMode,
            timeoutSec: stageTrackPillTimeoutSec,
            nextUp: stageNextUp,
            isNextUp: stageIsNextUp,
            theme,
            onActivate: currentView === 'home'
                ? navigateToPlayer
                : currentView === 'lattice'
                    ? locatePlayingSongOnWall
                    : openSongCardPanel,
            activateLabel: currentView === 'home'
                ? stageTrackPillOpenPlayerLabel
                : currentView === 'lattice'
                    ? stageTrackPillFocusLatticeLabel
                    : stageTrackPillOpenSongCardLabel,
        }
        : null;
    return {
        nowPlayingToast,
        // 洛雪工作台不限页面：登录页选中洛雪音源那一行就能开，开在播放页上面也说得通。
        lxWorkspace: {
            theme,
            isDaylight,
            onPlayTrack: handleSearchResultPlay,
            onAddToQueue: handleSearchResultAddToQueue,
        },
        searchOverlay: currentView === 'home'
            ? {
                theme,
                isDaylight,
                onClose: closeSearchView,
                onSubmitSearch: handleSearchOverlaySubmit,
                onLoadMore: handleSearchLoadMore,
                onPlayTrack: handleSearchResultPlay,
                onAddTrackToQueue: handleSearchResultAddToQueue,
                onOpenArtist: handleSearchResultArtistOpen,
                onOpenAlbum: handleSearchResultAlbumOpen,
                onOpenCollection: handleSearchResultCollectionOpen,
                resolveTrackDisplay: resolveSearchResultDisplay,
                hasLocalSongs,
            }
            : null,
        // 听歌档案不按页面门控：它读的是已经落库的播放记录，从命令面板在任何页面上都能打开。
        // 关闭走 store（这一层没有别处能关它的动作），和搜索 overlay 的 closeSearchView 一样是
        // 「关掉那一个功能自己的展开状态」。
        listeningArchiveOverlay: isListeningArchiveOpen
            ? {
                theme,
                isDaylight,
                onClose: () => useListeningArchiveStore.getState().close(),
            }
            : null,
        // Not gated on the view, and that was a real hole: the app cold-starts on the home page,
        // so after a restart the chord opened nothing until something had been played - which
        // reads exactly like the switch in Settings having lost its setting. This overlay is the
        // only console the packaged build has, and the pages it could not be opened from are the
        // ones where a problem stops you ever reaching the player.
        debugOverlay: isDevDebugOverlayVisible && devDebugSnapshot
            ? {
                snapshot: devDebugSnapshot,
                currentTime,
                lyricCurrentTime,
                isDaylight,
                onClose: () => setIsDevDebugOverlayVisible(false),
            }
            : null,
        // Independent of the log window on purpose: they answer different questions and are read side
        // by side. Closing either one stops neither the console buffer nor the sampling behind it.
        memoryMonitor: isMemoryMonitorVisible
            ? {
                isDaylight,
                shortcutLabel: memoryMonitorShortcutLabel,
                onClose: () => setIsMemoryMonitorVisible(false),
            }
            : null,
        floatingControls: currentSong
            ? {
                currentSong,
                playerState,
                currentTime,
                lyricCurrentTime,
                duration,
                loopMode: effectiveLoopMode,
                currentView,
                audioSrc,
                canTogglePlay: canToggleCurrentPlayback,
                controlsDisabled: isNowPlayingControlDisabled,
                lyrics,
                // 展开的紧凑胶囊拿它画封面和封面旁边的字（歌手 / 专辑，预告时是下一首）。
                // 和上面那个 toast 是同一份数据、同一个「能不能在这一页出现」的判断；
                // toast 那边几个字段是可选的，胶囊要的是填好的值，所以在这里逐个补齐。
                card: nowPlayingToast
                    ? {
                        song: nowPlayingToast.song,
                        trackKey: nowPlayingToast.trackKey,
                        nextUp: nowPlayingToast.nextUp ?? null,
                        isNextUp: nowPlayingToast.isNextUp ?? false,
                        mode: nowPlayingToast.mode ?? 'auto',
                        timeoutSec: nowPlayingToast.timeoutSec ?? 10,
                        onActivate: nowPlayingToast.onActivate,
                        activateLabel: nowPlayingToast.activateLabel,
                    }
                    : null,
                // 播放页胶囊上的定位按钮：回到歌曲墙上正在放的那一首。
                onFocusLatticeCurrentSong: locatePlayingSongOnWall,
                onSeek: (time) => {
                    if (isNowPlayingControlDisabled) {
                        return;
                    }

                    if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
                        syncStageLyricsClock(time, duration, playerState, stageLyricsClockRef.current.startTimeSec);
                        currentTime.set(time);
                        if (playerState !== PlayerState.PLAYING) {
                            setPlayerState(PlayerState.PLAYING);
                        }
                        void onStagePlayerSeek();
                    } else {
                        onSeekMainAudio(time);
                    }
                },
                onTogglePlay: togglePlay,
                onToggleLoop: toggleLoop,
                onNavigateToPlayer: navigateFromPlayerCapsule,
                noTrackText,
                primaryColor: 'var(--text-primary)',
                secondaryColor: 'var(--text-secondary)',
                theme,
                isDaylight,
                isHidden: currentView === 'player' && isPlayerChromeHidden,
                // 搜索页盖住整屏、又不给列表末尾留出胶囊的净空，「查看更多」就在胶囊底下。
                // 往下滚时把它收到屏幕下面，往上滚（或关掉搜索页）再放回来。
                isScrollHidden: currentView === 'home' && isSearchOpen && isSearchResultsBarHidden,
                hideControlBar: shouldHidePlayerProgressBar,
                slotPrimary: playerControlSlotPrimary,
                slotSecondary: playerControlSlotSecondary,
                slotContext: playerControlSlotContext,
                onCommitBottomBarOffset: onCommitPlayerBottomBarOffset,
                trackNavigation: ((): FloatingControlsProps['trackNavigation'] => {
                    const neighbors = resolvePlaybackNeighbors({
                        playQueue,
                        currentSong,
                        loopMode: effectiveLoopMode,
                        isFmMode,
                        isStageActive: isNowPlayingStageActive,
                    });

                    return {
                        currentTrackKey: getPlaybackSongKey(currentSong),
                        onPrev: handlePrevTrack,
                        onNext: handleNextTrack,
                        canPrev: neighbors.prev.canGo && !isNowPlayingControlDisabled,
                        canNext: neighbors.next.canGo && !isNowPlayingControlDisabled,
                        prevTitle: neighbors.prev.title,
                        nextTitle: neighbors.next.title,
                        prevLabel: prevTrackLabel,
                        nextLabel: nextTrackLabel,
                    };
                })(),
            }
            : null,
    };
};
