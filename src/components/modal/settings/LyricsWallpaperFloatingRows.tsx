import React from 'react';
import { useTranslation } from 'react-i18next';
import SettingsRow from './SettingsRow';
import { settingsDividerClassFor } from './settingsCardClasses';
import { Button, RangeInput, Reveal, Segmented, Toggle } from './kit';
import { WALLPAPER } from './pages/appearance/options';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { resetFloatingLyricsWindow } from '../../../platform/foliaWallpaper';

// src/components/modal/settings/LyricsWallpaperFloatingRows.tsx
// 「精简」样式下那颗悬浮歌词小窗的设置行：底色浓度、是否叠在安全区上、左右位置与宽度、
// 避开区域、字号，以及把它拖丢了之后的重置。从 LyricsWallpaperSettingsSection 拆出。

const LyricsWallpaperFloatingRows: React.FC<{ isDaylight: boolean }> = ({ isDaylight }) => {
    const { t } = useTranslation();
    const dividerClass = settingsDividerClassFor(isDaylight);
    // 这颗小窗自己的开关。以前它跟着「壁纸样式 = 精简」走，没有自己的开关，
    // 现在拆出来了：下面所有行都随它出现和收起。
    const wallpaperFloatingLyricsEnabled = useVisualizerSettingsStore(
        state => state.wallpaperFloatingLyricsEnabled);
    const onToggleWallpaperFloatingLyricsEnabled = useVisualizerSettingsStore(
        state => state.handleToggleWallpaperFloatingLyricsEnabled);
    // 「精简」样式那颗悬浮歌词小窗的底色浓度。单独一根滑条，不复用叠层那根。
    const wallpaperFloatingOpacity = useVisualizerSettingsStore(state => state.wallpaperFloatingOpacity);
    const onSetWallpaperFloatingOpacity = useVisualizerSettingsStore(state => state.handleSetWallpaperFloatingOpacity);
    // 小窗叠在安全区上面 + 叠加模式下的左右位置。
    const wallpaperFloatingOverSafeArea = useVisualizerSettingsStore(
        state => state.wallpaperFloatingOverSafeArea);
    const onToggleWallpaperFloatingOverSafeArea = useVisualizerSettingsStore(
        state => state.handleToggleWallpaperFloatingOverSafeArea);
    const wallpaperFloatingOffsetX = useVisualizerSettingsStore(
        state => state.wallpaperFloatingOffsetX);
    const onSetWallpaperFloatingOffsetX = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingOffsetX);
    const wallpaperFloatingWidth = useVisualizerSettingsStore(
        state => state.wallpaperFloatingWidth);
    const onSetWallpaperFloatingWidth = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingWidth);
    // 占满整条安全区 + 避开区域（宽度 / 左右位置）。
    const wallpaperFloatingFillSafeArea = useVisualizerSettingsStore(
        state => state.wallpaperFloatingFillSafeArea);
    const onToggleWallpaperFloatingFillSafeArea = useVisualizerSettingsStore(
        state => state.handleToggleWallpaperFloatingFillSafeArea);
    const wallpaperFloatingAvoidWidth = useVisualizerSettingsStore(
        state => state.wallpaperFloatingAvoidWidth);
    const onSetWallpaperFloatingAvoidWidth = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingAvoidWidth);
    const wallpaperFloatingAvoidOffsetX = useVisualizerSettingsStore(
        state => state.wallpaperFloatingAvoidOffsetX);
    const onSetWallpaperFloatingAvoidOffsetX = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingAvoidOffsetX);
    // 字号：动态（跟着窗口高度算）/ 自定义（自己指定 dp）。
    const wallpaperFloatingFontSizeMode = useVisualizerSettingsStore(
        state => state.wallpaperFloatingFontSizeMode);
    const onSetWallpaperFloatingFontSizeMode = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingFontSizeMode);
    const wallpaperFloatingFontSize = useVisualizerSettingsStore(
        state => state.wallpaperFloatingFontSize);
    const onSetWallpaperFloatingFontSize = useVisualizerSettingsStore(
        state => state.handleSetWallpaperFloatingFontSize);

    // 「重置悬浮窗」按完之后给个回执：小窗此刻多半不在屏幕上（应用在前台它就不挂），
    // 点了没反应会让人以为按钮坏了。
    const [floatingResetDone, setFloatingResetDone] = React.useState(false);

    const handleResetFloatingLyricsWindow = () => {
        void resetFloatingLyricsWindow();
        setFloatingResetDone(true);
        window.setTimeout(() => setFloatingResetDone(false), 2000);
    };

    return (
        <>
            {/* 小窗的独立开关。关掉之后下面整段都收起 —— 那些滑条调的是一个
                不存在的窗口，留着只会让人以为没生效。 */}
            <SettingsRow
                option={WALLPAPER.floatingEnabled}
                dividerClass={dividerClass}
                control={(
                    <Toggle checked={wallpaperFloatingLyricsEnabled} onChange={onToggleWallpaperFloatingLyricsEnabled} />
                )}
            />
            {/* 小窗的底色浓度。单独一根：它是另一层系统窗口，
                跟壁纸背景那根、叠层那根都无关。 */}
            <Reveal when={wallpaperFloatingLyricsEnabled}>
                <>
            <SettingsRow
                option={WALLPAPER.floatingOpacity}
                dividerClass={dividerClass}
                control={(
                    <div className="flex items-center gap-2">
                        {/* 下限 0：要的就是「只有字、没有底」，尤其叠在安全区上时。 */}
                        <RangeInput
                            min={0}
                            max={100}
                            step={5}
                            value={Math.round(wallpaperFloatingOpacity * 100)}
                            onChange={value => onSetWallpaperFloatingOpacity(value / 100)}
                            className="h-1 w-28 cursor-pointer accent-white"
                        />
                        <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                            {Math.round(wallpaperFloatingOpacity * 100)}%
                        </span>
                    </div>
                )}
            />
            {/* 叠在安全区上面：小窗贴到屏幕最顶上那一条（盖住状态栏），
                此时高度方向不再参与摆放，只给左右。 */}
            <SettingsRow
                option={WALLPAPER.floatingOverSafeArea}
                dividerClass={dividerClass}
                control={(
                    <Toggle checked={wallpaperFloatingOverSafeArea} onChange={onToggleWallpaperFloatingOverSafeArea} />
                )}
            />
            {/* 叠加模式下的左右位置。只给初值：原生那边拖过之后以拖出来的为准。
                占满整条时没有「左右」可言，那两根一起收起来。 */}
            {/*
                左右位置 / 宽度 / 避开区域这几行随开关出现和收起：一律走 Reveal，
                跟同页其它「依赖上一行」的行一样地展开 / 收起。之前是 `&&` 直接
                挂载，开关一拨整段就凭空消失，看着像界面抽了一下。
            */}
            <Reveal when={wallpaperFloatingOverSafeArea && !wallpaperFloatingFillSafeArea}>
                <SettingsRow
                    option={WALLPAPER.floatingOffsetX}
                    dividerClass={dividerClass}
                    control={(
                        <div className="flex items-center gap-2">
                            <RangeInput
                                min={0}
                                max={100}
                                step={5}
                                value={Math.round(wallpaperFloatingOffsetX * 100)}
                                onChange={value => onSetWallpaperFloatingOffsetX(value / 100)}
                                className="h-1 w-28 cursor-pointer accent-white"
                            />
                            <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                {Math.round(wallpaperFloatingOffsetX * 100)}%
                            </span>
                        </div>
                    )}
                />
            </Reveal>
            {/* 宽度：占屏幕宽度的比例。和左右位置那根一样，
                每次拖动都会立刻下发，小窗当场跟着变。占满时不参与。 */}
            <Reveal when={wallpaperFloatingOverSafeArea && !wallpaperFloatingFillSafeArea}>
                <SettingsRow
                    option={WALLPAPER.floatingWidth}
                    dividerClass={dividerClass}
                    control={(
                        <div className="flex items-center gap-2">
                            <RangeInput
                                min={50}
                                max={100}
                                step={5}
                                value={Math.round(wallpaperFloatingWidth * 100)}
                                onChange={value => onSetWallpaperFloatingWidth(value / 100)}
                                className="h-1 w-28 cursor-pointer accent-white"
                            />
                            <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                {Math.round(wallpaperFloatingWidth * 100)}%
                            </span>
                        </div>
                    )}
                />
            </Reveal>
            {/* 占满整条安全区：左右不再留空，宽度滑条也让位。
                横屏下原生那边不认这一条，自动退回宽度滑条给的宽。 */}
            <Reveal when={wallpaperFloatingOverSafeArea}>
                <SettingsRow
                    option={WALLPAPER.floatingFillSafeArea}
                    dividerClass={dividerClass}
                    control={(
                        <Toggle checked={wallpaperFloatingFillSafeArea} onChange={onToggleWallpaperFloatingFillSafeArea} />
                    )}
                />
            </Reveal>
            {/* 避开区域：挖孔 / 刘海那一块。字从它两边绕过去，不是被裁掉。 */}
            <Reveal when={wallpaperFloatingOverSafeArea && wallpaperFloatingFillSafeArea}>
                <>
                    <SettingsRow
                        option={WALLPAPER.floatingAvoidWidth}
                        dividerClass={dividerClass}
                        control={(
                            <div className="flex items-center gap-2">
                                <RangeInput
                                    min={0}
                                    max={50}
                                    step={2}
                                    value={Math.round(wallpaperFloatingAvoidWidth * 100)}
                                    onChange={value => onSetWallpaperFloatingAvoidWidth(value / 100)}
                                    className="h-1 w-28 cursor-pointer accent-white"
                                />
                                <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                    {Math.round(wallpaperFloatingAvoidWidth * 100)}%
                                </span>
                            </div>
                        )}
                    />
                    <SettingsRow
                        option={WALLPAPER.floatingAvoidOffsetX}
                        dividerClass={dividerClass}
                        control={(
                            <div className="flex items-center gap-2">
                                <RangeInput
                                    min={0}
                                    max={100}
                                    step={2}
                                    value={Math.round(wallpaperFloatingAvoidOffsetX * 100)}
                                    onChange={value => onSetWallpaperFloatingAvoidOffsetX(value / 100)}
                                    className="h-1 w-28 cursor-pointer accent-white"
                                />
                                <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                    {Math.round(wallpaperFloatingAvoidOffsetX * 100)}%
                                </span>
                            </div>
                        )}
                    />
                </>
            </Reveal>
            {/* 字号：动态 = 跟着窗口高度算（拖大窗口字就跟着大）；
                自定义 = 自己指定。默认动态。 */}
            <SettingsRow
                option={WALLPAPER.floatingFontSize}
                dividerClass={dividerClass}
                control={(
                    <Segmented
                        value={wallpaperFloatingFontSizeMode}
                        options={[
                            { value: 'dynamic', label: t('options.floatingLyricsFontSizeDynamic') },
                            { value: 'custom', label: t('options.floatingLyricsFontSizeCustom') },
                        ]}
                        onChange={onSetWallpaperFloatingFontSizeMode}
                    />
                )}
            />
    <Reveal when={wallpaperFloatingFontSizeMode === 'custom'}>
        <SettingsRow
            option={WALLPAPER.floatingFontSizeCustom}
                    dividerClass={dividerClass}
                    control={(
                        <div className="flex items-center gap-2">
                            <RangeInput
                                min={10}
                                max={32}
                                step={1}
                                value={Math.round(wallpaperFloatingFontSize)}
                                onChange={onSetWallpaperFloatingFontSize}
                                className="h-1 w-28 cursor-pointer accent-white"
                            />
                            <span className="w-9 text-right font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                {Math.round(wallpaperFloatingFontSize)}
                            </span>
            </div>
        )}
    />
    </Reveal>
    {/* 拖到角落 / 缩到最小又上了锁之后光靠手势弄不回来，
                所以这里给一颗「重置」当出口。 */}
            <SettingsRow
                option={WALLPAPER.floatingWindow}
                dividerClass={dividerClass}
                control={(
                    <Button onClick={handleResetFloatingLyricsWindow}>
                        {floatingResetDone
                            ? t('options.floatingLyricsResetDone')
                            : t('options.floatingLyricsReset')}
                    </Button>
                )}
            />
                </>
            </Reveal>
        </>
    );
};

export default LyricsWallpaperFloatingRows;
