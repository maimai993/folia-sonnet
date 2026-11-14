import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import { useAccountReads } from '../../../hooks/useAccountReads';
import { useNeteaseLibrary } from '../../../hooks/useNeteaseLibrary';
import { createLibraryAccountSwitchCleanupPort } from '../../../library/app/createLibraryAccountPort';
import { useLibraryAccountController } from '../../../library/app/useLibraryAccountController';
import { resolveActiveProviderSummary } from '../../../library/core/account/accountRules';
import { selectAccountSyncPending, useLibraryAccountProviders, useLibraryAccountSelector } from '../../../library/core/account/useLibraryAccount';
import { omni } from '../../../services/onlineMusic/omni';
import { syncAccountData } from '../../login/syncAccountData';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { OnlineProviderId } from '../../../types/onlineMusic';
import { useProviderSignOut } from '../dialogs/useProviderSignOut';
import { useStagePlaybackController } from '../playback/useStagePlaybackController';
import { useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

// src/components/app/appWiring/useAppAccountsAndStage.ts
// 在线账户、平台同步、收藏集合与 Stage 播放控制器。

type Input = AppFoundation & AppAudioOutput & AppThemeAndNavigation;

export const useAppAccountsAndStage = (model: Input) => {
    const {
        audioRef, automixRef, blobUrlRef, currentOnlineAudioUrlFetchedAtRef, isDev, isElectronWindow, lastAudioRecoverySourceRef,
        navigateToPlayer, pendingResumeTimeRef, setIsLyricsLoading, setLyrics, setLyricsStable,
        shouldAutoPlay, t
    } = model;
    const {
        isSearchOpen,
        searchSourceTab,
        submitSearch,
        loadMoreSearchResults,
    } = useSearchNavigationStore(useShallow(state => ({
        isSearchOpen: state.isSearchOpen,
        searchSourceTab: state.searchSourceTab,
        submitSearch: state.submitSearch,
        loadMoreSearchResults: state.loadMoreSearchResults,
    })));

    // Netease Library Hook
    // the NetEase account as the account store holds it
    const {
        user,
        playlists,
        cloudPlaylist,
    } = useNeteaseLibrary();

    // Every platform's account is read and signed out of through omni (services/onlineMusic/account/),
    // NetEase like the others. One entry per platform registered at start; a mod's source has none.
    const onlineProviderRefreshers = useMemo<Partial<Record<OnlineProviderId, () => Promise<unknown>>>>(() => Object.fromEntries(
        omni.getProviderSummaries().map(({ providerId }) => [providerId, async () => await omni.readAccount(providerId, 'sync') === 'read']),
    ), []);
    // 在线账户 controller（Library v2 · A4）：登录、选平台、切换确认与登出都在 core，App 只交出退出与退出前的那一问
    // （useProviderSignOut），以及换平台时清空播放器的端口。端口读的句柄都是稳定引用，建一次。
    const { confirmLogout, signOut, dialog: signOutDialog } = useProviderSignOut();
    const [providerSwitchCleanup] = useState(() => createLibraryAccountSwitchCleanupPort(() => ({
        audioRef,
        automixRef,
        shouldAutoPlay,
        setLyrics: setLyricsStable,
        setIsLyricsLoading,
    })));
    const accountController = useLibraryAccountController({
        logout: signOut,
        confirmLogout,
        switchCleanup: providerSwitchCleanup,
    });
    const { providers: onlineProviders, activeProviderId } = useLibraryAccountProviders(accountController);
    const activeProvider = useMemo(
        () => resolveActiveProviderSummary(onlineProviders, activeProviderId),
        [activeProviderId, onlineProviders],
    );
    // 保留 App 对整张账户表的订阅（原先 useOnlineProviderPlatform 订阅它）：底栏与命令面板的收藏心形
    // （resolveSongLiked → omni.isSongLiked）经 getState 读各平台的 likedSongIds，账户摘要里没有它，
    // 只订阅 controller 快照的话收藏之后心形不会当场更新。取值没有用处。
    useOnlineProviderAccountStore(state => state.accounts);
    // 面板账户页的「同步数据」：经账户 controller 同步当前平台（和登录窗口账号那一幅同一条路，同一时间一个）。
    const isProviderSyncing = useLibraryAccountSelector(accountController, selectAccountSyncPending);
    const handleActiveProviderSyncData = useCallback(() => {
        void syncAccountData(accountController, activeProviderId, t);
    }, [accountController, activeProviderId, t]);
    const refreshActiveProviderPlaylists = useCallback(
        () => omni.refreshProviderPlaylists(activeProviderId),
        [activeProviderId],
    );
    useAccountReads();
    const {
        stageStatus,
        setStageStatus,
        stageSource,
        stageActiveEntryKind,
        stageLyricsSession,
        stageMediaSession,
        nowPlayingConnectionStatus,
        nowPlayingTrack,
        nowPlayingLyricPayload,
        nowPlayingProgressMs,
        nowPlayingProgressQuality,
        nowPlayingPaused,
        nowPlayingDebugInfo,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
        getPlayerCapDisplayTime,
        playerCapConnectionStatus,
        playerCapPlayers,
        mainPlaybackSnapshotRef,
        stageLyricsClockRef,
        syncStageLyricsClock,
        getSyntheticStageLyricsTime,
        syncNowPlayingClock,
        getNowPlayingDisplayTime,
        loadStageSessionIntoPlayback,
        restoreStagePlaybackHandoff,
        clearPersistedStagePlaybackCache,
        openStagePlayer,
        leaveStagePlayback,
        interruptStagePlaybackForMainTransition,
        clearStagePlaybackSession,
    } = useStagePlaybackController({
        isDev,
        isElectronWindow,
        audioRef,
        blobUrlRef,
        shouldAutoPlayRef: shouldAutoPlay,
        pendingResumeTimeRef,
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef,
        setLyrics,
        setIsLyricsLoading,
        navigateToPlayer,
    });

    return {
        ...model,
        accountController, activeProvider, activeProviderId, clearPersistedStagePlaybackCache,
        clearStagePlaybackSession, cloudPlaylist, getNowPlayingDisplayTime, getPlayerCapDisplayTime,
        getSyntheticStageLyricsTime, handleActiveProviderSyncData, interruptStagePlaybackForMainTransition,
        isNowPlayingStageActive, isPlayerCapStageActive, isProviderSyncing, isSearchOpen, leaveStagePlayback,
        loadMoreSearchResults, loadStageSessionIntoPlayback, mainPlaybackSnapshotRef, nowPlayingConnectionStatus,
        nowPlayingDebugInfo, nowPlayingLyricPayload, nowPlayingPaused, nowPlayingProgressMs,
        nowPlayingProgressQuality, nowPlayingTrack, onlineProviders, openStagePlayer, playerCapConnectionStatus,
        playerCapPlayers, playlists, refreshActiveProviderPlaylists, restoreStagePlaybackHandoff, searchSourceTab,
        setStageStatus, signOutDialog, stageActiveEntryKind, stageLyricsClockRef, stageLyricsSession, stageSource,
        stageStatus, submitSearch, syncNowPlayingClock, syncStageLyricsClock, user
    };
};

export type AppAccountsAndStage = ReturnType<typeof useAppAccountsAndStage>;
