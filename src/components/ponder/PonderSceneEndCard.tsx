import React from 'react';
import { ArrowRight, Check, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// src/components/ponder/PonderSceneEndCard.tsx
// 一章播完之后出现的卡片。
//
// 它替代了原先的无限循环。循环有两个问题：看不出「这一章讲完了」，也就没有任何时刻
// 适合告诉用户还有下一章 —— 章节切换因此一直藏在底部那对小箭头里。停下来给一张卡片，
// 「还有几章、下一章讲什么」就成了这一刻画面上最大的东西。

type PonderSceneEndCardProps = {
    sceneIndex: number;
    sceneCount: number;
    /** 下一章的标题；已经是最后一章时为 null。 */
    nextSceneTitle: string | null;
    onNextScene: () => void;
    onReplay: () => void;
    onExit: () => void;
    theme?: { accentColor?: string };
    isDaylight: boolean;
};

const PonderSceneEndCard: React.FC<PonderSceneEndCardProps> = ({
    sceneIndex,
    sceneCount,
    nextSceneTitle,
    onNextScene,
    onReplay,
    onExit,
    theme,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const accent = theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa');
    const text = isDaylight ? '#27272a' : '#fafafa';
    const muted = isDaylight ? 'rgba(24, 24, 27, 0.55)' : 'rgba(255, 255, 255, 0.55)';
    const surface = isDaylight ? 'rgba(255, 255, 255, 0.92)' : 'rgba(24, 24, 27, 0.92)';
    const border = isDaylight ? 'rgba(24, 24, 27, 0.12)' : 'rgba(255, 255, 255, 0.14)';
    const ghost = isDaylight ? 'hover:bg-black/[0.06]' : 'hover:bg-white/[0.08]';

    return (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
                className="pointer-events-auto flex w-[min(28rem,86vw)] flex-col gap-5 rounded-2xl border p-6 shadow-2xl backdrop-blur-md"
                style={{ backgroundColor: surface, borderColor: border, color: text }}
            >
                {/* 章节进度画成一排点：还有几章一眼看得出，不必去数底部的 1/3。 */}
                <div className="flex items-center gap-1.5">
                    {Array.from({ length: sceneCount }, (_, index) => (
                        <span
                            key={index}
                            className="h-1.5 flex-1 rounded-full transition-colors"
                            style={{
                                backgroundColor: index <= sceneIndex ? accent : border,
                                opacity: index <= sceneIndex ? 1 : 0.6,
                            }}
                        />
                    ))}
                </div>

                <div className="space-y-1">
                    <div className="text-xs" style={{ color: muted }}>
                        {t('ponder.sceneCounter', { current: sceneIndex + 1, total: sceneCount })}
                    </div>
                    <div className="text-base font-medium">
                        {nextSceneTitle ? t('ponder.chapterDone') : t('ponder.allChaptersDone')}
                    </div>
                </div>

                {nextSceneTitle ? (
                    <button
                        type="button"
                        onClick={onNextScene}
                        autoFocus
                        className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-transform hover:scale-[1.01] active:scale-[0.99]"
                        style={{ backgroundColor: accent, color: isDaylight ? '#fafafa' : '#18181b' }}
                    >
                        <span className="min-w-0">
                            <span className="block text-[11px] opacity-70">{t('ponder.nextChapter')}</span>
                            <span className="block truncate text-sm font-medium">{nextSceneTitle}</span>
                        </span>
                        <ArrowRight size={18} className="shrink-0" />
                    </button>
                ) : (
                    <div
                        className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm"
                        style={{ backgroundColor: isDaylight ? 'rgba(24,24,27,0.05)' : 'rgba(255,255,255,0.06)', color: muted }}
                    >
                        <Check size={16} style={{ color: accent }} />
                        {t('ponder.lastChapterHint')}
                    </div>
                )}

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onReplay}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${ghost}`}
                        style={{ color: muted }}
                    >
                        <RotateCcw size={14} />
                        {t('ponder.replayChapter')}
                    </button>
                    <button
                        type="button"
                        onClick={onExit}
                        className={`ml-auto rounded-lg px-3 py-2 text-xs transition-colors ${ghost}`}
                        style={{ color: muted }}
                    >
                        {t('ponder.exit')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PonderSceneEndCard;
