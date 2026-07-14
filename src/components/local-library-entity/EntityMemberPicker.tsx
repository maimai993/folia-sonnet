import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { List as VirtualList, type RowComponentProps } from 'react-window';
import type { LocalSong } from '../../types';
import { filterEntityMemberSongs } from './entityEditorModel';

// src/components/local-library-entity/EntityMemberPicker.tsx
// Provides the searchable member selection shown only while splitting an entity.

type EntityMemberPickerProps = {
    memberSongs: LocalSong[];
    selectedSongIds: Set<string>;
    onToggle: (songId: string) => void;
    isDaylight: boolean;
};

type SongRowProps = Pick<EntityMemberPickerProps, 'selectedSongIds' | 'onToggle' | 'isDaylight'> & {
    songs: LocalSong[];
};

const SongRow = ({ index, style, ariaAttributes, songs, selectedSongIds, onToggle, isDaylight }: RowComponentProps<SongRowProps>) => {
    const song = songs[index];
    const selected = selectedSongIds.has(song.id);

    return (
        <div {...ariaAttributes} style={style} className="px-1 py-0.5">
            <button
                type="button"
                onClick={() => onToggle(song.id)}
                className={`flex h-full w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors ${selected
                    ? isDaylight ? 'bg-blue-500/10 border-blue-500/30' : 'bg-blue-500/20 border-blue-500/50'
                    : isDaylight ? 'bg-black/5 hover:bg-black/10 border-black/5' : 'bg-white/5 hover:bg-white/10 border-white/5'
                }`}
            >
                <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected
                        ? 'border-blue-500 bg-blue-500 text-white'
                        : isDaylight ? 'border-black/20' : 'border-white/20'
                    }`}
                >
                    {selected && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{song.title || song.fileName}</span>
                    <span className="block truncate text-[10px] opacity-40">{song.artist || song.album || song.fileName}</span>
                </span>
            </button>
        </div>
    );
};

export const EntityMemberPicker = ({ memberSongs, selectedSongIds, onToggle, isDaylight }: EntityMemberPickerProps) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const songs = useMemo(() => filterEntityMemberSongs(memberSongs, query), [memberSongs, query]);
    const rowProps = useMemo(() => ({
        songs,
        selectedSongIds,
        onToggle,
        isDaylight,
    }), [isDaylight, onToggle, selectedSongIds, songs]);
    const inputTheme = isDaylight
        ? 'bg-black/5 focus-within:bg-black/10 border-black/10 focus-within:border-black/20'
        : 'bg-white/5 focus-within:bg-white/10 border-white/10 focus-within:border-white/20';

    return (
        <div className="min-w-0">
            <div className={`flex items-center gap-3 rounded-2xl border px-4 py-2.5 transition-colors ${inputTheme}`}>
                <Search size={14} className="opacity-35" />
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder={t('localMusic.searchEntitySongs')}
                    aria-label={t('localMusic.searchEntitySongs')}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
            </div>

            <div className="mt-2 h-64 overflow-hidden">
                {songs.length > 0 ? (
                    <VirtualList
                        style={{ height: '100%', width: '100%' }}
                        rowCount={songs.length}
                        rowHeight={52}
                        rowProps={rowProps}
                        rowComponent={SongRow}
                        className="custom-scrollbar"
                    />
                ) : (
                    <div className="flex h-full items-center justify-center px-4 text-center text-xs opacity-40">
                        {t('localMusic.noEntitySongs')}
                    </div>
                )}
            </div>
        </div>
    );
};
