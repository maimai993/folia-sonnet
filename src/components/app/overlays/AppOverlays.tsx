import React from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import SearchWorkspace from '../search/SearchWorkspace';
import ListeningArchive from '../listeningArchive/ListeningArchive';
import DevDebugOverlay from '../../DevDebugOverlay';
import MemoryMonitorWindow from '../../debug/MemoryMonitorWindow';
import NowPlayingToast from './NowPlayingToast';
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    const isCurrentSongPosterVisible = useLatticeControlsStore(state => state.isCurrentSongPosterVisible);
    const {
        searchOverlay,
        listeningArchiveOverlay,
        debugOverlay,
        memoryMonitor,
        floatingControls,
        nowPlayingToast,
    } = model;

    return (
        <>
            {searchOverlay && <SearchWorkspace {...searchOverlay} />}

            {listeningArchiveOverlay && <ListeningArchive {...listeningArchiveOverlay} />}

            {debugOverlay && <DevDebugOverlay {...debugOverlay} />}

            {memoryMonitor && <MemoryMonitorWindow {...memoryMonitor} />}

            {floatingControls
                && (floatingControls.currentView !== 'lattice' || !isCurrentSongPosterVisible)
                && <FloatingPlayerControls {...floatingControls} />}

            {nowPlayingToast && <NowPlayingToast {...nowPlayingToast} />}
        </>
    );
};

export default React.memo(AppOverlays);
