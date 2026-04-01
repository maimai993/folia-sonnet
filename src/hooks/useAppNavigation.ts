import { useEffect, useState } from 'react';
import { NeteasePlaylist } from '../types';

type ViewState = 'home' | 'player';
const LAST_APP_VIEW_KEY = 'last_app_view';

export function useAppNavigation() {
    const [currentView, setCurrentView] = useState<ViewState>(() => {
        return localStorage.getItem(LAST_APP_VIEW_KEY) === 'player' ? 'player' : 'home';
    });
    const [selectedPlaylist, setSelectedPlaylist] = useState<NeteasePlaylist | null>(null);
    const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
    const [selectedArtistId, setSelectedArtistId] = useState<number | null>(null);

    useEffect(() => {
        const initialView = localStorage.getItem(LAST_APP_VIEW_KEY) === 'player' ? 'player' : 'home';
        window.history.replaceState({ view: initialView }, '', initialView === 'player' ? '#player' : '');
        setCurrentView(initialView);

        const handlePopState = (event: PopStateEvent) => {
            const state = event.state;

            if (!state || state.view === 'home') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                setSelectedPlaylist(null);
                setSelectedAlbumId(null);
                setSelectedArtistId(null);
                return;
            }

            if (state.view === 'player') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'player');
                setCurrentView('player');
                setSelectedPlaylist(null);
                setSelectedAlbumId(null);
                setSelectedArtistId(null);
                return;
            }

            if (state.view === 'playlist') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                setCurrentView('home');
                setSelectedAlbumId(null);
                setSelectedArtistId(null);
                return;
            }

            if (state.view === 'album') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                if (state.id) {
                    setSelectedAlbumId(state.id);
                    setCurrentView('home');
                    setSelectedArtistId(null);
                } else {
                    setCurrentView('home');
                    setSelectedAlbumId(null);
                }
                return;
            }

            if (state.view === 'artist') {
                localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
                if (state.id) {
                    setSelectedArtistId(state.id);
                    setCurrentView('home');
                } else {
                    setCurrentView('home');
                    setSelectedArtistId(null);
                }
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    const navigateToPlayer = () => {
        if (currentView !== 'player') {
            localStorage.setItem(LAST_APP_VIEW_KEY, 'player');
            window.history.pushState({ view: 'player' }, '', '#player');
            setCurrentView('player');
        }
    };

    const navigateToHome = () => {
        if (currentView !== 'home' || selectedPlaylist || selectedAlbumId) {
            localStorage.setItem(LAST_APP_VIEW_KEY, 'home');
            window.history.back();
        }
    };

    const handlePlaylistSelect = (playlist: NeteasePlaylist | null) => {
        if (playlist) {
            window.history.pushState({ view: 'playlist', id: playlist.id }, '', `#playlist/${playlist.id}`);
            setSelectedPlaylist(playlist);
            setSelectedAlbumId(null);
            setSelectedArtistId(null);
            setCurrentView('home');
            return;
        }

        window.history.back();
    };

    const handleAlbumSelect = (id: number | null) => {
        if (id) {
            window.history.pushState({ view: 'album', id }, '', `#album/${id}`);
            setSelectedAlbumId(id);
            setSelectedArtistId(null);
            setCurrentView('home');
            return;
        }

        window.history.back();
    };

    const handleArtistSelect = (id: number | null) => {
        if (id) {
            window.history.pushState({ view: 'artist', id }, '', `#artist/${id}`);
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
        handlePlaylistSelect,
        handleAlbumSelect,
        handleArtistSelect,
    };
}
