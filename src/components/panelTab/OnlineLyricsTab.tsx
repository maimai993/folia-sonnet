import React, { useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { FileText, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OnlineLyricsState, SongResult } from '../../types';

// src/components/panelTab/OnlineLyricsTab.tsx

interface OnlineLyricsTabProps {
    currentSong: SongResult;
    onlineLyricsState: OnlineLyricsState | null;
    onImportLyrics: (content: string, fileName: string) => void;
    onChangeLyricsSource: (source: 'online' | 'imported') => void;
    onMatchOnlineLyrics: () => void;
    isDaylight: boolean;
}

const OnlineLyricsTab: React.FC<OnlineLyricsTabProps> = ({
    currentSong,
    onlineLyricsState,
    onImportLyrics,
    onChangeLyricsSource,
    onMatchOnlineLyrics,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);

    const activeTabBg = isDaylight ? 'bg-blue-500/15 text-blue-600' : 'bg-blue-500/20 text-blue-300';
    const inactiveTabBg = isDaylight ? 'bg-black/5 text-zinc-500 hover:bg-black/10' : 'bg-white/5 text-zinc-400 hover:bg-white/10';

    const hasImportedLyrics = Boolean(onlineLyricsState?.importedLyrics);
    const activeSource = onlineLyricsState?.lyricsSource === 'imported' && hasImportedLyrics ? 'imported' : 'online';
    const availableSources = useMemo(
        () => (hasImportedLyrics
            ? [
                { key: 'online' as const, label: t('localMusic.statusOnline') },
                { key: 'imported' as const, label: t('localMusic.statusImported') },
            ]
            : [{ key: 'online' as const, label: t('localMusic.statusOnline') }]),
        [hasImportedLyrics, t],
    );

    const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = nextEvent => {
            const content = nextEvent.target?.result as string | null;
            if (content) {
                onImportLyrics(content, file.name);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col space-y-6 pt-4 px-2"
        >
            <div className="space-y-3">
                <h3 className="text-sm font-semibold opacity-50 uppercase tracking-wider flex items-center gap-2">
                    <FileText size={14} /> {t('localMusic.lyrics')}
                </h3>
                <div className="bg-white/5 rounded-xl p-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                        <span className="opacity-60">{t('localMusic.filename')}</span>
                        <span className="text-xs opacity-80 truncate max-w-[160px]" title={currentSong.name}>
                            {currentSong.name}
                        </span>
                    </div>
                    <div className="flex justify-between gap-4">
                        <span className="opacity-60">{t('localMusic.lyricsSource')}</span>
                        <span className="text-xs opacity-80 truncate max-w-[160px]" title={activeSource === 'imported' ? t('localMusic.statusImported') : t('localMusic.statusOnline')}>
                            {activeSource === 'imported' ? t('localMusic.statusImported') : t('localMusic.statusOnline')}
                        </span>
                    </div>
                    {onlineLyricsState?.importedLyricsName && (
                        <div className="flex justify-between gap-4">
                            <span className="opacity-60">{t('localMusic.importedLyricsFile')}</span>
                            <span className="text-xs opacity-80 truncate max-w-[160px]" title={onlineLyricsState.importedLyricsName}>
                                {onlineLyricsState.importedLyricsName}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold opacity-50 uppercase tracking-wider flex items-center gap-2">
                        <FileText size={14} /> {t('localMusic.lyricsSource')}
                    </h3>
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => inputRef.current?.click()}
                            className="p-1.5 hover:bg-white/10 rounded-md transition-colors"
                            title={t('localMusic.importLyricsFile')}
                        >
                            <Upload size={14} />
                        </button>
                        <input
                            type="file"
                            accept=".lrc,.txt"
                            ref={inputRef}
                            className="hidden"
                            onChange={handleImport}
                        />
                        <button
                            onClick={onMatchOnlineLyrics}
                            className="px-3 py-1 bg-white/10 hover:bg-white/20 active:bg-white/30 transition-colors rounded-lg text-xs font-medium flex items-center gap-1.5"
                        >
                            <RefreshCw size={12} />
                            {t('localMusic.matchOnline')}
                        </button>
                    </div>
                </div>

                {availableSources.length === 1 ? (
                    <div className={`text-xs px-3 py-2 rounded-lg ${activeTabBg} font-medium`}>
                        {availableSources[0].label}
                    </div>
                ) : (
                    <div className="flex gap-1.5">
                        {availableSources.map(source => (
                            <button
                                key={source.key}
                                onClick={() => onChangeLyricsSource(source.key)}
                                className={`flex-1 text-xs py-1.5 px-2 rounded-lg font-medium transition-all ${
                                    activeSource === source.key ? activeTabBg : inactiveTabBg
                                }`}
                            >
                                {source.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </motion.div>
    );
};

export default OnlineLyricsTab;
