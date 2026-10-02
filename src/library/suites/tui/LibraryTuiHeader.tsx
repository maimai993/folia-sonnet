import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryCollectionDescriptor } from '../../core/contracts/collection';
import type { CollectionResourceSnapshot } from '../../core/contracts/resource';
import type { LibraryCapability } from '../../core/contracts/capability';
import { resolveCollectionSyncCounts } from '../../core/model/collectionProgress';

// src/library/suites/tui/LibraryTuiHeader.tsx
// TUI 的状态栏：返回、集合名、来源、加载进度（中断时可续传）、重新拉取，以及当前筛选。
// 文案沿用网格已有的 playlist.* 条目，两个 renderer 对同一状态说同一句话。

type LibraryTuiHeaderProps = {
    collection: LibraryCollectionDescriptor;
    snapshot: CollectionResourceSnapshot | null;
    query: string;
    scopeCount: number;
    reload: LibraryCapability;
    accentColor: string;
    onBack: () => void;
    onReload: () => void;
    onResumeSync: () => void;
};

const sourceLabel = (collection: LibraryCollectionDescriptor, t: (key: string, options?: Record<string, unknown>) => string) => {
    if (collection.source === 'online') return t('libraryTui.sourceOnline', { provider: collection.providerId });
    return collection.source === 'local' ? t('libraryTui.sourceLocal') : t('libraryTui.sourceNavidrome');
};

const LibraryTuiHeader: React.FC<LibraryTuiHeaderProps> = ({
    collection,
    snapshot,
    query,
    scopeCount,
    reload,
    accentColor,
    onBack,
    onReload,
    onResumeSync,
}) => {
    const { t } = useTranslation();
    const loaded = snapshot?.tracks.length ?? 0;
    const total = snapshot?.detail?.trackCount ?? collection.trackCount;
    const counts = resolveCollectionSyncCounts(loaded, total);
    const sync = snapshot?.sync ?? { status: 'none' as const };
    const isLoading = !snapshot || snapshot.status === 'idle' || snapshot.status === 'loading';

    return (
        <header className="shrink-0 border-b border-current/15 px-4 py-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button type="button" onClick={onBack} className="opacity-70 hover:opacity-100">
                    {`[← ${t('libraryTui.back')}]`}
                </button>
                <span className="font-bold" style={{ color: accentColor }} data-tui-title>{collection.name}</span>
                <span className="opacity-50">{sourceLabel(collection, t)}</span>
                <span className="tabular-nums opacity-70">
                    {counts ? t('libraryTui.loadedOfTotal', counts) : t('libraryTui.loaded', { loaded: loaded.toLocaleString() })}
                </span>
                {sync.status === 'syncing' && (
                    <span className="opacity-70" data-tui-sync="syncing">
                        {counts ? t('playlist.syncProgress', counts) : t('playlist.loading')}
                    </span>
                )}
                {sync.status === 'interrupted' && (
                    <button
                        type="button"
                        data-tui-sync="interrupted"
                        onClick={onResumeSync}
                        title={t('playlist.syncFailedHint', { error: sync.message })}
                        className="underline decoration-dotted"
                    >
                        {`${counts ? t('playlist.syncInterruptedProgress', counts) : t('playlist.syncInterrupted')} · ${t('ui.retry')}`}
                    </button>
                )}
                {reload.supported && (
                    <button
                        type="button"
                        onClick={onReload}
                        disabled={!reload.enabled}
                        className="opacity-70 hover:opacity-100 disabled:opacity-30"
                    >
                        {`[${t('playlist.reload')}]`}
                    </button>
                )}
                {isLoading && <span className="opacity-50">{t('playlist.loading')}</span>}
            </div>
            <div className="mt-1 flex items-center gap-3 opacity-70">
                <span data-tui-filter>{query ? t('libraryTui.filter', { query }) : t('libraryTui.filterHint')}</span>
                <span className="tabular-nums opacity-70">{t('libraryTui.scope', { count: scopeCount })}</span>
            </div>
        </header>
    );
};

export default LibraryTuiHeader;
