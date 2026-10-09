import React, { useState } from 'react';
import { Gauge, MonitorCog, Wallpaper } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme, VisualizerFrameRate } from '../../../types';
import { VISUALIZER_FRAME_RATE_OPTIONS } from '../../../utils/frameRateLimiter';
import ThemedDialog from '../../shared/ThemedDialog';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import MotionReductionSettingsSection from './MotionReductionSettingsSection';
import SettingsRow, { SettingsToggle } from './SettingsRow';
import { settingsDividerClassFor } from './settingsCardClasses';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { encodeWallpaperImage } from '../../../utils/wallpaperImage';
import { isCapacitorAndroid } from '../../../platform/runtime';
import {
    clearWallpaperBackgroundImage,
    clearWallpaperFont,
    hasWallpaperFont as queryWallpaperFont,
    hasWallpaperOverlayPermission,
    isLyricsWallpaperActive,
    openLyricsWallpaperPicker,
    openWallpaperOverlaySettings,
    pickWallpaperFont,
} from '../../../platform/foliaWallpaper';

// src/components/modal/settings/GraphicsSettingsSubview.tsx
// Everything that trades picture for smoothness or works around a renderer problem: static mode,
// the home background, native blur, the frame-rate cap, the Linux glow fix and reduced motion.
// Moved out of the lab page, where these sat among unrelated player-chrome switches.

/** Docs page behind the "Fix lyric animation freeze on Linux" switch. */
const CHROMIUM_FD_EXHAUSTION_DOCS_URL = 'https://folia-site.cielaniska.top/guide/chromium-fd-exhaustion';

/** On desktop a plain link would open inside the app window; hand it to the system browser instead. */
const openDocsLinkExternally = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!window.electron?.openExternalUrl) return;
    event.preventDefault();
    void window.electron.openExternalUrl(event.currentTarget.href);
};

const getFrameRateLabel = (frameRate: VisualizerFrameRate) => `${frameRate} FPS`;

type GraphicsSettingsSubviewProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    toggleOffBackgroundClass: string;
    utilityGhostButtonClass: string;
    rangeInputClass: string;
    theme?: Theme;
};

const GraphicsSettingsSubview: React.FC<GraphicsSettingsSubviewProps> = ({
    isDaylight,
    settingsCardClass,
    toggleOffBackgroundClass,
    utilityGhostButtonClass,
    rangeInputClass,
    theme,
}) => {
    const { t } = useTranslation();
    const [isNativeBlurNoticeOpen, setIsNativeBlurNoticeOpen] = useState(false);
    const {
        disableHomeDynamicBackground,
        staticMode,
        onToggleDisableHomeDynamicBackground,
        onToggleStaticMode,
    } = useThemeSettingsStore(useShallow(state => ({
        disableHomeDynamicBackground: state.disableHomeDynamicBackground,
        staticMode: state.staticMode,
        onToggleDisableHomeDynamicBackground: state.handleToggleDisableHomeDynamicBackground,
        onToggleStaticMode: state.handleToggleStaticMode,
    })));
    const enablePlayerPageNativeBlur = usePlayerChromeSettingsStore(state => state.enablePlayerPageNativeBlur);
    const onTogglePlayerPageNativeBlur = usePlayerChromeSettingsStore(state => state.handleTogglePlayerPageNativeBlur);
    const visualizerFrameRate = useVisualizerSettingsStore(state => state.visualizerFrameRate);
    const onVisualizerFrameRateChange = useVisualizerSettingsStore(state => state.handleSetVisualizerFrameRate);
    const glowBlurQuantize = useVisualizerSettingsStore(state => state.glowBlurQuantize);
    const onToggleGlowBlurQuantize = useVisualizerSettingsStore(state => state.handleToggleGlowBlurQuantize);
    const lyricsWallpaperFeed = useVisualizerSettingsStore(state => state.lyricsWallpaperFeed);
    const onToggleLyricsWallpaperFeed = useVisualizerSettingsStore(state => state.handleToggleLyricsWallpaperFeed);
    const lyricsWallpaperBackground = useVisualizerSettingsStore(state => state.lyricsWallpaperBackground);
    const onSetLyricsWallpaperBackground = useVisualizerSettingsStore(state => state.handleSetLyricsWallpaperBackground);
    const lyricsWallpaperImage = useVisualizerSettingsStore(state => state.lyricsWallpaperImage);
    const onSetLyricsWallpaperImage = useVisualizerSettingsStore(state => state.handleSetLyricsWallpaperImage);
    const lyricsWallpaperBlur = useVisualizerSettingsStore(state => state.lyricsWallpaperBlur);
    const onSetLyricsWallpaperBlur = useVisualizerSettingsStore(state => state.handleSetLyricsWallpaperBlur);
    const lyricsWallpaperProgress = useVisualizerSettingsStore(state => state.lyricsWallpaperProgress);
    const onToggleLyricsWallpaperProgress = useVisualizerSettingsStore(state => state.handleToggleLyricsWallpaperProgress);
    const lyricsWallpaperTranslation = useVisualizerSettingsStore(state => state.lyricsWallpaperTranslation);
    const onToggleLyricsWallpaperTranslation = useVisualizerSettingsStore(state => state.handleToggleLyricsWallpaperTranslation);
    const lyricsWallpaperStyle = useVisualizerSettingsStore(state => state.lyricsWallpaperStyle);
    const onSetLyricsWallpaperStyle = useVisualizerSettingsStore(state => state.handleSetLyricsWallpaperStyle);
    const wallpaperOverlayOpacity = useVisualizerSettingsStore(state => state.wallpaperOverlayOpacity);
    const onSetWallpaperOverlayOpacity = useVisualizerSettingsStore(state => state.handleSetWallpaperOverlayOpacity);
    const wallpaperOverlayAllApps = useVisualizerSettingsStore(state => state.wallpaperOverlayAllApps);
    const onToggleWallpaperOverlayAllApps = useVisualizerSettingsStore(state => state.handleToggleWallpaperOverlayAllApps);
    const wallpaperOverlayHideNativeLyrics = useVisualizerSettingsStore(state => state.wallpaperOverlayHideNativeLyrics);
    const onToggleWallpaperOverlayHideNativeLyrics = useVisualizerSettingsStore(state => state.handleToggleWallpaperOverlayHideNativeLyrics);
    const wallpaperOverlayHideNativeProgress = useVisualizerSettingsStore(state => state.wallpaperOverlayHideNativeProgress);
    const onToggleWallpaperOverlayHideNativeProgress = useVisualizerSettingsStore(state => state.handleToggleWallpaperOverlayHideNativeProgress);
    const wallpaperOverlaySkipInstrumental = useVisualizerSettingsStore(state => state.wallpaperOverlaySkipInstrumental);
    const onToggleWallpaperOverlaySkipInstrumental = useVisualizerSettingsStore(state => state.handleToggleWallpaperOverlaySkipInstrumental);
    const wallpaperOverlayHideWhenPaused = useVisualizerSettingsStore(state => state.wallpaperOverlayHideWhenPaused);
    const onToggleWallpaperOverlayHideWhenPaused = useVisualizerSettingsStore(state => state.handleToggleWallpaperOverlayHideWhenPaused);
    const wallpaperOverlayHideAfterLyricsEnd = useVisualizerSettingsStore(state => state.wallpaperOverlayHideAfterLyricsEnd);
    const onToggleWallpaperOverlayHideAfterLyricsEnd = useVisualizerSettingsStore(state => state.handleToggleWallpaperOverlayHideAfterLyricsEnd);
    const imageInputRef = React.useRef<HTMLInputElement | null>(null);

    const handleWallpaperImagePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const encoded = await encodeWallpaperImage(file);
        if (encoded) onSetLyricsWallpaperImage(encoded);
    };

    // 歌词壁纸是 Android 专有的，其它平台整段不渲染。
    const isAndroid = isCapacitorAndroid();
    const [isWallpaperActive, setIsWallpaperActive] = useState(false);

    React.useEffect(() => {
        if (!isAndroid) return;
        let cancelled = false;
        void isLyricsWallpaperActive().then((active) => {
            if (!cancelled) setIsWallpaperActive(active);
        });
        return () => {
            cancelled = true;
        };
    }, [isAndroid]);

    const handleOpenWallpaperPicker = () => {
        void openLyricsWallpaperPicker();
        // 系统选择器要用户手动确认，返回后状态才变，延后复查一次。
        window.setTimeout(() => {
            void isLyricsWallpaperActive().then(setIsWallpaperActive);
        }, 3000);
    };

    // 可视化叠层要「显示在其他应用上层」权限，没授权时它是静默不启用的。
    const [hasOverlayPermission, setHasOverlayPermission] = useState(false);

    React.useEffect(() => {
        if (!isAndroid) return;
        let cancelled = false;
        void hasWallpaperOverlayPermission().then((granted) => {
            if (!cancelled) setHasOverlayPermission(granted);
        });
        return () => {
            cancelled = true;
        };
    }, [isAndroid]);

    const handleOpenOverlaySettings = () => {
        void openWallpaperOverlaySettings();
        // 授权页是系统界面，用户回来之后才生效，延后复查一次。
        window.setTimeout(() => {
            void hasWallpaperOverlayPermission().then(setHasOverlayPermission);
        }, 3000);
    };

    // 字体是原生落在私有目录里的文件，应用这边只缓存一个「有没有」用于按钮文案。
    const [hasWallpaperFont, setHasWallpaperFont] = useState(false);
    const [fontNotice, setFontNotice] = useState<'applied' | 'rejected' | null>(null);

    React.useEffect(() => {
        if (!isAndroid) return;
        let cancelled = false;
        void queryWallpaperFont().then((value) => {
            if (!cancelled) setHasWallpaperFont(value);
        });
        return () => {
            cancelled = true;
        };
    }, [isAndroid]);

    const handlePickWallpaperFont = async () => {
        const result = await pickWallpaperFont();
        if (result === 'cancelled') return;
        setHasWallpaperFont(result === 'applied');
        setFontNotice(result);
        window.setTimeout(() => setFontNotice(null), 3200);
    };

    const handleClearWallpaperFont = () => {
        setHasWallpaperFont(false);
        setFontNotice(null);
        void clearWallpaperFont();
    };

    const dividerClass = settingsDividerClassFor(isDaylight);
    const isLinux = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('linux');
    const isVisualizerFrameRateLimiterEnabled = visualizerFrameRate !== 'off';
    const selectedVisualizerFrameRate = isVisualizerFrameRateLimiterEnabled ? visualizerFrameRate : 120;
    const selectedVisualizerFrameRateIndex = VISUALIZER_FRAME_RATE_OPTIONS.indexOf(selectedVisualizerFrameRate);

    const renderToggle = (checked: boolean, onChange: () => void) => (
        <SettingsToggle checked={checked} onChange={onChange} offClass={toggleOffBackgroundClass} onColor={theme?.secondaryColor} />
    );

    // Native blur can drop frames on some GPUs, so switching it on goes through a confirmation.
    const handleNativeBlurToggle = () => {
        if (enablePlayerPageNativeBlur) {
            onTogglePlayerPageNativeBlur(false);
            return;
        }
        setIsNativeBlurNoticeOpen(true);
    };

    const confirmNativeBlur = () => {
        onTogglePlayerPageNativeBlur(true);
        setIsNativeBlurNoticeOpen(false);
    };

    const handleFrameRateSliderChange = (value: string) => {
        const nextIndex = Math.min(VISUALIZER_FRAME_RATE_OPTIONS.length - 1, Math.max(0, Number(value)));
        onVisualizerFrameRateChange(VISUALIZER_FRAME_RATE_OPTIONS[nextIndex]);
    };

    return (
        <div className="space-y-5">
            <SettingsAnchor anchorId="graphicsPerformance" label={t('options.labPerformanceSection')} className="space-y-4">
                <SettingsSectionHeading icon={MonitorCog} label={t('options.labPerformanceSection')} />
                <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
                    <SettingsRow
                        title={t('options.enableStaticMode')}
                        description={t('options.enableStaticModeDesc')}
                        note={t('options.enableStaticModeDescSub')}
                        control={renderToggle(staticMode, () => onToggleStaticMode(!staticMode))}
                        dividerClass={dividerClass}
                    />
                    <SettingsRow
                        title={t('options.disableHomeDynamicBackground')}
                        description={t('options.disableHomeDynamicBackgroundDesc')}
                        note={t('options.disableHomeDynamicBackgroundWarning')}
                        control={renderToggle(disableHomeDynamicBackground, () => onToggleDisableHomeDynamicBackground(!disableHomeDynamicBackground))}
                        dividerClass={dividerClass}
                    />
                    {!isLinux && (
                        <SettingsRow
                            title={t('options.enablePlayerPageNativeBlur')}
                            description={t('options.enablePlayerPageNativeBlurDesc')}
                            control={renderToggle(enablePlayerPageNativeBlur, handleNativeBlurToggle)}
                            dividerClass={dividerClass}
                        />
                    )}
                    <SettingsRow
                        title={t('options.visualizerFrameRate')}
                        description={t('options.visualizerFrameRateDesc')}
                        control={renderToggle(
                            isVisualizerFrameRateLimiterEnabled,
                            () => onVisualizerFrameRateChange(isVisualizerFrameRateLimiterEnabled ? 'off' : selectedVisualizerFrameRate),
                        )}
                        dividerClass={dividerClass}
                    >
                        <div className={`space-y-3 transition-opacity ${isVisualizerFrameRateLimiterEnabled ? 'opacity-100' : 'opacity-45 pointer-events-none'}`}>
                            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <span className="opacity-60">{t('options.visualizerFrameRateValue')}</span>
                                <span className="font-mono opacity-70">{getFrameRateLabel(selectedVisualizerFrameRate)}</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max={VISUALIZER_FRAME_RATE_OPTIONS.length - 1}
                                step="1"
                                value={Math.max(0, selectedVisualizerFrameRateIndex)}
                                onChange={(event) => handleFrameRateSliderChange(event.target.value)}
                                className={rangeInputClass}
                                aria-label={t('options.visualizerFrameRateValue')}
                                disabled={!isVisualizerFrameRateLimiterEnabled}
                            />
                            <div className="grid grid-cols-3 text-[11px] font-mono opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                {VISUALIZER_FRAME_RATE_OPTIONS.map((frameRate, index) => (
                                    <span key={frameRate} className={index === 1 ? 'text-center' : index === 2 ? 'text-right' : ''}>
                                        {frameRate}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </SettingsRow>
                    <SettingsRow
                        title={t('options.glowBlurQuantize')}
                        description={(
                            <>
                                {t('options.glowBlurQuantizeDesc')}{' '}
                                <a
                                    href={CHROMIUM_FD_EXHAUSTION_DOCS_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={openDocsLinkExternally}
                                    className="underline underline-offset-2 hover:opacity-80"
                                >
                                    {t('options.glowBlurQuantizeDocs')}
                                </a>
                            </>
                        )}
                        control={renderToggle(glowBlurQuantize, () => onToggleGlowBlurQuantize(!glowBlurQuantize))}
                        dividerClass={dividerClass}
                        isLast
                    />
                </div>
            </SettingsAnchor>

            <SettingsAnchor anchorId="graphicsMotion" label={t('options.reduceMotionSection')} className="space-y-4">
                <SettingsSectionHeading icon={Gauge} label={t('options.reduceMotionSection')} />
                <MotionReductionSettingsSection
                    settingsCardClass={settingsCardClass}
                    settingsDividerClass={dividerClass}
                    toggleOffBackgroundClass={toggleOffBackgroundClass}
                    theme={theme}
                />
            </SettingsAnchor>

            {isAndroid && (
                <SettingsAnchor anchorId="graphicsLyricsWallpaper" label={t('options.lyricsWallpaperSection')} className="space-y-4">
                    <SettingsSectionHeading icon={Wallpaper} label={t('options.lyricsWallpaperSection')} />
                    <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
                        <SettingsRow
                            title={t('options.lyricsWallpaperApply')}
                            description={t('options.lyricsWallpaperApplyDesc')}
                            control={(
                                <button
                                    type="button"
                                    onClick={handleOpenWallpaperPicker}
                                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${utilityGhostButtonClass}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    {isWallpaperActive
                                        ? t('options.lyricsWallpaperActive')
                                        : t('options.lyricsWallpaperSet')}
                                </button>
                            )}
                            dividerClass={dividerClass}
                        />
                        <SettingsRow
                            title={t('options.lyricsWallpaperStyle')}
                            description={t('options.lyricsWallpaperStyleDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <div className="flex items-center gap-1 rounded-lg border p-0.5" style={{ borderColor: 'var(--text-secondary)' }}>
                                    {(['minimal', 'follow'] as const).map((style) => (
                                        <button
                                            key={style}
                                            type="button"
                                            onClick={() => onSetLyricsWallpaperStyle(style)}
                                            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${lyricsWallpaperStyle === style ? '' : 'opacity-60'}`}
                                            style={lyricsWallpaperStyle === style
                                                ? { backgroundColor: theme?.accentColor || '#3b82f6', color: '#fff' }
                                                : { color: 'var(--text-primary)' }}
                                        >
                                            {style === 'minimal'
                                                ? t('options.lyricsWallpaperStyleMinimal')
                                                : t('options.lyricsWallpaperStyleFollow')}
                                        </button>
                                    ))}
                                </div>
                            )}
                        />
                        {/* 可视化叠层要 SYSTEM_ALERT_WINDOW；没授权时它静默不工作，
                            用户只会看到「壁纸跟以前一样」，所以这里必须给明确入口。 */}
                        <SettingsRow
                            title={t('options.lyricsWallpaperOverlay')}
                            description={t('options.lyricsWallpaperOverlayDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={handleOpenOverlaySettings}
                                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${utilityGhostButtonClass}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    {hasOverlayPermission
                                        ? t('options.lyricsWallpaperOverlayGranted')
                                        : t('options.lyricsWallpaperOverlayGrant')}
                                </button>
                            )}
                        />
                        {/* 叠层不透明度：整层从几乎看不见到完全不透明。 */}
                        <SettingsRow
                            title={t('options.wallpaperOverlayOpacity')}
                            description={t('options.wallpaperOverlayOpacityDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <div className="flex items-center gap-2">
                                    <input
                                        type="range"
                                        min={10}
                                        max={100}
                                        step={5}
                                        value={Math.round(wallpaperOverlayOpacity * 100)}
                                        onChange={(event) => onSetWallpaperOverlayOpacity(Number(event.target.value) / 100)}
                                        className="h-1 w-28 cursor-pointer accent-white"
                                    />
                                    <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                        {Math.round(wallpaperOverlayOpacity * 100)}%
                                    </span>
                                </div>
                            )}
                        />
                        {/* 叠层是否在所有应用之上显示。 */}
                        <SettingsRow
                            title={t('options.wallpaperOverlayAllApps')}
                            description={t('options.wallpaperOverlayAllAppsDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => onToggleWallpaperOverlayAllApps(!wallpaperOverlayAllApps)}
                                    className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${!wallpaperOverlayAllApps ? toggleOffBackgroundClass : ''}`}
                                    style={{ backgroundColor: wallpaperOverlayAllApps ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${wallpaperOverlayAllApps ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            )}
                        />
                        {/* 跟随 + 叠层时，原生那层的歌词/进度条要不要让位。 */}
                        <SettingsRow
                            title={t('options.wallpaperOverlayHideNativeLyrics')}
                            description={t('options.wallpaperOverlayHideNativeLyricsDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => onToggleWallpaperOverlayHideNativeLyrics(!wallpaperOverlayHideNativeLyrics)}
                                    className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${!wallpaperOverlayHideNativeLyrics ? toggleOffBackgroundClass : ''}`}
                                    style={{ backgroundColor: wallpaperOverlayHideNativeLyrics ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${wallpaperOverlayHideNativeLyrics ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            )}
                        />
                        {/* 暂停时是否收起叠层。 */}
                        <SettingsRow
                            title={t('options.wallpaperOverlayHideWhenPaused')}
                            description={t('options.wallpaperOverlayHideWhenPausedDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => onToggleWallpaperOverlayHideWhenPaused(!wallpaperOverlayHideWhenPaused)}
                                    className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${!wallpaperOverlayHideWhenPaused ? toggleOffBackgroundClass : ''}`}
                                    style={{ backgroundColor: wallpaperOverlayHideWhenPaused ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${wallpaperOverlayHideWhenPaused ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            )}
                        />
                        {/* 歌词唱完之后（长尾奏）是否收起叠层。 */}
                        <SettingsRow
                            title={t('options.wallpaperOverlayHideAfterLyricsEnd')}
                            description={t('options.wallpaperOverlayHideAfterLyricsEndDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => onToggleWallpaperOverlayHideAfterLyricsEnd(!wallpaperOverlayHideAfterLyricsEnd)}
                                    className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${!wallpaperOverlayHideAfterLyricsEnd ? toggleOffBackgroundClass : ''}`}
                                    style={{ backgroundColor: wallpaperOverlayHideAfterLyricsEnd ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${wallpaperOverlayHideAfterLyricsEnd ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            )}
                        />
                        {/* 纯音乐（没有歌词）时是否显示叠层。 */}
                        <SettingsRow
                            title={t('options.wallpaperOverlaySkipInstrumental')}
                            description={t('options.wallpaperOverlaySkipInstrumentalDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => onToggleWallpaperOverlaySkipInstrumental(!wallpaperOverlaySkipInstrumental)}
                                    className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${!wallpaperOverlaySkipInstrumental ? toggleOffBackgroundClass : ''}`}
                                    style={{ backgroundColor: wallpaperOverlaySkipInstrumental ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${wallpaperOverlaySkipInstrumental ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            )}
                        />
                        <SettingsRow
                            title={t('options.wallpaperOverlayHideNativeProgress')}
                            description={t('options.wallpaperOverlayHideNativeProgressDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => onToggleWallpaperOverlayHideNativeProgress(!wallpaperOverlayHideNativeProgress)}
                                    className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${!wallpaperOverlayHideNativeProgress ? toggleOffBackgroundClass : ''}`}
                                    style={{ backgroundColor: wallpaperOverlayHideNativeProgress ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${wallpaperOverlayHideNativeProgress ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            )}
                        />
                        <SettingsRow
                            title={t('options.lyricsWallpaperBackground')}
                            description={t('options.lyricsWallpaperBackgroundDesc')}
                            dividerClass={dividerClass}
                            control={(
                                <div className="flex items-center gap-1 rounded-lg border p-0.5" style={{ borderColor: 'var(--text-secondary)' }}>
                                    {(['cover', 'color', 'image'] as const).map((mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            onClick={() => onSetLyricsWallpaperBackground(mode)}
                                            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${lyricsWallpaperBackground === mode ? '' : 'opacity-60'}`}
                                            style={lyricsWallpaperBackground === mode
                                                ? { backgroundColor: theme?.accentColor || '#3b82f6', color: '#fff' }
                                                : { color: 'var(--text-primary)' }}
                                        >
                                            {mode === 'cover'
                                                ? t('options.lyricsWallpaperBackgroundCover')
                                                : mode === 'color'
                                                    ? t('options.lyricsWallpaperBackgroundColor')
                                                    : t('options.lyricsWallpaperBackgroundImage')}
                                        </button>
                                    ))}
                                </div>
                            )}
                        >
                            {lyricsWallpaperBackground === 'image' && (
                                <div className="mt-3 flex items-center gap-3">
                                    {lyricsWallpaperImage ? (
                                        <img
                                            src={lyricsWallpaperImage}
                                            alt=""
                                            className="h-14 w-14 shrink-0 rounded-lg object-cover"
                                        />
                                    ) : (
                                        <div
                                            className="h-14 w-14 shrink-0 rounded-lg border"
                                            style={{ borderColor: 'var(--text-secondary)' }}
                                        />
                                    )}
                                    <div className="space-y-2">
                                        <button
                                            type="button"
                                            onClick={() => imageInputRef.current?.click()}
                                            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${utilityGhostButtonClass}`}
                                            style={{ color: 'var(--text-primary)' }}
                                        >
                                            {t('options.lyricsWallpaperPickImage')}
                                        </button>
                                        {lyricsWallpaperImage && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                onSetLyricsWallpaperImage(null);
                                                void clearWallpaperBackgroundImage();
                                            }}
                                                className="block text-xs opacity-60 hover:opacity-100"
                                                style={{ color: 'var(--text-secondary)' }}
                                            >
                                                {t('options.lyricsWallpaperClearImage')}
                                            </button>
                                        )}
                                        <input
                                            ref={imageInputRef}
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={handleWallpaperImagePick}
                                        />
                                    </div>
                                </div>
                            )}
                        </SettingsRow>
                        <SettingsRow
                            title={t('options.lyricsWallpaperBlur')}
                            description={t('options.lyricsWallpaperBlurDesc')}
                            dividerClass={dividerClass}
                        >
                            <div className="space-y-3">
                                <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    <span className="opacity-60">{t('options.lyricsWallpaperBlurValue')}</span>
                                    <span className="font-mono opacity-70">{Math.round(lyricsWallpaperBlur * 100)}%</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="5"
                                    value={Math.round(lyricsWallpaperBlur * 100)}
                                    onChange={(event) => onSetLyricsWallpaperBlur(Number(event.target.value) / 100)}
                                    className={rangeInputClass}
                                    aria-label={t('options.lyricsWallpaperBlurValue')}
                                />
                            </div>
                        </SettingsRow>
                        <SettingsRow
                            title={t('options.lyricsWallpaperProgress')}
                            description={t('options.lyricsWallpaperProgressDesc')}
                            control={renderToggle(lyricsWallpaperProgress, () => onToggleLyricsWallpaperProgress(!lyricsWallpaperProgress))}
                            dividerClass={dividerClass}
                        />
                        <SettingsRow
                            title={t('options.lyricsWallpaperTranslation')}
                            description={t('options.lyricsWallpaperTranslationDesc')}
                            control={renderToggle(lyricsWallpaperTranslation, () => onToggleLyricsWallpaperTranslation(!lyricsWallpaperTranslation))}
                            dividerClass={dividerClass}
                        />
                        <SettingsRow
                            title={t('options.lyricsWallpaperFont')}
                            description={t('options.lyricsWallpaperFontDesc')}
                            control={(
                                <button
                                    type="button"
                                    onClick={() => void handlePickWallpaperFont()}
                                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${utilityGhostButtonClass}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    {hasWallpaperFont
                                        ? t('options.lyricsWallpaperReplaceFont')
                                        : t('options.lyricsWallpaperPickFont')}
                                </button>
                            )}
                            dividerClass={dividerClass}
                        >
                            <div className="mt-2 flex items-center gap-3">
                                <span
                                    className="text-xs"
                                    style={{
                                        color: fontNotice === 'rejected'
                                            ? 'var(--danger-color, #ef4444)'
                                            : 'var(--text-secondary)',
                                    }}
                                >
                                    {fontNotice === 'applied'
                                        ? t('options.lyricsWallpaperFontApplied')
                                        : fontNotice === 'rejected'
                                            ? t('options.lyricsWallpaperFontFailed')
                                            : ''}
                                </span>
                                {hasWallpaperFont && (
                                    <button
                                        type="button"
                                        onClick={handleClearWallpaperFont}
                                        className="text-xs opacity-60 hover:opacity-100"
                                        style={{ color: 'var(--text-secondary)' }}
                                    >
                                        {t('options.lyricsWallpaperClearFont')}
                                    </button>
                                )}
                            </div>
                        </SettingsRow>
                        <SettingsRow
                            title={t('options.lyricsWallpaperFeed')}
                            description={t('options.lyricsWallpaperFeedDesc')}
                            control={renderToggle(lyricsWallpaperFeed, () => onToggleLyricsWallpaperFeed(!lyricsWallpaperFeed))}
                            dividerClass={dividerClass}
                            isLast
                        />
                    </div>
                </SettingsAnchor>
            )}

            <ThemedDialog
                isOpen={isNativeBlurNoticeOpen}
                onClose={() => setIsNativeBlurNoticeOpen(false)}
                isDaylight={isDaylight}
                title={t('options.nativeBlurConfirmTitle')}
                footer={(
                    <>
                        <button
                            type="button"
                            onClick={() => setIsNativeBlurNoticeOpen(false)}
                            className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${utilityGhostButtonClass}`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {t('localMusic.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={confirmNativeBlur}
                            className="rounded-xl px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                            style={{ backgroundColor: theme?.accentColor || '#3b82f6' }}
                        >
                            {t('options.nativeBlurConfirmAction')}
                        </button>
                    </>
                )}
            >
                <p className="text-sm leading-6 opacity-75" style={{ color: 'var(--text-secondary)' }}>
                    {t('options.nativeBlurConfirmDesc')}
                </p>
            </ThemedDialog>
        </div>
    );
};

export default GraphicsSettingsSubview;
