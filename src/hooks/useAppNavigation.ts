import { useEffect, useState } from 'react';
import type { HomeViewTab, NeteasePlaylist } from '../types';
import { useSearchNavigationStore } from '../stores/useSearchNavigationStore';

type ViewState = 'home' | 'player';

type NavigationHistoryState =
    | { view: 'home'; }
    | { view: 'player'; }
    | { view: 'search'; query: string; sourceTab: HomeViewTab; }
    | { view: 'playlist'; id: number; }
    | { view: 'album'; id: number; }
    | { view: 'artist'; id: number; };

const LAST_APP_VIEW_KEY = 'last_app_view';

export function useAppNavigation() {
    const [currentView, setCurrentView] = useState<ViewState>('home');
    const [selectedPlaylist, setSelectedPlaylist] = useState<NeteasePlaylist | null>(null);
    const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
    const [selectedArtistId, setSelectedArtistId] = useState<number | null>(null);

    const clearDetailSelections = () => {
        setSelectedPlaylist(null);
        setSelectedAlbumId(null);
        setSelectedArtistId(null);
    };

    const resetToHomeState = () => {
        localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
        window.history.replaceState({ view: 'home' } satisfies NavigationHistoryState, '', window.location.pathname + window.location.search);
        setCurrentView('home');
        clearDetailSelections();
        useSearchNavigationStore.getState().hideSearchOverlay();
    };

    useEffect(() => {
        resetToHomeState();

        const handlePopState = (event: PopStateEvent) => {
            const state = event.state as NavigationHistoryState | null;

            if (!state || state.view === 'home') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                clearDetailSelections();
                useSearchNavigationStore.getState().hideSearchOverlay();
                return;
            }

            if (state.view === 'player') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'player');
                setCurrentView('player');
                clearDetailSelections();
                return;
            }

            if (state.view === 'search') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                clearDetailSelections();
                useSearchNavigationStore.getState().restoreSearch({
                    query: state.query,
                    sourceTab: state.sourceTab,
                });
                return;
            }

            if (state.view === 'playlist') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                setSelectedAlbumId(null);
                setSelectedArtistId(null);
                useSearchNavigationStore.getState().hideSearchOverlay();
                return;
            }

            if (state.view === 'album') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                setSelectedPlaylist(null);
                setSelectedAlbumId(state.id || null);
                setSelectedArtistId(null);
                useSearchNavigationStore.getState().hideSearchOverlay();
                return;
            }

            if (state.view === 'artist') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                setSelectedPlaylist(null);
                setSelectedAlbumId(null);
                setSelectedArtistId(state.id || null);
                useSearchNavigationStore.getState().hideSearchOverlay();
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    const navigateToPlayer = () => {
        if (currentView !== 'player') {
            localStorage.setItem(LAST_APP_VIEW_KEY, 'player');
            window.history.pushState({ view: 'player' } satisfies NavigationHistoryState, '', '#player');
            setCurrentView('player');
        }
    };

    const navigateToSearch = ({
        query,
        sourceTab,
        replace = false,
    }: {
        query: string;
        sourceTab: HomeViewTab;
        replace?: boolean;
    }) => {
        const method = replace ? window.history.replaceState : window.history.pushState;
        method(
            { view: 'search', query, sourceTab } satisfies NavigationHistoryState,
            '',
            `#search/${encodeURIComponent(query)}`
        );
        localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
        setCurrentView('home');
        clearDetailSelections();
        useSearchNavigationStore.getState().restoreSearch({ query, sourceTab });
    };

    const closeSearchView = () => {
        useSearchNavigationStore.getState().hideSearchOverlay();

        if (window.history.state?.view === 'search') {
            window.history.back();
            return;
        }

        localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
        setCurrentView('home');
    };

    const navigateToHome = () => {
        if (currentView !== 'home' || selectedPlaylist || selectedAlbumId || selectedArtistId) {
            localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
            if (window.history.state?.view === 'player') {
                window.history.back();
                return;
            }

            resetToHomeState();
        }
    };

    const handlePlaylistSelect = (playlist: NeteasePlaylist | null) => {
        useSearchNavigationStore.getState().hideSearchOverlay();

        if (playlist) {
            window.history.pushState({ view: 'playlist', id: playlist.id } satisfies NavigationHistoryState, '', `#playlist/${playlist.id}`);
            setSelectedPlaylist(playlist);
            setSelectedAlbumId(null);
            setSelectedArtistId(null);
            setCurrentView('home');
            return;
        }

        window.history.back();
    };

    const handleAlbumSelect = (id: number | null) => {
        useSearchNavigationStore.getState().hideSearchOverlay();

        if (id) {
            window.history.pushState({ view: 'album', id } satisfies NavigationHistoryState, '', `#album/${id}`);
            setSelectedAlbumId(id);
            setSelectedArtistId(null);
            setCurrentView('home');
            return;
        }

        window.history.back();
    };

    const handleArtistSelect = (id: number | null) => {
        useSearchNavigationStore.getState().hideSearchOverlay();

        if (id) {
            window.history.pushState({ view: 'artist', id } satisfies NavigationHistoryState, '', `#artist/${id}`);
            setSelectedArtistId(id);
            setCurrentView('home');
            return;
        }

        window.history.back();
    };

    return {
        currentView,
        selectedPlaylist,
        selectedAlbumId,
        selectedArtistId,
        navigateToPlayer,
        navigateToHome,
        navigateToSearch,
        closeSearchView,
        handlePlaylistSelect,
        handleAlbumSelect,
        handleArtistSelect,
    };
}
