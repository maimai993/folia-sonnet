import React from 'react';
import { PictureGrid } from '../../../modal/settings/kit/PictureGrid';
import type { ParticlesForm } from './forms';
import { PARTICLES_FORMS } from './forms';

// src/components/visualizer/backgrounds/particles/ParticlesFormGrid.tsx
// 设置面板里的「形态」选择：和町景「场景」那一排一样的大图标卡片（PictureGrid）。
//
// 为什么用 PictureGrid 而不是下拉：这几种形态本来就是「同一效果的几种样子」，
// 看图比看字直观，而且设置里选场景用的就是这一套，手感一致。
// 选中的那张外面有一圈强调色描边（PictureGrid 的 shared ring）。
//
// 播放控制台上不铺这一排 —— 那里是一个循环切换的按钮（ParticlesFormChip），
// 因为控制台那一格放不下这么多卡片。

/** 每种形态的线稿小图（24×24，跟着面板文字色，和町景的场景图同一套画法）。 */
const FORM_GLYPHS: Record<ParticlesForm, React.ReactNode> = {
    // 自动：两道交错的箭头（和町景的场景「自动」同一个图形）
    auto: (
        <>
            <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
            <path d="m18 2 4 4-4 4" />
            <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" opacity="0.6" />
            <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" opacity="0.6" />
            <path d="m18 14 4 4-4 4" />
        </>
    ),
    // 丝绸：一片起伏的横线
    silk: (
        <>
            <path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
            <path d="M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0" opacity="0.6" />
            <path d="M3 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0" opacity="0.35" />
        </>
    ),
    // 滚筒：一圈套一圈的隧道
    tunnel: (
        <>
            <ellipse cx="12" cy="12" rx="9" ry="9" opacity="0.35" />
            <ellipse cx="12" cy="12" rx="5.5" ry="5.5" opacity="0.6" />
            <ellipse cx="12" cy="12" rx="2" ry="2" />
        </>
    ),
    // 星球：带经纬线的球
    planet: (
        <>
            <circle cx="12" cy="12" r="8" />
            <ellipse cx="12" cy="12" rx="3.4" ry="8" opacity="0.6" />
            <path d="M4 12h16" opacity="0.6" />
        </>
    ),
    // 唱片：黑胶
    vinyl: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <circle cx="12" cy="12" r="5.2" opacity="0.6" />
            <circle cx="12" cy="12" r="1.6" />
        </>
    ),
};

/**
 * 一张卡片的画面。
 *
 * 画法照抄町景的「场景」那一排（machi/MachiSettingsPanel.tsx 的 scenePicture）：
 * 44px 的线稿、1.6 线宽、统一的面板文字色。两处长得一样，
 * 手指头就不用重新认一遍。
 */
const picture = (form: ParticlesForm) => (
    <span className="absolute inset-0 flex items-center justify-center text-[color:var(--st-t2)]">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {FORM_GLYPHS[form]}
        </svg>
    </span>
);

interface ParticlesFormGridProps {
    value: ParticlesForm;
    t: (key: string) => string;
    onChange: (form: ParticlesForm) => void;
    className?: string;
}

/** 形态选择的卡片组：设置面板里用，选中的那张外面一圈强调色描边。 */
export const ParticlesFormGrid: React.FC<ParticlesFormGridProps> = ({ value, t, onChange, className = '' }) => (
    <PictureGrid<ParticlesForm>
        value={value}
        // 三列：和町景的场景选择一样，一行三个大卡片。
        columns={3}
        options={PARTICLES_FORMS.map(form => ({
            value: form,
            label: t(`options.particlesForm_${form}`),
        }))}
        picture={picture}
        onChange={onChange}
        label={t('options.particlesForm')}
        className={className}
    />
);

export default ParticlesFormGrid;
