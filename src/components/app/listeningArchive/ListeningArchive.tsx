import React, { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme } from '../../../types';
import { Button } from '@/components/ui';
import { Tabs } from '@/components/modal/settings/kit';
import { settingsTokens } from '@/components/modal/settings/kit/kitTheme';
import { useGlassSurfaceSettingsStore } from '@/stores/useGlassSurfaceSettingsStore';
import { useListeningArchiveStore, type ListeningArchiveTab } from './listeningArchiveStore';
import { useArchivePlays } from './useArchivePlays';
import RankingsTab from './RankingsTab';
import TimelineTab from './TimelineTab';
import SongTrajectoryTab from './SongTrajectoryTab';
import ArchiveSettingsTab from './ArchiveSettingsTab';
import CoverFocusDialog from './CoverFocusDialog';

// src/components/app/listeningArchive/ListeningArchive.tsx
// 听歌档案的全屏外壳：层级与关闭方式照 app/search/SearchWorkspace（fixed inset-0 + z-50，
// 自己的 Esc 监听，进场/离场位移）。四个页签各自一个文件，数据只在这里读一次。
//
// 这一层同时给出设置页 kit 的颜色变量（settingsTokens）：档案用的是 kit 的页签、分段控件与
// 开关，而那些部件读的是 --st-*，只有设置窗口和 Sheet 会写；不在这里写，它们就是一堆没颜色的
// 方块。kit 自己取明暗主题的那条路走的是 AppShell 已经提供的上下文，不用再传。

type ListeningArchiveProps = {
    theme: Theme;
    isDaylight: boolean;
    onClose: () => void;
};

const ListeningArchive: React.FC<ListeningArchiveProps> = ({ theme, isDaylight, onClose }) => {
    const { t } = useTranslation();
    const { isOpen, tab, setTab } = useListeningArchiveStore(useShallow(state => ({
        isOpen: state.isOpen,
        tab: state.tab,
        setTab: state.setTab,
    })));
    const focusedCover = useListeningArchiveStore(state => state.focusedCover);
    const setFocusedCover = useListeningArchiveStore(state => state.setFocusedCover);
    const { plays, isLoading, reload } = useArchivePlays(isOpen);

    // Esc 只关这一层：面板（ThemedDialog / Sheet）在 document 上先拿到这个键并 stopPropagation，
    // 所以它对着一层开着的对话框按 Esc 时不会连档案一起关掉。
    useEffect(() => {
        if (!isOpen) return undefined;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const tabs = useMemo(() => ([
        { id: 'rankings', label: t('listeningArchive.tabs.rankings') },
        { id: 'timeline', label: t('listeningArchive.tabs.timeline') },
        { id: 'song', label: t('listeningArchive.tabs.song') },
        { id: 'settings', label: t('listeningArchive.tabs.settings') },
    ]), [t]);

    const glassOn = useGlassSurfaceSettingsStore(state => state.liquidGlassEnabled);
    const tokens = useMemo(() => settingsTokens(isDaylight, theme, glassOn), [isDaylight, theme, glassOn]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.section
                    initial={{ opacity: 0, y: 28 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 28 }}
                    className="fixed inset-0 z-50 flex flex-col overflow-hidden px-3 py-4 sm:px-6 sm:py-6"
                    style={{
                        ...tokens,
                        color: 'var(--st-t1)',
                        // 玻璃开着时整片背景压透（0.95/0.97 → 72% 档位），折射有画面可看，
                        // 又不至于透出后面的层；关掉时保持原来的近实底。
                        backgroundColor: glassOn
                            ? 'color-mix(in srgb, var(--bg-color) 72%, transparent)'
                            : (isDaylight ? 'rgba(250,250,250,0.97)' : 'rgba(8,8,10,0.95)'),
                        backdropFilter: 'blur(24px)',
                    }}
                    aria-label={t('listeningArchive.title')}
                >
                    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
                        <header data-folia-safe-top="shift" className="flex shrink-0 items-center gap-3 pb-3">
                            <Button
                                variant="quiet"
                                className="h-8 w-8 shrink-0 rounded-full"
                                onClick={onClose}
                                aria-label={t('listeningArchive.close')}
                                tip={t('listeningArchive.close')}
                                icon={ArrowLeft}
                            />
                            <h1 className="truncate text-[15px] text-[color:var(--st-t1)]">
                                {t('listeningArchive.title')}
                            </h1>
                            <p className="ml-auto shrink-0 text-[11px] text-[color:var(--st-t3)]">
                                {isLoading ? t('listeningArchive.loading') : t('listeningArchive.recordedCount', { count: plays.length })}
                            </p>
                        </header>

                        <Tabs
                            tabs={tabs}
                            activeId={tab}
                            onSelect={id => setTab(id as ListeningArchiveTab)}
                            label={t('listeningArchive.tabs.label')}
                            className="pb-1"
                        />

                        <div className="min-h-0 flex-1 pt-3">
                            {tab === 'rankings' && <RankingsTab plays={plays} />}
                            {tab === 'timeline' && <TimelineTab plays={plays} isDaylight={isDaylight} />}
                            {tab === 'song' && <SongTrajectoryTab plays={plays} />}
                            {tab === 'settings' && (
                                <ArchiveSettingsTab
                                    playCount={plays.length}
                                    isDaylight={isDaylight}
                                    onReload={reload}
                                />
                            )}
                        </div>
                    </div>

                    <CoverFocusDialog
                        cover={focusedCover}
                        isDaylight={isDaylight}
                        onClose={() => setFocusedCover(null)}
                    />
                </motion.section>
            )}
        </AnimatePresence>
    );
};

export default ListeningArchive;
