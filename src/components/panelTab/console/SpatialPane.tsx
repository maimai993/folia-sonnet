import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_SPATIAL_LEVEL_MAX,
    AUDIO_CONSOLE_SPATIAL_LEVEL_MIN,
    AUDIO_CONSOLE_SPATIAL_PAN_MAX,
    AUDIO_CONSOLE_SPATIAL_PAN_MIN,
    AUDIO_CONSOLE_SPATIAL_WIDTH_MAX,
    AUDIO_CONSOLE_SPATIAL_WIDTH_MIN,
    AUDIO_CONSOLE_STEM_KINDS,
    type AudioConsoleStemKind,
    type AudioConsoleStemSpatial,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { resolveNativeAudioUrl } from '../../../services/beatFx/beatFxSource';
import { isNativePlayerAvailable, nativePlayer } from '../../../services/playbackEngine/nativePlayerPlugin';
import { refreshInstrumentalStatus } from '../../../services/playbackEngine/nativeEqualizer';
import { Button, Segmented, Toggle } from '../../modal/settings/kit';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb } from './controls';

// src/components/panelTab/console/SpatialPane.tsx
// 调音台的空间声场页：把 SCNet 拆出的四轨（鼓 / 贝斯 / 其他 / 人声）分别摆位。
//
// 自动（auto）用内置摆位 —— 人声居中、贝斯略收、鼓与其他铺开；自定义（custom）则
// 逐轨调 audible / pan / width / level。两条路共用同一组数据，切到 custom 时滑杆
// 显示的就是自定义值，不会覆盖。
//
// 上半部分是「拆分」：当前歌四轨拆到哪一步、缓存占多少，以及自动拆分 / 立即拆分 /
// 删除缓存；下半部分是「摆位」：一键预设 + 逐轨细调。

const STEM_LABEL_KEYS: Record<AudioConsoleStemKind, string> = {
    drums: 'ui.consoleStemDrums',
    bass: 'ui.consoleStemBass',
    other: 'ui.consoleStemOther',
    vocals: 'ui.consoleStemVocals',
};

const MODES = [
    { value: 'auto', labelKey: 'ui.consoleSpatialAuto' },
    { value: 'custom', labelKey: 'ui.consoleSpatialCustom' },
] as const;

/** 一键摆位预设：每个都是「四轨各该在哪」的一组常见答案，点完进入自定义模式可继续手调。 */
const PRESETS: ReadonlyArray<{
    id: string;
    labelKey: string;
    stems: Record<AudioConsoleStemKind, AudioConsoleStemSpatial>;
}> = [
    {
        id: 'standard',
        labelKey: 'ui.consoleSpatialPresetStandard',
        stems: {
            drums: { audible: true, pan: 0, width: 1, levelDb: 0 },
            bass: { audible: true, pan: 0, width: 1, levelDb: 0 },
            other: { audible: true, pan: 0, width: 1, levelDb: 0 },
            vocals: { audible: true, pan: 0, width: 1, levelDb: 0 },
        },
    },
    {
        id: 'vocal',
        labelKey: 'ui.consoleSpatialPresetVocal',
        stems: {
            drums: { audible: true, pan: 0, width: 0.7, levelDb: -3 },
            bass: { audible: true, pan: 0, width: 0.7, levelDb: -2 },
            other: { audible: true, pan: 0, width: 0.7, levelDb: -3 },
            vocals: { audible: true, pan: 0, width: 1, levelDb: 0 },
        },
    },
    {
        id: 'wide',
        labelKey: 'ui.consoleSpatialPresetWide',
        stems: {
            drums: { audible: true, pan: 0, width: 1.5, levelDb: 0 },
            bass: { audible: true, pan: 0, width: 0.8, levelDb: 0 },
            other: { audible: true, pan: 0, width: 1.3, levelDb: 0 },
            vocals: { audible: true, pan: 0, width: 1, levelDb: 1 },
        },
    },
    {
        id: 'band',
        labelKey: 'ui.consoleSpatialPresetBand',
        stems: {
            drums: { audible: true, pan: -0.4, width: 1.2, levelDb: 0 },
            bass: { audible: true, pan: 0, width: 0.8, levelDb: 0 },
            other: { audible: true, pan: 0.4, width: 1.2, levelDb: 0 },
            vocals: { audible: true, pan: 0, width: 1, levelDb: 1 },
        },
    },
];

const SpatialPane: React.FC = () => {
    const { t } = useTranslation();
    const spatial = useAudioConsoleStore(state => state.settings.spatial);
    const setSpatial = useAudioConsoleStore(state => state.setSpatial);
    const setStemSpatial = useAudioConsoleStore(state => state.setStemSpatial);

    const currentSong = usePlaybackStore(state => state.currentSong);
    const separationState = useAudioSettingsStore(state => state.vocalCancelState);
    const separationPercent = useAudioSettingsStore(state => state.vocalCancelPercent);
    const cacheCount = useAudioSettingsStore(state => state.vocalCancelCachedCount);
    const cacheBytes = useAudioSettingsStore(state => state.vocalCancelCacheBytes);
    const cacheLimit = useAudioSettingsStore(state => state.vocalCancelCacheLimit);
    const prebuildEnabled = useAudioSettingsStore(state => state.prebuildTracksEnabled);
    const handleTogglePrebuildTracks = useAudioSettingsStore(state => state.handleTogglePrebuildTracks);

    // 拆分进行中每 1.5 秒问一次原生进度；其余状态只在打开时问一次。
    useEffect(() => {
        refreshInstrumentalStatus();
        if (separationState !== 'building') return undefined;
        const timer = setInterval(refreshInstrumentalStatus, 1500);
        return () => clearInterval(timer);
    }, [separationState]);

    const prepareCurrentSong = async (): Promise<void> => {
        if (!currentSong || !isNativePlayerAvailable()) return;
        try {
            const url = await resolveNativeAudioUrl(currentSong);
            if (url) await nativePlayer.prepareSongTracks(url, getPlaybackSongKey(currentSong));
        } catch (error) {
            console.warn('[Spatial] 拆分当前歌失败', error);
        }
        refreshInstrumentalStatus();
    };

    const clearCache = async (): Promise<void> => {
        if (!isNativePlayerAvailable()) return;
        try {
            await nativePlayer.clearSeparationCache();
        } catch (error) {
            console.warn('[Spatial] 删除拆分缓存失败', error);
        }
        refreshInstrumentalStatus();
    };

    const applyPreset = (preset: (typeof PRESETS)[number]): void => {
        for (const kind of AUDIO_CONSOLE_STEM_KINDS) {
            setStemSpatial(kind, preset.stems[kind]);
        }
        setSpatial({ enabled: true, mode: 'custom' });
    };

    // Solo：点一下只听这一轨（自动静音其它三轨）；再点一下恢复之前的 audible 状态。
    const [solo, setSolo] = useState<AudioConsoleStemKind | null>(null);
    const soloBefore = useRef<Record<AudioConsoleStemKind, boolean> | null>(null);
    const toggleSolo = (kind: AudioConsoleStemKind): void => {
        if (solo === kind) {
            if (soloBefore.current) {
                for (const other of AUDIO_CONSOLE_STEM_KINDS) {
                    setStemSpatial(other, { audible: soloBefore.current[other] });
                }
            }
            soloBefore.current = null;
            setSolo(null);
            return;
        }
        const before = {} as Record<AudioConsoleStemKind, boolean>;
        for (const other of AUDIO_CONSOLE_STEM_KINDS) before[other] = spatial.stems[other].audible;
        soloBefore.current = before;
        for (const other of AUDIO_CONSOLE_STEM_KINDS) setStemSpatial(other, { audible: other === kind });
        setSolo(kind);
    };

    const stateKey = separationState === 'building' || separationState === 'ready' || separationState === 'failed'
        ? `ui.consoleSpatialState${separationState[0].toUpperCase()}${separationState.slice(1)}`
        : 'ui.consoleSpatialStateIdle';

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consoleSpatialSplit')} hint={t('ui.consoleSpatialSplitHint')}>
                <div className="space-y-3 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleSpatialAutoSplit')}</span>
                        <Toggle
                            checked={prebuildEnabled}
                            onChange={enabled => handleTogglePrebuildTracks(enabled)}
                            label={t('ui.consoleSpatialAutoSplit')}
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-[12px] text-[color:var(--st-t2)]">{t(stateKey)}</span>
                        {separationState === 'building' && (
                            <span className="text-[12px] text-[color:var(--st-t2)]">{separationPercent}%</span>
                        )}
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--st-fill)]">
                        <div
                            className="h-full rounded-full bg-[var(--st-accent)] transition-[width]"
                            style={{ width: `${separationState === 'building' ? separationPercent : separationState === 'ready' ? 100 : 0}%` }}
                        />
                    </div>
                    <p className="text-[11px] leading-4 text-[color:var(--st-t3)]">
                        {t('ui.consoleSpatialCacheUsage', {
                            count: String(cacheCount),
                            used: (cacheBytes / 1024 / 1024).toFixed(0),
                            limit: (cacheLimit / 1024 / 1024).toFixed(0),
                        })}
                    </p>

                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void prepareCurrentSong()} disabled={!currentSong || separationState === 'building'}>
                            {t('ui.consoleSpatialPrepare')}
                        </Button>
                        <Button onClick={() => void clearCache()} disabled={cacheCount <= 0}>
                            {t('ui.consoleSpatialClearCache')}
                        </Button>
                    </div>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleSpatial')} hint={t('ui.consoleSpatialHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleSpatialEnabled')}</span>
                        <Toggle
                            checked={spatial.enabled}
                            onChange={enabled => setSpatial({ enabled })}
                            label={t('ui.consoleSpatialEnabled')}
                        />
                    </div>

                    <div className={spatial.enabled ? '' : 'opacity-40'}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] text-[color:var(--st-t2)]">{t('ui.consoleSpatialMode')}</span>
                            <Segmented
                                value={spatial.mode}
                                options={MODES.map(item => ({ value: item.value, label: t(item.labelKey) }))}
                                onChange={mode => setSpatial({ mode })}
                            />
                        </div>

                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {PRESETS.map(preset => (
                                <Button key={preset.id} onClick={() => applyPreset(preset)}>
                                    {t(preset.labelKey)}
                                </Button>
                            ))}
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            {AUDIO_CONSOLE_STEM_KINDS.map(kind => {
                const stem = spatial.stems[kind];
                const editable = spatial.enabled && spatial.mode === 'custom';
                return (
                    <EqualizerSection key={kind} title={t(STEM_LABEL_KEYS[kind])}>
                        <div className={`space-y-3.5 px-4 pb-4 pt-3${editable ? '' : ' opacity-40'}`}>
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-[13px] leading-5">{t(STEM_LABEL_KEYS[kind])}</span>
                                <div className="flex items-center gap-2">
                                    <Button
                                        variant="quiet"
                                        tip={t('ui.consoleStemSolo')}
                                        disabled={!editable}
                                        onClick={() => toggleSolo(kind)}
                                    >
                                        {solo === kind ? t('ui.consoleStemSoloOff') : t('ui.consoleStemSolo')}
                                    </Button>
                                    <Toggle
                                        checked={stem.audible}
                                        disabled={!editable}
                                        onChange={audible => setStemSpatial(kind, { audible })}
                                        label={t('ui.consoleStemAudible')}
                                    />
                                </div>
                            </div>
                            <ConsoleSlider
                                label={t('ui.consoleStemPan')}
                                valueText={stem.pan.toFixed(2)}
                                value={stem.pan}
                                min={AUDIO_CONSOLE_SPATIAL_PAN_MIN}
                                max={AUDIO_CONSOLE_SPATIAL_PAN_MAX}
                                decimals={2}
                                disabled={!editable}
                                onChange={pan => setStemSpatial(kind, { pan })}
                                onCommit={() => undefined}
                            />
                            <ConsoleSlider
                                label={t('ui.consoleStemWidth')}
                                valueText={stem.width.toFixed(2)}
                                value={stem.width}
                                min={AUDIO_CONSOLE_SPATIAL_WIDTH_MIN}
                                max={AUDIO_CONSOLE_SPATIAL_WIDTH_MAX}
                                decimals={2}
                                disabled={!editable}
                                onChange={width => setStemSpatial(kind, { width })}
                                onCommit={() => undefined}
                            />
                            <ConsoleSlider
                                label={t('ui.consoleStemLevel')}
                                valueText={formatDb(stem.levelDb, 1)}
                                value={stem.levelDb}
                                min={AUDIO_CONSOLE_SPATIAL_LEVEL_MIN}
                                max={AUDIO_CONSOLE_SPATIAL_LEVEL_MAX}
                                decimals={1}
                                disabled={!editable}
                                onChange={levelDb => setStemSpatial(kind, { levelDb })}
                                onCommit={() => undefined}
                            />
                        </div>
                    </EqualizerSection>
                );
            })}
        </div>
    );
};

export default SpatialPane;
