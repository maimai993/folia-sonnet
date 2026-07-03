import React from 'react';
import { Sparkles, Palette, Zap, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UserGuideTipCard } from './UserGuideTipCard';
import { UserGuideFeatureCard } from './UserGuideFeatureCard';

export type NewFeaturesIntroProps = {
    isDaylight: boolean;
    classes: {
        textPrimary: string;
        textSecondary: string;
        tipCardBg: string;
        iconTileBg: string;
        cardBg: string;
    };
};

// 在这里编辑当前版本的新功能介绍
export const NewFeaturesIntro: React.FC<NewFeaturesIntroProps> = ({ isDaylight, classes }) => {
    const { t } = useTranslation();
    const { textPrimary, textSecondary, tipCardBg, iconTileBg, cardBg } = classes;
    const tipCardClasses = { iconTileBg, tipCardBg, textPrimary, textSecondary };
    const featureCardClasses = { iconTileBg, cardBg, textPrimary, textSecondary };

    return (
        <div className="flex flex-col h-full">
            <div className="flex justify-center mb-6 mt-4 shrink-0">
                <div className={`relative w-20 h-20 rounded-full flex items-center justify-center ${isDaylight ? 'bg-blue-50 shadow-inner' : 'bg-white/[0.03] shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]'}`}>
                    <Sparkles size={32} className={isDaylight ? 'text-blue-500' : 'text-blue-400'} />
                </div>
            </div>

            <div className="shrink-0">
                <UserGuideTipCard
                    {...tipCardClasses}
                    icon={Sparkles}
                    iconClassName={isDaylight ? 'text-blue-500' : 'text-blue-400'}
                    title={t('userGuide.title', '欢迎使用 Folia')}
                    description="以下是新版本功能与改进"
                />
            </div>

            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto custom-scrollbar pr-2 pb-2">
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={Palette}
                    iconClassName={isDaylight ? 'text-rose-500' : 'text-rose-400'}
                    title="主题快速编辑"
                    description="点击控制面板中的 AI主题/自定义主题 名称，可从封面取色和 AI 推荐色中选择心仪的颜色搭配。"
                />
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={ImageIcon}
                    iconClassName={isDaylight ? 'text-purple-500' : 'text-purple-400'}
                    title="封面取色优化"
                    description="改进了颜色提取算法，更准确地抓取封面主题色，并智能匹配亮暗色方案。"
                />
            </div>
        </div>
    );
};
