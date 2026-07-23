import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, type MotionValue, useMotionValueEvent } from 'framer-motion';
import type { Line, Theme } from '../../types';
import { resolveThemeFontWeight, resolveThemeTranslationFontStack } from '../../utils/fontStacks';
import { colorWithAlpha } from './colorMix';
import {
    getLyricsBackgroundVocals,
    resolveHarmonySnapshotFromVocals,
    type HarmonySnapshot,
    type HarmonyTokenStatus,
} from './harmonyRuntime';

// src/components/visualizer/VisualizerHarmonyOverlay.tsx
// Renders TTML background vocals in one shared top safe-area without changing mode-specific main lyrics.

interface VisualizerHarmonyOverlayProps {
    currentTime: MotionValue<number>;
    lines: Line[];
    showText: boolean;
    theme: Theme;
    subtitleTheme?: Theme;
    isPlayerChromeHidden?: boolean;
}

const EMPTY_HARMONY_SNAPSHOT: HarmonySnapshot = { signature: '', lines: [] };

const resolveTokenColor = (status: HarmonyTokenStatus, theme: Theme) => {
    if (status === 'active') return theme.accentColor;
    if (status === 'passed') return colorWithAlpha(theme.primaryColor, 0.92);
    if (status === 'static') return colorWithAlpha(theme.primaryColor, 0.74);
    return colorWithAlpha(theme.secondaryColor, 0.58);
};

const VisualizerHarmonyOverlay: React.FC<VisualizerHarmonyOverlayProps> = ({
    currentTime,
    lines,
    showText,
    theme,
    subtitleTheme,
    isPlayerChromeHidden = false,
}) => {
    const backgroundVocals = useMemo(() => getLyricsBackgroundVocals(lines), [lines]);
    const buildSnapshot = useCallback(
        (time: number) => showText
            ? resolveHarmonySnapshotFromVocals(backgroundVocals, time)
            : EMPTY_HARMONY_SNAPSHOT,
        [backgroundVocals, showText],
    );
    const initialSnapshot = buildSnapshot(currentTime.get());
    const [snapshot, setSnapshot] = useState<HarmonySnapshot>(initialSnapshot);
    const signatureRef = useRef(initialSnapshot.signature);

    const updateSnapshot = useCallback((time: number) => {
        const next = buildSnapshot(time);
        if (signatureRef.current === next.signature) {
            return;
        }
        signatureRef.current = next.signature;
        setSnapshot(next);
    }, [buildSnapshot]);

    useEffect(() => {
        updateSnapshot(currentTime.get());
    }, [currentTime, updateSnapshot]);

    useMotionValueEvent(currentTime, 'change', updateSnapshot);

    return (
        <AnimatePresence>
            {snapshot.lines.length > 0 && (
                <motion.div
                    key="visualizer-harmony-overlay"
                    initial={{ opacity: 0, y: -12 }}
                    animate={{ opacity: 1, y: 0, top: isPlayerChromeHidden ? 28 : 76 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{
                        top: { type: 'spring', stiffness: 280, damping: 28 },
                        opacity: { duration: 0.2, ease: 'easeOut' },
                        y: { duration: 0.2, ease: 'easeOut' },
                    }}
                    className="pointer-events-none absolute left-0 right-0 z-30 flex flex-col items-center gap-1.5 px-5 text-center"
                >
                    {snapshot.lines.map(entry => (
                        <motion.div
                            key={entry.key}
                            initial={{ opacity: 0, scale: 0.97 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.97 }}
                            className="max-w-4xl whitespace-pre-wrap break-words"
                            style={{
                                fontFamily: resolveThemeTranslationFontStack(subtitleTheme ?? theme),
                                fontSize: 'clamp(0.95rem, 1.8vw, 1.3rem)',
                                fontWeight: resolveThemeFontWeight(subtitleTheme ?? theme, 500),
                                lineHeight: 1.3,
                                textShadow: `0 2px 12px ${colorWithAlpha(theme.backgroundColor, 0.68)}`,
                            }}
                        >
                            {entry.tokens.map(token => (
                                <span
                                    key={token.key}
                                    style={{
                                        color: resolveTokenColor(token.status, theme),
                                        transition: 'color 160ms ease-out',
                                    }}
                                >
                                    {token.text}
                                </span>
                            ))}
                        </motion.div>
                    ))}
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default VisualizerHarmonyOverlay;
