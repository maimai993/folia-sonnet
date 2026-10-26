import { registerPlugin } from '@capacitor/core';

// src/platform/foliaWallpaper.ts
// 歌词动态壁纸的 Web 侧入口。原生实现见 android/.../wallpaper/LyricsWallpaperService。

export interface FoliaWallpaperTimelineWord {
    /** 片段文本（一个词，或中文的一个字）。 */
    text: string;
    /** 起始毫秒。 */
    start: number;
    /** 结束毫秒。 */
    end: number;
}

export interface FoliaWallpaperTimelineEntry {
    /** 歌词文本。 */
    text: string;
    /** 起始毫秒。 */
    start: number;
    /** 结束毫秒。 */
    end: number;
    /** 翻译行。没有就整个字段不传 —— 传空串会让原生分不清「没翻译」和「翻译是空的」。 */
    translation?: string;
    /**
     * 逐字（逐词）时间轴。
     *
     * 叠层之前只有整行的起止，于是整行被当成一个「词」渲染 —— 后果有两个：
     * 歌词是**整一段**冒出来的（播放器里是一个字一个字推进的），以及 AI 主题的
     * 关键词着色会命中这唯一那个 token、**整行都染成高亮色**。播放器那里
     * 用的就是同一份 `Line.words`，所以这里把它原样带下来即可。
     *
     * 只有 > 1 段时才下发：一段等于整行，传了跟没传一样。
     * 这份数据体积不小（几百行×十几段），但 publish 只在换歌时走整条轴，
     * 心跳只带 positionMs，所以不在热路径上。
     */
    words?: FoliaWallpaperTimelineWord[];
}

/**
 * 壁纸背景：模糊封面 / 主题色渐变 / 自选图片 / 视频。
 *
 * 'video' 那一档只在**原生系统动态壁纸**上生效（GLES 里用 MediaPlayer 解码画到
 * Surface 上），不走 Web 叠层 —— 视频过不了桥，也没有必要过。
 */
export type FoliaWallpaperBackgroundMode = 'cover' | 'color' | 'image' | 'video';

export interface FoliaWallpaperPublishOptions {
    /** 整条时间轴。只在换歌时发一次；之后原生自己按墙钟推进。 */
    timeline?: FoliaWallpaperTimelineEntry[];
    /** 当前播放位置（毫秒）。与 timeline 一起发时作为时间锚点。 */
    positionMs?: number;
    playing?: boolean;
    title?: string;
    artist?: string;
    /** 主题色，形如 #7c5cff。 */
    accent?: string;
    /** App 当前主题的底色，形如 #09090b。 */
    backgroundColor?: string;
    /**
     * App 当前主题的**主文本色**。
     *
     * 叠层页面（另一个 WebView）的主题是拿内置主题打底、只覆盖高亮色和底色搭出来的，
     * 主文本色因此永远是内置主题的 —— AI / 自定义主题换上去，歌词颜色一点没变。
     * 这两个颜色单独下发，叠层才可能跟 App 用同一套配色。
     */
    primaryColor?: string;
    /** App 当前主题的次色（未唱到的那些行、辅助文本）。 */
    secondaryColor?: string;
    /**
     * App 当前**整份主题**的 JSON。
     *
     * 只推四个颜色是不够的：AI 主题的辨识度往往不在颜色上 ——
     * `wordColors`（给指定的词单独上色）和 `lyricsIcons`（可视化里飘的那些图标）
     * 这类字段一个都传不过去，叠层画出来就只有配色变了，「AI 主题效果」一点没有。
     * 按字段一个个加永远补不全（每加一项就漏一项），所以整份序列化推下来，
     * 叠层拿它当打底主题，再套上单独推的颜色（那几个要走平滑过渡）。
     */
    themeJson?: string;
    /** 动效强度倍数：calm 0.6 / normal 1.0 / chaotic 1.5。 */
    motion?: number;
    /** 封面 base64。体积大，只在换歌时发。 */
    cover?: string | null;
    /**
     * 封面的**原始地址**。
     *
     * 叠层的封面之前只能靠上面那份 base64：它是 App 用 canvas 抓图转出来的，
     * 一旦那一首没转成（跨域 / 解码失败 / 图还没到），原生这边 `cover` 就不动，
     * 叠层就一直挂着上一首的封面 —— 表现是「换歌封面不更新」。
     *
     * 带上地址之后叠层可以直接 `<img>` 去拉（img 不受 CORS 约束），
     * 每首歌地址都在变，所以封面一定会跟着换；base64 那份留着当兜底
     * （已经下载好了，断网也能显示）。
     */
    coverUrl?: string | null;
    /** 背景模式：cover = 模糊封面，color = 主题色渐变，image = 自选图片。 */
    background?: FoliaWallpaperBackgroundMode;
    /** 自选背景图的 base64，background=image 时生效。 */
    image?: string | null;
    /** App 当前可视化模式，决定壁纸动画风格。 */
    visualizer?: string;
    /** 背景模糊强度 0..1。0 = 完全清晰，1 = 糊到只剩色块。 */
    blur?: number;
    /** 是否在歌词上方显示整首歌的进度条。 */
    progress?: boolean;
    /** 是否在主行下面再画一行翻译。歌词本身没翻译时不会因此多出空行。 */
    translation?: boolean;
    /**
     * 歌词动画实验台里当前那个模式的配置，摊平成 { 字段名: number }。
     * 布尔开关是 0/1，字符串枚举已翻成序号。
     */
    tuning?: Record<string, number> | null;
    /** 整首歌时长（毫秒），画进度条用。传 0 / 不传就不画。 */
    durationMs?: number;
}

export interface FoliaWallpaperAppearance {
    background?: FoliaWallpaperBackgroundMode;
    image?: string | null;
    visualizer?: string;
    blur?: number;
    progress?: boolean;
    translation?: boolean;
    tuning?: Record<string, number> | null;
    durationMs?: number;
}

interface FoliaWallpaperPlugin {
    publish(options: FoliaWallpaperPublishOptions): Promise<void>;
    setAppearance(options: FoliaWallpaperAppearance): Promise<void>;
    clearImage(): Promise<void>;
    /** 打开系统文件选择器挑字体；原生自己拷贝，不走 base64。 */
    pickFont(): Promise<{ picked: boolean; rejected?: boolean }>;
    getFont(): Promise<{ font: boolean }>;
    /** font 传 null / 空串 = 清除，回落到系统字体。 */
    setFont(options: { font: string | null }): Promise<void>;
    /** 「跟随播放页」用：把播放页那个字体的字节（base64）托管给原生。null = 清除。 */
    setFollowFont(options: { font: string | null }): Promise<void>;
    /**
     * 开 / 关「精简小窗」的预览。
     *
     * 不走 setAppearance 那张 tuning 表：那张表是落盘的，而预览是瞬时状态。
     * 见 setWallpaperFloatingPreview 上方那段。
     */
    setFloatingPreview(options: { on: boolean }): Promise<void>;
    getBackground(): Promise<{ mode: FoliaWallpaperBackgroundMode }>;
    /**
     * 把「简易」样式那颗悬浮歌词小窗恢复默认（位置 / 大小 / 锁一起清掉）。
     * 见 FloatingLyricsOverlay.resetLayout。
     */
    resetFloatingLyrics(): Promise<void>;
    clear(): Promise<void>;
    /** 心跳：只刷新「播放管线还活着」的时间戳，见 wallpaperHeartbeat。 */
    heartbeat(): Promise<void>;
    isActive(): Promise<{ active: boolean }>;
    openPicker(): Promise<{ opened: boolean }>;
    /** 壁纸的可视化叠层要 SYSTEM_ALERT_WINDOW，没授权时它是静默不工作的。 */
    hasOverlayPermission(): Promise<{ granted: boolean }>;
    openOverlaySettings(): Promise<void>;
    pickVideo(): Promise<{ picked: boolean; rejected?: boolean }>;
    getVideo(): Promise<{ has: boolean }>;
    clearVideo(): Promise<void>;
    getLockScreenStatus(): Promise<{
        started: boolean;
        blocked: boolean;
        hosted: boolean;
        attempts: number;
        error?: string;
        /** ROM 标签（"ColorOS 14"）。空串 = 不是 ColorOS 系。 */
        rom?: string;
        /** 悬浮窗权限：Android 14 上它是后台启动 Activity 的主要豁免来源。 */
        overlayGranted?: boolean;
    }>;
    /** 跳到 ROM 那几道开关的页面。见 RomPermissionGuide。 */
    openRomPermission(options: { target: string }): Promise<{ opened: boolean }>;
    /** 叠层最近做了什么（新的在前）。见 WallpaperOverlay.noteOverlayEvent。 */
    getOverlayEventLog(): Promise<{ events: string[] }>;
}

/** 音乐锁屏页的自诊断结果。见 WallpaperOverlay.LockScreenStatus。 */
export interface WallpaperLockScreenStatus {
    /** 锁屏页成功起来过（本次或上一次都算）。 */
    started: boolean;
    /** 试了几次都被系统挡回来了：基本可以确定是后台启动限制 / ROM 的「锁屏显示」开关。 */
    blocked: boolean;
    /** 此刻正挂在锁屏页上（叠层画在它上面）。 */
    hosted: boolean;
    attempts: number;
    error?: string;
    /** 上一次为什么退出（中文，直接显示给用户）。 */
    lastExit?: string;
    /** ROM 标签（"ColorOS 14"）；空串 = 不是 ColorOS 系。 */
    rom?: string;
    /** 悬浮窗权限。Android 14 起它是后台启动 Activity 的主要豁免来源。 */
    overlayGranted?: boolean;
}

const FoliaWallpaper = registerPlugin<FoliaWallpaperPlugin>('FoliaWallpaper');

export const publishLyricsWallpaper = async (
    options: FoliaWallpaperPublishOptions,
): Promise<void> => {
    try {
        await FoliaWallpaper.publish(options);
    } catch {
        // 壁纸没启用或插件不可用时静默失败：它不该影响播放本身。
    }
};

export const setWallpaperAppearance = async (
    options: FoliaWallpaperAppearance,
): Promise<void> => {
    try {
        await FoliaWallpaper.setAppearance(options);
    } catch {
        // 同上。
    }
};

/**
 * 心跳：告诉原生「这条播放管线还活着」。
 *
 * 什么都不推、什么都不改，只刷新壁纸那边的心跳时间戳。停了（App 被划掉后台 /
 * WebView 死透）之后，壁纸与两层叠层超时就只画背景，不再画没人听的歌词和进度条。
 * 前台由这里的定时器发；退到后台 JS 定时器被挂起，由播放服务接管（见
 * FoliaPlaybackService 的 heartbeatTick）—— 音频还在放，歌词就得继续走。
 */
export const wallpaperHeartbeat = async (): Promise<void> => {
    try {
        await FoliaWallpaper.heartbeat();
    } catch {
        // 同上。
    }
};

/** 清除壁纸的自选背景图（同时删掉原生那边的落盘副本）。 */
export const clearWallpaperBackgroundImage = async (): Promise<void> => {
    try {
        await FoliaWallpaper.clearImage();
    } catch {
        // 同上。
    }
};

export type WallpaperFontPickResult = 'applied' | 'rejected' | 'cancelled';

/**
 * 打开系统文件选择器给壁纸歌词挑一个 .ttf / .otf。
 *
 * 字体文件几 MB，不经过 JS：原生拿到 URI 自己拷进私有目录，这里只拿回结果。
 * rejected 表示用户确实选了文件，但那不是个能用的字体 —— 要跟「取消」区分开提示。
 */
export const pickWallpaperFont = async (): Promise<WallpaperFontPickResult> => {
    try {
        const result = await FoliaWallpaper.pickFont();
        if (result?.picked) return 'applied';
        return result?.rejected ? 'rejected' : 'cancelled';
    } catch {
        return 'cancelled';
    }
};

/** 壁纸歌词当前是否已经选过字体（重启后依然成立，因为字体是落在磁盘上的文件）。 */
export const hasWallpaperFont = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.getFont();
        return Boolean(result?.font);
    } catch {
        return false;
    }
};

/**
 * 把「简易」样式那颗悬浮歌词小窗恢复默认。
 *
 * 小窗是靠角上的把手拖 / 改的：拖到屏幕角落、或者缩到最小又上了锁之后，
 * 光靠手势很难弄回来（锁只画一个很小的图标，看不出能点），所以设置里要留一颗按钮。
 */
export const resetFloatingLyricsWindow = async (): Promise<void> => {
    try {
        await FoliaWallpaper.resetFloatingLyrics();
    } catch {
        // 同上：桌面端 / 老版本原生没有这个方法，静默即可。
    }
};

/**
 * 「跟随播放页」用：把播放页那个字体的字节托管给原生。
 *
 * 播放页的歌词字体是网页侧用 FontFace 注册的（字节在 IndexedDB 里），
 * 原生那两层是自绘的、读不到它 —— 只能由网页把字节推下去落盘。
 * 传 null 表示「播放页没设自定义字体」，原生回落系统字体。
 */
export const pushLyricsFontToNative = async (base64: string | null): Promise<void> => {
    try {
        await FoliaWallpaper.setFollowFont({ font: base64 });
    } catch {
        // 桌面端 / 老版本原生没有这个方法，静默。
    }
};

/*
 * 开 / 关「精简小窗」的预览。前端在设置页期间要**定期续约**（见 useLyricsWallpaperFeed）。
 *
 * 为什么单独开一条通道，不塞进 tuning 表跟着 setAppearance 一起下发：
 * 原生那张 tuning 表是**落盘**的。而预览是「设置页还开着」这种**会话内的瞬时状态** ——
 * 把它落盘，只要应用没来得及把它关掉（被杀 / 崩 / WebView 被回收），
 * 盘上的 1 就一直留到下次冷启动，于是两个症状同时出现：
 *   ① 小窗恒挂 → 壁纸那层看见它恒挂就不再画自己的原生歌词
 *      （「我没有打开隐藏原生歌词，原生歌词在所有情况下都不显示了」）；
 *   ② 预览会强制整层不吃触摸 → 小窗彻底拖不动（「安全区开关了 无法拖动」）。
 * 独立通道只活在进程内存里，还带租约，没人续就自动过期 —— 任何异常退出都能自愈。
 */
export const setWallpaperFloatingPreview = async (on: boolean): Promise<void> => {
    try {
        await FoliaWallpaper.setFloatingPreview({ on });
    } catch {
        // 桌面端 / 老版本原生没有这个方法，静默。
    }
};

/**
 * 直接把字体字节（base64）交给原生落盘。
 *
 * 字体市场走这条：文件是后台上传的，本机没有 Uri，只能由网页把字节推下去。
 * 与 `pickFont`（系统文件选择器那条路）落在同一个文件上，两者互斥 ——
 * 谁后调谁生效。传 null / 空串 = 清除，回落到系统 sans-serif。
 */
export const setWallpaperFont = async (base64: string | null): Promise<void> => {
    try {
        await FoliaWallpaper.setFont({ font: base64 });
    } catch {
        // 桌面端 / 老版本原生没有这个方法，静默。
    }
};

/** 清除壁纸歌词的自选字体，回落到系统 sans-serif。 */
export const clearWallpaperFont = async (): Promise<void> => {
    await setWallpaperFont(null);
};

export const clearLyricsWallpaper = async (): Promise<void> => {
    try {
        await FoliaWallpaper.clear();
    } catch {
        // 同上。
    }
};

/** 打开系统动态壁纸选择器，并直接定位到 Folia 的歌词壁纸。 */
export const openLyricsWallpaperPicker = async (): Promise<void> => {
    try {
        await FoliaWallpaper.openPicker();
    } catch {
        // 少数 ROM 没有这个入口，忽略即可。
    }
};

/** 叠层可视化有没有拿到「显示在其他应用上层」权限。 */
export const hasWallpaperOverlayPermission = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.hasOverlayPermission();
        return Boolean(result?.granted);
    } catch {
        return false;
    }
};

/**
 * 挑一个视频当壁纸背景。
 *
 * 和字体那套一样：原生拿到 URI 自己拷进私有目录，这里只拿「成没成」——
 * 视频动辄几十 MB，绝不走 base64 过桥。
 */
export const pickWallpaperVideo = async (): Promise<WallpaperFontPickResult> => {
    try {
        const result = await FoliaWallpaper.pickVideo();
        if (result?.picked) return 'applied';
        return result?.rejected ? 'rejected' : 'cancelled';
    } catch {
        return 'cancelled';
    }
};

/** 有没有上传过视频背景：决定按钮显示「上传」还是「更换」。 */
export const hasWallpaperVideo = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.getVideo();
        return Boolean(result?.has);
    } catch {
        return false;
    }
};

/** 删掉原生那边的视频副本。 */
export const clearWallpaperVideo = async (): Promise<void> => {
    try {
        await FoliaWallpaper.clearVideo();
    } catch {
        // 同上。
    }
};

/** 跳到系统的叠层授权页。 */
export const openWallpaperOverlaySettings = async (): Promise<void> => {
    try {
        await FoliaWallpaper.openOverlaySettings();
    } catch {
        // 桌面端 / 不支持的系统：静默，UI 那边会提示用户手动去设置里开。
    }
};

/**
 * 音乐锁屏页起没起来。
 *
 * 「后台启动 Activity 被系统拦」是**静默**的（不抛错也不返回失败），
 * 而真机上的 logcat 又基本取不到 —— 没有这一路反馈，用户只能对着一个
 * 没反应的开关猜。设置页拿它把原因直接写出来。
 */
export const getWallpaperLockScreenStatus =
    async (): Promise<WallpaperLockScreenStatus | null> => {
        try {
            return await FoliaWallpaper.getLockScreenStatus();
        } catch {
            return null;
        }
    };

/**
 * 跳到 ROM 那几道开关对应的一页。
 *
 * ColorOS 这类 ROM 会**静默**掐掉后台弹出的界面，而且没有 API 能替用户授权，
 * 只能把人送到正确的设置页。target 见 RomPermissionGuide：
 * overlay（悬浮窗）/ background（后台弹出界面 · 锁屏显示）/ power（自启动 · 耗电）
 * / details（应用详情，兜底，一定在）。
 */
export const openRomPermissionPage = async (target: string): Promise<void> => {
    try {
        await FoliaWallpaper.openRomPermission({ target });
    } catch {
        // 打不开也没关系：设置页那段引导已经把手动路径写出来了。
    }
};

/**
 * 叠层最近做了什么（新的在前）。
 *
 * 「叠层放着放着突然消失、然后又淡入」四条来路（窗口淡出 / 整页重载 / 息屏摘窗口 /
 * 被系统摘窗口）在画面上完全一样，而真机上 logcat 又取不到 —— 只能把它读出来给用户看。
 */
export const getWallpaperOverlayEventLog = async (): Promise<string[]> => {
    try {
        const result = await FoliaWallpaper.getOverlayEventLog();
        return Array.isArray(result?.events) ? result.events : [];
    } catch {
        return [];
    }
};

export const isLyricsWallpaperActive = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.isActive();
        return Boolean(result?.active);
    } catch {
        return false;
    }
};
