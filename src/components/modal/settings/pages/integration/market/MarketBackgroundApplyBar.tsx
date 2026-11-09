// src/components/modal/settings/pages/integration/market/MarketBackgroundApplyBar.tsx
//
// 「当前背景应用到哪」。
//
// 和字体那条一样，应用范围要能事后改。两个去处：
//   · app         App 内歌词可视化背景
//   · wallpaper   桌面/锁屏的系统壁纸
//
// 桌面壁纸那个目标要用户手动在系统里确认，所以按钮上写清楚，不假装一键生效。

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AppliedMarketBackground, BackgroundTarget } from './useBackgroundApplyTarget';

interface MarketBackgroundApplyBarProps {
    target: AppliedMarketBackground | null;
    onChangeTarget: (next: AppliedMarketBackground | null) => void;
}

const MarketBackgroundApplyBar: React.FC<MarketBackgroundApplyBarProps> = ({ target }) => {
    const { t } = useTranslation();

    if (!target) {
        return (
            <div className="rounded-xl bg-[var(--glass-highlight)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]">
                {t('options.marketBackgroundHint')}
            </div>
        );
    }

    return (
        <div className="space-y-1.5 rounded-xl bg-[var(--glass-highlight)] px-3 py-2.5">
            <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-[var(--text-secondary)]">{t('options.marketAppliedBackground')}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                    {target.name || t('options.marketAppliedBackgroundUntitled')}
                </span>
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
                {t('options.marketAppliedBackgroundTarget', {
                    target: target.appliesTo
                        .map((entry: BackgroundTarget) => t(`options.marketTargetBackground_${entry}`))
                        .join('、'),
                })}
            </div>
        </div>
    );
};

export default MarketBackgroundApplyBar;
