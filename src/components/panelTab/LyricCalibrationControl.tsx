import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useLyricCalibrationStore } from '../../stores/useLyricCalibrationStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { Button } from '../ui';
import { PanelIconButton } from './shell/PanelIconButton';
import { PanelRow } from './shell/PanelRow';

// src/components/panelTab/LyricCalibrationControl.tsx
//
// 播放面板「来源」页里的一行：自动校准。
//
// 为什么放在这里而不是播放页上长按：歌词来源、时间轴偏移、自动校准是同一件事的三个面
// （用哪份词、这份词整体偏多少、这个偏移谁来定），分开在两处只会让人找不到。面板里的
// 「时间轴偏移」是手调的旋钮，这一行是让它自己转的那个开关。
//
// 状态行说的是这一首现在的情况：正在算 / 已对齐多少 / 无需调整 / 没有本地音频 / 已关闭。
// 右侧的刷新按钮是「现在就再算一次」—— 缓存是播完才写的，用户不想等下一轮播放时用它。

/** 与设置里那颗开关同一个尺寸，颜色跟面板的主题走。 */
const Switch: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({
    checked,
    onChange,
    label,
}) => (
    <Button
        variant="bare"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`st-t-move h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${checked ? 'bg-[var(--st-accent)]' : 'bg-[var(--st-fill2)]'}`}
    >
        <span
            className={`st-t-move block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-6' : 'translate-x-0'}`}
        />
    </Button>
);

const LyricCalibrationControl: React.FC = () => {
    const { t } = useTranslation();
    const hasLyrics = usePlaybackStore(state => (state.lyrics?.lines.length ?? 0) > 0);
    const mediaCacheEnabled = useAudioSettingsStore(state => state.enableMediaCache);
    const autoEnabled = useLyricCalibrationStore(state => state.autoEnabled);
    const setAutoEnabled = useLyricCalibrationStore(state => state.setAutoEnabled);
    const phase = useLyricCalibrationStore(state => state.phase);
    const lastOffsetMs = useLyricCalibrationStore(state => state.lastOffsetMs);
    const lastReason = useLyricCalibrationStore(state => state.lastReason);
    const requestRun = useLyricCalibrationStore(state => state.requestRun);

    // 「不用调」有三种原因，对用户的含义完全不同：本来就很准 / 不是整曲偏移 / 证据不够。
    const skippedText = lastReason === 'low-confidence'
        ? t('lyricCalibration.autoSkippedLowConfidence')
        : lastReason === 'not-enough-lines'
            ? t('lyricCalibration.autoSkippedNotEnough')
            : t('lyricCalibration.autoSkippedNegligible');

    const status = !autoEnabled
        ? t('lyricCalibration.autoOff')
        : phase === 'running'
            ? t('lyricCalibration.autoRunning')
            : phase === 'applied'
                ? t('lyricCalibration.autoApplied', { ms: `${lastOffsetMs > 0 ? '+' : ''}${lastOffsetMs}` })
                : phase === 'skipped'
                    ? skippedText
                    : phase === 'no-audio'
                        ? t(mediaCacheEnabled ? 'lyricCalibration.autoNoAudio' : 'lyricCalibration.autoNoAudioCacheOff')
                        : phase === 'too-long'
                            ? t('lyricCalibration.autoTooLong')
                            : phase === 'decode-failed'
                                ? t('lyricCalibration.autoDecodeFailed')
                                : phase === 'manual'
                                    ? t('lyricCalibration.autoManual')
                                    : t('lyricCalibration.autoIdle');

    return (
        <PanelRow label={t('lyricCalibration.autoTitle')} hint={status}>
            <PanelIconButton
                size="s"
                label={t('lyricCalibration.autoRerun')}
                onClick={requestRun}
                disabled={!autoEnabled || !hasLyrics || phase === 'running'}
            >
                <RefreshCw size={15} className={phase === 'running' ? 'animate-spin' : undefined} />
            </PanelIconButton>
            <Switch
                checked={autoEnabled}
                onChange={setAutoEnabled}
                label={t('lyricCalibration.autoTitle')}
            />
        </PanelRow>
    );
};

export default LyricCalibrationControl;
