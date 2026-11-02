import React, { useMemo, useState } from 'react';
import { motion, MotionValue, useMotionValueEvent } from 'framer-motion';
import type { Theme, Word as WordType } from '../../../types';
import { buildWordGraphemeTimings } from '../../../utils/lyrics/graphemeTiming';
import { resolveThemeFontWeight } from '../../../utils/fontStacks';
import { colorWithAlpha } from '../colorMix';
import { resolveWordColor } from '../wordColoring';
import { getGlowWordActiveEndTime, type GlowWordRenderProfile } from '../glowWordTiming';
import { type KineticCharMeta, type KineticRow } from './kineticLayout';
import { type KineticTuning } from './types';

// src/components/visualizer/kinetic/KineticChar.tsx
// 文字PV 的单字组件：一个字一个 waiting / active / passed 三态，状态变化才 setState；
// 入场/出场动画全部由 framer-motion variants 驱动，不走每帧 React 渲染。
// 逐字点亮时序来自原始 Word timing + grapheme 映射，不在组件里猜。

export interface KineticCharProps {
    meta: KineticCharMeta;
    row: KineticRow;
    charIndexInRow: number;
    currentTime: MotionValue<number>;
    theme: Theme;
    renderProfile: GlowWordRenderProfile;
    tuning: KineticTuning;
    fontPx: number;
}

/** 四种入场动画：waiting → active 的位移 / 缩放 / 旋转起点。 */
const entranceInitials: Record<KineticTuning['entrance'], { scale: number; y: number; x: number; rotate: number }> = {
    pop: { scale: 0.3, y: 0, x: 0, rotate: -8 },
    slide: { scale: 0.9, y: 0, x: -28, rotate: 0 },
    drop: { scale: 0.85, y: -34, x: 0, rotate: 4 },
    wipe: { scale: 1.06, y: 0, x: 0, rotate: 0 },
};

export const KineticChar: React.FC<KineticCharProps> = ({
    meta,
    row,
    charIndexInRow,
    currentTime,
    theme,
    renderProfile,
    tuning,
    fontPx,
}) => {
    const [status, setStatus] = useState<'waiting' | 'active' | 'passed'>('waiting');
    const word = meta.word;
    const activeEndTime = getGlowWordActiveEndTime(word, renderProfile);
    // 一个 display word 内多字时按 grapheme 时序错开；单字（含 sticky 合并）直接用词的时序。
    const graphemeTimings = useMemo(() => buildWordGraphemeTimings(word), [word]);
    const timing = graphemeTimings.length > 1
        ? graphemeTimings[Math.min(meta.indexInWord, graphemeTimings.length - 1)]
        : { startTime: word.startTime, endTime: word.endTime, char: word.text };

    useMotionValueEvent(currentTime, 'change', (latest: number) => {
        let next: 'waiting' | 'active' | 'passed' = 'waiting';
        if (latest >= timing.startTime - renderProfile.wordLookahead && latest <= activeEndTime) {
            next = 'active';
        } else if (latest > activeEndTime) {
            next = 'passed';
        }
        if (next !== status) setStatus(next);
    });

    const charGap = fontPx * 0.08;
    // 强调色与云阶同源：theme.wordColors 关键字命中用关键字色，否则 accentColor。
    const getWordColor = (text: string, currentTheme: Theme) => resolveWordColor(text, currentTheme.wordColors, currentTheme.accentColor);

    const initial = entranceInitials[tuning.entrance];
    const activeScale = 1 + (tuning.activeScale - 1) * 0.35;
    // 行内偏移按布局算好的字宽累计（含峰值缩放留位），保证弹跳最大时也不压到相邻字。
    const baseX = row.chars.slice(0, charIndexInRow).reduce((sum, c) => sum + c.width + charGap, 0);

    const activeColor = getWordColor(meta.word.text, theme);
    const baseColor = theme.primaryColor;
    const isCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(meta.word.text);

    return (
        <motion.span
            className="absolute left-0 top-1/2 origin-center whitespace-nowrap will-change-transform overflow-visible"
            style={{
                // 字只靠 transform 定位（行内不参与 inline 排列）。行盒高度给 1.6em：
                // CJK 字体的 em 盒上下各带约 0.12em 的伸展，scrollHeight 要到 1.6em 才不报纵向裁切。
                marginTop: -fontPx * 0.8,
                height: fontPx * 1.6,
                fontSize: fontPx,
                fontWeight: resolveThemeFontWeight(theme, 700),
                lineHeight: 1.25,
                color: status === 'active' ? activeColor : baseColor,
                WebkitTextStroke: tuning.showStroke && isCjk
                    ? `1px ${colorWithAlpha(theme.secondaryColor, 0.6)}`
                    : undefined,
            }}
            initial={false}
            animate={
                status === 'waiting'
                    ? { opacity: 0, scale: initial.scale, y: initial.y, x: baseX + initial.x, rotate: initial.rotate }
                    : status === 'active'
                        ? { opacity: 1, scale: activeScale, y: 0, x: baseX, rotate: 0 }
                        : { opacity: 0.55, scale: 1, y: 6, x: baseX, rotate: 0 }
            }
            transition={
                status === 'active'
                    ? { type: 'spring' as const, stiffness: 260, damping: 20, opacity: { duration: 0.08 } }
                    : { duration: 0.32, ease: 'easeOut' as const }
            }
        >
            {/* 当前字的强调残影：active 时在字后面留一层缩放过的淡影。 */}
            {tuning.showEcho && status === 'active' && (
                <span
                    aria-hidden="true"
                    className="absolute inset-0 pointer-events-none select-none"
                    style={{
                        color: colorWithAlpha(activeColor, 0.35),
                        transform: 'scale(1.18) translate(-4px, 4px)',
                    }}
                >
                    {timing.char}
                </span>
            )}
            {timing.char}
            {/* 装饰下划线块：当前行当前字 active 时点亮。放在字盒内部底下，不溢出盒子
                （下探 0.12em 会被 layoutCheck 的 scrollHeight 记成纵向裁切）。 */}
            {tuning.showUnderline && status === 'active' && (
                <motion.span
                    aria-hidden="true"
                    className="absolute left-0 right-0 pointer-events-none"
                    style={{ bottom: 0, height: Math.max(2, fontPx * 0.055), backgroundColor: activeColor }}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.22, ease: 'easeOut' as const }}
                />
            )}
        </motion.span>
    );
};
