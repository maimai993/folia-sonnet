import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_ATTACK_MAX,
    AUDIO_CONSOLE_ATTACK_MIN,
    AUDIO_CONSOLE_COMPRESSOR_BANDS,
    AUDIO_CONSOLE_COMPRESSOR_BAND_INFO,
    AUDIO_CONSOLE_CROSSOVER_MAX,
    AUDIO_CONSOLE_CROSSOVER_MIN,
    AUDIO_CONSOLE_CROSSOVER_RATIO,
    clampCrossovers,
    AUDIO_CONSOLE_KNEE_MAX,
    AUDIO_CONSOLE_KNEE_MIN,
    AUDIO_CONSOLE_RATIO_MAX,
    AUDIO_CONSOLE_RATIO_MIN,
    AUDIO_CONSOLE_RELEASE_MAX,
    AUDIO_CONSOLE_RELEASE_MIN,
    AUDIO_CONSOLE_THRESHOLD_MAX,
    AUDIO_CONSOLE_THRESHOLD_MIN,
    type AudioConsoleCompressorBandId,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Segmented, Toggle } from '../../modal/settings/kit';
import { Button } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import CompressorCurve from './CompressorCurve';
import { ConsoleSlider, formatDb, formatHz, formatMs, formatPercent, formatRatio } from './controls';

// src/components/panelTab/console/CompressorPane.tsx
// 调音台的第二页：四段压缩。
//
// 页面结构照着「先选段、再调段」走：上面四张卡片是 Low / Mid / High / Air，
// 点哪张，下面就是那一段的曲线与四个旋钮。一次只显示一段的参数 —— 四段全摊开
// 会有十六根滑杆，谁也记不住自己刚改的是哪一根。
//
// 2 频段与温和/平直是**整机**的开关，所以它们在顶部，不在段里。
// 「温和」会按压掉的量自动补一半增益（听起来更响但不变糊），「平直」不补，
// 用来做「压了 vs 没压」的 A/B。

const CompressorPane: React.FC = () => {
    const { t } = useTranslation();
    const compressor = useAudioConsoleStore(state => state.settings.compressor);
    const setCompressor = useAudioConsoleStore(state => state.setCompressor);
    const setBand = useAudioConsoleStore(state => state.setCompressorBand);
    const [selected, setSelected] = useState<AudioConsoleCompressorBandId>('low');

    // 2 频段是 Low + High 两段（不是 Low + Mid）：与原生 MultibandCompressor 的对应关系一致，
    // 否则调 High 的人会发现 2 频段下声音没变。
    const visibleBands: AudioConsoleCompressorBandId[] = compressor.bandCount === 2
        ? ['low', 'high']
        : [...AUDIO_CONSOLE_COMPRESSOR_BANDS];
    const activeId = visibleBands.includes(selected) ? selected : visibleBands[0];
    const band = compressor.bands[activeId];
    const info = AUDIO_CONSOLE_COMPRESSOR_BAND_INFO[activeId];

    // 分频点滑杆：第二级的下限跟着第一级走，第三级跟着第二级，拖前面的会把后面的推上去
    // （与原生 sanitizeCrossovers 同一套规则，见 clampCrossovers）。
    const crossoverList = [
        {
            index: 0 as const,
            label: t('ui.consoleCrossoverLow'),
            value: compressor.crossovers[0],
            min: AUDIO_CONSOLE_CROSSOVER_MIN,
            max: 600,
        },
        {
            index: 1 as const,
            label: t('ui.consoleCrossoverMid'),
            value: compressor.crossovers[1],
            min: compressor.crossovers[0] * AUDIO_CONSOLE_CROSSOVER_RATIO,
            max: 6000,
        },
        {
            index: 2 as const,
            label: t('ui.consoleCrossoverHigh'),
            value: compressor.crossovers[2],
            min: compressor.crossovers[1] * AUDIO_CONSOLE_CROSSOVER_RATIO,
            max: AUDIO_CONSOLE_CROSSOVER_MAX,
        },
    ].filter(item => compressor.bandCount === 4 || item.index === 0);

    const updateCrossover = (index: 0 | 1 | 2, value: number) => {
        const next: [number, number, number] = [
            compressor.crossovers[0],
            compressor.crossovers[1],
            compressor.crossovers[2],
        ];
        next[index] = value;
        setCompressor({ crossovers: clampCrossovers(next) });
    };

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consoleCompressor')} hint={t('ui.consoleCompressorHint')}>
                <div className="space-y-3 px-4 pb-3.5 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleCompressorEnabled')}</span>
                        <Toggle
                            checked={compressor.enabled}
                            onChange={enabled => setCompressor({ enabled })}
                            label={t('ui.consoleCompressorEnabled')}
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                        <div className="flex items-center gap-2">
                            <span className="text-[12px] text-[color:var(--st-t2)]">{t('ui.consoleCompressorBands')}</span>
                            <Segmented
                                value={compressor.bandCount === 2 ? '2' : '4'}
                                options={[
                                    { value: '2', label: '2' },
                                    { value: '4', label: '4' },
                                ]}
                                onChange={value => setCompressor({ bandCount: value === '2' ? 2 : 4 })}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[12px] text-[color:var(--st-t2)]">{t('ui.consoleCompressorProfile')}</span>
                            <Segmented
                                value={compressor.profile}
                                options={[
                                    { value: 'gentle', label: t('ui.consoleCompressorGentle') },
                                    { value: 'flat', label: t('ui.consoleCompressorFlat') },
                                ]}
                                onChange={profile => setCompressor({ profile })}
                            />
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            <EqualizerSection
                title={t('ui.consoleCompressorCrossovers')}
                hint={t('ui.consoleCompressorCrossoversHint')}
            >
                <div className="space-y-3 px-4 pb-4 pt-3">
                    {crossoverList.map(item => (
                        <ConsoleSlider
                            key={item.label}
                            label={item.label}
                            valueText={formatHz(item.value)}
                            value={item.value}
                            min={item.min}
                            max={item.max}
                            log
                            decimals={0}
                            onChange={value => updateCrossover(item.index, value)}
                            onCommit={() => undefined}
                        />
                    ))}
                    <p className="-mt-1 text-[11px] leading-4 text-[color:var(--st-t3)]">
                        {t('ui.consoleCompressorCrossoversNote')}
                    </p>
                </div>
            </EqualizerSection>

            <div className={`mt-5 ${compressor.enabled ? '' : 'opacity-40'}`}>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                    {visibleBands.map(id => {
                        const item = compressor.bands[id];
                        const itemInfo = AUDIO_CONSOLE_COMPRESSOR_BAND_INFO[id];
                        const isActive = id === activeId;
                        return (
                            <Button
                                key={id}
                                variant="bare"
                                onClick={() => setSelected(id)}
                                aria-pressed={isActive}
                                className={`rounded-xl px-3 py-2.5 text-left transition-colors ${isActive
                                    ? 'bg-[var(--st-fill2)] shadow-[0_0_0_1px_var(--st-accent)]'
                                    : 'bg-[var(--st-card)] shadow-[0_0_0_1px_var(--st-line)] hover:bg-[var(--st-fill)]'}`}
                            >
                                <div className="flex items-center gap-1.5">
                                    <span
                                        aria-hidden
                                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.enabled ? 'bg-[var(--st-accent)]' : 'bg-[var(--st-track)]'}`}
                                    />
                                    <span className="truncate text-[13px] font-medium leading-5">{itemInfo.label}</span>
                                </div>
                                <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--st-t3)]">{itemInfo.range}</div>
                                <div className="mt-1 font-mono text-[11px] leading-4 text-[color:var(--st-t2)]">
                                    {formatDb(item.thresholdDb, 0)} · {formatRatio(item.ratio)}
                                </div>
                            </Button>
                        );
                    })}
                </div>

                <EqualizerSection title={`${info.label} · ${info.range}`} hint={t('ui.consoleCompressorCurveHint')}>
                    <div className="px-4 pb-3 pt-3">
                        <CompressorCurve
                            thresholdDb={band.thresholdDb}
                            ratio={band.ratio}
                            makeupDb={band.makeupDb}
                            kneeDb={band.kneeDb}
                            dimmed={!band.enabled}
                        />
                    </div>
                </EqualizerSection>

                <EqualizerSection title={t('ui.consoleCompressorParams', { band: info.label })}>
                    <div className="space-y-3.5 px-4 pb-4 pt-3">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleCompressorBandEnabled')}</span>
                            <Toggle
                                checked={band.enabled}
                                onChange={enabled => setBand(activeId, { enabled })}
                                label={t('ui.consoleCompressorBandEnabled')}
                            />
                        </div>
                        <ConsoleSlider
                            label={t('ui.consoleThreshold')}
                            valueText={formatDb(band.thresholdDb, 0)}
                            value={band.thresholdDb}
                            min={AUDIO_CONSOLE_THRESHOLD_MIN}
                            max={AUDIO_CONSOLE_THRESHOLD_MAX}
                            decimals={1}
                            disabled={!band.enabled}
                            onChange={thresholdDb => setBand(activeId, { thresholdDb })}
                            onCommit={() => undefined}
                        />
                        <ConsoleSlider
                            label={t('ui.consoleRatio')}
                            valueText={formatRatio(band.ratio)}
                            value={band.ratio}
                            min={AUDIO_CONSOLE_RATIO_MIN}
                            max={AUDIO_CONSOLE_RATIO_MAX}
                            decimals={1}
                            disabled={!band.enabled}
                            onChange={ratio => setBand(activeId, { ratio })}
                            onCommit={() => undefined}
                        />
                        <ConsoleSlider
                            label={t('ui.consoleAttack')}
                            valueText={formatMs(band.attackMs)}
                            value={band.attackMs}
                            min={AUDIO_CONSOLE_ATTACK_MIN}
                            max={AUDIO_CONSOLE_ATTACK_MAX}
                            log
                            decimals={1}
                            disabled={!band.enabled}
                            onChange={attackMs => setBand(activeId, { attackMs })}
                            onCommit={() => undefined}
                        />
                        <ConsoleSlider
                            label={t('ui.consoleRelease')}
                            valueText={formatMs(band.releaseMs)}
                            value={band.releaseMs}
                            min={AUDIO_CONSOLE_RELEASE_MIN}
                            max={AUDIO_CONSOLE_RELEASE_MAX}
                            log
                            decimals={0}
                            disabled={!band.enabled}
                            onChange={releaseMs => setBand(activeId, { releaseMs })}
                            onCommit={() => undefined}
                        />
                        <ConsoleSlider
                            label={t('ui.consoleMakeup')}
                            valueText={formatDb(band.makeupDb)}
                            value={band.makeupDb}
                            min={0}
                            max={12}
                            decimals={1}
                            disabled={!band.enabled}
                            onChange={makeupDb => setBand(activeId, { makeupDb })}
                            onCommit={() => undefined}
                        />
                        <ConsoleSlider
                            label={t('ui.consoleKnee')}
                            valueText={formatDb(band.kneeDb, 0)}
                            value={band.kneeDb}
                            min={AUDIO_CONSOLE_KNEE_MIN}
                            max={AUDIO_CONSOLE_KNEE_MAX}
                            decimals={1}
                            disabled={!band.enabled}
                            onChange={kneeDb => setBand(activeId, { kneeDb })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleKneeHint')}</p>
                        <ConsoleSlider
                            label={t('ui.consoleParallel')}
                            valueText={formatPercent(band.mix)}
                            value={band.mix}
                            min={0}
                            max={1}
                            decimals={2}
                            disabled={!band.enabled}
                            onChange={mix => setBand(activeId, { mix })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleParallelHint')}</p>
                    </div>
                </EqualizerSection>
            </div>
        </div>
    );
};

export default CompressorPane;
