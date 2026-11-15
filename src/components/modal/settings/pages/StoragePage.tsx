import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LYRIC_EXPORT_COMMAND_ID } from '../../../command-palette/commands/lyricExportCommands';
import ConfirmDialog from '../../../shared/ConfirmDialog';
import { clearAllCaches } from '../../../../services/db';
import { isCapacitorAndroid } from '../../../../platform/runtime';
import { refreshInstrumentalStatus } from '../../../../services/playbackEngine/nativeEqualizer';
import { nativePlayer } from '../../../../services/playbackEngine/nativePlayerPlugin';
import { openCommandPaletteCommand } from '../../../../stores/useAppViewStore';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { closeSettings } from '../../../../stores/useSettingsModalStore';
import { Button, CopyValue, FoldedGroup, Group, Row, Select, Toggle, Value, useSettingsKitTheme, type SettingsOptionDef } from '../kit';
import { useSettingsPage } from './settingsPageContext';
import ConfigTransferRows from './storage/ConfigTransferRows';
import FolderWatchGroup from './storage/FolderWatchGroup';
import { BACKUP, CACHE_ROWS, CACHES, MEDIA, O } from './storage/options';

// src/components/modal/settings/pages/StoragePage.tsx
// The 存储与备份 page: what Folia keeps on disk and how to carry its look to another Folia. The
// song cache first (on or off, and in the desktop app where it is and how large it may grow), then
// what each kind of cache takes with a button to clear it, the watch on imported folders, and a
// folded group for copying and pasting the visual settings as a config code. The cache sizes and
// the cache folder are the settings dialog's own state.

export const OPTIONS: SettingsOptionDef[] = [...Object.values(O), ...CACHE_ROWS.map(row => row.option)];

// Zero is "no ceiling", which is a real answer rather than a missing one, so it gets a name.
const CACHE_LIMITS_GB = [1, 2, 5, 10, 20, 50, 0];

/** 分离缓存体积：过了 1G 用 G，否则用 M —— 「2.0 GB」比「2048 MB」好读。 */
const formatCacheSize = (bytes: number): string => {
    if (bytes <= 0) return '0 MB';
    return bytes >= 1024 ** 3
        ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
        : `${Math.round(bytes / 1024 ** 2)} MB`;
};

const StoragePage: React.FC = () => {
    const { t } = useTranslation();
    const { isElectron, viewProps } = useSettingsPage();
    const { isDaylight } = useSettingsKitTheme();
    const { cacheDirectory, cacheDirectoryIsDefault, cacheDirectoryStatus, cacheSizes, isCleaning, mediaCount, onChooseCacheDirectory, onClear } = viewProps.storage;
    const mediaCacheEnabled = useAudioSettingsStore(state => state.enableMediaCache);
    const setMediaCacheEnabled = useAudioSettingsStore(state => state.handleToggleMediaCache);
    const cacheLimitGb = useAudioSettingsStore(state => state.mediaCacheLimitGb);
    const setCacheLimitGb = useAudioSettingsStore(state => state.handleSetMediaCacheLimitGb);
    // 总开关：开了才预先拆两轨、提前分析下一首；关着只正常给智能动感供数据。
    const prebuildTracksEnabled = useAudioSettingsStore(state => state.prebuildTracksEnabled);
    const setPrebuildTracksEnabled = useAudioSettingsStore(state => state.handleTogglePrebuildTracks);
    const [clearingAll, setClearingAll] = useState<'no' | 'asking' | 'running'>('no');
    const [clearingSeparation, setClearingSeparation] = useState(false);
    // 分离出来的伴奏 / 清唱落在原生缓存里，用量同样上报到这个 store；
    // 进存储页问一次，和其余缓存一起量。
    const vocalCachedCount = useAudioSettingsStore(state => state.vocalCancelCachedCount);
    const vocalCacheBytes = useAudioSettingsStore(state => state.vocalCancelCacheBytes);
    const vocalCacheLimit = useAudioSettingsStore(state => state.vocalCancelCacheLimit);
    useEffect(() => {
        if (isCapacitorAndroid()) refreshInstrumentalStatus();
    }, []);

    // Every cache listed below goes; the local library and its hand-made merges, splits and
    // assignments stay, because a rescan cannot bring those back. Reload so nothing in memory keeps
    // serving what was just cleared.
    const clearEverything = async () => {
        setClearingAll('running');
        await clearAllCaches();
        window.location.reload();
    };

    /*
     * 「删除人声分离缓存」：清的是原生 cacheDir/instrumental 下那两轨 m4a 文件。
     *
     * 之前这一行叫「分析缓存」，点下去清的其实是 IndexedDB 里的整曲曲线
     * （clearMusicEnvelopeCache + onClear('analysis')）—— 用户要清的分离音轨文件
     * 一个没删，反而把智能动感的数据删了。两件事现在各归各：分析数据在下面
     * CACHES 组的 analysis 分类里清，这里只清原生分离结果。
     */
    const clearSeparationCache = async () => {
        if (!isCapacitorAndroid()) return;
        setClearingSeparation(true);
        try {
            await nativePlayer.clearSeparationCache();
            // 原生已经把模式退回「全部」并落盘；界面这边同步一次，选中态不能还停在人声 / 伴奏。
            useAudioSettingsStore.getState().handleSetVocalMode('off');
            refreshInstrumentalStatus();
        } catch (error) {
            console.warn('[Storage] 删除人声分离缓存失败', error);
        } finally {
            setClearingSeparation(false);
        }
    };

    return (
        <>
            <Group def={MEDIA}>
                <Row option={O.mediaCache} hint={t('options.enableMediaCacheDesc')}>
                    <Toggle checked={mediaCacheEnabled} onChange={setMediaCacheEnabled} />
                </Row>
                {isElectron && (
                    <>
                        <Row
                            option={O.cacheDirectory}
                            hint={t(cacheDirectoryIsDefault ? 'options.cacheDirectoryDefaultHint' : 'options.cacheDirectoryCustomHint')}
                        >
                            {cacheDirectory ? <CopyValue value={cacheDirectory} /> : <Value>...</Value>}
                            <Button onClick={onChooseCacheDirectory} disabled={cacheDirectoryStatus !== 'idle'}>
                                {t('options.chooseCacheDirectory')}
                            </Button>
                        </Row>
                        <Row option={O.cacheLimit} hint={t('options.mediaCacheLimitDesc')}>
                            <Select
                                value={String(cacheLimitGb)}
                                options={CACHE_LIMITS_GB.map(gigabytes => ({
                                    value: String(gigabytes),
                                    label: gigabytes === 0 ? t('options.mediaCacheLimitNone') : `${gigabytes} GB`,
                                }))}
                                onChange={value => setCacheLimitGb(Number(value))}
                            />
                        </Row>
                    </>
                )}
                <Row label={t('options.cachedSongsCount')}>
                    <Value>{mediaCount} · {cacheSizes.media}</Value>
                </Row>
                {isCapacitorAndroid() && (
                    <Row label={t('options.prebuildTracks')} hint={t('options.prebuildTracksDesc')}>
                        <Toggle checked={prebuildTracksEnabled} onChange={setPrebuildTracksEnabled} />
                    </Row>
                )}
                {isCapacitorAndroid() && (
                    <Row label={t('options.separationCache')} hint={t('options.separationCacheClearDesc')}>
                        {vocalCachedCount > 0 && (
                            <Value>{t('account.vocalCancelCache', {
                                count: vocalCachedCount,
                                used: formatCacheSize(vocalCacheBytes),
                                limit: formatCacheSize(vocalCacheLimit),
                            })}</Value>
                        )}
                        <Button onClick={() => void clearSeparationCache()} disabled={clearingSeparation}>
                            {clearingSeparation ? t('options.cacheClearing') : t('ui.clear')}
                        </Button>
                    </Row>
                )}
            </Group>

            <Group
                def={CACHES}
                action={(
                    <Button variant="quiet" onClick={() => setClearingAll('asking')} disabled={clearingAll === 'running'}>
                        {clearingAll === 'running' ? t('options.cacheClearing') : t('options.clearAll')}
                    </Button>
                )}
            >
                {CACHE_ROWS.map(({ category, option }) => (
                    <Row key={category} option={option}>
                        <Value>{cacheSizes[category]}</Value>
                        {category === 'lyrics' && (
                            // Named for the Ponder hint of the lyric export, which finds its entry by this attribute.
                            <span data-ponder-lyric-export-settings-entry className="contents">
                                <Button
                                    onClick={() => {
                                        openCommandPaletteCommand(LYRIC_EXPORT_COMMAND_ID);
                                        closeSettings();
                                    }}
                                >
                                    {t('lyricExport.settingsEntry')}
                                </Button>
                            </span>
                        )}
                        <Button onClick={() => onClear(category)} disabled={isCleaning === category}>
                            {isCleaning === category ? t('options.cacheClearing') : t('ui.clear')}
                        </Button>
                    </Row>
                ))}
            </Group>

            <FolderWatchGroup />

            <FoldedGroup def={BACKUP}>
                <ConfigTransferRows />
            </FoldedGroup>

            <ConfirmDialog
                isOpen={clearingAll === 'asking'}
                title={t('options.clearAll')}
                description={t('options.confirmClearAll')}
                confirmVariant="danger"
                isDaylight={isDaylight}
                onConfirm={() => void clearEverything()}
                onClose={() => setClearingAll('no')}
            />
        </>
    );
};

export default StoragePage;
