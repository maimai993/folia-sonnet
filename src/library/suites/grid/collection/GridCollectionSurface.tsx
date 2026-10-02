import React, { useMemo } from 'react';
import type { LibraryCollectionSurfaceProps } from '../../../core/contracts/suite';
import { useGridMorphPlan } from '../transitions/useGridMorphPlan';
import GridView from './GridView';
import { toGridViewSourceActions } from './gridViewSourceActions';

// src/library/suites/grid/collection/GridCollectionSurface.tsx
// 网格的集合 surface：把宿主交给任何 suite 的同一份输入（core/contracts/suite 的 LibraryCollectionSurfaceProps）
// 接到 GridView 的旧 props 上。网格专属的部分在这里补：移形换影的入场计划（自己从转场 store 读），
// P2.2 之前的 sourceActions（从变更端口转接）。标题、副标题的取法原样搬自 GridViewOverlayHost。

const GridCollectionSurface: React.FC<LibraryCollectionSurfaceProps> = ({
    collection,
    resource,
    playback,
    mutationPort,
    localSongs,
    theme,
    isDaylight,
    isInteractive,
    onStatusMessage,
    currentUserId,
    declaredActions,
    onBack,
    onOpenAlbum,
    onOpenArtist,
}) => {
    const morphPlan = useGridMorphPlan();
    const sourceActions = useMemo(() => toGridViewSourceActions(mutationPort), [mutationPort]);
    const subtitle = (collection as any).creator?.nickname || (collection as any).artists?.[0]?.name || collection.description || '';

    return (
        <GridView
            title={collection.name}
            subtitle={subtitle}
            collection={collection}
            mode="tracks"
            onBack={onBack}
            onSelectTrack={playback.playTrack}
            onAddTrackToQueue={playback.enqueueTrack}
            onPlayAll={playback.playAll}
            onAddAllToQueue={playback.enqueueAll}
            onSelectAlbum={onOpenAlbum}
            onSelectArtist={onOpenArtist}
            currentUserId={currentUserId}
            onPlaylistMutated={mutationPort.onCollectionMutated}
            onStatusMessage={onStatusMessage}
            resource={resource}
            localSongs={localSongs}
            sourceActions={sourceActions}
            theme={theme}
            isDaylight={isDaylight}
            isInteractive={isInteractive}
            morphPlan={morphPlan}
            declaredActions={declaredActions}
        />
    );
};

export default GridCollectionSurface;
