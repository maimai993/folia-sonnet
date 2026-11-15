import React from 'react';
import { AnimatePresence, motion, MotionValue, useTransform, type MotionValue as MotionValueType } from 'framer-motion';

import { Cast, ChevronLeft, Loader2, RefreshCw, Speaker, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import LanCastRemoteBody from './LanCastRemote';
import { Button } from '../ui';
import { QuickTile } from '../panelTab/controls/QuickTile';
import { usePlaybackStore, selectDisplaySong, selectDisplayCoverUrl } from '../../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import {
    castTrackToSpeaker,
    discoverLanSpeakers,
    ensureCastingMute,
    getCastingSpeaker,
    getLastSpeaker,
    getWifiAutoCastEnabled,
    isLanCastAvailable,
    lanCastErrorText,
    setWifiAutoCastEnabled,
    stopCastingToSpeaker,
    subscribeCasting,
    subscribeWifiCast,
    type LanCastTrack,
    type LanSpeaker,
} from '../../services/lanCast';

// src/components/lan-cast/LanCastControl.tsx
// 播放页左下角的投送入口：与 PanelHandle 右下角那颗按钮镜像对称（同一隐藏条件、同一贴底
// 基线、同一配色与透明度）。投送成功后手机静音但不暂停，进度条和歌词照常走，声音只在音响上。
//
// 面板结构：整个组件只有一个 fixed 浮层，设备列表与遥控器是它的两种「视图」，用 panel 状态
// 切换内容而非再叠一个弹窗。面板与左下角按钮共用 PanelHandle 传来的 hidden：播放页 chrome
// 闲置几秒收起时，面板一起退场，不再长期压住歌词；收起态不保留任何浮层（投送中用按钮上的
// 绿点表示），底部切歌区不会被额外胶囊挡住。

type Panel = 'closed' | 'devices' | 'remote';

/**
 * 渲染形态。
 *
 * - `floating`：播放页左下角那颗悬浮圆钮（旧形态，保留给别处复用）。
 * - `tile`：音质页里的一张卡片，和「信号链路」排在一起（issue #279 之后播放页走这个）。
 *
 * 之所以要分两种：悬浮形态的按钮是 fixed 定位，会压在「正在播放」提示卡上，
 * 而提示卡是 z-40、按钮是 z-60，用户看到的就是投送钮糊在卡片上。
 */
export type LanCastControlVariant = 'floating' | 'tile';

type LanCastControlProps = {
    /** floating 形态：与右下角那颗按钮共用的隐藏条件。tile 形态忽略。 */
    hidden?: boolean;
    /** floating 形态：PanelHandle 的贴底基线。tile 形态忽略。 */
    bottom?: MotionValueType<number>;
    isDaylight: boolean;
    /** floating 形态：面板是否展开。tile 形态忽略。 */
    isOpen?: boolean;
    isCommandPaletteOpen?: boolean;
    /** 渲染形态，默认 floating（向后兼容）。 */
    variant?: LanCastControlVariant;
};

const hostOf = (location: string): string => {
    try {
        return new URL(location).host;
    } catch {
        return location;
    }
};

const LanCastControl: React.FC<LanCastControlProps> = ({
    hidden = false,
    bottom,
    isDaylight,
    isOpen = false,
    isCommandPaletteOpen = false,
    variant = 'floating',
}) => {
    const { t } = useTranslation();
    const [panel, setPanel] = React.useState<Panel>('closed');
    const [devices, setDevices] = React.useState<LanSpeaker[]>([]);
    const [scanning, setScanning] = React.useState(false);
    const [castingUrl, setCastingUrl] = React.useState<string | null>(null);
    const [active, setActive] = React.useState<LanSpeaker | null>(() => getCastingSpeaker());
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    /*
     * bottom 只有 floating 形态才有（tile 形态没有贴底基线）。
     * useTransform 不接受 undefined，所以这里给一颗稳定的默认 MotionValue；
     * tile 形态下它算出来的值根本不会被用到（浮层改成居中定位）。
     */
    const fallbackBottom = React.useRef(new MotionValue(32)).current;
    const panelBottom = useTransform(bottom ?? fallbackBottom, (value: number) => value + 64);

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

    // 外部停止投送（例如离开 WiFi 自动回落）时别把遥控器留在屏幕上。
    React.useEffect(() => {
        if (!active) setPanel(current => (current === 'remote' ? 'closed' : current));
    }, [active]);

    // 面板跟着播放页 chrome 一起收起。面板内部正在操作（拖音量、点按钮）时给 5 秒宽限，
    // 免得滑块拖到一半卡片突然消失；宽限一过、chrome 仍是隐藏状态就把视图收敛成 closed，
    // 下次点屏幕唤出按钮时不会又自动弹出一张大卡。
    const [keepAliveUntil, setKeepAliveUntil] = React.useState(0);
    const pinTimerRef = React.useRef<number | null>(null);
    const lastPinRef = React.useRef(0);
    const keepAlive = React.useCallback(() => {
        const now = Date.now();
        if (pinTimerRef.current !== null && now - lastPinRef.current < 1000) return;
        lastPinRef.current = now;
        setKeepAliveUntil(now + 5000);
        if (pinTimerRef.current !== null) window.clearTimeout(pinTimerRef.current);
        pinTimerRef.current = window.setTimeout(() => {
            pinTimerRef.current = null;
            lastPinRef.current = 0;
            setKeepAliveUntil(0);
        }, 5000);
    }, []);
    React.useEffect(() => () => {
        if (pinTimerRef.current !== null) window.clearTimeout(pinTimerRef.current);
    }, []);
    React.useEffect(() => {
        if (hidden && Date.now() >= keepAliveUntil) {
            setPanel(current => (current === 'closed' ? current : 'closed'));
        }
    }, [hidden, keepAliveUntil]);

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

    // 每次切到设备列表都重新搜一遍：音响可能刚上电，缓存的旧列表意义不大。
    React.useEffect(() => {
        if (panel === 'devices' && available) void scan();
        if (panel !== 'devices') setError('');
    }, [panel, available, scan]);

    const trackKey = song ? `${song.id}::${song.name}` : '';
    const pushedSongRef = React.useRef<string | null>(null);
    const pushedSrcRef = React.useRef<string | null>(null);

    // 手机当遥控器：投送期间切歌，自动把新歌推给同一台音响。
    // store 切歌是「先写 currentSong、再异步写 audioSrc」，只看歌曲变化会拿到旧地址配新歌名。
    // 所以要等播放地址也换了才推；同一首歌的 token 变化则忽略，免得把音响反复打断重播。
    // 切歌意味着用户要操作底部控制条，顺手把展开的面板收起来让路。
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
        setPanel('closed');
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
            // 选完设备直接在同一张卡里换成遥控器，不再另开浮层。
            setPanel('remote');
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
            setPanel('closed');
        } catch (stopError) {
            setError(lanCastErrorText(stopError));
        }
    };

    const buildTrackRef = React.useRef(buildTrack);
    buildTrackRef.current = buildTrack;

    // 连上 WiFi 时自动投送到上次那台音响；离开 WiFi 时收口并恢复手机声音。
    // 网络事件可能连着来好几次，用一个 ref 挡住重复推送。
    const autoCastingRef = React.useRef(false);
    React.useEffect(() => {
        if (!available) return undefined;
        if (getWifiAutoCastEnabled()) setWifiAutoCastEnabled(true);
        return subscribeWifiCast(wifi => {
            if (wifi) {
                if (autoCastingRef.current || getCastingSpeaker()) return;
                const remembered = getLastSpeaker();
                if (!remembered) return;
                autoCastingRef.current = true;
                void (async () => {
                    try {
                        const found = await discoverLanSpeakers(2200);
                        const target = found.find(item => item.controlUrl === remembered.controlUrl)
                            ?? found.find(item => item.name === remembered.name);
                        if (target) {
                            await castTrackToSpeaker(target, buildTrackRef.current());
                            setNotice(t('lanCastWifiAutoRestored', { name: target.name }));
                        }
                    } catch { /* 自动投送失败就安静跳过，不打扰手动操作。 */ }
                    finally { autoCastingRef.current = false; }
                })();
            } else if (getCastingSpeaker()) {
                void stopCastingToSpeaker().catch(() => {});
            }
        });
    }, [available, t]);

    if (!available) return null;

    // active 可能在外部消失，先把 remote 视图收敛成收起态，避免渲染出一张空卡。
    const effectivePanel: Panel = active ? panel : (panel === 'remote' ? 'closed' : panel);
    const panelVisible = effectivePanel !== 'closed' && (!hidden || keepAliveUntil > 0);
    const buttonLabel = active
        ? `${t('lanCastRemoteTitle')} · ${active.name}`
        : t('lanCastTitle');

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
    /*
     * 外观和定位分开。
     *
     * 原来 cardShell 里硬编码了 `fixed left-4 md:left-8`，tile 形态再往后面叠一个
     * `left-1/2` —— 同一个属性两处写，谁生效看 Tailwind 的类序，实机上就偏出去压到了封面。
     * 现在这里只管「长什么样 + 是 fixed」，左右/上下由各形态自己给。
     */
    const cardShell = 'pointer-events-auto fixed z-[70] backdrop-blur-xl border ' + glass;
    const expandedShell = `${cardShell} flex max-h-[min(60vh,30rem)] w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl p-4 shadow-2xl`;
    /*
     * tile 形态：面板在屏幕右侧，浮层贴右侧、垂直居中。
     *
     * 不按屏幕居中 —— 居中会横跨到左边的封面/歌词区。
     * 宽度沿用 expandedShell 的 w-[min(22rem,calc(100vw-2rem))]，这里不再重复写宽度
     * （两处写宽度会打架，实机上出现过内容被裁掉一块）。
     */
    const tilePosition = 'right-4 top-1/2 -translate-y-1/2 md:right-8';

    return (
        <>
            {variant === 'tile' ? (
                /*
                 * tile 形态：音质页里的一张卡片，和「信号链路」并排。
                 *
                 * 不做 fixed、不带自己的浮层定位 —— 卡片在面板流里正常排布，
                 * 点开后由下面那个居中的浮层承载设备列表 / 遥控器。
                 */
                <div className="grid min-w-0 px-1 py-2">
                    <QuickTile
                        kind="open"
                        lit={Boolean(active)}
                        icon={<Cast size={18} />}
                        label={active
                            ? t('lanCastCastingTo', { name: active.name })
                            : t('lanCastTitle')}
                        aria-haspopup="dialog"
                        onClick={() => setPanel(effectivePanel !== 'closed' ? 'closed' : (active ? 'remote' : 'devices'))}
                    />
                </div>
            ) : (
            <AnimatePresence>
                {!hidden && (
                    <motion.div
                        initial={{ opacity: 0, x: -20, y: 12, scale: 0.92 }}
                        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                        exit={isCommandPaletteOpen
                            ? { opacity: 0, x: 0, y: 0, scale: 1 }
                            : { opacity: 0, x: -20, y: 12, scale: 0.92 }}
                        transition={{ duration: 0.24, ease: 'easeOut' }}
                        style={{ bottom: bottom ?? 32 }}
                        data-folia-safe-bottom="shift"
                        data-folia-safe-left="shift"
                        className="pointer-events-auto fixed left-0 z-[60] pl-4 md:pl-8 group w-20 flex justify-start"
                    >
                        <Button
                            tip={buttonLabel}
                            aria-label={buttonLabel}
                            onClick={() => setPanel(
                                effectivePanel !== 'closed' ? 'closed' : (active ? 'remote' : 'devices'),
                            )}
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
            )}

            {/* 唯一的浮层：devices / remote 互斥，mode="wait" 保证不会同时存在两个 DOM；
                收起态不留任何浮层，投送中状态只体现在左下角按钮的绿点上。 */}
            <AnimatePresence mode="wait">
                {panelVisible && (
                    <motion.div
                        key={effectivePanel}
                        initial={{ opacity: 0, y: 10, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.97 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        /*
                         * floating：贴着左下角那颗按钮往上展开（bottom 由 PanelHandle 的基线推出来）。
                         * tile：卡片在面板流里、没有固定锚点，所以改成屏幕居中弹出 ——
                         * 贴底会正好压住底部那排 tab，而用户此刻正在音质页里点它。
                         */
                        style={variant === 'tile' ? {} : { bottom: panelBottom }}
                        onPointerDown={keepAlive}
                        onTouchStart={keepAlive}
                        onChange={keepAlive}
                        data-folia-safe-bottom="shift"
                        className={`${expandedShell} ${variant === 'tile' ? tilePosition : 'left-4 md:left-8'}`}
                    >
                        {error && (
                            <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                                {error}
                            </div>
                        )}
                        {notice && !error && (
                            <div className={`rounded-lg border px-3 py-2 text-xs ${row}`}>{notice}</div>
                        )}

                        {effectivePanel === 'devices' ? (
                            <>
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="truncate text-sm font-semibold">{t('lanCastTitle')}</div>
                                        <div className={`truncate text-xs ${soft}`}>{t('lanCastHint')}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {active && (
                                            <Button
                                                tip={t('lanCastRemoteTitle')}
                                                aria-label={t('lanCastRemoteTitle')}
                                                onClick={() => setPanel('remote')}
                                                className={`flex h-8 w-8 items-center justify-center rounded-full ${row}`}
                                            >
                                                <ChevronLeft size={16} />
                                            </Button>
                                        )}
                                        <Button
                                            tip={t('lanCastClose')}
                                            aria-label={t('lanCastClose')}
                                            onClick={() => setPanel('closed')}
                                            className={`flex h-8 w-8 items-center justify-center rounded-full ${row}`}
                                        >
                                            <X size={16} />
                                        </Button>
                                    </div>
                                </div>

                                <div className={`truncate text-xs ${soft}`}>
                                    {song ? `${song.name} · ${getSongArtistLabel(song)}` : t('lanCastNoTrack')}
                                </div>

                                {active && (
                                    <div className={`text-[11px] leading-snug ${soft}`}>
                                        {t('lanCastLocalHint')}
                                    </div>
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
                            </>
                        ) : active && (
                            <LanCastRemoteBody
                                speaker={active}
                                title={song?.name ?? ''}
                                artist={getSongArtistLabel(song)}
                                coverUrl={coverUrl}
                                isDaylight={isDaylight}
                                onMinimize={() => setPanel('closed')}
                                onSwitch={() => setPanel('devices')}
                                onStop={() => void stop()}
                            />
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
};

export default LanCastControl;
