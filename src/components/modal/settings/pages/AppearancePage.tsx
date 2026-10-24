import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { getVisualizerModeLabel } from '../../../visualizer/registry';
import { usePlayerChromeSettingsStore } from '../../../../stores/usePlayerChromeSettingsStore';
import { openSettings } from '../../../../stores/useSettingsModalStore';
import { useThemeSettingsStore } from '../../../../stores/useThemeSettingsStore';
import { useVisualizerSettingsStore } from '../../../../stores/useVisualizerSettingsStore';
import { openAIEndpointOf } from '../../../../utils/openAIEndpoint';
import { Button, FoldedGroup, Group, NumberField, Reveal, Row, Segmented, TextField, Toggle, Value, parseNumberText, type SettingsOptionDef } from '../kit';
import { settingsAnchorSubview } from '../../../../utils/settingsAnchorModel';
import { isCapacitorAndroid } from '../../../../platform/runtime';
import { settingsCardClassFor } from '../settingsCardClasses';
import AndroidForceLandscapeSetting from '../AndroidForceLandscapeSetting';
import AndroidPlaybackAutoLandscapeSetting from '../AndroidPlaybackAutoLandscapeSetting';
import DeviceTypeSetting from '../DeviceTypeSetting';
import GlassSurfaceSetting from '../GlassSurfaceSetting';
import LyricFlatSetting from '../LyricFlatSetting';
import LyricsWallpaperSettingsSection from '../LyricsWallpaperSettingsSection';
import { AI, LYRICS_WALLPAPER_OPTIONS, LYRICS, LYRICS_WALLPAPER, O, SONG_THEME, THEME, VIEW } from './appearance/options';
import AiProviderSettings from '../AiProviderSettings';
import { AiConnectionTestReply, useAiConnectionTest } from './AiConnectionTest';
import { useSettingsPage, type AiApiKeyName } from './settingsPageContext';

// src/components/modal/settings/pages/AppearancePage.tsx
// The 外观 page: which lyric animation the player uses, light or dark, the colour theme, how a
// song's own theme is made and applied, and (desktop app) the AI provider that makes those themes.
// The lyric animation workbench and the theme colour editor are the existing overlays; their rows
// here only open them.

/** What the search can find on this page: the rows declared above, plus the wallpaper section's. */
export const OPTIONS: SettingsOptionDef[] = [...Object.values(O), ...LYRICS_WALLPAPER_OPTIONS];

/**
 * 歌词动态壁纸那一节（fork 独有，Android 专有）。
 *
 * 上游把外观页重画成 kit 的一排 Row，这一节还是老式的行 + 滑条，塞不进 kit 的 Row，
 * 所以整块挂在「歌词动画」那一组下面；组件内部非安卓直接返回 null，这里不用再判端。
 * 它整块落在这一组的 kit 卡片里，所以不自己画卡、不自己带边框；里面的开关、分段器、
 * 按钮都用 kit 的那几个，跟下面「主题」「歌曲主题」两组是同一副样子。
 */
const LyricsWallpaperSection: React.FC<{ isDaylight: boolean }> = ({ isDaylight }) => (
    <LyricsWallpaperSettingsSection
        isDaylight={isDaylight}
        rangeInputClass={[
            'w-full h-1.5 rounded-full appearance-none cursor-pointer',
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full',
            '[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0',
            isDaylight
                ? 'bg-black/15 [&::-webkit-slider-thumb]:bg-zinc-700 [&::-moz-range-thumb]:bg-zinc-700'
                : 'bg-white/10 [&::-webkit-slider-thumb]:bg-white [&::-moz-range-thumb]:bg-white',
        ].join(' ')}
    />
);

type DaylightChoice = 'light' | 'dark' | 'system';

const AppearancePage: React.FC = () => {
    const { t } = useTranslation();
    const { isElectron, themeControls, onOpenVisPlayground, onOpenThemePark } = useSettingsPage();
    const { isDaylight, followSystemTheme, setDaylightPreference, setFollowSystemTheme } = useThemeSettingsStore(useShallow(state => ({
        isDaylight: state.isDaylight,
        followSystemTheme: state.followSystemTheme,
        setDaylightPreference: state.setDaylightPreference,
        setFollowSystemTheme: state.setFollowSystemTheme,
    })));
    const visualizerMode = useVisualizerSettingsStore(state => state.visualizerMode);
    const randomEnabled = useVisualizerSettingsStore(state => state.randomVisualizerModePerSong);
    const nativeBlurEnabled = usePlayerChromeSettingsStore(state => state.enablePlayerPageNativeBlur);

    return (
        <>
            <Group def={LYRICS} bare>
                {nativeBlurEnabled && <Row notice={t('options.nativeBlurBackgroundNotice')} />}
                <Row option={O.lyricsAnimation} hint={t('options.lyricsRendererDesc')} onClick={onOpenVisPlayground}>
                    <Value>{randomEnabled ? t('ui.visualizerRandom') : getVisualizerModeLabel(visualizerMode, t)}</Value>
                </Row>
            </Group>

            {/* 歌词动态壁纸单独一张卡：不再和上面「歌词动画样式」挤在同一张里。
                整节只有安卓画（组件内部也判了一次），非安卓连空卡都别留。 */}
            {isCapacitorAndroid() && (
                <Group def={LYRICS_WALLPAPER}>
                    <LyricsWallpaperSection isDaylight={isDaylight} />
                </Group>
            )}

            {/* 显示那四项：排在歌词那组之后、主题之前；每行自带左右两栏的行式排布。 */}
            <Group def={VIEW}>
                <GlassSurfaceSetting />
                <LyricFlatSetting />
                {/* 下面三项组件内部自行判断运行时：非安卓直接返回 null，这里不用再判端。 */}
                <DeviceTypeSetting />
                <AndroidForceLandscapeSetting />
                <AndroidPlaybackAutoLandscapeSetting />
            </Group>

            <Group def={THEME}>
                <Row option={O.daylight} note={t('options.followSystemThemeDesc')}>
                    <Segmented<DaylightChoice>
                        value={followSystemTheme ? 'system' : isDaylight ? 'light' : 'dark'}
                        options={[
                            { value: 'light', label: t('options.daylightModeLight') },
                            { value: 'dark', label: t('options.daylightModeDark') },
                            { value: 'system', label: t('options.daylightModeSystem') },
                        ]}
                        onChange={(choice) => {
                            if (choice === 'system') {
                                setFollowSystemTheme(true);
                            } else {
                                // A light or dark picked by hand also stops following the system.
                                setDaylightPreference(choice === 'light');
                            }
                        }}
                    />
                </Row>
                <Row option={O.preset}>
                    <Segmented
                        value={themeControls.bgMode}
                        options={[
                            { value: 'default', label: t('options.themePresetsDefault') },
                            { value: 'custom', label: t('options.customTheme'), disabled: !themeControls.hasCustomTheme },
                        ]}
                        onChange={mode => (mode === 'custom' ? themeControls.onApplyCustomTheme() : themeControls.onApplyDefaultTheme())}
                    />
                </Row>
                <Row option={O.themePark} onClick={onOpenThemePark} />
            </Group>

            <Group def={SONG_THEME}>
                <Row option={O.autoSwitch} note={t('options.autoSwitchSongThemeDesc')}>
                    <Toggle checked={themeControls.songThemeAutoSwitchEnabled} onChange={themeControls.onToggleSongThemeAutoSwitch} />
                </Row>
                <Reveal when={themeControls.songThemeAutoSwitchEnabled}>
                    <Row
                        sub
                        option={O.autoGenerate}
                        note={t(themeControls.themeGenerationSource === 'cover' ? 'options.autoGenerateSongThemeCoverDesc' : 'options.autoGenerateSongThemeDesc')}
                    >
                        <Toggle checked={themeControls.songThemeAutoGenerateEnabled} onChange={themeControls.onToggleSongThemeAutoGenerate} />
                    </Row>
                </Reveal>
                <Row
                    option={O.source}
                    note={t(themeControls.themeGenerationSource === 'cover' ? 'options.themeGenerationSourceCoverDesc' : 'options.themeGenerationSourceAiDesc')}
                >
                    <Segmented
                        value={themeControls.themeGenerationSource}
                        options={[
                            { value: 'ai', label: t('options.themeGenerationSourceAi'), disabled: themeControls.aiApiKeyStatus !== 'configured' },
                            { value: 'cover', label: t('options.themeGenerationSourceCover') },
                        ]}
                        onChange={themeControls.onChangeThemeGenerationSource}
                    />
                </Row>
                <Reveal when={themeControls.aiApiKeyStatus === 'missing'}>
                    <Row sub notice={t('options.themeGenerationSourceAiUnavailable')}>
                        <Button onClick={() => openSettings('options', settingsAnchorSubview('electronSettings'), null, 'electronSettings')}>
                            {t('options.configureAiApiKey')}
                        </Button>
                    </Row>
                </Reveal>
                {/*
                    非桌面端（安卓 / 网页）没有主进程那套 AI 设置：凭据由用户自己填、存在本机，
                    AI 主题生成因此才有第三条路（services/aiThemeClient.ts）。桌面端继续走主进程设置。
                */}
                {!isElectron && (
                    <Row below={<AiProviderSettings settingsCardClass={settingsCardClassFor(isDaylight)} isDaylight={isDaylight} />} />
                )}
                <Row option={O.preferCustom} hint={t('options.preferCustomThemeDesc')}>
                    <Toggle
                        checked={themeControls.isCustomThemePreferred}
                        onChange={themeControls.onToggleCustomThemePreferred}
                        disabled={!themeControls.hasCustomTheme}
                    />
                </Row>
            </Group>

            {isElectron && <AiProviderSettings settingsCardClass={settingsCardClassFor(isDaylight)} isDaylight={isDaylight} />}
        </>
    );
};

export default AppearancePage;
