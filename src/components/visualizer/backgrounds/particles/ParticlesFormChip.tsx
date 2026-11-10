import React from 'react';
import { cycleValue, QuickControlChip } from '../../../shared/QuickControlChip';
import { PARTICLES_FORMS, type ParticlesForm } from './forms';

// src/components/visualizer/backgrounds/particles/ParticlesFormChip.tsx
// 播放控制台上的形态切换：一个胶囊按钮，点一下换下一种。
//
// 为什么不是一排卡片：
//
// 播放控制台那一格本来就不宽（还要放「自动涟漪」开关和别的背景自己的控件），
// 五个大卡片铺开会把整格撑成两行，把别的控件挤下去。
// 而形态是「看一眼就行、顺手换一下」的东西，不需要每次都做选择 ——
// 一个按钮写着当前是什么，点一下就换，比铺开五张卡省事。
//
// 完整的卡片列表还在设置面板里（ParticlesFormGrid），
// 想一眼看全部、或者要挑特定的一种，去那里。
//
// 「自动」也在循环序列里：自动 → 丝绸 → 滚筒 → 星球 → 唱片 → 自动。

interface ParticlesFormChipProps {
    value: ParticlesForm;
    t: (key: string) => string;
    onChange: (form: ParticlesForm) => void;
}

const ParticlesFormChip: React.FC<ParticlesFormChipProps> = ({ value, t, onChange }) => {
    const next = cycleValue(PARTICLES_FORMS, value);
    return (
        <QuickControlChip
            onClick={() => onChange(next)}
            label={`${t('options.particlesForm')} · ${t(`options.particlesForm_${value}`)}`}
            title={t('options.particlesForm')}
        />
    );
};

export default ParticlesFormChip;
