import React from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, Select } from '@/components/ui';
import { useBilibiliMvStore } from '../../../../stores/useBilibiliMvStore';
import { useLyricSettingsStore } from '../../../../stores/useLyricSettingsStore';
import { isAiTargetConfigured } from '../../../../services/aiCompletion';

// src/components/visualizer/backgrounds/mv/MvBackgroundSettingsCard.tsx
// 「MV」背景自己的设置：那一页只有两件真选项 ——
//   · 让不让 AI 挑画面（配了 AI 才有意义，没配就摆一句说明）；
//   · 歌词跟哪一边（平台自己的歌词 / 这条投稿的字幕）。
// 画面本身要不要出现，由「背景类型选了 MV」这一件事决定（BilibiliMvLayer 读持久化的
// 模式选择），这里不再摆第二个开关 —— 一个概念一处管，和别的背景一致。

const MvBackgroundSettingsCard: React.FC<{ t: (key: string) => string }> = ({ t }) => {
    const useAiMatch = useBilibiliMvStore(state => state.useAiMatch);
    const setUseAiMatch = useBilibiliMvStore(state => state.setUseAiMatch);
    const mvLyricSource = useLyricSettingsStore(state => state.mvLyricSource);
    const setMvLyricSource = useLyricSettingsStore(state => state.handleSetMvLyricSource);
    const aiReady = isAiTargetConfigured();

    return (
        <div className="flex flex-col gap-3 text-[13px]" style={{ color: 'var(--st-t1)' }}>
            <label className="flex items-center justify-between gap-3">
                <span>{t('options.mvBackgroundAiMatch')}</span>
                <Checkbox
                    checked={useAiMatch && aiReady}
                    disabled={!aiReady}
                    onChange={event => setUseAiMatch(event.target.checked)}
                />
            </label>
            {!aiReady && (
                <p className="text-[12px] opacity-60">{t('options.mvBackgroundAiNeedsTarget')}</p>
            )}
            <label className="flex items-center justify-between gap-3">
                <span>{t('options.mvBackgroundLyricSource')}</span>
                <Select
                    value={mvLyricSource}
                    onChange={value => setMvLyricSource(value === 'video' ? 'video' : 'platform')}
                    options={[
                        { value: 'platform', label: t('options.mvBackgroundLyricSourcePlatform') },
                        { value: 'video', label: t('options.mvBackgroundLyricSourceVideo') },
                    ]}
                />
            </label>
        </div>
    );
};

export default MvBackgroundSettingsCard;
