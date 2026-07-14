import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, GitMerge, Pencil, Scissors, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LocalSong } from '../../types';
import type { LocalLibraryEntity } from '../../types/localLibrary';
import { normalizeLocalLibraryName } from '../../utils/localLibraryNames';
import { EntityMemberPicker } from './EntityMemberPicker';
import {
    buildEntityNameSuggestions,
    filterMergeEntitySuggestions,
} from './entityEditorModel';

// src/components/local-library-entity/EntityEditorWorkspace.tsx
// Adapts one name input and one primary action to rename, merge, or split context.

type EntityEditorWorkspaceProps = {
    entity: LocalLibraryEntity;
    sameKindEntities: LocalLibraryEntity[];
    memberSongs: LocalSong[];
    isDaylight: boolean;
    pending: boolean;
    onRename: (displayName: string) => Promise<boolean>;
    onMerge: (sourceEntityId: string) => Promise<boolean>;
    onSplit: (songIds: string[], displayName: string) => Promise<boolean>;
};

export const EntityEditorWorkspace = ({
    entity,
    sameKindEntities,
    memberSongs,
    isDaylight,
    pending,
    onRename,
    onMerge,
    onSplit,
}: EntityEditorWorkspaceProps) => {
    const { t } = useTranslation();
    const entityKindLabel = entity.kind === 'artist'
        ? t('localMusic.artistLabel')
        : t('localMusic.albumLabel');
    const borderTheme = isDaylight ? 'border-black/5' : 'border-white/10';
    const inputTheme = isDaylight
        ? 'bg-black/5 focus-within:bg-black/10 border-black/10 focus-within:border-black/20'
        : 'bg-white/5 focus-within:bg-white/10 border-white/10 focus-within:border-white/20';
    const resultTheme = isDaylight
        ? 'bg-black/5 hover:bg-black/10 border-black/5'
        : 'bg-white/5 hover:bg-white/10 border-white/5';
    const selectedTheme = isDaylight
        ? 'bg-blue-500/10 border-blue-500/30'
        : 'bg-blue-500/20 border-blue-500/50';
    const secondaryButtonTheme = isDaylight
        ? 'bg-zinc-100/80 hover:bg-zinc-200'
        : 'bg-white/5 hover:bg-white/10';
    const [identityInput, setIdentityInput] = useState(entity.displayName);
    const [splitInput, setSplitInput] = useState('');
    const [splitMode, setSplitMode] = useState(false);
    const [mergeSourceId, setMergeSourceId] = useState('');
    const [selectedSongIds, setSelectedSongIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        setIdentityInput(entity.displayName);
        setSplitInput('');
        setSplitMode(false);
        setMergeSourceId('');
        setSelectedSongIds(new Set());
    }, [entity.displayName, entity.id]);

    const selectedSongs = useMemo(
        () => memberSongs.filter(song => selectedSongIds.has(song.id)),
        [memberSongs, selectedSongIds],
    );
    const nameSuggestions = useMemo(
        () => buildEntityNameSuggestions(entity.kind, splitMode && selectedSongs.length > 0 ? selectedSongs : memberSongs).slice(0, 5),
        [entity.kind, memberSongs, selectedSongs, splitMode],
    );
    const mergeSuggestions = useMemo(
        () => identityInput.trim()
            ? filterMergeEntitySuggestions(sameKindEntities, entity.id, identityInput, 4)
            : [],
        [entity.id, identityInput, sameKindEntities],
    );
    const exactMergeSource = mergeSuggestions.find(candidate => (
        [candidate.displayName, ...candidate.aliases]
            .some(name => normalizeLocalLibraryName(name) === normalizeLocalLibraryName(identityInput))
    ));
    const mergeSource = sameKindEntities.find(candidate => candidate.id === mergeSourceId) || exactMergeSource;
    const inputValue = splitMode ? splitInput : identityInput;
    const normalizedInput = normalizeLocalLibraryName(inputValue);
    const canRename = Boolean(normalizedInput && normalizedInput !== normalizeLocalLibraryName(entity.displayName));
    const canSubmit = splitMode
        ? selectedSongIds.size > 0 && Boolean(normalizedInput)
        : mergeSource
            ? true
            : canRename;

    const toggleSong = useCallback((songId: string) => {
        setSelectedSongIds(current => {
            const next = new Set(current);
            if (next.has(songId)) next.delete(songId);
            else next.add(songId);
            return next;
        });
    }, []);

    // Dispatches the primary button according to the context currently visible to the user.
    const submit = async () => {
        if (!canSubmit || pending) return;
        if (splitMode) {
            const ok = await onSplit(Array.from(selectedSongIds), splitInput.trim());
            if (ok) {
                setSplitMode(false);
                setSplitInput('');
                setSelectedSongIds(new Set());
            }
            return;
        }
        if (mergeSource) {
            const ok = await onMerge(mergeSource.id);
            if (ok) setMergeSourceId('');
            return;
        }
        await onRename(identityInput.trim());
    };

    const chooseSuggestedName = (name: string) => {
        if (splitMode) setSplitInput(name);
        else {
            setIdentityInput(name);
            setMergeSourceId('');
        }
    };

    return (
        <div className={`grid gap-5 p-6 ${splitMode ? 'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]' : ''}`}>
            <section className="min-w-0">
                <label className="mb-2 block text-xs font-bold opacity-60">
                    {splitMode ? t('localMusic.newEntityName', { kind: entityKindLabel }) : t('localMusic.entityDisplayName')}
                </label>
                <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${inputTheme}`}>
                    {splitMode ? <Scissors size={18} className="opacity-40" /> : <Pencil size={18} className="opacity-40" />}
                    <input
                        value={inputValue}
                        onChange={event => {
                            if (splitMode) setSplitInput(event.target.value);
                            else {
                                setIdentityInput(event.target.value);
                                setMergeSourceId('');
                            }
                        }}
                        onKeyDown={event => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            void submit();
                        }}
                        placeholder={splitMode ? t('localMusic.newEntityName', { kind: entityKindLabel }) : t('localMusic.searchEntity', { kind: entityKindLabel })}
                        aria-label={splitMode ? t('localMusic.newEntityName', { kind: entityKindLabel }) : t('localMusic.entityDisplayName')}
                        autoFocus
                        className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
                    />
                </div>

                {nameSuggestions.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Sparkles size={13} className="mr-0.5 opacity-35" />
                        {nameSuggestions.map(suggestion => (
                            <button
                                key={suggestion.name}
                                type="button"
                                onClick={() => chooseSuggestedName(suggestion.name)}
                                className={`max-w-full truncate rounded-lg border px-3 py-1.5 text-xs transition-colors ${resultTheme}`}
                            >
                                {suggestion.name} <span className="opacity-35">· {suggestion.count}</span>
                            </button>
                        ))}
                    </div>
                )}

                {!splitMode && mergeSource && (
                    <div className={`mt-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${selectedTheme}`}>
                        <GitMerge size={15} className="shrink-0 opacity-45" />
                        <span className="min-w-0 flex-1 truncate">{mergeSource.displayName}</span>
                        <ArrowRight size={14} className="shrink-0 opacity-35" />
                        <span className="min-w-0 flex-1 truncate text-right font-bold">{entity.displayName}</span>
                    </div>
                )}

                {!splitMode && !mergeSource && mergeSuggestions.length > 0 && (
                    <div className="mt-4 space-y-1.5">
                        {mergeSuggestions.map(candidate => (
                            <button
                                key={candidate.id}
                                type="button"
                                onClick={() => {
                                    setMergeSourceId(candidate.id);
                                    setIdentityInput(candidate.displayName);
                                }}
                                className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors ${resultTheme}`}
                            >
                                <GitMerge size={14} className="shrink-0 opacity-35" />
                                <span className="min-w-0 flex-1 truncate font-semibold">{candidate.displayName}</span>
                                <span className="text-[10px] font-bold uppercase tracking-wider opacity-35">
                                    {t('localMusic.mergeIntoCurrent', { kind: entityKindLabel })}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

            </section>

            {splitMode && (
                <section className={`min-w-0 border-t pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0 ${borderTheme}`}>
                    <div className="mb-3 text-xs font-bold opacity-60">
                        {t('localMusic.selectedSongCount', { count: selectedSongIds.size })}
                    </div>
                    <EntityMemberPicker
                        memberSongs={memberSongs}
                        selectedSongIds={selectedSongIds}
                        onToggle={toggleSong}
                        isDaylight={isDaylight}
                    />
                </section>
            )}

            <footer className={`-mx-6 -mb-6 mt-1 flex flex-wrap items-center justify-end gap-3 border-t px-6 py-4 ${borderTheme} ${splitMode ? 'lg:col-span-2' : ''}`}>
                <button
                    type="button"
                    onClick={() => {
                        setSplitMode(current => !current);
                        setMergeSourceId('');
                    }}
                    className={`mr-auto flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors ${secondaryButtonTheme}`}
                >
                    {splitMode ? <ArrowLeft size={14} /> : <Scissors size={14} />}
                    {splitMode ? t('localMusic.backToEntityEditing') : t('localMusic.chooseSongsToSplit')}
                </button>
                <button
                    type="button"
                    disabled={!canSubmit || pending}
                    onClick={() => void submit()}
                    className="flex items-center justify-center gap-2 rounded-lg bg-blue-500 px-5 py-2 text-sm text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {splitMode ? <Scissors size={14} /> : mergeSource ? <GitMerge size={14} /> : <Check size={14} />}
                    {splitMode
                        ? t('localMusic.splitSelectedAction', { count: selectedSongIds.size, kind: entityKindLabel })
                        : mergeSource
                            ? t('localMusic.mergeEntity', { kind: entityKindLabel })
                            : t('localMusic.save')}
                </button>
            </footer>
        </div>
    );
};
