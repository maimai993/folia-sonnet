import React from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { LocalPlaylist, SongResult } from '../../types';

interface CoverTabProps {
    currentSong: SongResult | null;
    onAlbumSelect: (albumId: number) => void;
    onSelectArtist: (artistId: number) => void;
    localPlaylists: LocalPlaylist[];
    onAddCurrentSongToLocalPlaylist: (playlistId: string) => Promise<void>;
    onOpenCurrentLocalAlbum: () => void;
    onOpenCurrentLocalArtist: () => void;
}

const CoverTab: React.FC<CoverTabProps> = ({
    currentSong,
    onAlbumSelect,
    onSelectArtist,
    localPlaylists,
    onAddCurrentSongToLocalPlaylist,
    onOpenCurrentLocalAlbum,
    onOpenCurrentLocalArtist,
}) => {
    const { t } = useTranslation();
    const [isPlaylistPickerOpen, setIsPlaylistPickerOpen] = React.useState(false);
    const isLocalSong = Boolean(currentSong && (((currentSong as any).isLocal === true) || (currentSong as any).localData));

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center text-center space-y-4 mt-4"
        >
            <div className="space-y-1 relative w-full">
                <div className="flex items-start justify-center gap-2">
                    <h2 className="text-2xl font-bold line-clamp-2">{currentSong?.name || t('ui.noTrack')}</h2>
                    {isLocalSong && localPlaylists.length > 0 && (
                        <div className="relative shrink-0">
                            <button
                                type="button"
                                onClick={() => setIsPlaylistPickerOpen(open => !open)}
                                className="mt-1 p-1 rounded-full opacity-50 hover:opacity-100 hover:bg-white/10 transition-all"
                                title={t('localMusic.addToPlaylist') || '添加到歌单'}
                            >
                                <Plus size={14} />
                            </button>
                            {isPlaylistPickerOpen && (
                                <div className="absolute right-0 top-8 w-48 rounded-2xl border border-white/10 bg-black/70 backdrop-blur-xl p-2 shadow-2xl z-10">
                                    {localPlaylists.map(playlist => (
                                        <button
                                            key={playlist.id}
                                            type="button"
                                            onClick={async () => {
                                                try {
                                                    await onAddCurrentSongToLocalPlaylist(playlist.id);
                                                } catch (error) {
                                                    console.error('Failed to add song to local playlist', error);
                                                }
                                                setIsPlaylistPickerOpen(false);
                                            }}
                                            className="w-full text-left px-3 py-2 rounded-xl text-sm hover:bg-white/10 transition-colors"
                                        >
                                            {playlist.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div className="text-sm opacity-60 space-y-1">
                    <div className="font-medium">
                        {currentSong?.ar?.map((a, i) => (
                            <React.Fragment key={a.id}>
                                {i > 0 && ", "}
                                <span
                                    className="cursor-pointer hover:underline hover:opacity-100 transition-opacity"
                                    onClick={() => {
                                        if (isLocalSong) {
                                            onOpenCurrentLocalArtist();
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
                            if (currentSong?.al?.id || currentSong?.album?.id) {
                                onAlbumSelect(currentSong?.al?.id || currentSong?.album?.id);
                            }
                        }}
                    >
                        {currentSong?.al?.name || currentSong?.album?.name}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default CoverTab;
