// src/components/app/video/VideoPlayerPanel.tsx
// 播放层右侧那块面板：封面 / 选集 / 字幕 / 清晰度 / 更多。纯展示，状态仍由 VideoPlayer 持有。
//
// 从 VideoPlayer.tsx 拆出来的原因只有一个：那个文件顶到了仓库 800 行的上限（CI 的 check:size）。
// 这里不新增任何逻辑，props 就是原来闭包里用到的那些。

import React from 'react';
import { Button, TextField, Slider } from '../../ui';
import { languageName, type SubtitleHit } from '../../../services/videoSources/subtitles';
import { openOutsideLink } from '../../../utils/system/outsideLink';
import type { CmsPlayLine } from '../../../services/videoSources/cms';
import type { Level, PanelTab, Prefs, VideoEpisode } from './videoPlayerModel';

export type VideoPlayerPanelProps = {
    panel: PanelTab;
    setPanel: React.Dispatch<React.SetStateAction<PanelTab | null>>;
    title: string;
    cover?: string;
    current?: VideoEpisode;
    lines: CmsPlayLine[];
    lineIndex: number;
    onLineChange: (index: number) => void;
    episodes: VideoEpisode[];
    index: number;
    onIndexChange: (index: number) => void;
    subKeyword: string;
    setSubKeyword: React.Dispatch<React.SetStateAction<string>>;
    runSubSearch: () => Promise<void>;
    subBusy: boolean;
    subNote: string;
    subHits: SubtitleHit[];
    applySubtitle: (hit: SubtitleHit) => Promise<void>;
    subtitleUrl: string;
    subtitleLabel: string;
    setSubtitleUrl: (url: string) => void;
    setSubtitleLabel: (label: string) => void;
    levels: Level[];
    levelIndex: number;
    setLevel: (index: number) => void;
    prefs: Prefs;
    patchPrefs: (patch: Partial<Prefs>) => void;
    setSpeed: (speed: number) => void;
    mediaUrl: string;
    url: string;
    goFullscreen: () => void;
    shootScreen: () => void;
    togglePip: () => void;
    setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export const VideoPlayerPanel: React.FC<VideoPlayerPanelProps> = ({
    panel,
    setPanel,
    title,
    cover,
    current,
    lines,
    lineIndex,
    onLineChange,
    episodes,
    index,
    onIndexChange,
    subKeyword,
    setSubKeyword,
    runSubSearch,
    subBusy,
    subNote,
    subHits,
    applySubtitle,
    subtitleUrl,
    subtitleLabel,
    setSubtitleUrl,
    setSubtitleLabel,
    levels,
    levelIndex,
    setLevel,
    prefs,
    patchPrefs,
    setSpeed,
    mediaUrl,
    url,
    goFullscreen,
    shootScreen,
    togglePip,
    setHelpOpen,
}) => (
        <div className="absolute bottom-3 right-3 top-14 z-30 flex w-[min(78vw,340px)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#141418]/95 backdrop-blur">
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
                {cover && <img src={cover} alt="" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded-md object-cover" />}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-[#f2f2f4]">{title}</div>
                    <div className="truncate text-[11px] text-[#f2f2f4]/45">{current?.name ?? ''}</div>
                </div>
                <Button type="button" onClick={() => setPanel(null)} className="shrink-0 rounded-full p-1 text-[#f2f2f4]/70 hover:bg-white/10 hover:text-[#f2f2f4]" aria-label="关闭面板">
                    ✕
                </Button>
            </div>

            <div className="tabs flex shrink-0 gap-1 px-2 pt-2">
                {([['cover', '封面'], ['episodes', '选集'], ['subtitle', '字幕'], ['quality', '清晰度'], ['more', '更多']] as Array<[PanelTab, string]>).map(([key, label]) => (
                    <Button
                        key={key}
                        type="button"
                        onClick={() => setPanel(key)}
                        className={`rounded-lg px-2.5 py-1 text-[12px] ${panel === key ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/50 hover:text-[#f2f2f4]'}`}
                    >
                        {label}
                    </Button>
                ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {panel === 'cover' && (
                    <div className="flex flex-col items-stretch gap-2">
                        {cover ? (
                            <img src={cover} alt="" referrerPolicy="no-referrer" className="w-full rounded-xl object-cover" />
                        ) : (
                            <div className="flex h-48 items-center justify-center rounded-xl bg-white/5 text-[12px] text-[#f2f2f4]/35">没有海报</div>
                        )}
                        <div className="text-[13px] font-semibold text-[#f2f2f4]">{title}</div>
                        <div className="text-[11.5px] text-[#f2f2f4]/45">{current?.name ?? ''}</div>
                        <div className="text-[11.5px] leading-5 text-[#f2f2f4]/35">
                            片源：{lines[lineIndex]?.name ?? '内置源'} · 共 {episodes.length} 集
                        </div>
                    </div>
                )}

                {panel === 'episodes' && (
                    <div className="flex flex-col gap-1">
                        <div className="mb-1 flex items-center justify-between text-[11.5px] text-[#f2f2f4]/45">
                            <span>选集 {episodes.length}</span>
                            <span>当前第 {index + 1} 集</span>
                        </div>
                        {episodes.map((episode, at) => (
                            <Button
                                key={`${episode.name}-${at}`}
                                type="button"
                                onClick={() => onIndexChange(at)}
                                className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] ${at === index ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]'}`}
                            >
                                <span className="truncate">{episode.name}</span>
                                <span className="shrink-0 text-[11px] tabular-nums text-[#f2f2f4]/35">{String(at + 1).padStart(2, '0')}</span>
                            </Button>
                        ))}
                    </div>
                )}

                {panel === 'subtitle' && (
                    <div className="flex flex-col gap-2">
                        <div className="text-[11.5px] leading-4 text-[#f2f2f4]/45">
                            搜全网字幕（OpenSubtitles）。中文剧名多半搜不到，换成英文名或拼音更准——庆余年 就是 qing yu nian 或 Joy of Life。
                        </div>
                        <div className="flex gap-1.5">
                            <TextField
                                value={subKeyword}
                                onChange={event => setSubKeyword(event.target.value)}
                                onKeyDown={event => { if (event.key === 'Enter') void runSubSearch(); }}
                                placeholder="剧名 / 英文名 / 拼音"
                                className="h-8 min-w-0 flex-1 select-text rounded-lg bg-white/10 px-2.5 text-[12.5px] text-[#f2f2f4] outline-none placeholder:text-[#f2f2f4]/35"
                            />
                            <Button
                                type="button"
                                disabled={subBusy}
                                onClick={() => void runSubSearch()}
                                className="h-8 shrink-0 rounded-lg bg-[#6f5bf0] px-2.5 text-[12px] font-medium text-white disabled:opacity-40"
                            >
                                {subBusy ? '搜索中…' : '搜索'}
                            </Button>
                        </div>
                        {subNote && <div className="text-[11.5px] leading-4 text-[#e3a949]">{subNote}</div>}
                        {subtitleUrl && (
                            <div className="flex items-center justify-between gap-2 rounded-lg bg-white/10 px-2.5 py-1.5 text-[12px] text-[#f2f2f4]">
                                <span className="min-w-0 truncate">已加载：{subtitleLabel}</span>
                                <Button
                                    type="button"
                                    onClick={() => { setSubtitleUrl(''); setSubtitleLabel(''); }}
                                    className="shrink-0 text-[11.5px] text-[#f2f2f4]/60 hover:text-[#f2f2f4]"
                                >
                                    关闭字幕
                                </Button>
                            </div>
                        )}
                        <div className="flex flex-col gap-1">
                            {subHits.map(hit => {
                                const matched = hit.episode === index + 1;
                                return (
                                    <Button
                                        key={hit.id}
                                        type="button"
                                        onClick={() => void applySubtitle(hit)}
                                        className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${matched ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/60 hover:bg-white/8 hover:text-[#f2f2f4]'}`}
                                    >
                                        <span className="min-w-0 truncate">
                                            {matched && <span className="mr-1 text-[#56c98d]">当前集</span>}
                                            {hit.name}
                                        </span>
                                        <span className="shrink-0 text-[10.5px] text-[#f2f2f4]/40">
                                            {languageName(hit.language)}{hit.downloads ? ` · ${hit.downloads}` : ''}
                                        </span>
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {panel === 'quality' && (
                    <div className="flex flex-col gap-2">
                        <div className="text-[11.5px] text-[#f2f2f4]/45">当前：{lines[lineIndex]?.name ?? '内置源'}</div>
                        {levels.length > 0 ? (
                            <>
                                <Button
                                    type="button"
                                    onClick={() => setLevel(-1)}
                                    className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] ${levelIndex < 0 ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8'}`}
                                >
                                    <span>自动</span>
                                    {levelIndex < 0 && <span className="text-[#56c98d]">✓</span>}
                                </Button>
                                {levels.map(level => (
                                    <Button
                                        key={level.index}
                                        type="button"
                                        onClick={() => setLevel(level.index)}
                                        className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] ${levelIndex === level.index ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8'}`}
                                    >
                                        <span>{level.height ? `${level.height}P` : `第 ${level.index + 1} 档`}</span>
                                        <span className="flex items-center gap-2 text-[11px] text-[#f2f2f4]/40">
                                            {level.bitrate ? `${Math.round(level.bitrate / 1000)}kbps` : ''}
                                            {levelIndex === level.index && <span className="text-[#56c98d]">✓</span>}
                                        </span>
                                    </Button>
                                ))}
                            </>
                        ) : (
                            <div className="rounded-lg bg-white/8 px-3 py-2 text-[12px] leading-5 text-[#f2f2f4]/55">
                                这个片源只有一档清晰度。想更清楚就换线路——下面这些线路来自不同的站，画质不一样。
                            </div>
                        )}
                        <div className="mt-1 text-[11.5px] text-[#f2f2f4]/45">换线路（换片源，也就换了画质）</div>
                        {lines.map((line, at) => (
                            <Button
                                key={`${line.name}-${at}`}
                                type="button"
                                onClick={() => onLineChange(at)}
                                className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] ${at === lineIndex ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8'}`}
                            >
                                <span className="truncate">{line.name}</span>
                                <span className="shrink-0 text-[11px] text-[#f2f2f4]/40">{line.episodes.length} 集</span>
                            </Button>
                        ))}
                    </div>
                )}

                {panel === 'more' && (
                    <div className="flex flex-col gap-1">
                        {[
                            ['倍速 0.5×', () => setSpeed(0.5)],
                            ['倍速 1×', () => setSpeed(1)],
                            ['倍速 1.25×', () => setSpeed(1.25)],
                            ['倍速 1.5×', () => setSpeed(1.5)],
                            ['倍速 2×', () => setSpeed(2)],
                        ].map(([label, run]) => (
                            <Button
                                key={label as string}
                                type="button"
                                onClick={run as () => void}
                                className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]"
                            >
                                {label as string}
                            </Button>
                        ))}

                        <div className="mt-2 text-[11.5px] text-[#f2f2f4]/45">画面调节</div>
                        {([
                            ['亮度', prefs.brightness, (value: number) => patchPrefs({ brightness: value })],
                            ['对比度', prefs.contrast, (value: number) => patchPrefs({ contrast: value })],
                            ['饱和度', prefs.saturation, (value: number) => patchPrefs({ saturation: value })],
                        ] as Array<[string, number, (value: number) => void]>).map(([label, value, apply]) => (
                            <label key={label} className="flex items-center gap-2 px-1 py-1 text-[11.5px] text-[#f2f2f4]/55">
                                <span className="w-8 shrink-0">{label}</span>
                                <Slider
                                    value={(value - 0.6) / 0.9}
                                    onPreview={(unit: number) => apply(Number((0.6 + unit * 0.9).toFixed(3)))}
                                    onCommit={() => { /* 拖动过程已经实时生效，这里不需要落盘 */ }}
                                    label={label}
                                    valueText={`${Math.round(value * 100)}%`}
                                    className="min-w-0 flex-1"
                                />
                                <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(value * 100)}%</span>
                            </label>
                        ))}

                        <div className="mt-2 text-[11.5px] text-[#f2f2f4]/45">媒体信息</div>
                        <div className="break-all rounded-lg bg-white/5 px-2.5 py-2 text-[10.5px] leading-4 text-[#f2f2f4]/35">{mediaUrl || url}</div>
                        <Button type="button" onClick={goFullscreen} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">全屏</Button>
                        <Button type="button" onClick={shootScreen} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">截图</Button>
                        <Button type="button" onClick={togglePip} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">画中画</Button>
                        <Button type="button" onClick={() => { void openOutsideLink(mediaUrl || url); }} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">用浏览器打开</Button>
                        <Button type="button" onClick={() => setHelpOpen(true)} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">快捷键一览</Button>
                    </div>
                )}
            </div>
        </div>
);

export default VideoPlayerPanel;
