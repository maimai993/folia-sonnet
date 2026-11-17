// src/components/app/video/VideoPlayer.tsx
// 影视的播放层：全屏沉浸的一层，照 Folia 自己的播放页来——大封面、底部那条控制条、右侧一块页签面板。
//
// 与音乐播放页的区别只在内容：这里的「封面」是剧集海报，「播放列表」里的条目是一集一集，
// 「音质」那个位置换成了「清晰度」（片源是 m3u8，档位来自 master playlist；单档源就说明只有一档，
// 换线路就是换片源清晰度）。
//
// m3u8 用 hls.js（动态 import，只有真点进一集时才拉这个 chunk）；mp4 之类直链直接交给 <video>。
// 影视站常见的 svip/share 播放网页不是媒体直链，这里先去这个网页里把真正的 m3u8 抠出来。
//
// 操作面是把几家主流播放器的习惯合成一套（不另起一套键位）：
//   PotPlayer —— 空格停/播、←/→ 5 秒、↑/↓ 音量、Enter 全屏、PgUp/PgDn 上下集、/ - 调倍速、B 设 A-B、C 载图
//   mpv       —— , . 逐帧、[ ] 倍速 ∓10%、{ } 减半/加倍、L 循环、数字键跳百分比、滚轮音量
//   网页播放器 —— 单击画面停/播、双击全屏、双击左右两侧快退/快进、J/K/L、M 静音
//   IINA/Infuse —— 断点续播、自动下一集、结尾倒计时
// 画面走 Folia 的液态玻璃：海报虚化打底 + 环境光，控制条是一条玻璃胶囊，播放中鼠标停下几秒自己走开。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Camera,
    Check,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    HelpCircle,
    ListMusic,
    Maximize2,
    Pause,
    PictureInPicture2,
    Play,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    Settings2,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
} from 'lucide-react';
import { Button } from '../../ui';
import { useVideoPlayerController } from './useVideoPlayerController';
import { VideoPlayerPanel } from './VideoPlayerPanel';
import { VideoPlayerStage } from './VideoPlayerStage';
import { VideoPlayerOverlays } from './VideoPlayerOverlays';
import { openOutsideLink } from '../../../utils/system/outsideLink';
import { fetchVideoText } from '../../../services/videoSources/net';
import { isMediaUrl, type CmsPlayLine } from '../../../services/videoSources/cms';
import { languageName, loadSubtitleVtt, searchSubtitles, type SubtitleHit } from '../../../services/videoSources/subtitles';

import {
    STEP_SECONDS, STEP_SECONDS_LONG, SPEEDS, CHROME_LINGER_MS, PREFS_KEY, ENHANCE_KEY, POS_PREFIX, DEFAULT_PREFS, readPrefs, writePrefs, isHls, resolvePageMedia, clock, KEYMAP,
} from './videoPlayerModel';
import type {
    VideoEpisode,
    LoopMode,
    AspectMode,
    Prefs,
    Level,
    PanelTab,
    MenuLeaf,
    MenuBranch,
    MenuEntry,
} from './videoPlayerModel';

import type { VideoPlayerProps as Props } from './videoPlayerModel';

/** 选集条目：仍从这个文件导出，调用方（影视工作台）不用改引用位置。 */
export type { VideoEpisode };

export const VideoPlayer: React.FC<Props> = props => {
    const {
        ab,
        applySubtitle,
        buffering,
        chrome,
        cover,
        current,
        endCount,
        enhance,
        episodes,
        error,
        failedPage,
        fitClass,
        goFullscreen,
        handleStageClick,
        hasNext,
        hasPrev,
        helpOpen,
        index,
        levelIndex,
        levels,
        lineIndex,
        lines,
        loopMode,
        mediaUrl,
        menu,
        menuEntries,
        menuRef,
        muted,
        onClose,
        onIndexChange,
        onLineChange,
        panel,
        patchPrefs,
        playRate,
        playingState,
        pokeChrome,
        prefs,
        progress,
        resolving,
        runSubSearch,
        seekBarRef,
        seekTo,
        seekingRef,
        setEndCount,
        setHelpOpen,
        setLevel,
        setMenu,
        setPanel,
        setSpeed,
        setSub,
        setSubKeyword,
        setSubtitleLabel,
        setSubtitleUrl,
        setVolAt,
        setVolOpen,
        shellRef,
        shootScreen,
        sub,
        subBusy,
        subHits,
        subKeyword,
        subNote,
        subtitleLabel,
        subtitleOn,
        subtitleUrl,
        tick,
        tip,
        title,
        toggleMute,
        togglePip,
        togglePlay,
        url,
        videoFilter,
        videoRef,
        videoTransform,
        volDraggingRef,
        volOpen,
        volume,
    } = useVideoPlayerController(props);
    return (
        <div
            ref={shellRef}
            data-video-player
            className="fixed inset-0 z-[90] flex min-h-0 select-none flex-col overflow-hidden bg-[#07070a]"
            onMouseMove={pokeChrome}
            onContextMenu={event => {
                event.preventDefault();
                const width = 214;
                // 一列到底：一行 28px，分隔线各占 8px，再加内边距。
                const rows = menuEntries.reduce((sum, entry) => sum + (entry.kind === 'line' ? 8 : 28), 0) + 8;
                const height = Math.min(rows, 470);
                const x = Math.min(event.clientX, window.innerWidth - width - 8);
                const y = Math.min(event.clientY, Math.max(8, window.innerHeight - height - 8));
                setSub(null);
                setMenu({ x, y });
            }}
        >
            <VideoPlayerStage
                chrome={chrome}
                title={title}
                current={current}
                episodes={episodes}
                index={index}
                lines={lines}
                lineIndex={lineIndex}
                enhance={enhance}
                loopMode={loopMode}
                ab={ab}
                clock={clock}
                tip={tip}
                togglePip={togglePip}
                setHelpOpen={setHelpOpen}
                goFullscreen={goFullscreen}
                onClose={onClose}
                cover={cover}
                videoRef={videoRef}
                videoFilter={videoFilter}
                videoTransform={videoTransform}
                fitClass={fitClass}
                mediaUrl={mediaUrl}
                subtitleUrl={subtitleUrl}
                subtitleOn={subtitleOn}
                subtitleLabel={subtitleLabel}
                resolving={resolving}
                url={url}
                handleStageClick={handleStageClick}
                buffering={buffering}
                playingState={playingState}
                togglePlay={togglePlay}
                endCount={endCount}
                setEndCount={setEndCount}
                hasNext={hasNext}
                hasPrev={hasPrev}
                onIndexChange={onIndexChange}
                seekBarRef={seekBarRef}
                tick={tick}
                seekingRef={seekingRef}
                seekTo={seekTo}
                progress={progress}
                playRate={playRate}
                muted={muted}
                volume={volume}
                toggleMute={toggleMute}
                setVolOpen={setVolOpen}
                volOpen={volOpen}
                volDraggingRef={volDraggingRef}
                setVolAt={setVolAt}
                setPanel={setPanel}
                panel={panel}
            />

            {/* 右侧面板：封面 / 选集 / 字幕 / 清晰度 / 更多。 */}
            {panel && (
                <VideoPlayerPanel
                    panel={panel}
                    setPanel={setPanel}
                    title={title}
                    cover={cover}
                    current={current}
                    lines={lines}
                    lineIndex={lineIndex}
                    onLineChange={onLineChange}
                    episodes={episodes}
                    index={index}
                    onIndexChange={onIndexChange}
                    subKeyword={subKeyword}
                    setSubKeyword={setSubKeyword}
                    runSubSearch={runSubSearch}
                    subBusy={subBusy}
                    subNote={subNote}
                    subHits={subHits}
                    applySubtitle={applySubtitle}
                    subtitleUrl={subtitleUrl}
                    subtitleLabel={subtitleLabel}
                    setSubtitleUrl={setSubtitleUrl}
                    setSubtitleLabel={setSubtitleLabel}
                    levels={levels}
                    levelIndex={levelIndex}
                    setLevel={setLevel}
                    prefs={prefs}
                    patchPrefs={patchPrefs}
                    setSpeed={setSpeed}
                    mediaUrl={mediaUrl}
                    url={url}
                    goFullscreen={goFullscreen}
                    shootScreen={shootScreen}
                    togglePip={togglePip}
                    setHelpOpen={setHelpOpen}
                />
            )}

            {error && (
                <div className="absolute bottom-20 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-[#e3a949]/15 px-3 py-1.5 text-[12px] text-[#e3a949]">
                    {error}
                </div>
            )}

            {failedPage && mediaUrl === '' && !resolving && (
                <span className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 text-[11px] text-[#f2f2f4]/30">页面已抓取，但没有可用的媒体地址</span>
            )}

            <VideoPlayerOverlays
                helpOpen={helpOpen}
                setHelpOpen={setHelpOpen}
                menu={menu}
                setMenu={setMenu}
                sub={sub}
                setSub={setSub}
                menuEntries={menuEntries}
                menuRef={menuRef}
            />
        </div>
    );
};

export default VideoPlayer;
