import React from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SongResult } from '../../types';

interface CoverTabProps {
    currentSong: SongResult | null;
    onAlbumSelect: (albumId: number) => void;
    onSelectArtist: (artistId: number) => void;
    onOpenCurrentLocalAlbum: () => void;
    onOpenCurrentLocalArtist: () => void;
    onOpenCurrentNavidromeAlbum: () => void;
    onOpenCurrentNavidromeArtist: () => void;
}

const CoverTab: React.FC<CoverTabProps> = ({
    currentSong,
    onAlbumSelect,
    onSelectArtist,
    onOpenCurrentLocalAlbum,
    onOpenCurrentLocalArtist,
    onOpenCurrentNavidromeAlbum,
    onOpenCurrentNavidromeArtist,
}) => {
    const { t } = useTranslation();
    const isLocalSong = Boolean(currentSong && (((currentSong as any).isLocal === true) || (currentSong as any).localData));
    const isNavidromeSong = Boolean(currentSong && (currentSong as any).isNavidrome === true);
    const displayArtists = currentSong?.ar?.length ? currentSong.ar : (currentSong?.artists || []);
    const displayAlbumName = currentSong?.al?.name || currentSong?.album?.name || '';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center text-center space-y-4 mt-4"
        >
            <div className="space-y-1 relative w-full">
                <div className="flex items-start justify-center gap-2">
                    <h2 className="text-2xl font-bold line-clamp-2">{currentSong?.name || t('ui.noTrack')}</h2>
                </div>
                <div className="text-sm opacity-60 space-y-1">
                    <div className="font-medium">
                        {displayArtists.map((a, i) => (
                            <React.Fragment key={a.id}>
                                {i > 0 && ", "}
                                <span
                                    className="cursor-pointer hover:underline hover:opacity-100 transition-opacity"
                                    onClick={() => {
                                        if (isLocalSong) {
                                            onOpenCurrentLocalArtist();
                                            return;
                                        }
                                        if (isNavidromeSong) {
                                            onOpenCurrentNavidromeArtist();
                                            return;
                                        }
                                        onSelectArtist(a.id);
                                    }}
                                >
                                    {a.name}
                                </span>
                            </React.Fragment>
                        ))}
                    </div>
                    <div
                        className="opacity-60 cursor-pointer hover:opacity-100 hover:underline transition-all"
                        onClick={() => {
                            if (isLocalSong) {
                                onOpenCurrentLocalAlbum();
                                return;
                            }
                            if (isNavidromeSong) {
                                onOpenCurrentNavidromeAlbum();
                                return;
                            }
                            const albumId = currentSong?.al?.id || currentSong?.album?.id;
                            if (albumId) {
                                onAlbumSelect(albumId);
                            }
                        }}
                    >
                        {displayAlbumName}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default CoverTab;
