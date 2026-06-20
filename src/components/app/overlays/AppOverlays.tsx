import React from 'react';
import { AnimatePresence } from 'framer-motion';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import SearchResultsOverlay from '../../SearchResultsOverlay';
import DevDebugOverlay from '../../DevDebugOverlay';
import PlaylistView from '../views/PlaylistView';
import AlbumView from '../views/AlbumView';
import ArtistView from '../views/ArtistView';
import type { AppOverlaysModel } from './buildAppOverlaysModel';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    const {
        searchOverlay,
        detailOverlay,
        debugOverlay,
        floatingControls,
    } = model;

    return (
        <>
            {searchOverlay && <SearchResultsOverlay {...searchOverlay} />}

            <AnimatePresence>
                {detailOverlay && (() => {
                    const { type, props } = detailOverlay;
                    if (type === 'playlist') {
                        return <PlaylistView {...props} />;
                    }
                    if (type === 'album') {
                        return <AlbumView {...props} />;
                    }
                    return <ArtistView {...props} />;
                })()}
            </AnimatePresence>

            {debugOverlay && <DevDebugOverlay {...debugOverlay} />}

            {floatingControls && <FloatingPlayerControls {...floatingControls} />}
        </>
    );
};

export default AppOverlays;
