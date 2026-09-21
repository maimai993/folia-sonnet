import React from 'react';
import { ChevronLeft, ChevronRight, Keyboard, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PonderStageNodes } from './ponderStageNodes';

// src/components/ponder/PonderChrome.tsx
// 教程层的外框：标题 + 场景计数，底部 ◀ ⏯ ▶ + 带关键帧刻度的进度条 + ↻ 重播。
//
// @note 这里有两套导航共存：屏幕上的 ◀▶ 切场景，键盘 ←/→ 跳关键帧。原版 Create 里
// 底部箭头就是跳关键帧，所以这是一处有意的分歧，容易让人误解。三条缓解措施都在这个文件里：
// ◀▶ 紧贴场景计数并且 aria-label 写明「场景」；刻度本身可点击，让关键帧跳转也有屏幕入口；
// 底部留一行图例把两套键位说清楚。

type PonderChromeProps = {
    title: string;
    /** 当前这一章讲什么。章节切换之所以隐蔽，一半原因是屏幕上从没写出章节的名字。 */
    sceneTitle: string;
    sceneIndex: number;
    sceneCount: number;
    isPaused: boolean;
    /** 每根刻度的比例位置，0..1。 */
    ticks: number[];
    nodes: PonderStageNodes;
    onPrevScene: () => void;
    onNextScene: () => void;
    onTogglePlay: () => void;
    onRestart: () => void;
    onSeekToTick: (index: number) => void;
    /** 当前这一章有没有「直接去那儿」的入口；没有就不渲染。 */
    actionLabel: string | null;
    onRunAction: () => void;
    theme?: { accentColor?: string };
    isDaylight: boolean;
};

const PonderChrome: React.FC<PonderChromeProps> = ({
    title,
    sceneTitle,
    sceneIndex,
    sceneCount,
    isPaused,
    ticks,
    nodes,
    onPrevScene,
    onNextScene,
    onTogglePlay,
    onRestart,
    onSeekToTick,
    actionLabel,
    onRunAction,
    theme,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const accent = theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa');
    const text = isDaylight ? '#27272a' : '#fafafa';
    const muted = isDaylight ? 'rgba(24, 24, 27, 0.55)' : 'rgba(255, 255, 255, 0.55)';
    const track = isDaylight ? 'rgba(24, 24, 27, 0.12)' : 'rgba(255, 255, 255, 0.14)';
    const hover = isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/10';

    const iconButton = `rounded-full p-2 transition-colors ${hover}`;

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-center justify-between px-6 py-5">
                <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium" style={{ color: text }}>
                        <Keyboard size={15} style={{ color: accent }} />
                        <span style={{ color: muted }}>{t('ponder.title')}</span>
                        <span style={{ color: muted }}>·</span>
                        <span>{title}</span>
                    </div>
                    <div className="pl-[23px] text-xs" style={{ color: muted }}>
                        {t('ponder.sceneCounter', { current: sceneIndex + 1, total: sceneCount })} · {sceneTitle}
                    </div>
                </div>
            </div>

            <div className="pointer-events-auto absolute bottom-0 left-0 right-0 px-6 pb-5">
                <div className="mx-auto flex max-w-3xl flex-col gap-2">
                    {/* 进度条。填充由时间线每帧写 scaleX，刻度是静态 DOM 且可点击。 */}
                    <div className="relative h-1.5 w-full rounded-full" style={{ backgroundColor: track }}>
                        <div
                            ref={node => { nodes.progressFill = node; }}
                            className="absolute inset-0 origin-left rounded-full"
                            style={{ backgroundColor: accent, transform: 'scaleX(0)' }}
                        />
                        {ticks.map((fraction, index) => (
                            <button
                                key={index}
                                type="button"
                                ref={node => { nodes.ticks[index] = node; }}
                                onClick={() => onSeekToTick(index)}
                                aria-label={t('ponder.seekKeyframe', { index: index + 1 })}
                                className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-125 data-[active]:scale-125"
                                style={{ left: `${fraction * 100}%` }}
                            >
                                <span
                                    className="block h-1.5 w-1.5 rounded-full"
                                    style={{ backgroundColor: accent, margin: '0 auto', opacity: 0.55 }}
                                />
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center justify-between" style={{ color: text }}>
                        {/* ◀ 计数 ▶ 三件挨在一起：箭头改的就是中间那个数字。 */}
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={onPrevScene}
                                disabled={sceneCount <= 1}
                                className={`${iconButton} disabled:opacity-30`}
                                aria-label={t('ponder.prevScene')}
                                title={t('ponder.prevScene')}
                            >
                                <ChevronLeft size={16} />
                            </button>
                            <span className="flex min-w-32 flex-col items-center leading-tight" style={{ color: muted }}>
                                <span className="text-[10px]">{t('ponder.sceneLabel')}</span>
                                <span className="text-xs tabular-nums">
                                    {t('ponder.sceneCounter', { current: sceneIndex + 1, total: sceneCount })}
                                </span>
                            </span>
                            <button
                                type="button"
                                onClick={onNextScene}
                                disabled={sceneCount <= 1}
                                className={`${iconButton} disabled:opacity-30`}
                                aria-label={t('ponder.nextScene')}
                                title={t('ponder.nextScene')}
                            >
                                <ChevronRight size={16} />
                            </button>
                        </div>

                        <div className="flex items-center gap-2">
                            {/* 讲完某个设置藏在哪，就给一条直接过去的路 ——
                                这些设置本来就以难找著称，那正是它们被收进教程的原因。 */}
                            {actionLabel && (
                                <button
                                    type="button"
                                    data-testid="ponder-scene-action"
                                    onClick={onRunAction}
                                    className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-transform hover:scale-[1.03] active:scale-[0.98]"
                                    style={{ borderColor: accent, color: accent }}
                                >
                                    <SlidersHorizontal size={13} />
                                    {actionLabel}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={onTogglePlay}
                                className={iconButton}
                                aria-label={t('ponder.playPause')}
                                title={t('ponder.playPause')}
                            >
                                {isPaused ? <Play size={16} /> : <Pause size={16} />}
                            </button>
                            <button
                                type="button"
                                onClick={onRestart}
                                className={iconButton}
                                aria-label={t('ponder.replay')}
                                title={t('ponder.replay')}
                            >
                                <RotateCcw size={16} />
                            </button>
                        </div>
                    </div>

                    <div className="text-center text-[11px]" style={{ color: muted }}>
                        {t('ponder.keyLegend')}
                    </div>
                </div>
            </div>
        </>
    );
};

export default PonderChrome;
