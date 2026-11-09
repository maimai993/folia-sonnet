import React from 'react';
import ParticlesBackground from './ParticlesBackground';
import { defineVisualizerBackground } from '../definition';

// src/components/visualizer/backgrounds/particles/entry.tsx
// Registers the cover-particle background (ported from Mineradio's cover particles).

export default defineVisualizerBackground({
    mode: 'particles',
    order: 45,
    labelKey: 'options.visualizerBackgroundModeParticles',
    labelFallback: '粒子',
    // 粒子：一堆小点
    glyph: (
        <>
            <circle cx="7" cy="7" r="1.9" />
            <circle cx="15" cy="6" r="1.4" opacity="0.6" />
            <circle cx="5" cy="14" r="1.4" opacity="0.6" />
            <circle cx="12" cy="12" r="2.4" />
            <circle cx="18" cy="15" r="1.7" opacity="0.75" />
            <circle cx="8" cy="19" r="1.2" opacity="0.45" />
            <circle cx="16" cy="19" r="1.2" opacity="0.45" />
        </>
    ),
    command: {
        title: 'Background: Particles',
        description: 'Cover broken into particles that ripple and jump',
        keywords: ['particles', 'particle', 'cover particles', '粒子', '粒子背景', '封面粒子', '跳跃'],
    },
    // 封面换了就整块重画（粒子是从封面取样来的）
    song: ({ coverUrl }) => [coverUrl ?? null],
    render: ({ coverUrl, theme }) => (
        <ParticlesBackground coverUrl={coverUrl} theme={theme} />
    ),
});
