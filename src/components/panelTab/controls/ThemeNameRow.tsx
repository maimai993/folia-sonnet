import React from 'react';
import { ArrowUpDown, Check, Moon, RefreshCw, Sparkle, Sparkles, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import type { ThemeSourceModel } from '../../../hooks/themeControllerState';
import { useAiThemeCloudSync } from '../../../hooks/useAiThemeCloudSync';
import { Button } from '../../modal/settings/kit';
import { PanelIconButton } from '../shell/PanelIconButton';
import { Segments } from '../shell/Segments';

// src/components/panelTab/controls/ThemeNameRow.tsx
// The line under the theme source: the name of the theme in use, light or dark, the button that has
// an AI theme made for the playing song, and the button that syncs themes now (there for an AI or a
// custom theme; it comes last, so opening it moves nothing but itself).

interface ThemeNameRowProps {
    theme: Theme;
    themeSourceModel: ThemeSourceModel;
    defaultTheme: Theme;
    daylightTheme: Theme;
    onGenerateAITheme: () => void;
    isGeneratingTheme: boolean;
    canGenerateAITheme: boolean;
    isDaylight: boolean;
    onToggleDaylight: () => void;
}

const ThemeNameRow: React.FC<ThemeNameRowProps> = ({
    theme,
    themeSourceModel,
    defaultTheme,
    daylightTheme,
    onGenerateAITheme,
    isGeneratingTheme,
    canGenerateAITheme,
    isDaylight,
    onToggleDaylight,
}) => {
    const { t } = useTranslation();
    /*
     * 这颗按钮走 **AI 云缓存**，不再碰自建 sync 服务器：按下去匹配一次，命中就当场
     * 用上，没命中而本机改过就把这一版贡献上去 —— 全程不生成。
     *
     * 只有一颗。以前旁边还挂着一颗「恢复云端版本」，两颗都在跟云端打交道、样子又一样，
     * 看上去就是「同步按钮怎么有两个」；而「拿云端那版来用」本来就是这颗按钮命中时
     * 干的事，那颗是多余的。
     */
    const { syncState, runSync } = useAiThemeCloudSync({
        locallyEdited: themeSourceModel.hasLocalAiTheme,
    });
    const hasSync = themeSourceModel.activeSource !== 'default';

    const formatThemeDisplayName = (name: string) => {
        if (themeSourceModel.activeSource !== 'default') {
            return name;
        }

        return name === defaultTheme.name
            ? t('theme.midnightDefault')
            : (name === daylightTheme.name ? t('theme.daylightDefault') : name);
    };

    return (
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 py-1.5">
            <span className="min-w-0 flex-[1_1_72px] truncate text-[13px] text-[color:var(--st-t2)]">
                {formatThemeDisplayName(themeSourceModel.current.label || theme.name)}
            </span>
            <span className="ml-auto flex max-w-full items-center gap-1.5">
                <Segments
                    size="m"
                    value={isDaylight ? 'light' : 'dark'}
                    onChange={() => onToggleDaylight()}
                    options={[
                        { value: 'light', label: t('options.daylightModeLight'), icon: <Sun size={15} />, iconOnly: true },
                        { value: 'dark', label: t('options.daylightModeDark'), icon: <Moon size={15} />, iconOnly: true },
                    ]}
                />
                <Button
                    icon={themeSourceModel.hasLocalAiTheme && !isGeneratingTheme ? Sparkles : Sparkle}
                    onClick={onGenerateAITheme}
                    disabled={isGeneratingTheme || !canGenerateAITheme}
                >
                    {isGeneratingTheme ? t('ui.generatingTheme') : t('ui.generateAITheme')}
                </Button>
                {/* Opens its width at the row's end when there is a theme to sync. */}
                <span
                    inert={!hasSync}
                    className={`st-t-move grid transition-[grid-template-columns,opacity,margin] ${hasSync ? 'grid-cols-[1fr]' : '-ml-1.5 grid-cols-[0fr] opacity-0'}`}
                >
                        <span className="min-w-0 overflow-hidden">
                            <PanelIconButton
                                size="s"
                                filled
                                label={syncState === 'syncing'
                                    ? t('options.syncing')
                                    : syncState === 'complete'
                                        ? t('ui.synced')
                                        : t('commandPalette.commands.sync-now.title')}
                                disabled={syncState === 'syncing'}
                                onClick={() => void runSync()}
                            >
                                {syncState === 'syncing' ? (
                                    <RefreshCw size={15} className="animate-spin" />
                                ) : syncState === 'complete' ? (
                                    <Check size={15} className="text-[color:var(--st-ok)]" strokeWidth={3} />
                                ) : (
                                    <ArrowUpDown size={15} />
                                )}
                            </PanelIconButton>
                        </span>
                </span>
            </span>
        </div>
    );
};

export default ThemeNameRow;
