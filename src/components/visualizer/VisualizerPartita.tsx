import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion, MotionValue, useMotionValueEvent } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { AudioBands, Line, Theme, Word as WordType } from '../../types';
import { getLineRenderEndTime, getLineRenderHints } from '../../utils/lyrics/renderHints';
import { resolveThemeFontStack } from '../../utils/fontStacks';
import FluidBackground from './FluidBackground';
import GeometricBackground from './GeometricBackground';

interface VisualizerPartitaProps {
    currentTime: MotionValue<number>;
    currentLineIndex: number;
    lines: Line[];
    theme: Theme;
    audioPower: MotionValue<number>;
    audioBands: AudioBands;
    showText?: boolean;
    coverUrl?: string | null;
    useCoverColorBg?: boolean;
    seed?: string | number;
    backgroundOpacity?: number;
    lyricsFontScale?: number;
    onBack?: () => void;
}

interface PartitaRenderProfile {
    lineRenderEndTime: number;
    wordRevealMode: 'normal' | 'fast' | 'instant';
    wordLookahead: number;
}

const isCJK = (text: string) => /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text);

const resolvePartitaRenderProfile = (line: Line | null | undefined): PartitaRenderProfile | null => {
    if (!line) {
        return null;
    }

    const renderHints = getLineRenderHints(line);
    const wordRevealMode = renderHints?.wordRevealMode ?? 'normal';

    return {
        lineRenderEndTime: getLineRenderEndTime(line),
        wordRevealMode,
        wordLookahead: wordRevealMode === 'instant' ? 0.03 : wordRevealMode === 'fast' ? 0.08 : 0.18,
    };
};

const getPartitaWordActiveEndTime = (word: WordType, renderProfile: PartitaRenderProfile) => {
    if (renderProfile.wordRevealMode === 'instant') {
        return renderProfile.lineRenderEndTime;
    }

    if (renderProfile.wordRevealMode === 'fast') {
        return Math.min(renderProfile.lineRenderEndTime, Math.max(word.endTime, word.startTime + 0.12));
    }

    return word.endTime;
};

const getActiveColor = (wordText: string, theme: Theme) => {
    if (!theme.wordColors || theme.wordColors.length === 0) {
        return theme.accentColor;
    }

    const cleanCurrent = wordText.trim();
    const matched = theme.wordColors.find(entry => {
        const target = entry.word;
        if (isCJK(cleanCurrent)) {
            return target.includes(cleanCurrent);
        }

        const targetWords = target.split(/\s+/).map(value => value.toLowerCase().replace(/[^\w]/g, ''));
        const normalizedCurrent = cleanCurrent.toLowerCase().replace(/[^\w]/g, '');
        return targetWords.includes(normalizedCurrent);
    });

    return matched?.color ?? theme.accentColor;
};

const PartitaWord: React.FC<{
    word: WordType;
    currentTime: MotionValue<number>;
    renderProfile: PartitaRenderProfile;
    theme: Theme;
    fontSize: string;
    activeColor: string;
    index: number;
}> = ({ word, currentTime, renderProfile, theme, fontSize, activeColor, index }) => {
    const [status, setStatus] = useState<'waiting' | 'active' | 'passed'>('waiting');
    const [progress, setProgress] = useState(0);
    const activeEndTime = getPartitaWordActiveEndTime(word, renderProfile);
    const trimmedText = word.text.trim();
    const displayText = trimmedText.length > 0 ? trimmedText : word.text;
    const verticalWord = isCJK(displayText);

    useMotionValueEvent(currentTime, 'change', (latest: number) => {
        const nextStatus = latest >= word.startTime - renderProfile.wordLookahead && latest <= activeEndTime
            ? 'active'
            : latest > activeEndTime
                ? 'passed'
                : 'waiting';
        setStatus(prev => (prev === nextStatus ? prev : nextStatus));

        const duration = Math.max(activeEndTime - word.startTime, 0.08);
        const nextProgress = latest < word.startTime
            ? 0
            : latest > activeEndTime
                ? 1
                : Math.max(0, Math.min(1, (latest - word.startTime) / duration));
        setProgress(prev => (Math.abs(prev - nextProgress) < 0.018 ? prev : nextProgress));
    });

    return (
        <motion.div
            initial={false}
            animate={status === 'active'
                ? {
                    opacity: 1,
                    scale: 1.08,
                    x: 0,
                    filter: 'blur(0px)',
                }
                : status === 'passed'
                    ? {
                        opacity: 0.56,
                        scale: 0.98,
                        x: -2,
                        filter: 'blur(0px)',
                    }
                    : {
                        opacity: 0.22,
                        scale: 0.92,
                        x: 10,
                        filter: 'blur(6px)',
                    }}
            transition={{
                type: status === 'active' ? 'spring' : 'tween',
                stiffness: 260,
                damping: 24,
                duration: status === 'waiting' ? 0.22 : 0.28,
            }}
            className="relative flex items-center justify-center"
            style={{
                marginTop: index === 0 ? '0' : '0.55rem',
            }}
        >
            <div
                className="absolute inset-0 rounded-[1.4rem] border"
                style={{
                    borderColor: status === 'active' ? `${activeColor}88` : 'rgba(255,255,255,0.06)',
                    background: status === 'active'
                        ? `linear-gradient(180deg, ${activeColor}1f 0%, rgba(255,255,255,0.03) 100%)`
                        : 'rgba(255,255,255,0.03)',
                    boxShadow: status === 'active'
                        ? `0 0 26px ${activeColor}30, inset 0 0 0 1px ${activeColor}18`
                        : 'none',
                    transform: 'translateZ(0)',
                }}
            />
            <div
                className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full"
                style={{
                    width: '3px',
                    height: `${Math.max(10, Math.round(34 * progress))}px`,
                    background: activeColor,
                    opacity: status === 'waiting' ? 0 : 0.9,
                    boxShadow: `0 0 14px ${activeColor}`,
                }}
            />
            <div
                className="relative z-10 flex min-h-[5rem] min-w-[4.5rem] items-center justify-center px-3 py-5 font-semibold tracking-[0.08em]"
                style={{
                    color: status === 'active' ? activeColor : theme.primaryColor,
                    fontSize,
                    textShadow: status === 'active' ? `0 0 22px ${activeColor}55` : 'none',
                }}
            >
                <span
                    className="block whitespace-pre"
                    style={verticalWord
                        ? {
                            writingMode: 'vertical-rl',
                            textOrientation: 'upright',
                            letterSpacing: '0.14em',
                        }
                        : {
                            display: 'inline-block',
                            transform: 'rotate(90deg)',
                            transformOrigin: 'center',
                            letterSpacing: '0.12em',
                        }}
                >
                    {displayText}
                </span>
            </div>
        </motion.div>
    );
};

const ContextColumn: React.FC<{
    line: Line;
    theme: Theme;
    fontSize: string;
}> = ({ line, theme, fontSize }) => (
    <div
        className="flex h-full items-center justify-center rounded-[2rem] border px-3 py-6"
        style={{
            borderColor: 'rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.03)',
            color: theme.secondaryColor,
        }}
    >
        <div
            className="max-h-full whitespace-pre-wrap"
            style={{
                writingMode: 'vertical-rl',
                textOrientation: 'upright',
                fontSize,
                letterSpacing: '0.1em',
                lineHeight: 1.5,
            }}
        >
            {line.fullText}
        </div>
    </div>
);

const VisualizerPartita: React.FC<VisualizerPartitaProps & { staticMode?: boolean; }> = ({
    currentTime,
    currentLineIndex,
    lines,
    theme,
    audioPower,
    audioBands,
    showText = true,
    coverUrl,
    useCoverColorBg = false,
    seed,
    staticMode = false,
    backgroundOpacity = 0.75,
    lyricsFontScale = 1,
    onBack,
}) => {
    const { t } = useTranslation();
    const [showBackButton, setShowBackButton] = useState(false);

    const currentTimeValue = currentTime.get();
    const activeLine = lines[currentLineIndex];
    const renderProfile = resolvePartitaRenderProfile(activeLine);

    let recentCompletedLine: Line | null = null;
    if (currentLineIndex === -1 && lines.length > 0) {
        for (let i = lines.length - 1; i >= 0; i--) {
            if (currentTimeValue > getLineRenderEndTime(lines[i])) {
                recentCompletedLine = lines[i];
                break;
            }
        }
    }

    const nextLines = useMemo(() => lines.slice(currentLineIndex + 1, currentLineIndex + 3), [currentLineIndex, lines]);
    const resolvedFontFamily = resolveThemeFontStack(theme);
    const mainFontSize = `clamp(${(1.18 * lyricsFontScale).toFixed(3)}rem, ${(2.35 * lyricsFontScale).toFixed(3)}vw, ${(1.72 * lyricsFontScale).toFixed(3)}rem)`;
    const contextFontSize = `clamp(${(0.92 * lyricsFontScale).toFixed(3)}rem, ${(1.4 * lyricsFontScale).toFixed(3)}vw, ${(1.06 * lyricsFontScale).toFixed(3)}rem)`;
    const translationFontSize = `clamp(${(0.98 * lyricsFontScale).toFixed(3)}rem, ${(1.8 * lyricsFontScale).toFixed(3)}vw, ${(1.12 * lyricsFontScale).toFixed(3)}rem)`;

    return (
        <div
            className="w-full h-full flex flex-col items-center justify-center overflow-hidden relative transition-colors duration-1000"
            style={{
                backgroundColor: 'transparent',
                fontFamily: resolvedFontFamily,
            }}
            onMouseMove={(event) => {
                const nearBackArea = event.clientX <= 120 && event.clientY <= 120;
                if (nearBackArea !== showBackButton) {
                    setShowBackButton(nearBackArea);
                }
            }}
            onMouseLeave={() => {
                if (showBackButton) {
                    setShowBackButton(false);
                }
            }}
        >
            {onBack && (
                <motion.button
                    type="button"
                    aria-label={t('ui.backToHome')}
                    initial={false}
                    animate={{
                        opacity: showBackButton ? 1 : 0,
                        scale: showBackButton ? 1 : 0.92,
                        x: showBackButton ? 0 : -6,
                    }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onBack();
                    }}
                    className="absolute top-6 left-6 z-30 h-10 w-10 rounded-full flex items-center justify-center transition-colors backdrop-blur-md bg-black/20 hover:bg-white/10 text-white/60 pointer-events-auto"
                    style={{ pointerEvents: showBackButton ? 'auto' : 'none' }}
                >
                    <ChevronLeft size={20} />
                </motion.button>
            )}

            <AnimatePresence>
                {useCoverColorBg && (
                    <motion.div
                        key="fluid-bg"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 1 }}
                        className="absolute inset-0 z-0"
                    >
                        <FluidBackground coverUrl={coverUrl} theme={theme} />
                    </motion.div>
                )}
            </AnimatePresence>

            <div
                className="absolute inset-0 z-0 transition-all duration-1000"
                style={{ backgroundColor: theme.backgroundColor, opacity: useCoverColorBg ? backgroundOpacity : 1 }}
            />

            {!staticMode && (
                <div className="absolute inset-0 z-0">
                    <GeometricBackground theme={theme} audioPower={audioPower} audioBands={audioBands} seed={seed} />
                </div>
            )}

            <div className="absolute inset-y-12 left-1/2 z-10 hidden w-px -translate-x-1/2 bg-white/10 md:block" />
            <div className="absolute inset-y-20 left-[30%] z-10 hidden w-px bg-white/5 lg:block" />
            <div className="absolute inset-y-20 right-[30%] z-10 hidden w-px bg-white/5 lg:block" />

            <motion.div
                className="relative z-20 flex h-[72vh] w-full items-center justify-center gap-4 px-4 sm:px-8 lg:gap-8"
                animate={{
                    y: [0, -8, 0, 6, 0],
                }}
                transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: 'easeInOut',
                }}
            >
                {showText && nextLines[1] && (
                    <div className="hidden h-full max-h-[34rem] lg:block">
                        <ContextColumn line={nextLines[1]} theme={theme} fontSize={contextFontSize} />
                    </div>
                )}

                {showText && nextLines[0] && (
                    <div className="hidden h-full max-h-[38rem] md:block">
                        <ContextColumn line={nextLines[0]} theme={theme} fontSize={contextFontSize} />
                    </div>
                )}

                <div className="relative flex h-full min-w-[11rem] max-w-[22rem] flex-col items-center justify-center">
                    <div
                        className="absolute inset-0 rounded-[2.2rem] border backdrop-blur-[14px]"
                        style={{
                            borderColor: 'rgba(255,255,255,0.08)',
                            background: 'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)',
                            boxShadow: `0 30px 80px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.06)`,
                        }}
                    />
                    <AnimatePresence mode="wait">
                        {showText && activeLine && renderProfile ? (
                            <motion.div
                                key={activeLine.startTime}
                                initial={{ opacity: 0, y: 18, scale: 0.96, filter: 'blur(8px)' }}
                                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                                exit={{ opacity: 0, y: -18, scale: 1.04, filter: 'blur(12px)' }}
                                transition={{ duration: 0.3, ease: 'easeOut' }}
                                className="relative z-10 flex h-full w-full flex-col items-center justify-center px-4 py-8 sm:px-5"
                            >
                                <div className="mb-4 text-[10px] uppercase tracking-[0.34em] text-white/40">
                                    Partita
                                </div>
                                <div className="flex max-h-full flex-col items-center justify-center overflow-hidden">
                                    {activeLine.words.map((word, index) => (
                                        <PartitaWord
                                            key={`${activeLine.startTime}-${index}-${word.text}`}
                                            word={word}
                                            currentTime={currentTime}
                                            renderProfile={renderProfile}
                                            theme={theme}
                                            fontSize={mainFontSize}
                                            activeColor={getActiveColor(word.text, theme)}
                                            index={index}
                                        />
                                    ))}
                                </div>
                            </motion.div>
                        ) : showText ? (
                            <motion.div
                                key="partita-empty"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 0.55 }}
                                exit={{ opacity: 0 }}
                                className="relative z-10 flex h-full items-center justify-center px-6 text-center"
                                style={{
                                    color: theme.secondaryColor,
                                    fontSize: translationFontSize,
                                }}
                            >
                                {t('ui.waitingForMusic')}
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>
            </motion.div>

            <AnimatePresence>
                {showText && (activeLine?.translation || recentCompletedLine?.translation) && (
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 12 }}
                        className="absolute bottom-10 left-1/2 z-20 w-[min(78vw,36rem)] -translate-x-1/2 rounded-[1.4rem] border px-5 py-3 text-center backdrop-blur-md"
                        style={{
                            borderColor: 'rgba(255,255,255,0.08)',
                            background: 'rgba(0,0,0,0.22)',
                            color: theme.secondaryColor,
                            fontSize: translationFontSize,
                        }}
                    >
                        {activeLine?.translation || recentCompletedLine?.translation}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default VisualizerPartita;
