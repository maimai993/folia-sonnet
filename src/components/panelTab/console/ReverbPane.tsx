import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_BASS_MONO_MAX,
    AUDIO_CONSOLE_DAMPING_MAX,
    AUDIO_CONSOLE_DAMPING_MIN,
    AUDIO_CONSOLE_PRE_DELAY_MAX,
    AUDIO_CONSOLE_REVERB_RT60_MAX,
    AUDIO_CONSOLE_REVERB_RT60_MIN,
    AUDIO_CONSOLE_REVERB_SHAPES,
    AUDIO_CONSOLE_ROOM_LEVEL_MAX,
    AUDIO_CONSOLE_ROOM_LEVEL_MIN,
    AUDIO_CONSOLE_STEREO_WIDTH_MAX,
    AUDIO_CONSOLE_STEREO_WIDTH_MIN,
    analyzeImpulseWav,
    type AudioConsoleImpulseProfile,
    type AudioConsoleReverbPreset,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Toggle } from '../../modal/settings/kit';
import { Button, TextField } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatHz, formatMs, formatPercent, formatSeconds } from './controls';

// src/components/panelTab/console/ReverbPane.tsx
// 调音台的第三页：空间环境混响，外加声场宽度。
//
// 与截图里那个「全局混音（Session 0）」的方案不同的地方：Folia 只处理**自己的**声音，
// 没有系统级的音频会话可以接管，所以这里没有「跟随外部应用流」那一组开关。
// 留下的是真正能实现的参数：房间多大（预设）、尾巴多长（RT60）、湿声多响（room level）、
// 尾巴多暗（damping）、多远（pre-delay）、干湿比（mix），外加一个「暂停时余音自然落下」。
//
// 预设在这里只是**起点**：点一下会把该空间的阻尼与预延迟写进设置，之后两个滑杆各调各的。
// 这样「想要大教堂的空间感但不要那 42 ms 的空档」是能做到的 —— 之前做不到。
//
// 导入 IR 走的是**测量**而不是卷积：读一遍 WAV，量出它的 RT60、预延迟与高频阻尼，
// 再把这三个数折成参数化混响的参数（原因写在 audioConsole.ts 的 analyzeImpulseWav 上）。

const PRESETS: ReadonlyArray<{ id: AudioConsoleReverbPreset; key: string }> = [
    { id: 'factory', key: 'ui.consoleReverbPresetFactory' },
    { id: 'hall', key: 'ui.consoleReverbPresetHall' },
    { id: 'cathedral', key: 'ui.consoleReverbPresetCathedral' },
    { id: 'plate', key: 'ui.consoleReverbPresetPlate' },
];

/** 把量到的空间折成最接近的预设：预延迟决定「多远」，阻尼决定「多暗」。 */
const pickPreset = (profile: AudioConsoleImpulseProfile): AudioConsoleReverbPreset => {
    if (profile.preDelayMs >= 32) return 'cathedral';
    if (profile.damping <= 0.14) return 'plate';
    if (profile.preDelayMs >= 10) return 'hall';
    return 'factory';
};

const ReverbPane: React.FC = () => {
    const { t } = useTranslation();
    const reverb = useAudioConsoleStore(state => state.settings.reverb);
    const stereo = useAudioConsoleStore(state => state.settings.stereo);
    const setReverb = useAudioConsoleStore(state => state.setReverb);
    const setStereo = useAudioConsoleStore(state => state.setStereo);
    const fileRef = useRef<HTMLInputElement>(null);
    const [profile, setProfile] = useState<AudioConsoleImpulseProfile | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** 换预设 = 把该空间的阻尼与预延迟一起带出来；之后两个滑杆仍可各自微调。 */
    const choosePreset = (preset: AudioConsoleReverbPreset) => {
        setReverb({ preset, ...AUDIO_CONSOLE_REVERB_SHAPES[preset] });
    };

    const importImpulse = async (file: File) => {
        setError(null);
        try {
            const measured = analyzeImpulseWav(await file.arrayBuffer());
            setProfile(measured);
            setReverb({
                enabled: true,
                preset: pickPreset(measured),
                rt60: Number(measured.rt60.toFixed(2)),
                roomLevelDb: reverb.roomLevelDb,
                damping: Number(measured.damping.toFixed(2)),
                preDelayMs: Number(measured.preDelayMs.toFixed(0)),
            });
        } catch {
            setProfile(null);
            setError(t('ui.consoleReverbImpulseError'));
        }
    };

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consoleReverb')} hint={t('ui.consoleReverbHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleReverbEnabled')}</span>
                        <Toggle
                            checked={reverb.enabled}
                            onChange={enabled => setReverb({ enabled })}
                            label={t('ui.consoleReverbEnabled')}
                        />
                    </div>

                    <div className={`space-y-3.5 ${reverb.enabled ? '' : 'opacity-40'}`} inert={!reverb.enabled}>
                        <div>
                            <div className="mb-1.5 text-[12px] leading-4 text-[color:var(--st-t2)]">{t('ui.consoleReverbSpace')}</div>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {PRESETS.map(preset => {
                                    const chosen = reverb.preset === preset.id;
                                    return (
                                        <Button
                                            key={preset.id}
                                            variant="bare"
                                            aria-pressed={chosen}
                                            onClick={() => choosePreset(preset.id)}
                                            className={`flex h-9 items-center justify-center truncate rounded-lg text-[12px] transition-colors ${chosen
                                                ? 'bg-[var(--st-fill2)] text-[color:var(--st-t1)] shadow-[0_0_0_1px_var(--st-accent)]'
                                                : 'bg-[var(--st-fill)] text-[color:var(--st-t2)] hover:bg-[var(--st-fill2)]'}`}
                                        >
                                            {t(preset.key)}
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>

                        <ConsoleSlider
                            label={t('ui.consoleReverbRt60')}
                            valueText={formatSeconds(reverb.rt60)}
                            value={reverb.rt60}
                            min={AUDIO_CONSOLE_REVERB_RT60_MIN}
                            max={AUDIO_CONSOLE_REVERB_RT60_MAX}
                            log
                            onChange={rt60 => setReverb({ rt60 })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleReverbRt60Hint')}</p>

                        <ConsoleSlider
                            label={t('ui.consoleReverbRoomLevel')}
                            valueText={formatDb(reverb.roomLevelDb)}
                            value={reverb.roomLevelDb}
                            min={AUDIO_CONSOLE_ROOM_LEVEL_MIN}
                            max={AUDIO_CONSOLE_ROOM_LEVEL_MAX}
                            decimals={1}
                            onChange={roomLevelDb => setReverb({ roomLevelDb })}
                            onCommit={() => undefined}
                        />

                        <ConsoleSlider
                            label={t('ui.consoleReverbDamping')}
                            valueText={formatPercent(reverb.damping)}
                            value={reverb.damping}
                            min={AUDIO_CONSOLE_DAMPING_MIN}
                            max={AUDIO_CONSOLE_DAMPING_MAX}
                            decimals={2}
                            onChange={damping => setReverb({ damping })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleReverbDampingHint')}</p>

                        <ConsoleSlider
                            label={t('ui.consoleReverbPreDelay')}
                            valueText={formatMs(reverb.preDelayMs)}
                            value={reverb.preDelayMs}
                            min={0}
                            max={AUDIO_CONSOLE_PRE_DELAY_MAX}
                            decimals={0}
                            onChange={preDelayMs => setReverb({ preDelayMs })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleReverbPreDelayHint')}</p>

                        <ConsoleSlider
                            label={t('ui.consoleReverbMix')}
                            valueText={formatPercent(reverb.mix)}
                            value={reverb.mix}
                            min={0}
                            max={1}
                            decimals={2}
                            onChange={mix => setReverb({ mix })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleReverbMixHint')}</p>

                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[13px] leading-5">{t('ui.consoleReverbTail')}</div>
                                <div className="text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleReverbTailHint')}</div>
                            </div>
                            {/* 暂停那一下由播放器的淡化负责：这里只是把「要不要留尾巴」记进设置，
                                原生在 pause 时按它决定淡出还是立即停住。 */}
                            <Toggle
                                checked={reverb.tailOnPause}
                                onChange={tailOnPause => setReverb({ tailOnPause })}
                                label={t('ui.consoleReverbTail')}
                            />
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleStereo')} hint={t('ui.consoleStereoHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleStereoEnabled')}</span>
                        <Toggle
                            checked={stereo.enabled}
                            onChange={enabled => setStereo({ enabled })}
                            label={t('ui.consoleStereoEnabled')}
                        />
                    </div>
                    <div className={stereo.enabled ? '' : 'opacity-40'}>
                        <ConsoleSlider
                            label={t('ui.consoleStereoWidth')}
                            valueText={formatPercent(stereo.width)}
                            value={stereo.width}
                            min={AUDIO_CONSOLE_STEREO_WIDTH_MIN}
                            max={AUDIO_CONSOLE_STEREO_WIDTH_MAX}
                            decimals={2}
                            disabled={!stereo.enabled}
                            onChange={width => setStereo({ width })}
                            onCommit={() => undefined}
                        />
                        <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStereoWidthHint')}</p>
                        {/* 低频单声道：拖到最左边是关。它和宽度是两件事 —— 宽度管「侧向有多少」，
                            这一根管「多低的频率不算侧向」。 */}
                        <div className="mt-3">
                            <ConsoleSlider
                                label={t('ui.consoleStereoBassMono')}
                                valueText={stereo.bassMonoHz < 1 ? t('ui.consoleOff') : formatHz(stereo.bassMonoHz)}
                                value={stereo.bassMonoHz}
                                min={0}
                                max={AUDIO_CONSOLE_BASS_MONO_MAX}
                                log
                                decimals={0}
                                disabled={!stereo.enabled}
                                onChange={bassMonoHz => setStereo({ bassMonoHz })}
                                onCommit={() => undefined}
                            />
                            <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStereoBassMonoHint')}</p>
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleReverbImpulse')} hint={t('ui.consoleReverbImpulseHint')}>
                <div className="space-y-2 px-4 pb-4 pt-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            variant="bare"
                            className="h-7 whitespace-nowrap rounded-lg bg-[var(--st-fill)] px-3 text-[13px] text-[color:var(--st-t1)] transition-colors hover:bg-[var(--st-fill2)]"
                            onClick={() => fileRef.current?.click()}
                        >
                            {t('ui.consoleReverbImpulseChoose')}
                        </Button>
                        <span className="text-[11px] leading-4 text-[color:var(--st-t3)]">WAV · PCM 8/16/24/32 或 float</span>
                        {/* 系统文件选择器本身，藏起来由上面那个按钮按：全仓的 file input 都走
                            TextField，CI 的控件门禁不许这里另起一个裸标签。 */}
                        <TextField
                            ref={fileRef}
                            type="file"
                            accept=".wav,audio/wav,audio/x-wav"
                            className="sr-only"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                // 同一个文件连选两次也要能触发：清掉 value。
                                event.target.value = '';
                                if (file) void importImpulse(file);
                            }}
                        />
                    </div>
                    {error && <p className="text-[11px] leading-4 text-[color:var(--st-err)]">{error}</p>}
                    {profile && !error && (
                        <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 font-mono text-[11px] leading-5 text-[color:var(--st-t2)]">
                            <div>
                                {t('ui.consoleReverbImpulseMeasured', {
                                    rt60: profile.rt60.toFixed(2),
                                    preDelay: profile.preDelayMs.toFixed(0),
                                })}
                            </div>
                            <div className="text-[color:var(--st-t3)]">
                                {profile.sampleRate} Hz · {profile.durationSeconds.toFixed(2)} s
                            </div>
                        </div>
                    )}
                </div>
            </EqualizerSection>
        </div>
    );
};

export default ReverbPane;
