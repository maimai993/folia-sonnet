import React from 'react';
import type { LibraryArtistSurfaceProps } from '../../../core/contracts/suite';
import { useGridMorphPlan } from '../transitions/useGridMorphPlan';
import ArtistGridView from './ArtistGridView';

// src/library/suites/grid/artist/GridArtistSurface.tsx
// 网格的歌手页 surface：把宿主的契约输入（LibraryArtistSurfaceProps）接到 ArtistGridView 的旧 props 上，
// 移形换影的入场计划由网格自己读。歌手数据是宿主交来的歌手资源（P4.1）。歌手页还没向命令面板发布动作，
// declaredActions 暂时不用。

const GridArtistSurface: React.FC<LibraryArtistSurfaceProps> = ({
    collection,
    resource,
    playback,
    theme,
    isDaylight,
    isInteractive,
    onEditEntity,
    onBack,
    onOpenAlbum,
    onOpenArtist,
}) => {
    const morphPlan = useGridMorphPlan();

    return (
        <ArtistGridView
            collection={collection}
            resource={resource}
            onBack={onBack}
            onSelectTrack={playback.playTrack}
            onAddTrackToQueue={playback.enqueueTrack}
            onPlayAll={playback.playAll}
            onAddAllToQueue={playback.enqueueAll}
            onSelectAlbum={onOpenAlbum}
            onSelectArtist={onOpenArtist}
            theme={theme}
            isDaylight={isDaylight}
            onEditEntity={onEditEntity}
            isInteractive={isInteractive}
            morphPlan={morphPlan}
        />
    );
};

export default GridArtistSurface;
