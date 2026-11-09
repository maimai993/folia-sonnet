import React, { useState } from 'react';
import { Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsRow from './SettingsRow';
import { settingsDividerClassFor } from './settingsCardClasses';
import { Button, RangeInput, Reveal, Segmented, Toggle } from './kit';
import MarketEntryButton from './pages/integration/market/MarketEntryButton';
import { WALLPAPER } from './pages/appearance/options';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { encodeWallpaperImage } from '../../../utils/wallpaperImage';
import { isCapacitorAndroid } from '../../../platform/runtime';
import {
    clearWallpaperBackgroundImage,
    clearWallpaperFont,
    clearWallpaperVideo as removeWallpaperVideo,
    hasWallpaperFont as queryWallpaperFont,
    hasWallpaperVideo as queryWallpaperVideo,
    isLyricsWallpaperActive,
    openLyricsWallpaperPicker,
    pickWallpaperFont,
    pickWallpaperVideo,
} from '../../../platform/foliaWallpaper';
import { Button as UiButton, TextField } from '@/components/ui';
import LyricsWallpaperFloatingRows from './LyricsWallpaperFloatingRows';
import LyricsWallpaperOverlayRows from './LyricsWallpaperOverlayRows';

// src/components/modal/settings/LyricsWallpaperSettingsSection.tsx
// 歌词动态壁纸那一整节：设为壁纸、样式（跟随 / 精简小窗）、可视化叠层、背景（封面 /
// 纯色 / 图片 / 视频）、字体。Android 专有 —— 其它平台整节不渲染。
//
// 以前它挂在「图形设置」里，因为最早是作为「要不要省电 / 掉帧」这类开关进来的。
// 但它管的是**歌词长什么样**（小窗位置、字号、叠层让不让位），跟帧率、静态模式这些
// 不是一回事；放在图形设置里，调歌词样式的人根本找不到。所以整节搬到「外观 → 歌词
// 动画」，跟「歌词动画样式」那个入口挨在一起。

/** 壁纸背景四种模式的文案键。列成一张表，加一种模式时只改这一处。 */
const BACKGROUND_LABEL_KEYS: Record<'cover' | 'color' | 'image' | 'video', string> = {
    cover: 'options.lyricsWallpaperBackgroundCover',
    color: 'options.lyricsWallpaperBackgroundColor',
    image: 'options.lyricsWallpaperBackgroundImage',
    video: 'options.lyricsWallpaperBackgroundVideo',
};

type LyricsWallpaperSettingsSectionProps = {
    isDaylight: boolean;
};

const LyricsWallpaperSettingsSection: React.FC<LyricsWallpaperSettingsSectionProps> = ({
    isDaylight,
}) => {
    const { t } = useTranslation();
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

    // 歌词字体的来路：跟随播放页 / 单独指定。只有「单独」才需要那个选字体的按钮。
    const wallpaperLyricsFontMode = useVisualizerSettingsStore(
        state => state.wallpaperLyricsFontMode);
    const onSetWallpaperLyricsFontMode = useVisualizerSettingsStore(
        state => state.handleSetWallpaperLyricsFontMode);
    // 预览：在 App 里也把那层小窗挂出来（正常逻辑在 App 里不挂，设置页就什么都看不见）。
    const onSetWallpaperFloatingPreview = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingPreview);

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

    /*
     * 视频壁纸有没有上传。
     *
     * 视频是原生自己拷进私有目录的（几十 MB 不过桥），Web 侧拿不到内容，
     * 只能问一句「有没有」，用来决定按钮写「上传」还是「更换」。
     */
    const [hasVideo, setHasVideo] = useState(false);
    React.useEffect(() => {
        if (!isAndroid) return;
        let cancelled = false;
        void queryWallpaperVideo().then((has) => {
            if (!cancelled) setHasVideo(has);
        });
        return () => {
            cancelled = true;
        };
    }, [isAndroid, lyricsWallpaperBackground]);

    const handlePickVideo = async () => {
        const result = await pickWallpaperVideo();
        if (result === 'applied') setHasVideo(true);
    };

    const handleClearVideo = async () => {
        await removeWallpaperVideo();
        setHasVideo(false);
    };

    const handleOpenWallpaperPicker = () => {
        void openLyricsWallpaperPicker().then((outcome) => {
            /*
             * 以前这里不看结果，没权限时点按钮毫无反应。
             * 现在把结果告诉用户：进了系统设置就说明去放行，压根打不开也要说一声。
             */
            if (outcome === 'needsPermission') {
                setWallpaperPickerNotice('settings');
            } else if (outcome === 'unavailable') {
                setWallpaperPickerNotice('unavailable');
            } else if (outcome === 'alreadyActive') {
                setWallpaperPickerNotice('active');
            }
        });
        // 系统选择器要用户手动确认，返回后状态才变，延后复查一次。
        window.setTimeout(() => {
            void isLyricsWallpaperActive().then(setIsWallpaperActive);
        }, 3000);
    };

    /** 打开选择器之后的提示：没权限时要明确告诉用户去授权。 */
    const [wallpaperPickerNotice, setWallpaperPickerNotice] = useState<'settings' | 'unavailable' | 'active' | null>(null);

    // 字体是原生落在私有目录里的文件，应用这边只缓存一个「有没有」用于按钮文案。
    const [hasWallpaperFont, setHasWallpaperFont] = useState(false);
    const [fontNotice, setFontNotice] = useState<'applied' | 'appliedAppOnly' | 'rejected' | null>(null);

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

    /*
     * 预览：只要这一页挂着，就让原生那层悬浮小窗**在 App 里也显示出来**。
     *
     * 正常逻辑是「在应用里就不挂」（怕盖着自己的界面、播放页本来就有歌词），
     * 但调这些位置 / 大小 / 避开区域的滑条恰恰是在 App 里做的 —— 不开预览的话，
     * 拖到底屏幕上也一点反应都没有（「看不到预览界面」）。
     * 这一页是按 section 条件渲染的，卸载 = 离开设置页，预览随之关掉。
     */
    React.useEffect(() => {
        onSetWallpaperFloatingPreview(true);
        return () => {
            onSetWallpaperFloatingPreview(false);
        };
    }, [onSetWallpaperFloatingPreview]);

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

    /*
     * 从字体市场挑一款。
     *
     * 字体市场现在是 ZeoSeven 的切片 WebFont：它按 unicode-range 拆成几百个 woff2，
     * 由浏览器按需下发。网页侧（App 界面、歌词）直接就能用，效果立刻可见。
     *
     * 但**壁纸与叠层那两层是原生自绘的**，它们要的是一个完整字体文件（base64 推下去落盘），
     * 而切片字体拼不出整包 —— 所以那里用不了市场字体。这种情况下不假装成功：把提示
     * 换成「已在应用内生效，壁纸请用本地字体文件」，而不是静默传个空串让壁纸回落到系统字体。
     */
    const dividerClass = settingsDividerClassFor(isDaylight);

    /* 非安卓平台整节不渲染 —— 放在 hooks 之后，订阅顺序才稳定。 */
    if (!isAndroid) return null;

    /*
     * 自己不再画标题、也不画卡：外观页用 kit 的 Group 把整节包成**独立的一张卡**
     * （跟上面「歌词动画样式」那张分开），标题由 Group 画。原来这里自己照着
     * Group 的标题画了一个 h3 还带一颗 Wallpaper 图标 —— 别的组标题都没有图标，
     * 这颗也就一并去了。
     */
    return (
        <div>
            <SettingsRow
                option={WALLPAPER.apply}
                    control={(
                        <Button onClick={handleOpenWallpaperPicker}>
                            {isWallpaperActive
                                ? t('options.lyricsWallpaperActive')
                                : t('options.lyricsWallpaperSet')}
                        </Button>
                    )}
                    dividerClass={dividerClass}
                >
                    {/* 提示挂在「设为壁纸」这一行内部，不另起一块 ——
                        之前插成独立 div 会把下面的「样式」整行顶下去，看着像错位。 */}
                    {wallpaperPickerNotice && (
                        <p className="mt-1.5 text-[12px] leading-5 text-[var(--st-t2)]">
                            {wallpaperPickerNotice === 'settings'
                                ? t('options.lyricsWallpaperNeedPermission')
                                : wallpaperPickerNotice === 'active'
                                    ? t('options.lyricsWallpaperAlreadyActive')
                                    : t('options.lyricsWallpaperPickerUnavailable')}
                        </p>
                    )}
                </SettingsRow>
                <SettingsRow
                    option={WALLPAPER.style}
                    description={lyricsWallpaperStyle === 'minimal'
                        ? t('options.lyricsWallpaperStyleMinimalDesc')
                        : t('options.lyricsWallpaperStyleDesc')}
                    dividerClass={dividerClass}
                    control={(
                        <Segmented
                            value={lyricsWallpaperStyle}
                            options={[
                                { value: 'minimal', label: t('options.lyricsWallpaperStyleMinimal') },
                                { value: 'follow', label: t('options.lyricsWallpaperStyleFollow') },
                            ]}
                            onChange={onSetLyricsWallpaperStyle}
                        />
                    )}
                />
                {/* 精简模式下歌词是那颗可以拖的小窗，拖到角落 / 缩到最小又上了锁之后
                    光靠手势弄不回来，所以这里给一颗「重置」当出口。 */}
                <Reveal when={lyricsWallpaperStyle === 'minimal'}>
                    <LyricsWallpaperFloatingRows isDaylight={isDaylight} />
                </Reveal>
                <LyricsWallpaperOverlayRows isDaylight={isDaylight} />
                <SettingsRow
                    option={WALLPAPER.background}
                    dividerClass={dividerClass}
                    control={(
                        <Segmented
                            value={lyricsWallpaperBackground}
                            options={(['cover', 'color', 'image', 'video'] as const).map(mode => ({
                                value: mode,
                                label: t(BACKGROUND_LABEL_KEYS[mode]),
                            }))}
                            onChange={onSetLyricsWallpaperBackground}
                        />
                    )}
                >
                    <Reveal when={lyricsWallpaperBackground === 'image'}>
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
                                <Button onClick={() => imageInputRef.current?.click()}>
                                    {t('options.lyricsWallpaperPickImage')}
                                </Button>
                                {lyricsWallpaperImage && (
                                    <UiButton
                                        onClick={() => {
                                        onSetLyricsWallpaperImage(null);
                                        void clearWallpaperBackgroundImage();
                                    }}
                                        className="block text-xs opacity-60 hover:opacity-100"
                                        style={{ color: 'var(--text-secondary)' }}
                                    >
                                        {t('options.lyricsWallpaperClearImage')}
                                    </UiButton>
                                )}
                                <TextField
                                    ref={imageInputRef}
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={handleWallpaperImagePick}
                                />
                            </div>
                        </div>
                    </Reveal>
                    <Reveal when={lyricsWallpaperBackground === 'video'}>
                        <div className="mt-3 flex items-center gap-3">
                            <div
                                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border"
                                style={{ borderColor: 'var(--text-secondary)' }}
                            >
                                <Video className="h-6 w-6 opacity-60" />
                            </div>
                            <div className="space-y-2">
                                <Button onClick={() => void handlePickVideo()}>
                                    {t(hasVideo
                                        ? 'options.lyricsWallpaperReplaceVideo'
                                        : 'options.lyricsWallpaperPickVideo')}
                                </Button>
                                {/* 视频背景旁边给市场入口：视频才有「横屏进竖屏」的裁切需求。 */}
                                <MarketEntryButton tab="background" />
                                {hasVideo && (
                                    <UiButton
                                        onClick={() => void handleClearVideo()}
                                        className="block text-xs opacity-60 hover:opacity-100"
                                        style={{ color: 'var(--text-secondary)' }}
                                    >
                                        {t('options.lyricsWallpaperClearVideo')}
                                    </UiButton>
                                )}
                                <p className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                    {t('options.lyricsWallpaperVideoDesc')}
                                </p>
                            </div>
                        </div>
                    </Reveal>
                </SettingsRow>
                <SettingsRow
                    option={WALLPAPER.blur}
                    dividerClass={dividerClass}
                >
                    <div className="space-y-3">
                        <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-secondary)' }}>
                            <span className="opacity-60">{t('options.lyricsWallpaperBlurValue')}</span>
                            <span className="font-mono opacity-70">{Math.round(lyricsWallpaperBlur * 100)}%</span>
                        </div>
                        <RangeInput
                            min={0}
                            max={100}
                            step={5}
                            value={Math.round(lyricsWallpaperBlur * 100)}
                            onChange={value => onSetLyricsWallpaperBlur(value / 100)}
                            ariaLabel={t('options.lyricsWallpaperBlurValue')}
                        />
                    </div>
                </SettingsRow>
                <SettingsRow
                    option={WALLPAPER.progress}
                    control={<Toggle checked={lyricsWallpaperProgress} onChange={onToggleLyricsWallpaperProgress} />}
                    dividerClass={dividerClass}
                />
                <SettingsRow
                    option={WALLPAPER.translation}
                    control={<Toggle checked={lyricsWallpaperTranslation} onChange={onToggleLyricsWallpaperTranslation} />}
                    dividerClass={dividerClass}
                />
                {/* 字体来路：跟随播放页 / 单独指定。选「单独」才有下面那个选字体的按钮。 */}
                <SettingsRow
                    option={WALLPAPER.fontMode}
                    dividerClass={dividerClass}
                    control={(
                        <Segmented
                            value={wallpaperLyricsFontMode}
                            options={[
                                { value: 'follow', label: t('options.lyricsWallpaperFontFollow') },
                                { value: 'custom', label: t('options.lyricsWallpaperFontCustom') },
                            ]}
                            onChange={onSetWallpaperLyricsFontMode}
                        />
                    )}
                />
                <Reveal when={wallpaperLyricsFontMode === 'custom'}>
                    <SettingsRow
                        option={WALLPAPER.font}
                        control={(
                            <div className="flex shrink-0 items-center gap-1.5">
                                <Button onClick={() => void handlePickWallpaperFont()}>
                                    {hasWallpaperFont
                                        ? t('options.lyricsWallpaperReplaceFont')
                                        : t('options.lyricsWallpaperPickFont')}
                                </Button>
                                {/* 字体旁边给市场入口，和设置里的「市场」是同一个面板。 */}
                                <MarketEntryButton tab="font" />
                            </div>
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
                                    : fontNotice === 'appliedAppOnly'
                                        ? t('options.lyricsWallpaperFontAppliedAppOnly')
                                        : fontNotice === 'rejected'
                                            ? t('options.lyricsWallpaperFontFailed')
                                            : ''}
                            </span>
                            {hasWallpaperFont && (
                                <UiButton
                                    onClick={handleClearWallpaperFont}
                                    className="text-xs opacity-60 hover:opacity-100"
                                    style={{ color: 'var(--text-secondary)' }}
                                >
                                    {t('options.lyricsWallpaperClearFont')}
                                </UiButton>
                            )}
                        </div>
                    </SettingsRow>
                </Reveal>
                <SettingsRow
                    option={WALLPAPER.feed}
                    control={<Toggle checked={lyricsWallpaperFeed} onChange={onToggleLyricsWallpaperFeed} />}
                    dividerClass={dividerClass}
                    isLast
                />
        </div>
    );
};

export default LyricsWallpaperSettingsSection;
