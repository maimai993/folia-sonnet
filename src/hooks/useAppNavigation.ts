import { useCallback, useEffect, useState } from 'react';
import type { LocalLibraryGroup } from '../types';
import {
    type SearchReturnView,
    type SearchSource,
    useSearchNavigationStore,
} from '../stores/useSearchNavigationStore';
import {
    type CollectionNavigationOrigin,
    type CollectionNavigationSnapshot,
    notifyCollectionPop,
    useCollectionNavigationStore,
} from '../stores/useCollectionNavigationStore';
import type { GridViewCollectionDescriptor } from '../library/core/contracts/collection';
import { collectionHashPath } from '../library/core/model/collectionIdentity';
import { useAppViewStore } from '../stores/useAppViewStore';
import type { AppView } from '../stores/useAppViewStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { usePlaybackEntryViewStore } from '../stores/usePlaybackEntryViewStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import i18n from '../i18n/config';

// src/hooks/useAppNavigation.ts

type ViewState = AppView;

type LocalMusicNavigationState = {
    activeRow: 0 | 1 | 2 | 3;
    selectedGroup: LocalLibraryGroup | null;
    detailStack: LocalLibraryGroup[];
    detailOriginView: 'home' | 'player' | null;
    focusedFolderIndex: number;
    focusedAlbumIndex: number;
    focusedArtistIndex: number;
    focusedPlaylistIndex: number;
};

export type NavigationHistoryState = {
    view: ViewState;
    search?: { query: string; sourceTab: SearchSource; returnView?: SearchReturnView; } | null;
    collection?: CollectionNavigationSnapshot | null;
    appHistoryIndex: number;
};

const LAST_APP_VIEW_KEY = 'last_app_view';
const OPEN_PLAYER_ON_LAUNCH_KEY = 'open_player_on_launch';

const buildHistoryState = (
    view: ViewState,
    search: NavigationHistoryState['search'] = null,
    collection: NavigationHistoryState['collection'] = null,
    appHistoryIndex = 0,
): NavigationHistoryState => ({
    view,
    search,
    collection,
    appHistoryIndex,
});

const getAppHistoryIndex = (state: unknown): number => {
    if (!state || typeof state !== 'object') return 0;
    const index = (state as Partial<NavigationHistoryState>).appHistoryIndex;
    return typeof index === 'number' && Number.isFinite(index) && index >= 0 ? index : 0;
};

export const shouldNavigatePlayerBackThroughHistory = (
    state: NavigationHistoryState | null,
): boolean => state?.view === 'player' && getAppHistoryIndex(state) > 0;

export const shouldReplacePlayerNavigation = (
    state: NavigationHistoryState | null,
): boolean => state?.view === 'player';

export const resolvePlayerCapsuleNavigationTarget = (
    view: ViewState,
    playbackEntryView: 'player' | 'lattice',
    isFmMode: boolean,
): 'player' | 'lattice' | null => {
    if (view === 'lattice') return null;
    return playbackEntryView === 'lattice' && !isFmMode ? 'lattice' : 'player';
};

const getSearchHistorySnapshot = (): NavigationHistoryState['search'] => {
    const searchState = useSearchNavigationStore.getState();
    return searchState.isSearchOpen
        ? {
            query: searchState.searchQuery,
            sourceTab: searchState.searchSourceTab,
            returnView: searchState.searchReturnView,
        }
        : null;
};

/**
 * Which view a launch lands on. "Open player on launch" means "open the playback surface", so it
 * follows the stored playback entry preference and reuses the capsule's Lattice rule: Lattice only
 * when it can actually show something (non-empty queue, not FM), otherwise the player.
 */
export const resolveStartupView = ({
    openPlayerOnLaunch,
    playbackEntryView,
    isFmMode,
    queueLength,
}: {
    openPlayerOnLaunch: boolean;
    playbackEntryView: 'player' | 'lattice';
    isFmMode: boolean;
    queueLength: number;
}): 'home' | 'player' | 'lattice' => {
    if (!openPlayerOnLaunch) return 'home';
    if (queueLength <= 0) return 'player';
    return resolvePlayerCapsuleNavigationTarget('home', playbackEntryView, isFmMode) ?? 'player';
};

/** Whether a launch wanted Lattice but had to start on the player because the queue was not restored yet. */
export const isStartupLatticeDeferred = ({
    openPlayerOnLaunch,
    playbackEntryView,
    isFmMode,
}: {
    openPlayerOnLaunch: boolean;
    playbackEntryView: 'player' | 'lattice';
    isFmMode: boolean;
}): boolean => openPlayerOnLaunch && playbackEntryView === 'lattice' && !isFmMode;

// The last session is restored asynchronously (IndexedDB), so the queue is still empty when the
// startup view is chosen; a deferred Lattice launch waits at most this long for it.
const STARTUP_LATTICE_RESTORE_WINDOW_MS = 10000;

const getStartupView = (): ViewState => resolveStartupView({
    openPlayerOnLaunch: localStorage.getItem(OPEN_PLAYER_ON_LAUNCH_KEY) === 'true',
    playbackEntryView: usePlaybackEntryViewStore.getState().playbackEntryView,
    isFmMode: usePlaybackStore.getState().isFmMode,
    queueLength: usePlaybackStore.getState().playQueue.length,
});

const LOCAL_MUSIC_LAST_ROW_KEY = 'folia_local_music_last_row';

export const blockLatticeNavigationInFm = (): boolean => {
    if (!usePlaybackStore.getState().isFmMode) return false;
    setStatusMessage({ type: 'info', text: i18n.t('status.latticeUnavailableInFm') });
    return true;
};

export function useAppNavigation() {
    // The view itself lives in useAppViewStore so that consumers far from here can read it
    // without being handed it; this hook stays the only writer.
    const currentView = useAppViewStore(state => state.view);
    const setCurrentView = useAppViewStore(state => state.setView);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const [focusedPlaylistIndex, setFocusedPlaylistIndex] = useState(0);
    const [navidromeFocusedAlbumIndex, setNavidromeFocusedAlbumIndex] = useState(0);
    const [localMusicState, setLocalMusicState] = useState<LocalMusicNavigationState>(() => {
        let savedRow = 0;
        try {
            const saved = localStorage.getItem(LOCAL_MUSIC_LAST_ROW_KEY);
            if (saved !== null) {
                const parsed = parseInt(saved, 10);
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 3) {
                    savedRow = parsed;
                }
            }
        } catch (e) {
            console.warn('[useAppNavigation] Failed to restore local music last row:', e);
        }
        return {
            activeRow: savedRow as LocalMusicNavigationState['activeRow'],
            selectedGroup: null,
            detailStack: [],
            detailOriginView: null,
            focusedFolderIndex: 0,
            focusedAlbumIndex: 0,
            focusedArtistIndex: 0,
            focusedPlaylistIndex: 0,
        };
    });

    useEffect(() => {
        try {
            localStorage.setItem(LOCAL_MUSIC_LAST_ROW_KEY, localMusicState.activeRow.toString());
        } catch (e) {
            console.warn('[useAppNavigation] Failed to save local music last row:', e);
        }
    }, [localMusicState.activeRow]);

    const restoreHistoryState = useCallback((state: NavigationHistoryState) => {
        localStorage.setItem(LAST_APP_VIEW_KEY, state.view);
        setCurrentView(state.view);
        useCollectionNavigationStore.getState().restore(state.collection ?? null);
        if (state.search) {
            useSearchNavigationStore.getState().restoreSearch(state.search);
        } else {
            useSearchNavigationStore.getState().hideSearchOverlay();
        }
    }, [setCurrentView]);

    const pushNavigationState = useCallback(({
        view,
        replace = false,
        hash,
        search = null,
        collection = null,
    }: {
        view: ViewState;
        replace?: boolean;
        hash?: string;
        search?: NavigationHistoryState['search'];
        collection?: NavigationHistoryState['collection'];
    }) => {
        const currentHistoryIndex = getAppHistoryIndex(window.history.state);
        const nextState = buildHistoryState(
            view,
            search,
            collection,
            replace ? currentHistoryIndex : currentHistoryIndex + 1,
        );
        const method = replace ? window.history.replaceState.bind(window.history) : window.history.pushState.bind(window.history);
        method(nextState, '', hash ?? window.location.hash);
        restoreHistoryState(nextState);
    }, [restoreHistoryState]);

    const resetLocalNavigationContext = useCallback(() => {
        setLocalMusicState(prev => ({
            ...prev,
            activeRow: 0,
            selectedGroup: null,
            detailStack: [],
            detailOriginView: null,
        }));
    }, []);

    useEffect(() => {
        const initialView = getStartupView();
        const initialState = buildHistoryState(initialView);
        window.history.replaceState(
            initialState,
            '',
            initialView === 'player' ? '#player' : initialView === 'lattice' ? '#lattice' : (window.location.pathname + window.location.search),
        );
        restoreHistoryState(initialState);
        resetLocalNavigationContext();

        // A Lattice launch cannot be decided up front: the queue arrives after the session restore.
        // Start on the player (as before) and swap to Lattice in place once the queue lands, but only
        // if the listener has not moved on, so this never overrides a navigation they made.
        let unsubscribeDeferredLattice: (() => void) | null = null;
        let deferredLatticeTimer: ReturnType<typeof setTimeout> | null = null;
        const cancelDeferredLattice = () => {
            unsubscribeDeferredLattice?.();
            unsubscribeDeferredLattice = null;
            if (deferredLatticeTimer !== null) clearTimeout(deferredLatticeTimer);
            deferredLatticeTimer = null;
        };
        const startupOptions = {
            openPlayerOnLaunch: localStorage.getItem(OPEN_PLAYER_ON_LAUNCH_KEY) === 'true',
            playbackEntryView: usePlaybackEntryViewStore.getState().playbackEntryView,
            isFmMode: usePlaybackStore.getState().isFmMode,
        };
        if (initialView === 'player' && isStartupLatticeDeferred(startupOptions)) {
            const tryUpgrade = () => {
                const playback = usePlaybackStore.getState();
                const historyState = window.history.state as NavigationHistoryState | null;
                const stillOnStartupEntry = useAppViewStore.getState().view === 'player'
                    && historyState?.view === 'player'
                    && getAppHistoryIndex(historyState) === 0;
                if (!stillOnStartupEntry || playback.isFmMode) {
                    cancelDeferredLattice();
                    return;
                }
                if (playback.playQueue.length === 0) return;
                cancelDeferredLattice();
                const target = resolveStartupView({
                    ...startupOptions,
                    isFmMode: playback.isFmMode,
                    queueLength: playback.playQueue.length,
                });
                if (target !== 'lattice') return;
                const upgradedState = buildHistoryState('lattice');
                window.history.replaceState(upgradedState, '', '#lattice');
                restoreHistoryState(upgradedState);
            };
            unsubscribeDeferredLattice = usePlaybackStore.subscribe(tryUpgrade);
            deferredLatticeTimer = setTimeout(cancelDeferredLattice, STARTUP_LATTICE_RESTORE_WINDOW_MS);
        }

        const handlePopState = (event: PopStateEvent) => {
            const state = event.state as NavigationHistoryState | null;
            if (!state) {
                const fallbackState = buildHistoryState(getStartupView());
                window.history.replaceState(fallbackState, '', fallbackState.view === 'player' ? '#player' : fallbackState.view === 'lattice' ? '#lattice' : '#home');
                restoreHistoryState(fallbackState);
                return;
            }
            // 历史后退弹掉集合层时（浏览器后退，或应用内返回走的 history.back()），先在 store 变化之前通知：
            // 集合宿主据此让渲染这一层的 suite 跑 beforeBack（网格的反向移形换影），和应用内返回一致。
            notifyCollectionPop(state.collection ?? null);
            restoreHistoryState(state);
        };

        window.addEventListener('popstate', handlePopState);
        return () => {
            cancelDeferredLattice();
            window.removeEventListener('popstate', handlePopState);
        };
    }, []);

    const navigateToPlayer = useCallback(() => {
        const collection = useCollectionNavigationStore.getState().snapshot;
        const search = getSearchHistorySnapshot();
        const historyState = window.history.state as NavigationHistoryState | null;
        pushNavigationState({
            view: 'player',
            replace: shouldReplacePlayerNavigation(historyState),
            hash: '#player',
            search,
            collection,
        });
    }, [pushNavigationState]);

    useEffect(() => {
        if (!isFmMode || currentView !== 'lattice') return;
        const collection = useCollectionNavigationStore.getState().snapshot;
        const search = getSearchHistorySnapshot();
        // FM owns and extends its queue dynamically, so replace a stale Lattice entry instead of
        // leaving it in browser history where Back would immediately reopen an unsupported view.
        pushNavigationState({ view: 'player', replace: true, hash: '#player', search, collection });
    }, [currentView, isFmMode, pushNavigationState]);

    const navigateToHome = useCallback(() => {
        if (useAppViewStore.getState().view === 'home') {
            return;
        }
        const collection = useCollectionNavigationStore.getState().snapshot;
        const search = getSearchHistorySnapshot();
        pushNavigationState({
            view: 'home',
            hash: collection?.stack.length
                ? collectionHashPath(collection.stack[collection.stack.length - 1])
                : '#home',
            search,
            collection,
        });
    }, [pushNavigationState]);

    const navigateToLattice = useCallback(() => {
        if (blockLatticeNavigationInFm()) return;
        if (useAppViewStore.getState().view === 'lattice') return;
        useSearchNavigationStore.getState().hideSearchOverlay();
        pushNavigationState({
            view: 'lattice',
            hash: '#lattice',
        });
    }, [pushNavigationState]);

    /**
     * Where starting a song lands. Reads the stored preference rather than each caller deciding,
     * so every "play this" path agrees on one answer.
     *
     * Only redirects when the listener is arriving from somewhere else. Player and Lattice are both
     * playback surfaces, and this also runs on auto-advance — moving someone from the one they are
     * watching to the other because a track ended would be the setting reaching too far.
     *
     * FM falls back to the player silently: Lattice cannot show an FM queue, and the usual
     * "unavailable in FM" toast would be noise when nobody asked to open it.
     */
    const navigateToPlaybackView = useCallback(() => {
        const view = useAppViewStore.getState().view;
        if (view === 'lattice') return;
        const entryView = usePlaybackEntryViewStore.getState().playbackEntryView;
        if (entryView === 'lattice' && view !== 'player' && !usePlaybackStore.getState().isFmMode) {
            navigateToLattice();
            return;
        }
        navigateToPlayer();
    }, [navigateToLattice, navigateToPlayer]);

    const navigateFromPlayerCapsule = useCallback(() => {
        const target = resolvePlayerCapsuleNavigationTarget(
            useAppViewStore.getState().view,
            usePlaybackEntryViewStore.getState().playbackEntryView,
            usePlaybackStore.getState().isFmMode,
        );
        if (target === 'lattice') {
            navigateToLattice();
        } else if (target === 'player') {
            navigateToPlayer();
        }
    }, [navigateToLattice, navigateToPlayer]);

    const navigateBackFromLattice = useCallback(() => {
        const state = window.history.state as NavigationHistoryState | null;
        if (state?.view === 'lattice' && getAppHistoryIndex(state) > 0) {
            window.history.back();
            return;
        }
        navigateToHome();
    }, [navigateToHome]);

    const navigateDirectHome = useCallback((options?: { clearContext?: boolean; }) => {
        const clearContext = options?.clearContext ?? true;
        if (clearContext) {
            resetLocalNavigationContext();
        }
        useSearchNavigationStore.getState().hideSearchOverlay();
        useCollectionNavigationStore.getState().clear();
        pushNavigationState({
            view: 'home',
            replace: true,
            hash: window.location.pathname + window.location.search,
        });
    }, [pushNavigationState, resetLocalNavigationContext]);

    const navigateBackFromPlayer = useCallback(() => {
        const historyState = window.history.state as NavigationHistoryState | null;
        if (shouldNavigatePlayerBackThroughHistory(historyState)) {
            window.history.back();
            return;
        }
        navigateDirectHome();
    }, [navigateDirectHome]);

    const navigateToSearch = useCallback(({
        query,
        sourceTab,
        replace = false,
        returnView = 'home',
    }: {
        query: string;
        sourceTab: SearchSource;
        replace?: boolean;
        returnView?: SearchReturnView;
    }) => {
        useCollectionNavigationStore.getState().clear();
        const search = { query, sourceTab, returnView };
        pushNavigationState({
            view: 'home',
            replace,
            hash: `#search/${encodeURIComponent(query)}`,
            search,
        });
    }, [pushNavigationState]);

    const closeSearchView = useCallback(() => {
        const searchReturnView = useSearchNavigationStore.getState().searchReturnView;
        useSearchNavigationStore.getState().hideSearchOverlay();
        pushNavigationState({
            view: searchReturnView,
            replace: true,
            hash: searchReturnView === 'player'
                ? '#player'
                : window.location.pathname + window.location.search,
        });
    }, [pushNavigationState]);

    const navigateToCollection = useCallback((
        collection: GridViewCollectionDescriptor,
        origin: CollectionNavigationOrigin,
    ) => {
        const snapshot = useCollectionNavigationStore.getState().openRoot(collection, origin);
        const search = origin === 'search' ? getSearchHistorySnapshot() : null;
        pushNavigationState({
            view: 'home',
            hash: collectionHashPath(collection),
            search,
            collection: snapshot,
        });
    }, [pushNavigationState]);

    const pushCollection = useCallback((collection: GridViewCollectionDescriptor) => {
        const snapshot = useCollectionNavigationStore.getState().push(collection);
        if (!snapshot) {
            return;
        }
        pushNavigationState({
            view: 'home',
            hash: collectionHashPath(collection),
            search: snapshot.origin === 'search' ? getSearchHistorySnapshot() : null,
            collection: snapshot,
        });
    }, [pushNavigationState]);

    const backCollection = useCallback(() => {
        const snapshot = useCollectionNavigationStore.getState().snapshot;
        if (!snapshot) {
            return;
        }
        if (window.history.state?.collection) {
            window.history.back();
            return;
        }

        const nextStack = snapshot.stack.slice(0, -1);
        if (nextStack.length > 0) {
            const next = { ...snapshot, stack: nextStack };
            notifyCollectionPop(next);
            useCollectionNavigationStore.getState().restore(next);
            return;
        }
        notifyCollectionPop(null);
        useCollectionNavigationStore.getState().clear();
        if (snapshot.origin === 'player') {
            setCurrentView('player');
        }
    }, [setCurrentView]);

    return {
        currentView,
        focusedPlaylistIndex,
        setFocusedPlaylistIndex,
        navidromeFocusedAlbumIndex,
        setNavidromeFocusedAlbumIndex,
        localMusicState,
        setLocalMusicState,
        navigateToPlayer,
        navigateToPlaybackView,
        navigateFromPlayerCapsule,
        navigateToHome,
        navigateToLattice,
        navigateBackFromLattice,
        navigateBackFromPlayer,
        navigateDirectHome,
        navigateToSearch,
        closeSearchView,
        navigateToCollection,
        pushCollection,
        backCollection,
    };
}
