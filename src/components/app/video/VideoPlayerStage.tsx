// src/components/app/video/VideoPlayerStage.tsx
// 播放层的画面主体：顶条（返回/剧名/音量提示/画中画/全屏）、视频画面与点击层、底部控制条。
//
// 从 VideoPlayer.tsx 拆出来的原因只有一个：那个文件顶到了仓库 800 行的上限（CI 的 check:size）。
// 这里不新增逻辑，props 就是原来闭包里用到的那些；状态、解码、快捷键都还在 VideoPlayer。

import React from 'react';
import {
    ChevronLeft,
    ExternalLink,
    HelpCircle,
    ListMusic,
    Maximize2,
    Pause,
    PictureInPicture2,
    Play,
    Settings2,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
} from 'lucide-react';
import { Button } from '../../ui';
import { openOutsideLink } from '../../../utils/system/outsideLink';
import type { CmsPlayLine } from '../../../services/videoSources/cms';
import type { LoopMode, PanelTab, VideoEpisode } from './videoPlayerModel';

export type VideoPlayerStageProps = {
    chrome: boolean;
    title: string;
    current: VideoEpisode | undefined;
    episodes: VideoEpisode[];
    index: number;
    lines: CmsPlayLine[];
    lineIndex: number;
    enhance: boolean;
    loopMode: LoopMode;
    ab: { a: number | null; b: number | null };
    clock: (seconds: number) => string;
    tip: string;
    togglePip: () => void;
    setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
    goFullscreen: () => void;
    onClose: () => void;
    cover: string | undefined;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    videoFilter: string;
    videoTransform: string;
    fitClass: string;
    mediaUrl: string;
    subtitleUrl: string;
    subtitleOn: boolean;
    subtitleLabel: string;
    resolving: boolean;
    url: string;
    handleStageClick: (event: React.MouseEvent<HTMLDivElement>) => void;
    buffering: boolean;
    playingState: boolean;
    togglePlay: () => void;
    endCount: number | null;
    setEndCount: React.Dispatch<React.SetStateAction<number | null>>;
    hasNext: boolean;
    hasPrev: boolean;
    onIndexChange: (index: number) => void;
    seekBarRef: React.RefObject<HTMLSpanElement | null>;
    tick: { time: number; duration: number };
    seekingRef: React.MutableRefObject<boolean>;
    seekTo: (clientX: number) => void;
    progress: number;
    playRate: number;
    muted: boolean;
    volume: number;
    toggleMute: () => void;
    setVolOpen: React.Dispatch<React.SetStateAction<boolean>>;
    volOpen: boolean;
    volDraggingRef: React.MutableRefObject<boolean>;
    setVolAt: (clientX: number, el: HTMLElement | null) => void;
    setPanel: React.Dispatch<React.SetStateAction<PanelTab | null>>;
    panel: PanelTab | null;
};

export const VideoPlayerStage: React.FC<VideoPlayerStageProps> = ({
    chrome,
    title,
    current,
    episodes,
    index,
    lines,
    lineIndex,
    enhance,
    loopMode,
    ab,
    clock,
    tip,
    togglePip,
    setHelpOpen,
    goFullscreen,
    onClose,
    cover,
    videoRef,
    videoFilter,
    videoTransform,
    fitClass,
    mediaUrl,
    subtitleUrl,
    subtitleOn,
    subtitleLabel,
    resolving,
    url,
    handleStageClick,
    buffering,
    playingState,
    togglePlay,
    endCount,
    setEndCount,
    hasNext,
    hasPrev,
    onIndexChange,
    seekBarRef,
    tick,
    seekingRef,
    seekTo,
    progress,
    playRate,
    muted,
    volume,
    toggleMute,
    setVolOpen,
    volOpen,
    volDraggingRef,
    setVolAt,
    setPanel,
    panel,
}) => (
        <>
        {/* 顶条：返回、剧名、音量提示、画中画、全屏。播放中会跟底条一起淡出。 */}
        <div
            className={`absolute left-0 right-0 top-0 z-20 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-2 transition-opacity duration-300 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
            <Button
                type="button"
                onClick={onClose}
                className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10"
                title="返回选集（Esc）"
                aria-label="返回选集"
            >
                <ChevronLeft size={18} />
            </Button>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-[#f2f2f4]">{title}</div>
                <div className="truncate text-[11.5px] text-[#f2f2f4]/50">
                    {current?.name ?? ''}{episodes.length > 1 ? ` · 第 ${index + 1}/${episodes.length} 集` : ''}
                    {lines[lineIndex]?.name ? ` · ${lines[lineIndex].name}` : ''}
                    {enhance ? ' · 画质增强' : ''}
                    {loopMode !== 'off' ? (loopMode === 'episode' ? ' · 单集循环' : ' · 列表循环') : ''}
                    {ab.b !== null ? ` · A-B ${clock(ab.a ?? 0)}–${clock(ab.b)}` : ''}
                </div>
            </div>
            {tip && <span className="shrink-0 rounded-md bg-white/12 px-2 py-1 text-[11.5px] text-[#f2f2f4]">{tip}</span>}
            <Button type="button" onClick={togglePip} title="画中画（T）" aria-label="画中画" className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10">
                <PictureInPicture2 size={16} />
            </Button>
            <Button type="button" onClick={() => setHelpOpen(true)} title="快捷键一览（F1）" aria-label="快捷键一览" className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10">
                <HelpCircle size={16} />
            </Button>
            <Button type="button" onClick={goFullscreen} title="全屏（F）" aria-label="全屏" className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10">
                <Maximize2 size={16} />
            </Button>
        </div>

        {/* 画面：视频铺满；还没起来就放海报，别一片黑。 */}
        <div className="relative min-h-0 flex-1">
            {/* 液态玻璃底：海报虚化 + 环境光，黑色只压在四周，中间留出画面。 */}
            <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                {cover ? (
                    <img
                        src={cover}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-[70px] saturate-150"
                    />
                ) : null}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_18%,rgba(111,91,240,0.18),transparent_62%)]" />
                <div className="absolute inset-0 bg-gradient-to-b from-[#07070a]/70 via-[#07070a]/45 to-[#07070a]/85" />
            </div>

            {mediaUrl ? (
                <video
                    ref={videoRef}
                    controls={false}
                    autoPlay
                    playsInline
                    className={`relative h-full w-full bg-transparent ${fitClass}`}
                    style={{ filter: videoFilter, transform: videoTransform }}
                >
                    {subtitleUrl && subtitleOn && (
                        <track key={subtitleUrl} kind="subtitles" src={subtitleUrl} default label={subtitleLabel || '字幕'} srcLang="zh" />
                    )}
                </video>
            ) : (
                <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
                    {cover && (
                        <img src={cover} alt="" referrerPolicy="no-referrer" className="max-h-[52%] rounded-xl object-contain opacity-60" />
                    )}
                    {resolving ? (
                        <p className="text-[13px] text-[#f2f2f4]/70">正在解析这一集的播放地址…</p>
                    ) : (
                        <>
                            <p className="max-w-[460px] text-[13px] leading-6 text-[#f2f2f4]/70">
                                这一集这个站点只给了播放网页，页面里没找到能直接播的地址。换个线路试试，或者用浏览器打开。
                            </p>
                            <Button
                                type="button"
                                onClick={() => { void openOutsideLink(url); }}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-[#6f5bf0] px-3 py-1.5 text-[13px] font-medium text-white"
                            >
                                <ExternalLink size={15} />
                                用浏览器打开
                            </Button>
                            <Button
                                type="button"
                                onClick={onClose}
                                className="text-[12.5px] text-[#f2f2f4]/60 underline underline-offset-2 hover:text-[#f2f2f4]"
                            >
                                回去换线路
                            </Button>
                        </>
                    )}
                </div>
            )}

            {/* 画面点击层：单击停/播，双击中间全屏、双击左右 ±10 秒。 */}
            <div onClick={handleStageClick} className="absolute inset-0 z-10" aria-hidden="true" />

            {/* 缓冲中转一圈。 */}
            {buffering && mediaUrl ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <span className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white/75" />
                </div>
            ) : null}

            {/* 停下来的时候中间给一颗大播放钮，点一下接着看（跟 Folia 播放页一个意思）。 */}
            {!playingState && mediaUrl && !buffering ? (
                <Button
                    type="button"
                    onClick={togglePlay}
                    aria-label="播放"
                    className="absolute left-1/2 top-1/2 z-10 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-[#f2f2f4] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md transition-transform hover:scale-105"
                >
                    <Play size={26} className="translate-x-[2px]" />
                </Button>
            ) : null}

            {/* 播完：能续就倒计时自动下一集。 */}
            {endCount !== null && hasNext ? (
                <div className="absolute bottom-24 right-6 z-20 flex w-[240px] flex-col gap-2 rounded-2xl border border-white/10 bg-black/60 p-3 backdrop-blur-xl">
                    <div className="truncate text-[12.5px] text-[#f2f2f4]/70">本章播完，{endCount} 秒后继续</div>
                    <Button
                        type="button"
                        onClick={() => { setEndCount(null); onIndexChange(index + 1); }}
                        className="rounded-xl bg-white/12 px-3 py-1.5 text-[13px] font-medium text-[#f2f2f4] hover:bg-white/18"
                    >
                        立即播放第 {index + 2} 集
                    </Button>
                    <Button type="button" onClick={() => setEndCount(null)} className="text-[11.5px] text-[#f2f2f4]/45 hover:text-[#f2f2f4]/80">
                        停在这儿
                    </Button>
                </div>
            ) : null}

            {/* 底部控制条：一颗圆钮 + 上一集/下一集 + 剧名与集数 + 进度 + 列表 + 齿轮。 */}
            <div
                className={`absolute bottom-3 left-1/2 z-20 w-[min(92%,980px)] -translate-x-1/2 transition-opacity duration-300 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
                <div className="flex items-center gap-3 rounded-[22px] border border-white/12 bg-black/55 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-xl">
                    <Button
                        type="button"
                        onClick={togglePlay}
                        aria-label={playingState ? '暂停' : '播放'}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f2f2f4] text-[#0a0a0c] transition-transform hover:scale-[1.04]"
                    >
                        {playingState ? <Pause size={18} /> : <Play size={18} />}
                    </Button>
                    <Button
                        type="button"
                        disabled={!hasPrev}
                        onClick={() => onIndexChange(index - 1)}
                        title="上一集（P）"
                        className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4] disabled:opacity-30"
                    >
                        <SkipBack size={16} />
                    </Button>
                    <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
                        <span className="w-full truncate text-center text-[13px] font-medium text-[#f2f2f4]">{title}</span>
                        {/* 进度条自己是可点可拖的，不再包在选集按钮里，否则点一下只会弹面板。 */}
                        <span
                            ref={seekBarRef}
                            role="slider"
                            tabIndex={-1}
                            aria-label="播放进度"
                            aria-valuemin={0}
                            aria-valuemax={Math.round(tick.duration)}
                            aria-valuenow={Math.round(tick.time)}
                            onPointerDown={event => {
                                seekingRef.current = true;
                                try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 指针捕获不可用就退化到普通移动 */ }
                                seekTo(event.clientX);
                            }}
                            onPointerMove={event => { if (seekingRef.current) seekTo(event.clientX); }}
                            onPointerUp={event => {
                                seekingRef.current = false;
                                try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
                            }}
                            onPointerCancel={() => { seekingRef.current = false; }}
                            className="group relative block h-3.5 w-full cursor-pointer touch-none select-none"
                        >
                            <span className="absolute inset-x-0 top-1/2 block h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/15">
                                <span className="absolute inset-y-0 left-0 rounded-full bg-[#56c98d]" style={{ width: `${progress * 100}%` }} />
                                {ab.b !== null && tick.duration > 0 ? (
                                    <span
                                        className="absolute inset-y-0 rounded-full bg-[#e3a949]/70"
                                        style={{ left: `${((ab.a ?? 0) / tick.duration) * 100}%`, width: `${Math.max(0, ((ab.b - (ab.a ?? 0)) / tick.duration) * 100)}%` }}
                                    />
                                ) : null}
                            </span>
                            <span
                                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2f2f4] opacity-0 transition-opacity group-hover:opacity-100"
                                style={{ left: `${progress * 100}%` }}
                            />
                        </span>
                        <span className="flex w-full items-center justify-between text-[11px] tabular-nums text-[#f2f2f4]/55">
                            <span>{clock(tick.time)}</span>
                            <span className="truncate px-2">
                                {episodes.length > 1 ? `第 ${index + 1}/${episodes.length} 集` : current?.name ?? ''}
                                {playRate !== 1 ? ` · ${playRate}×` : ''}
                            </span>
                            <span>{clock(tick.duration)}</span>
                        </span>
                    </div>
                    <Button
                        type="button"
                        disabled={!hasNext}
                        onClick={() => onIndexChange(index + 1)}
                        title="下一集（N）"
                        className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4] disabled:opacity-30"
                    >
                        <SkipForward size={16} />
                    </Button>
                    <span className="h-5 w-px bg-white/15" aria-hidden="true" />
                    <span className="relative shrink-0">
                        <Button
                            type="button"
                            onClick={() => { if (muted) toggleMute(); setVolOpen(open => !open); }}
                            onDoubleClick={toggleMute}
                            title={muted ? '取消静音（双击切换静音）' : '静音（双击切换静音）'}
                            className="rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4]"
                        >
                            {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                        </Button>
                        {volOpen && (
                            <span className="absolute bottom-9 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-2 backdrop-blur">
                                <span
                                    role="slider"
                                    aria-label="音量"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
                                    onPointerDown={event => {
                                        volDraggingRef.current = true;
                                        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 退化 */ }
                                        setVolAt(event.clientX, event.currentTarget);
                                    }}
                                    onPointerMove={event => { if (volDraggingRef.current) setVolAt(event.clientX, event.currentTarget); }}
                                    onPointerUp={event => {
                                        volDraggingRef.current = false;
                                        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
                                    }}
                                    onPointerCancel={() => { volDraggingRef.current = false; }}
                                    className="relative block h-3 w-24 cursor-pointer touch-none select-none"
                                >
                                    <span className="absolute inset-x-0 top-1/2 block h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
                                        <span className="absolute inset-y-0 left-0 rounded-full bg-[#56c98d]" style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
                                    </span>
                                    <span
                                        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2f2f4]"
                                        style={{ left: `${(muted ? 0 : volume) * 100}%` }}
                                    />
                                </span>
                                <span className="w-8 text-[11px] tabular-nums text-[#f2f2f4]/70">{Math.round((muted ? 0 : volume) * 100)}%</span>
                            </span>
                        )}
                    </span>
                    <Button
                        type="button"
                        onClick={() => setPanel('episodes')}
                        title="播放列表（选集）"
                        className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4]"
                    >
                        <ListMusic size={16} />
                    </Button>
                    <Button
                        type="button"
                        onClick={() => setPanel(panel ? null : 'cover')}
                        title="播放面板"
                        className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4]"
                    >
                        <Settings2 size={16} />
                    </Button>
                </div>
            </div>
        </div>
        </>
);

export default VideoPlayerStage;
