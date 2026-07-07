import React from 'react';
import { Sparkles, Type, MousePointerClick, Zap } from 'lucide-react';
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
// 修改这里的介绍的同时，需要修改 src\components\modal\userGuideContent.ts 中的 USER_GUIDE_AUTO_OPEN_VERSION 到下一个发布版本号
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
                    icon={Sparkles}
                    iconClassName={isDaylight ? 'text-indigo-500' : 'text-indigo-400'}
                    title="全新动效与背景"
                    description="新增了回环动效以及星空背景，带来更沉浸的视觉体验。"
                />
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={MousePointerClick}
                    iconClassName={isDaylight ? 'text-rose-500' : 'text-rose-400'}
                    title="莫奈歌词交互升级"
                    description="莫奈歌词界面现已支持鼠标滚轮滚动查看，并可点击歌词直接跳转播放进度。"
                />
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={Type}
                    iconClassName={isDaylight ? 'text-purple-500' : 'text-purple-400'}
                    title="字体设置增强"
                    description="支持自定义字体回退栈（Font Stack），并可以为字幕配置完全独立的字体。"
                />
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={Zap}
                    iconClassName={isDaylight ? 'text-amber-500' : 'text-amber-400'}
                    title="歌词样式快速入口"
                    description="在控制面板新增快捷入口，可直接打开 Visualizer Playground 调整歌词与动效样式。"
                />
            </div>
        </div>
    );
};
