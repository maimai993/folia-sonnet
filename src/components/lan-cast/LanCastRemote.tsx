import React from 'react';
import { Cast, ChevronDown, RefreshCw, Square, Volume2, VolumeX, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Slider } from '../ui';
import {
    getSpeakerVolume,
    getWifiAutoCastEnabled,
    setSpeakerMuted,
    setSpeakerVolume,
    setWifiAutoCastEnabled,
    supportsSpeakerVolume,
    type LanSpeaker,
} from '../../services/lanCast';

// src/components/lan-cast/LanCastRemote.tsx
// 遥控器「内容」，不含任何 fixed 定位与浮层外壳：外壳由 LanCastControl 的单一面板容器提供，
// 设备列表与本组件作为同一个容器的两种视图切换，避免两个浮层在窄屏上互相压住。
// 手机端进度条与歌词照常可见、照常动，声音只在音响上；这里不放播放/暂停按钮，
// 免得和 Web 侧 togglePlay 那条链路再叠一层状态。

type LanCastRemoteBodyProps = {
    speaker: LanSpeaker;
    title: string;
    artist: string;
    coverUrl?: string | null;
    isDaylight: boolean;
    onMinimize: () => void;
    onSwitch: () => void;
    onStop: () => void;
};

const LanCastRemoteBody: React.FC<LanCastRemoteBodyProps> = ({
    speaker,
    title,
    artist,
    coverUrl,
    isDaylight,
    onMinimize,
    onSwitch,
    onStop,
}) => {
    const { t } = useTranslation();
    const [volume, setVolume] = React.useState<number | null>(null);
    const [volumeError, setVolumeError] = React.useState('');
    const [wifiAuto, setWifiAuto] = React.useState(() => getWifiAutoCastEnabled());
    const volumeSupported = supportsSpeakerVolume(speaker);
    const lastVolumeRef = React.useRef<number>(50);

    React.useEffect(() => {
        let alive = true;
        setVolume(null);
        setVolumeError('');
        if (!volumeSupported) return () => { alive = false; };
        void getSpeakerVolume(speaker)
            .then(value => { if (alive) setVolume(value); })
            .catch(() => { if (alive) setVolumeError(t('lanCastVolumeUnsupported')); });
        return () => { alive = false; };
    }, [speaker.controlUrl, speaker.volumeControlUrl, volumeSupported, speaker, t]);

    React.useEffect(() => {
        // 开关状态可能在设置里被改过；挂载时把原生监听也重新注册一次。
        if (wifiAuto) setWifiAutoCastEnabled(true);
    }, [wifiAuto]);

    // 音响端 SOAP 是网络请求，拖动滑杆时按 120ms 节流；松手补一次最终值，
    // 免得最后一次预览被节流吃掉、手机读数和音响实际音量对不上。
    const lastPushRef = React.useRef(0);
    const pendingVolumeRef = React.useRef<number | null>(null);
    const pushVolume = (next: number, force = false) => {
        const now = Date.now();
        if (!force && now - lastPushRef.current < 120) {
            pendingVolumeRef.current = next;
            return;
        }
        lastPushRef.current = now;
        pendingVolumeRef.current = null;
        void setSpeakerVolume(speaker, next)
            .catch(() => setVolumeError(t('lanCastVolumeUnsupported')));
    };

    const changeVolume = (next: number, force = false) => {
        const clamped = Math.max(0, Math.min(100, Math.round(next)));
        setVolume(clamped);
        lastVolumeRef.current = clamped;
        pushVolume(clamped, force);
    };

    const commitVolume = () => {
        const pending = pendingVolumeRef.current;
        if (pending !== null) pushVolume(pending, true);
    };

    const toggleMute = () => {
        const muted = volume === 0;
        const restored = muted ? (lastVolumeRef.current || 50) : 0;
        changeVolume(restored, true);
        void setSpeakerMuted(speaker, !muted).catch(() => {});
    };

    const toggleWifiAuto = () => {
        const next = !wifiAuto;
        setWifiAuto(next);
        setWifiAutoCastEnabled(next);
    };

    const soft = isDaylight ? 'text-zinc-500' : 'text-white/55';
    const row = isDaylight ? 'hover:bg-black/5 border-black/5' : 'hover:bg-white/10 border-white/10';

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-400/15">
                    <Cast size={15} className="text-emerald-400" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{t('lanCastRemoteTitle')}</div>
                    <div className={`truncate text-[11px] ${soft}`}>
                        {t('lanCastRemotePlayingOn', { name: speaker.name })}
                    </div>
                </div>
                <Button
                    tip={t('lanCastRemoteMinimize')}
                    aria-label={t('lanCastRemoteMinimize')}
                    onClick={onMinimize}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${row}`}
                >
                    <ChevronDown size={14} />
                </Button>
            </div>

            <div className="flex items-center gap-2.5">
                {coverUrl ? (
                    <img
                        src={coverUrl}
                        alt=""
                        className="h-11 w-11 shrink-0 rounded-lg object-cover"
                    />
                ) : (
                    <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${row}`}>
                        <Volume2 size={18} />
                    </div>
                )}
                <div className="min-w-0">
                    <div className="truncate text-sm">{title || t('lanCastNoTrack')}</div>
                    <div className={`truncate text-[11px] ${soft}`}>{artist}</div>
                </div>
            </div>

            <div className={`text-[11px] leading-snug ${soft}`}>
                {t('lanCastRemoteHint')}
            </div>

            {volumeSupported ? (
                <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                        <span className={`text-[11px] ${soft}`}>{t('lanCastVolume')}</span>
                        <span className="text-[11px] tabular-nums">{volume ?? '--'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            tip={t('lanCastVolumeMute')}
                            aria-label={t('lanCastVolumeMute')}
                            onClick={toggleMute}
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${row}`}
                        >
                            {volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                        </Button>
                        <Slider
                            value={(volume ?? 50) / 100}
                            onPreview={value => changeVolume(value * 100)}
                            onCommit={commitVolume}
                            label={t('lanCastVolume')}
                            valueText={volume === null ? undefined : `${volume}%`}
                            disabled={volume === null}
                            className="min-w-0 flex-1"
                        />
                    </div>
                </div>
            ) : (
                <div className={`text-[11px] ${soft}`}>{t('lanCastVolumeUnsupported')}</div>
            )}
            {volumeError && (
                <div className="text-[11px] text-amber-400">{volumeError}</div>
            )}

            <Button
                onClick={toggleWifiAuto}
                className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${row}`}
            >
                <span className="flex items-center gap-2">
                    <Wifi size={14} />
                    {t('lanCastWifiAuto')}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${wifiAuto ? 'bg-emerald-400/20 text-emerald-400' : soft}`}>
                    {wifiAuto ? t('lanCastWifiAutoOn') : t('lanCastWifiAutoOff')}
                </span>
            </Button>

            <div className="flex gap-2">
                <Button
                    onClick={onSwitch}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs ${row}`}
                >
                    <RefreshCw size={13} />
                    {t('lanCastRemoteSwitch')}
                </Button>
                <Button
                    onClick={onStop}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-2 py-2 text-xs text-rose-300"
                >
                    <Square size={13} />
                    {t('lanCastStop')}
                </Button>
            </div>
        </div>
    );
};

export default LanCastRemoteBody;
