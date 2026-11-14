import type { VisualizerMode } from '../types';

// src/platform/wallpaperVisualizerTuning.ts
// 把「歌词动画实验台」里当前生效那个模式的配置，摊平成一张键值表发给壁纸。
//
// 为什么是键值表：十几个模式合计一百多项，逐个做成桥上的字段的话，
// 每加一项都要改 TS 接口、Java 插件方法、原生状态类、还有落盘格式。
// 摊平之后四者只需要一张 map；同一时刻只有一个模式在渲染，
// 所以不同模式的同名字段（比如都叫 glowIntensity）不会打架。

/** 模式 → store 里存放它那份 tuning 的字段名。 */
const TUNING_FIELD: Record<string, string> = {
    sonnet: 'sonnetTuning',
    tempera: 'temperaTuning',
    lumiere: 'lumiereTuning',
    classic: 'classicTuning',
    cadenza: 'cadenzaTuning',
    partita: 'partitaTuning',
    fume: 'fumeTuning',
    claddagh: 'claddaghTuning',
    cappella: 'cappellaTuning',
    tilt: 'tiltTuning',
    diorama: 'dioramaTuning',
    monet: 'monetTuning',
    pendolo: 'pendoloTuning',
};

/** 字符串枚举在这里翻成序号：桥上不传字符串，省得原生还要记枚举表。 */
const OUTER_FRAME_INDEX: Record<string, number> = {
    none: 0,
    minimal: 1,
    full: 2,
};

/** 模式 → store 里存放它那份 tuning 的字段名。找不到的模式（静止等）返回 null。 */
export const tuningFieldFor = (mode: VisualizerMode | string | null | undefined): string | null => {
    if (!mode) return null;
    return TUNING_FIELD[mode] ?? null;
};

/**
 * 把某个模式那份 tuning 摊平成 number map。
 *
 * 值一律压成 number：布尔开关当 0/1、字符串枚举按上面的表翻成序号、
 * 其余数字原样带走。拿不到的字段不进表 —— 原生那边缺项自然退到默认值。
 *
 * 这里必须返回 store 里的原始对象引用（zustand 用 Object.is 比较），
 * 摊平要放在 useMemo 里做 —— 直接在 selector 里摊平的话每次都是新对象，
 * 会触发无限重渲染。
 */
export const flattenTuning = (raw: unknown): Record<string, number> | null => {
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            out[key] = value;
        } else if (typeof value === 'boolean') {
            out[key] = value ? 1 : 0;
        } else if (typeof value === 'string') {
            const index = OUTER_FRAME_INDEX[value];
            if (index !== undefined) out[key] = index;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
};

/**
 * 应用侧「视觉设置」里那几个跟背景有关的全局开关。
 *
 * 它们不属于某个歌词动画模式，但跟随模式要连它们一起跟随，
 * 所以也塞进同一张表 —— 用 `wp.` 前缀和 per-mode 字段区分开。
 */
export const WALLPAPER_GLOBAL_KEYS = {
    backgroundOpacity: 'wp.backgroundOpacity',
    vignetteDisabled: 'wp.vignetteDisabled',
    geometricDisabled: 'wp.geometricDisabled',
    /** 叠层整体窗口的不透明度。 */
    overlayOpacity: 'wp.overlayOpacity',
    /**
     * 「精简」样式那颗悬浮歌词小窗的底色不透明度。
     *
     * 单独一个 key：小窗是另一层系统窗口，底色浓淡跟壁纸背景（backgroundOpacity）
     * 和跟随样式那层 WebView 叠层（overlayOpacity）都无关，共用只会两头对不上。
     */
    floatingBackgroundOpacity: 'wp.floatingBackgroundOpacity',
    /**
     * 「精简」样式那颗小窗直接叠在安全区（状态栏那一条）上面。
     *
     * 开之后小窗贴在屏幕最顶上（y = 0），高度方向不再参与摆放，只给左右；
     * 关着时它还是那个能上下左右拖的桌面小窗。
     */
    floatingOverSafeArea: 'wp.floatingOverSafeArea',
    /** 叠加模式下小窗的左右位置（0 = 贴左，1 = 贴右）。只在这个开关打开时生效。 */
    floatingOffsetX: 'wp.floatingOffsetX',
    /**
     * 叠加模式下小窗占屏幕宽度的比例。
     *
     * 用比例而不是 dp：这个模式要的是「占住状态栏这一条的多宽」，说百分比比说像素直观，
     * 换设备也不会变样。比一半还窄的话每句都要靠横向滚动才看得完，所以下限 0.5。
     */
    floatingWidth: 'wp.floatingWidth',
    /**
     * 开关：叠加安全区时直接**占满整条**（左右滑条和宽度滑条都让位）。
     * 非竖屏时原生那边不认这一条，退回宽度滑条给的宽。
     */
    floatingFillSafeArea: 'wp.floatingFillSafeArea',
    /**
     * 占满时留出的「避开区域」宽度（占整条宽的比例）。0 = 不避让。
     *
     * 挖孔屏 / 刘海屏那条状态栏中间或某一侧有个洞，字压上去就成了「被切了一块」。
     * 各家 ROM 都不往外报挖孔位置，只能让用户自己指：多宽、在哪边。
     */
    floatingAvoidWidth: 'wp.floatingAvoidWidth',
    /** 避开区域的左右位置（0 = 贴左，1 = 贴右）。 */
    floatingAvoidOffsetX: 'wp.floatingAvoidOffsetX',
    /*
     * 「设置页正开着」这个预览标记**不在这一张表里**。
     *
     * 这张表是原生要**落盘**的那一份（WallpaperLyricsState → SharedPreferences），
     * 而预览是会话内的瞬时状态：混进来就等于「应用被杀一次就永久卡在开」。
     * 它现在走独立通道 FoliaWallpaper.setFloatingPreview（带租约、不落盘），
     * 见 foliaWallpaper.ts 里 setWallpaperFloatingPreview 上方那段。
     */
    /** 字号模式：0 = 动态（跟着窗口高度算），1 = 自定义。 */
    floatingFontSizeMode: 'wp.floatingFontSizeMode',
    /** 自定义模式的字号（dp）。只在上面那个开关打开时用。 */
    floatingFontSize: 'wp.floatingFontSize',
    /** 歌词字体是否走「单独指定」的那份（0 = 跟随播放页，不给原生两层覆盖字体）。 */
    lyricsFontCustom: 'wp.lyricsFontCustom',
    /** 叠层总开关。关掉就一层都不挂。 */
    overlayEnabled: 'wp.overlayEnabled',
    /** 音乐锁屏：锁屏之上也挂叠层。 */
    showOnLockScreen: 'wp.showOnLockScreen',
    /** 叠层只在锁屏上出现：桌面 / 所有应用 / App 内一律不挂。 */
    overlayLockScreenOnly: 'wp.overlayLockScreenOnly',
    /** 叠层是否在所有应用之上显示。 */
    overlayAllApps: 'wp.overlayAllApps',
    /** 跟随 + 叠层时隐藏原生那层歌词。 */
    hideNativeLyrics: 'wp.hideNativeLyrics',
    /** 跟随 + 叠层时隐藏原生那层的进度条。 */
    hideNativeProgress: 'wp.hideNativeProgress',
    /** 纯音乐（没有歌词）时不显示叠层。 */
    skipInstrumental: 'wp.skipInstrumental',
    /** 暂停时自动隐藏叠层。 */
    hideWhenPaused: 'wp.hideWhenPaused',
    /** 歌词唱完之后（长尾奏）自动隐藏叠层。 */
    hideAfterLyricsEnd: 'wp.hideAfterLyricsEnd',
    /**
     * 「和外观有关的那几个 store 变了」的计数。
     *
     * 叠层是**另一个 WebView**，它里面那份 store 只在页面加载那一刻读过一次 localStorage。
     * 主 WebView 改了「歌词动画实验台」里的参数，写的是主上下文的存储 ——
     * 两边没有同步机制，已经挂着的那一页永远看不到这次改动，
     * 用户看到的就是「App 里改了、叠层没反应」。
     *
     * 值只要变了就让原生那边的全局开关散列表跟着变，
     * `reloadOnTuningChange` 会把页面重载一份 —— 新页面重新读存储，改动就到位了。
     */
    settingsStamp: 'wp.settingsStamp',
    /*
     * 背景图/视频的裁切位置。
     *
     * 壁纸站上多是横屏图，手机是竖屏，cover 之后必然裁掉一段，居中常裁到主体。
     * 这两项让用户拖框决定保留哪一块（0 = 留左/上，0.5 = 居中，1 = 留右/下）。
     * 图片在下载时就裁好了，视频走渲染时的 UV 裁切 —— 所以视频这边必须下发。
     */
    imageFocusX: 'wp.imageFocusX',
    imageFocusY: 'wp.imageFocusY',
    /**
     * 视频背景的旋转角度（0 / 90 / 180 / 270）。
     *
     * 视频不能像图片那样在下载时重编码（几十 MB 转一遍太慢），
     * 所以角度只记录，由原生在画的时候转 —— 这张表就是把它送过去的通道。
     */
    videoRotation: 'wp.videoRotation',
} as const;

export const withGlobalSettings = (
    tuning: Record<string, number> | null,
    settings: Record<string, unknown>,
): Record<string, number> => {
    const out: Record<string, number> = { ...(tuning ?? {}) };
    /*
     * 视频背景的旋转每次都带上。
     *
     * tuning 是整体下发的：这次不带，原生那份就会被覆盖成「没转过」——
     * 表现就是重启（或改任何别的设置）之后旋转自己回去了。
     */
    const videoRotation = settings.wallpaperVideoRotation;
    if (typeof videoRotation === 'number' && Number.isFinite(videoRotation)) {
        out[WALLPAPER_GLOBAL_KEYS.videoRotation] = videoRotation;
    }
    const stamp = settings.settingsStamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp)) {
        out[WALLPAPER_GLOBAL_KEYS.settingsStamp] = Math.abs(Math.trunc(stamp)) % 1000000;
    }
    const opacity = settings.backgroundOpacity;
    if (typeof opacity === 'number' && Number.isFinite(opacity)) {
        out[WALLPAPER_GLOBAL_KEYS.backgroundOpacity] = opacity;
    }
    out[WALLPAPER_GLOBAL_KEYS.vignetteDisabled] = settings.disableVisualizerVignette ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.geometricDisabled] =
        settings.disableVisualizerGeometricBackground ? 1 : 0;
    const overlayOpacity = settings.wallpaperOverlayOpacity;
    if (typeof overlayOpacity === 'number' && Number.isFinite(overlayOpacity)) {
        out[WALLPAPER_GLOBAL_KEYS.overlayOpacity] = overlayOpacity;
    }
    const floatingOpacity = settings.wallpaperFloatingOpacity;
    if (typeof floatingOpacity === 'number' && Number.isFinite(floatingOpacity)) {
        out[WALLPAPER_GLOBAL_KEYS.floatingBackgroundOpacity] = floatingOpacity;
    }
    out[WALLPAPER_GLOBAL_KEYS.floatingOverSafeArea] =
        settings.wallpaperFloatingOverSafeArea ? 1 : 0;
    const floatingOffsetX = settings.wallpaperFloatingOffsetX;
    if (typeof floatingOffsetX === 'number' && Number.isFinite(floatingOffsetX)) {
        out[WALLPAPER_GLOBAL_KEYS.floatingOffsetX] = floatingOffsetX;
    }
    const floatingWidth = settings.wallpaperFloatingWidth;
    if (typeof floatingWidth === 'number' && Number.isFinite(floatingWidth)) {
        out[WALLPAPER_GLOBAL_KEYS.floatingWidth] = floatingWidth;
    }
    out[WALLPAPER_GLOBAL_KEYS.floatingFillSafeArea] =
        settings.wallpaperFloatingFillSafeArea ? 1 : 0;
    const floatingAvoidWidth = settings.wallpaperFloatingAvoidWidth;
    if (typeof floatingAvoidWidth === 'number' && Number.isFinite(floatingAvoidWidth)) {
        out[WALLPAPER_GLOBAL_KEYS.floatingAvoidWidth] = floatingAvoidWidth;
    }
    const floatingAvoidOffsetX = settings.wallpaperFloatingAvoidOffsetX;
    if (typeof floatingAvoidOffsetX === 'number' && Number.isFinite(floatingAvoidOffsetX)) {
        out[WALLPAPER_GLOBAL_KEYS.floatingAvoidOffsetX] = floatingAvoidOffsetX;
    }
    // 预览不在这张表里下发（见 WALLPAPER_GLOBAL_KEYS 里那段），它有自己的通道。
    out[WALLPAPER_GLOBAL_KEYS.lyricsFontCustom] =
        settings.wallpaperLyricsFontMode === 'follow' ? 0 : 1;
    out[WALLPAPER_GLOBAL_KEYS.floatingFontSizeMode] =
        settings.wallpaperFloatingFontSizeMode === 'custom' ? 1 : 0;
    const floatingFontSize = settings.wallpaperFloatingFontSize;
    if (typeof floatingFontSize === 'number' && Number.isFinite(floatingFontSize)) {
        out[WALLPAPER_GLOBAL_KEYS.floatingFontSize] = floatingFontSize;
    }
    out[WALLPAPER_GLOBAL_KEYS.overlayEnabled] = settings.wallpaperOverlayEnabled === false ? 0 : 1;
    out[WALLPAPER_GLOBAL_KEYS.showOnLockScreen] = settings.wallpaperOverlayLockScreen ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.overlayLockScreenOnly] = settings.wallpaperOverlayLockScreenOnly ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.overlayAllApps] = settings.wallpaperOverlayAllApps ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideNativeLyrics] = settings.wallpaperOverlayHideNativeLyrics ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideNativeProgress] = settings.wallpaperOverlayHideNativeProgress ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.skipInstrumental] = settings.wallpaperOverlaySkipInstrumental ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideWhenPaused] = settings.wallpaperOverlayHideWhenPaused ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideAfterLyricsEnd] = settings.wallpaperOverlayHideAfterLyricsEnd ? 1 : 0;
    return out;
};
