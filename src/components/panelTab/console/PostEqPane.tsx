import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AUDIO_EQUALIZER_BANDS, AUDIO_EQUALIZER_MAX_GAIN_DB, AUDIO_EQUALIZER_MIN_GAIN_DB } from '../../../utils/audioEqualizer';
import {
    AUDIO_CONSOLE_GLOBAL_GAIN_MAX,
    AUDIO_CONSOLE_GLOBAL_GAIN_MIN,
    AUDIO_CONSOLE_Q_MAX,
    AUDIO_CONSOLE_Q_MIN,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { isNativePlayerAvailable, nativePlayer } from '../../../services/playbackEngine/nativePlayerPlugin';
import { Segmented, Toggle } from '../../modal/settings/kit';
import { Button } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import Fader from '../equalizer/Fader';
import SpectrumChart from './SpectrumChart';
import { ConsoleSlider, formatDb } from './controls';

// src/components/panelTab/console/PostEqPane.tsx
// 调音台的第四页：后置均衡器 —— 挂在压缩之后、混响之前的那一套十段。
//
// 「后置」的意义：前置 EQ 改的是「这首歌听起来什么音色」，压缩器会跟着它的变化去压；
// 后置 EQ 在压缩之后动，用来修**房间**与**耳机**的问题（低频驻波、齿音过亮），
// 它不会回头影响压缩的判断。所以这一页给了一幅实时频谱：看着曲线调，比盲调可靠。
//
// 频谱只在原生播放时才有数据（声音在原生出的，Web 侧拿不到），网页播放时显示说明。

const POLL_MS = 60;

/** 十段推子。与前置那套同一个 Fader，只是不挂前置网格的手机排版标记。 */
const POST_BAND_COUNT = AUDIO_EQUALIZER_BANDS.length;

const PostEqPane: React.FC = () => {
    const { t } = useTranslation();
    const postEq = useAudioConsoleStore(state => state.settings.postEq);
    const setPostEq = useAudioConsoleStore(state => state.setPostEq);
    const resetGains = useAudioConsoleStore(state => state.resetPostEqGains);
    const [spectrum, setSpectrum] = useState<number[]>([]);
    const [waiting, setWaiting] = useState(false);
    const native = isNativePlayerAvailable();
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 频谱只在「原生播放 + 这一页在」时取样：关掉页签就不该占音频线程的 CPU。
    useEffect(() => {
        if (!native) return undefined;
        let cancelled = false;
        setWaiting(true);
        void nativePlayer.setSpectrumEnabled(true).catch(() => undefined);
        timerRef.current = setInterval(() => {
            void nativePlayer.getSpectrum()
                .then((frame) => {
                    if (cancelled) return;
                    setSpectrum(frame.bands);
                    setWaiting(false);
                })
                .catch(() => {
                    if (cancelled) return;
                    setWaiting(false);
                });
        }, POLL_MS);
        return () => {
            cancelled = true;
            if (timerRef.current !== null) clearInterval(timerRef.current);
            timerRef.current = null;
            void nativePlayer.setSpectrumEnabled(false).catch(() => undefined);
        };
    }, [native]);

    const updateGain = (index: number, value: number) => {
        const gains = [...postEq.gains];
        gains[index] = value;
        setPostEq({ gains });
    };

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consolePostEq')} hint={t('ui.consolePostEqHint')}>
                <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3">
                    <span className="text-[13px] leading-5">{t('ui.consolePostEqEnabled')}</span>
                    <Toggle
                        checked={postEq.enabled}
                        onChange={enabled => setPostEq({ enabled })}
                        label={t('ui.consolePostEqEnabled')}
                    />
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleSpectrum')} hint={native ? t('ui.consoleSpectrumNative') : t('ui.consoleSpectrumWeb')}>
                <SpectrumChart bands={spectrum} waiting={waiting} />
            </EqualizerSection>

            <div className={`st-t-move ${postEq.enabled ? '' : 'opacity-40'}`}>
                <EqualizerSection title={t('ui.consolePostEqBands')} hint={`${AUDIO_EQUALIZER_MIN_GAIN_DB} ~ +${AUDIO_EQUALIZER_MAX_GAIN_DB} dB`}>
                    <div className="st-scroll flex gap-2 overflow-x-auto px-4 pb-3 pt-3 [&::-webkit-scrollbar]:h-3" inert={!postEq.enabled}>
                        <div className="relative grid min-w-[360px] flex-1 grid-cols-10">
                            {Array.from({ length: POST_BAND_COUNT }, (_, index) => {
                                const band = AUDIO_EQUALIZER_BANDS[index];
                                const gain = postEq.gains[index] ?? 0;
                                return (
                                    <div key={band.frequency} className="flex min-h-[168px] flex-col items-center gap-1.5 font-mono text-[11px] leading-4">
                                        <span aria-hidden className="text-[color:var(--st-t2)]">
                                            {gain > 0 ? `+${gain}` : gain}
                                        </span>
                                        <Fader
                                            value={gain}
                                            min={AUDIO_EQUALIZER_MIN_GAIN_DB}
                                            max={AUDIO_EQUALIZER_MAX_GAIN_DB}
                                            label={`${band.label} Hz`}
                                            valueText={`${gain > 0 ? '+' : ''}${gain} dB`}
                                            onPreview={value => updateGain(index, value)}
                                            onCommit={() => undefined}
                                        />
                                        <span aria-hidden className="text-[color:var(--st-t3)]">{band.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                        <span aria-hidden className="w-5 shrink-0 self-end font-mono text-[11px] leading-4 text-[color:var(--st-t3)]">Hz</span>
                    </div>
                </EqualizerSection>

                <EqualizerSection
                    title={t('ui.consolePostEqCurve')}
                    hint={undefined}
                >
                    <div className="space-y-3.5 px-4 pb-4 pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Segmented
                                value={postEq.curve}
                                options={[
                                    { value: 'geq', label: t('ui.equalizerCurveGeq') },
                                    { value: 'peq', label: t('ui.equalizerCurvePeq') },
                                ]}
                                onChange={curve => setPostEq({ curve })}
                            />
                            <Button variant="quiet" size="sm" className="ml-auto" onClick={resetGains} disabled={!postEq.enabled}>
                                {t('ui.consolePostEqReset')}
                            </Button>
                        </div>
                        {postEq.curve === 'peq' && (
                            <ConsoleSlider
                                label={t('ui.equalizerQ')}
                                valueText={postEq.q.toFixed(2)}
                                value={postEq.q}
                                min={AUDIO_CONSOLE_Q_MIN}
                                max={AUDIO_CONSOLE_Q_MAX}
                                log
                                disabled={!postEq.enabled}
                                onChange={q => setPostEq({ q })}
                                onCommit={() => undefined}
                            />
                        )}
                        <ConsoleSlider
                            label={t('ui.equalizerGlobalGain')}
                            valueText={formatDb(postEq.globalGainDb)}
                            value={postEq.globalGainDb}
                            min={AUDIO_CONSOLE_GLOBAL_GAIN_MIN}
                            max={AUDIO_CONSOLE_GLOBAL_GAIN_MAX}
                            decimals={1}
                            disabled={!postEq.enabled}
                            onChange={globalGainDb => setPostEq({ globalGainDb })}
                            onCommit={() => undefined}
                        />
                    </div>
                </EqualizerSection>
            </div>
        </div>
    );
};

export default PostEqPane;
