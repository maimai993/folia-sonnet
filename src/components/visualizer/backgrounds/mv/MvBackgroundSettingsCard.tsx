import React from 'react';
import { Group, Row, Select, Toggle, type SettingsGroupDef } from '../../../modal/settings/kit';
import { useBilibiliMvStore } from '../../../../stores/useBilibiliMvStore';
import { useLyricSettingsStore } from '../../../../stores/useLyricSettingsStore';
import { isAiTargetConfigured } from '../../../../services/aiCompletion';

// src/components/visualizer/backgrounds/mv/MvBackgroundSettingsCard.tsx
// 「MV」背景自己的设置：那一页只有三件真选项 ——
//   · 让不让 AI 挑画面（配了 AI 才有意义，没配就摆一句说明）；
//   · MV 取哪一档画面（选谁只是挑轨的上限，接口给不给由会员和投稿本身定）；
//   · 歌词跟哪一边（平台自己的歌词 / 这条投稿的字幕）。
// 画面本身要不要出现，由「背景类型选了 MV」这一件事决定（BilibiliMvLayer 读持久化的
// 模式选择），这里不再摆第二个开关 —— 一个概念一处管，和别的背景一致。
//
// 画法照其余几款背景（Latent / Sonic 那些）：Group 一开，Row 一行一个选项，控件放右边。
// 这里早先是一串手写的 <label> + <span>，字色、行距、分隔线全和设置窗口其它页不一样，
// 在白色主题下字几乎看不见 —— 换成 kit 之后跟着主题走，也不再自己定义每一样尺寸。

const MV_GROUP: SettingsGroupDef = { id: 'bg-mv', titleKey: 'options.mvBackgroundSettings' };

const MvBackgroundSettingsCard: React.FC<{ t: (key: string) => string }> = ({ t }) => {
    const useAiMatch = useBilibiliMvStore(state => state.useAiMatch);
    const setUseAiMatch = useBilibiliMvStore(state => state.setUseAiMatch);
    const mvLyricSource = useLyricSettingsStore(state => state.mvLyricSource);
    const setMvLyricSource = useLyricSettingsStore(state => state.handleSetMvLyricSource);
    const quality = useBilibiliMvStore(state => state.quality);
    const setQuality = useBilibiliMvStore(state => state.setQuality);
    const aiReady = isAiTargetConfigured();

    return (
        <Group def={MV_GROUP}>
            <Row
                label={t('options.mvBackgroundAiMatch')}
                hint={aiReady ? undefined : t('options.mvBackgroundAiNeedsTarget')}
            >
                <Toggle
                    checked={useAiMatch && aiReady}
                    disabled={!aiReady}
                    onChange={checked => setUseAiMatch(checked)}
                    label={t('options.mvBackgroundAiMatch')}
                />
            </Row>
            <Row label={t('options.mvBackgroundQuality')} hint={t('options.mvBackgroundQualityDesc')}>
                <Select
                    value={quality}
                    onChange={value => setQuality(value === 'high' || value === 'ultra' ? value : 'standard')}
                    options={[
                        { value: 'standard', label: t('options.mvBackgroundQualityStandard') },
                        { value: 'high', label: t('options.mvBackgroundQualityHigh') },
                        { value: 'ultra', label: t('options.mvBackgroundQualityUltra') },
                    ]}
                />
            </Row>
            <Row label={t('options.mvBackgroundLyricSource')}>
                <Select
                    value={mvLyricSource}
                    onChange={value => setMvLyricSource(value === 'video' ? 'video' : 'platform')}
                    options={[
                        { value: 'platform', label: t('options.mvBackgroundLyricSourcePlatform') },
                        { value: 'video', label: t('options.mvBackgroundLyricSourceVideo') },
                    ]}
                />
            </Row>
        </Group>
    );
};

export default MvBackgroundSettingsCard;
