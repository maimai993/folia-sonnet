import React from 'react';
import { AnimatePresence, motion, useTransform, type MotionValue } from 'framer-motion';
import { Cast, Loader2, RefreshCw, Speaker, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { usePlaybackStore, selectDisplaySong, selectDisplayCoverUrl } from '../../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import {
    castTrackToSpeaker,
    discoverLanSpeakers,
    ensureCastingMute,
    getCastingSpeaker,
    isLanCastAvailable,
    lanCastErrorText,
    stopCastingToSpeaker,
    subscribeCasting,
    type LanCastTrack,
    type LanSpeaker,
} from '../../services/lanCast';

// src/components/lan-cast/LanCastControl.tsx
// 播放页左下角的投送入口：与 PanelHandle 右下角那颗按钮镜像对称（同一隐藏条件、同一贴底
// 基线、同一配色与透明度）。投送成功后手机静音但不暂停，进度条和歌词照常走，声音只在音响上。

type LanCastControlProps = {
    /** 与右下角那颗按钮共用的隐藏条件，保证两者同时出现、同时消失。 */
    hidden: boolean;
    /** PanelHandle 的贴底基线，避免和底部控制条 / 右侧按钮错位。 */
    bottom: MotionValue<number>;
    isDaylight: boolean;
    isOpen: boolean;
    isCommandPaletteOpen: boolean;
};

const hostOf = (location: string): string => {
    try {
        return new URL(location).host;
    } catch {
        return location;
    }
};

const LanCastControl: React.FC<LanCastControlProps> = ({
    hidden,
    bottom,
    isDaylight,
    isOpen,
    isCommandPaletteOpen,
}) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState(false);
    const [devices, setDevices] = React.useState<LanSpeaker[]>([]);
    const [scanning, setScanning] = React.useState(false);
    const [castingUrl, setCastingUrl] = React.useState<string | null>(null);
    const [active, setActive] = React.useState<LanSpeaker | null>(() => getCastingSpeaker());
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const panelBottom = useTransform(bottom, value => value + 64);

    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const song = usePlaybackStore(selectDisplaySong);
    const coverUrl = usePlaybackStore(selectDisplayCoverUrl);
    const isMuted = useAudioSettingsStore(state => state.isMuted);
    const available = isLanCastAvailable();

    // 会话存在服务层：进出播放页时组件会卸载重挂，仍能恢复「正在投送」的显示。
    React.useEffect(() => subscribeCasting(() => setActive(getCastingSpeaker())), []);

    // 投送期间始终静音。拖音量条之类的动作会悄悄取消静音，这里立刻压回去，
    // 保证不会出现「音响和手机同时出声」。
    React.useEffect(() => {
        if (!isMuted) ensureCastingMute();
    }, [isMuted]);

    const buildTrack = React.useCallback((): LanCastTrack => ({
        url: audioSrc ?? '',
        title: song?.name ?? '',
        artist: getSongArtistLabel(song),
        album: song?.album?.name ?? '',
        coverUrl: coverUrl ?? '',
        durationMs: song?.durationMs ?? 0,
    }), [audioSrc, song, coverUrl]);

    const scan = React.useCallback(async () => {
        setScanning(true);
        setError('');
        setNotice('');
        try {
            const found = await discoverLanSpeakers();
            setDevices(found);
            if (found.length === 0) setNotice(t('lanCastNoDevice'));
        } catch (scanError) {
            setError(lanCastErrorText(scanError));
        } finally {
            setScanning(false);
        }
    }, [t]);

    // 每次打开面板都重新搜一遍：音响可能刚上电，缓存的旧列表意义不大。
    React.useEffect(() => {
        if (open && available) void scan();
        if (!open) setError('');
    }, [open, available, scan]);

    const trackKey = song ? `${song.id}::${song.name}` : '';
    const pushedSongRef = React.useRef<string | null>(null);
    const pushedSrcRef = React.useRef<string | null>(null);

    // 手机当遥控器：投送期间切歌，自动把新歌推给同一台音响。
    // store 切歌是「先写 currentSong、再异步写 audioSrc」，只看歌曲变化会拿到旧地址配新歌名。
    // 所以要等播放地址也换了才推；同一首歌的 token 变化则忽略，免得把音响反复打断重播。
    React.useEffect(() => {
        if (!trackKey) return;
        if (pushedSongRef.current === null) {
            pushedSongRef.current = trackKey;
            pushedSrcRef.current = audioSrc;
            return;
        }
        if (pushedSongRef.current === trackKey) return;
        if (!audioSrc || audioSrc === pushedSrcRef.current) return;
        const speaker = getCastingSpeaker();
        if (!speaker) return;
        pushedSongRef.current = trackKey;
        pushedSrcRef.current = audioSrc;
        void castTrackToSpeaker(speaker, buildTrack())
            .then(() => {
                setNotice(t('lanCastFollowed', { name: speaker.name }));
                setError('');
            })
            .catch(followError => setError(lanCastErrorText(followError)));
    }, [trackKey, audioSrc, buildTrack, t]);

    const castTo = async (device: LanSpeaker) => {
        setCastingUrl(device.controlUrl);
        setError('');
        setNotice('');
        try {
            await castTrackToSpeaker(device, buildTrack());
            pushedSongRef.current = trackKey;
            pushedSrcRef.current = audioSrc;
            setNotice(t('lanCastPlaying', { name: device.name }));
        } catch (castError) {
            setError(lanCastErrorText(castError));
        } finally {
            setCastingUrl(null);
        }
    };

    const stop = async () => {
        setError('');
        try {
            await stopCastingToSpeaker();
            setNotice('');
        } catch (stopError) {
            setError(lanCastErrorText(stopError));
        }
    };

    if (!available) return null;

    // 与 PanelHandle 右下角那颗按钮逐字一致的配色与透明度，左右看是一对。
    const buttonTone = isOpen
        ? 'bg-white text-black'
        : (isDaylight ? 'bg-white/70 text-zinc-900' : 'bg-black/40 text-white');
    const buttonClass = `w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 shadow-lg backdrop-blur-md transform border-none relative ${buttonTone}`;
    const glass = isDaylight
        ? 'border-black/10 bg-white/85 text-zinc-900'
        : 'border-white/10 bg-black/70 text-white';
    const soft = isDaylight ? 'text-zinc-500' : 'text-white/55';
    const row = isDaylight ? 'hover:bg-black/5 border-black/5' : 'hover:bg-white/10 border-white/10';

    return (
        <>
            <AnimatePresence>
                {!hidden && (
                    <motion.div
                        initial={{ opacity: 0, x: -20, y: 12, scale: 0.92 }}
                        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                        exit={isCommandPaletteOpen
                            ? { opacity: 0, x: 0, y: 0, scale: 1 }
                            : { opacity: 0, x: -20, y: 12, scale: 0.92 }}
                        transition={{ duration: 0.24, ease: 'easeOut' }}
                        style={{ bottom }}
                        data-folia-safe-bottom="shift"
                        data-folia-safe-left="shift"
                        className="pointer-events-auto fixed left-0 z-[60] pl-4 md:pl-8 group w-20 flex justify-start"
                    >
                        <Button
                            tip={t('lanCastTitle')}
                            aria-label={t('lanCastTitle')}
                            onClick={() => setOpen(value => !value)}
                            className={buttonClass}
                        >
                            <Cast size={20} />
                            {active && (
                                <span className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
                            )}
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 12, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.97 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        style={{ bottom: panelBottom }}
                        className={`pointer-events-auto fixed left-4 z-[70] flex max-h-[min(60vh,30rem)] w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border p-4 shadow-2xl backdrop-blur-xl md:left-8 ${glass}`}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{t('lanCastTitle')}</div>
                                <div className={`truncate text-xs ${soft}`}>{t('lanCastHint')}</div>
                            </div>
                            <Button
                                tip={t('lanCastClose')}
                                onClick={() => setOpen(false)}
                                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${row}`}
                            >
                                <X size={16} />
                            </Button>
                        </div>

                        <div className={`truncate text-xs ${soft}`}>
                            {song ? `${song.name} · ${getSongArtistLabel(song)}` : t('lanCastNoTrack')}
                        </div>

                        {error && (
                            <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                                {error}
                            </div>
                        )}
                        {notice && !error && (
                            <div className={`rounded-lg border px-3 py-2 text-xs ${row}`}>{notice}</div>
                        )}
                        {active && (
                            <div className={`text-[11px] leading-snug ${soft}`}>{t('lanCastLocalHint')}</div>
                        )}

                        <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs ${soft}`}>
                                {scanning ? t('lanCastScanning') : t('lanCastDevices', { count: devices.length })}
                            </span>
                            <Button
                                onClick={() => void scan()}
                                disabled={scanning}
                                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${row} ${scanning ? 'opacity-50' : ''}`}
                            >
                                {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                                {t('lanCastRescan')}
                            </Button>
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
                            {devices.map(device => {
                                const busy = castingUrl === device.controlUrl;
                                const isActive = active?.controlUrl === device.controlUrl;
                                return (
                                    <Button
                                        key={device.id || device.controlUrl}
                                        onClick={() => void castTo(device)}
                                        disabled={Boolean(castingUrl)}
                                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${row} ${isActive ? 'ring-1 ring-emerald-400/60' : ''}`}
                                    >
                                        {busy
                                            ? <Loader2 size={18} className="shrink-0 animate-spin" />
                                            : <Speaker size={18} className="shrink-0" />}
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm">{device.name}</span>
                                            <span className={`block truncate text-[11px] ${soft}`}>
                                                {[device.manufacturer, hostOf(device.location)].filter(Boolean).join(' · ')}
                                            </span>
                                        </span>
                                    </Button>
                                );
                            })}
                        </div>

                        {active && (
                            <Button
                                onClick={() => void stop()}
                                className="flex items-center justify-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
                            >
                                <Square size={13} />
                                {t('lanCastStop')}
                            </Button>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
};

export default LanCastControl;
