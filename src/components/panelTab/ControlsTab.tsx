import React from 'react';
import { Theme, ThemeMode, VisualizerMode } from '../../types';
import type { ThemeSourceModel } from '../../hooks/themeControllerState';
import AudioEqualizerDialog from './AudioEqualizerDialog';
import AppearanceSection from './controls/AppearanceSection';
import HdrProjectionRow from './controls/HdrProjectionRow';
import SoundTiles from './controls/SoundTiles';
import SleepTimerRow from './controls/SleepTimerRow';
import ThemeNameRow from './controls/ThemeNameRow';
import ThemeSourceRow from './controls/ThemeSourceRow';
import VolumeRow from './controls/VolumeRow';
import { GroupLine } from './shell/GroupLine';
import { useIsWideShortViewport } from './shell/panelViewport';

// src/components/panelTab/ControlsTab.tsx
// 控制标签页只负责装配：声音（音量、定时关闭、主题来源与当前主题那一行、HUD 投影）与外观（歌词样式、背景、
// 播放页透明背景，最后是关闭循环 / 智能过渡 / 音频效果器那三块）。
// 音频效果器的入口已从声音组删掉（issue #107）；窗口仍由命令面板打开。
//
// 矮而宽（横过来的手机）时**分左右两栏**：那种窗口纵向只剩一百多像素，单栏要滚很久才看到
// 主题那一行；横向反倒还剩一大半，摊成两栏一屏能看到的控件就多了一倍。竖屏不分 —— 那儿缺的
// 是横向，摊开只会挤成一团。

interface ControlsTabProps {
    loopMode: 'off' | 'all' | 'one' | 'shuffle';
    onToggleLoop: () => void;
    onGenerateAITheme: () => void;
    isGeneratingTheme: boolean;
    canGenerateAITheme: boolean;
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    onBgModeChange: (mode: ThemeMode) => void;
    hasCustomTheme: boolean;
    themeSourceModel: ThemeSourceModel;
    defaultTheme: Theme;
    daylightTheme: Theme;
    visualizerMode: VisualizerMode;
    onVisualizerModeChange: (mode: VisualizerMode) => void;
    useCoverColorBg: boolean;
    onToggleCoverColorBg: (enable: boolean) => void;
    transparentPlayerBackground: boolean;
    onToggleTransparentPlayerBackground: (enable: boolean) => void;
    isDaylight: boolean;
    onToggleDaylight: () => void;
    volume: number;
    isMuted: boolean;
    onVolumePreview: (val: number) => void;
    onVolumeChange: (val: number) => void;
    onToggleMute: () => void;
    loopToggleDisabled?: boolean;
    onClosePanel?: () => void;
}

const ControlsTab: React.FC<ControlsTabProps> = ({
    loopMode,
    onToggleLoop,
    onGenerateAITheme,
    isGeneratingTheme,
    canGenerateAITheme,
    theme,
    onThemeChange,
    onBgModeChange,
    hasCustomTheme,
    themeSourceModel,
    defaultTheme,
    daylightTheme,
    visualizerMode,
    onVisualizerModeChange,
    useCoverColorBg,
    onToggleCoverColorBg,
    transparentPlayerBackground,
    onToggleTransparentPlayerBackground,
    isDaylight,
    onToggleDaylight,
    volume,
    isMuted,
    onVolumePreview,
    onVolumeChange,
    onToggleMute,
    loopToggleDisabled = false,
    onClosePanel,
}) => {
    const twoColumns = useIsWideShortViewport();

    // 「声音」那一组：音量、播放顺序那两块、定时关闭。
    const sound = (
        <>
            <VolumeRow
                volume={volume}
                isMuted={isMuted}
                onVolumePreview={onVolumePreview}
                onVolumeChange={onVolumeChange}
                onToggleMute={onToggleMute}
            />
            {/* 定时关闭：上游重写控制页时这一行没被挂回来，组件成了孤儿（useSleepTimer 仍在 App 里跑，
                只是没有入口）。默认收起，标题右侧始终显示当前配置或剩余时间。 */}
            <div className="pt-2">
                <SleepTimerRow theme={theme} isDaylight={isDaylight} />
            </div>

            {/* 主题来源、当前主题那一行与 HUD 投影摆在这里：横屏分两栏时「声音」这一栏到定时关闭就
                断了，底下一直是空的，右边那栏却挤满——挪过来正好把空档填上（issue #200）。 */}
            <ThemeSourceRow
                themeSourceModel={themeSourceModel}
                onBgModeChange={onBgModeChange}
                hasCustomTheme={hasCustomTheme}
                defaultTheme={defaultTheme}
                daylightTheme={daylightTheme}
                isDaylight={isDaylight}
            />
            <ThemeNameRow
                theme={theme}
                themeSourceModel={themeSourceModel}
                defaultTheme={defaultTheme}
                daylightTheme={daylightTheme}
                onGenerateAITheme={onGenerateAITheme}
                isGeneratingTheme={isGeneratingTheme}
                canGenerateAITheme={canGenerateAITheme}
                isDaylight={isDaylight}
                onToggleDaylight={onToggleDaylight}
            />
            {/* HUD 投影：三件事都跟「怎么显示」有关；非安卓自己不渲染。 */}
            <HdrProjectionRow theme={theme} />
        </>
    );

    // 「外观 + 主题」那一组。
    const looks = (
        <>
            <AppearanceSection
                theme={theme}
                onThemeChange={onThemeChange}
                isDaylight={isDaylight}
                visualizerMode={visualizerMode}
                onVisualizerModeChange={onVisualizerModeChange}
                useCoverColorBg={useCoverColorBg}
                onToggleCoverColorBg={onToggleCoverColorBg}
                transparentPlayerBackground={transparentPlayerBackground}
                onToggleTransparentPlayerBackground={onToggleTransparentPlayerBackground}
                onClosePanel={onClosePanel}
            />
            {/* 关闭循环 / 智能过渡 / 音频效果器这三块：外观那块以「播放页背景透明」收尾，正好接在它下面。
                声音那一栏只剩音量、定时关闭与主题那几行，两栏高度也就接近了（issue #200）。 */}
            <SoundTiles
                loopMode={loopMode}
                onToggleLoop={onToggleLoop}
                loopToggleDisabled={loopToggleDisabled}
            />
        </>
    );

    return (
        <div className={twoColumns ? 'grid grid-cols-2 gap-x-4' : undefined}>
            {twoColumns ? (
                <>
                    <div className="flex min-w-0 flex-col">{sound}</div>
                    <div className="flex min-w-0 flex-col">{looks}</div>
                </>
            ) : (
                <>
                    {sound}
                    <GroupLine />
                    {looks}
                </>
            )}

            <AudioEqualizerDialog isDaylight={isDaylight} />
        </div>
    );
};

export default ControlsTab;
