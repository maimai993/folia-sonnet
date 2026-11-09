// src/components/modal/settings/pages/integration/market/MarketFontApplyBar.tsx
//
// 「当前字体应用到哪」这一条，以及改应用范围的地方。
//
// 单独抽出来是因为它有两个身份：
//   · 没装字体时 —— 提示先选一个
//   · 装了字体后 —— 显示字体名 + 三个去处的多选，随时能改
//
// 三个去处能不能选，取决于平台：系统壁纸歌词只在安卓有原生渲染层，
// 桌面端没有这一层，所以那里要禁用而不是假装支持。

import React from 'react';
import { Button } from '../../../../../../components/ui';
import { useTranslation } from 'react-i18next';
import { isCapacitorAndroid } from '../../../../../../platform/runtime';
import type { AppliedMarketFont, FontMarketTarget } from './useFontMarketTarget';

interface MarketFontApplyBarProps {
    target: AppliedMarketFont | null;
    onChangeTarget: (targets: FontMarketTarget[]) => void;
}

const OPTIONS: Array<{ id: FontMarketTarget; labelKey: string; androidOnly?: boolean }> = [
    { id: 'lyric', labelKey: 'options.marketTargetLyric' },
    { id: 'subtitle', labelKey: 'options.marketTargetSubtitle' },
    { id: 'wallpaper', labelKey: 'options.marketTargetWallpaper', androidOnly: true },
];

const MarketFontApplyBar: React.FC<MarketFontApplyBarProps> = ({ target, onChangeTarget }) => {
    const { t } = useTranslation();
    const android = isCapacitorAndroid();

    if (!target) {
        return (
            <div className="rounded-xl bg-[var(--glass-highlight)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]">
                {t('options.marketFontHint')}
            </div>
        );
    }

    const toggle = (id: FontMarketTarget) => {
        const next = target.appliesTo.includes(id)
            ? target.appliesTo.filter((entry) => entry !== id)
            : [...target.appliesTo, id];
        onChangeTarget(next);
    };

    return (
        <div className="space-y-2 rounded-xl bg-[var(--glass-highlight)] px-3 py-2.5">
            <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-[var(--text-secondary)]">{t('options.marketAppliedFont')}</span>
                <span
                    className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]"
                    style={{ fontFamily: `"${target.family}", inherit` }}
                >
                    {target.name}
                </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
                {OPTIONS.map((entry) => {
                    const disabled = entry.androidOnly && !android;
                    const active = target.appliesTo.includes(entry.id);
                    return (
                        <Button
                            key={entry.id}
                            disabled={disabled}
                            onClick={() => toggle(entry.id)}
                            className={`rounded-full px-2.5 py-1 text-[11.5px] transition disabled:opacity-40 ${
                                active
                                    ? 'bg-[var(--accent)] text-[var(--accent-contrast,white)]'
                                    : 'bg-[var(--glass-bg)] text-[var(--text-secondary)]'
                            }`}
                        >
                            {t(entry.labelKey)}
                        </Button>
                    );
                })}
            </div>
            {!android && (
                <div className="text-[11px] text-[var(--text-secondary)]">
                    {t('options.marketTargetWallpaperAndroidOnly')}
                </div>
            )}
        </div>
    );
};

export default MarketFontApplyBar;
