import type { CappellaAvatarImage, CappellaEmojiImage, Theme } from '../types';

// src/entries/wallpaperSurfaceTypes.ts
// The payloads the native side pushes into the wallpaper WebView, and the globals it installs.

export type WallpaperTimedLine = {
    text: string;
    /** 毫秒 */
    start: number;
    /** 毫秒 */
    end: number;
    translation?: string;
    /**
     * 逐字（逐词）时间轴，毫秒。没有就是整行一个词（冷启动恢复出来的行就是这样）。
     *
     * 有了它，叠层才能按 App 那份 LRC 的时间逐字推进，而不是整一段冒出来；
     * AI 主题的关键词着色也才有「一个词」这么大的粒度可以命中。
     */
    words?: { text: string; start: number; end: number }[];
};

export type WallpaperPayload = {
    positionMs: number;
    playing: boolean;
    durationMs?: number;
    title?: string;
    artist?: string;
    accent?: string;
    backgroundColor?: string;
    /** App 当前主题的主文本色。没有（旧包）时退回从高亮色派生，行为不变。 */
    primaryColor?: string;
    /** App 当前主题的次色（未唱到的那些行）。 */
    secondaryColor?: string;
    /**
     * App 当前**整份主题**。
     *
     * AI 主题真正的辨识度往往不在四个颜色上，而在 `wordColors`（给指定词上色）
     * 和 `lyricsIcons`（可视化里飘的图标）这类字段里 —— 只推颜色的话这两样一个都来不了，
     * 叠层画出来就是「配色变了，AI 主题的效果一点没有」。
     */
    theme?: Partial<Theme> | null;
    visualizer?: string;
    lines?: WallpaperTimedLine[];
    firstIndex?: number;
    /**
     * 封面 base64（data URL）。
     *
     * 只用来兜底：它是 App 抓图转出来的，那一首没转成（跨域 / 还没解码好）时
     * 原生这边就不更新，只靠它会出现「换歌封面不更新」。
     */
    cover?: string | null;
    /**
     * 封面的原始地址，**优先用它**。
     *
     * 每首歌都在变，页面可以直接 `<img>` 去拉（img 不受 CORS 约束），
     * 所以封面一定跟着歌走。原生经单独那条通道推下来（见 WallpaperOverlay
     * .pushCoverIfChanged），不跟着整包 —— 整包是「签名变了才推」的离散模型，
     * 挤在里面时只要那一次没送达，封面就永远停在上一首。
     */
    coverUrl?: string | null;
    /**
     * 安全区（CSS px）：叠层这一层自己**量不到**。
     *
     * 它是另一个 WebView，里面没有 Capacitor 桥 —— `installPhoneInsets` 在那儿只会拿到
     * 'unavailable'，四项永远 0；安卓的 `env(safe-area-inset-*)` 又只报挖孔、不报系统栏。
     * 而叠层画在桌面 / 锁屏之上，状态栏与手势条照样压着它 —— 商籁右上角那行歌曲描述
     * （画在 Pixi 画布里，CSS 够不着）就会顶在挖孔底下，和应用里让开的那一行对不上。
     *
     * 所以数值由原生把主 Activity 算好的那一份（PhoneFitCutout.resolveInsets）跟着
     * 状态包推下来（见 WallpaperOverlay.buildPayload），页面按
     * `applyPushedPhoneInsets` 落到同一份 CSS 变量 / `getPhoneInsets()` 上。
     */
    insets?: { top?: number; right?: number; bottom?: number; left?: number };
    /**
     * 群唱（Cappella）自定义头像 / 表情图。
     *
     * 叠层是另一个 WebView，它**读不到**主应用 IndexedDB 里用户上传的那几张图，
     * 所以只能由原生把图（data URL）跟着单独那条通道推下来 —— 见
     * WallpaperOverlay.pushCappellaImagesIfChanged。
     *
     * 缺了这份数据时 Cappella 会按「没有自定义头像」回退到封面：用户看到的正是
     * 「群唱自定义头像显示的是封面」。
     */
    cappellaAvatarImages?: CappellaAvatarImage[];
    cappellaEmojiImages?: CappellaEmojiImage[];
};

/**
 * 原生推下来的音频帧。
 *
 * 叠层是独立 WebView，拿不到主应用播放会话里那个 AnalyserNode；而主应用的 rAF 在
 * 用户回到桌面后会被系统停掉，所以也不能把那边采到的数据转发过来（数据源本身就冻了）。
 * 真源在原生侧：`WallpaperAudioTap` 用 `Visualizer` 抓系统混音，算好之后经
 * `WallpaperOverlay.pushAudioFrame` 走独立通道推到这里。
 *
 * 所有数值都是 0..255，量纲和主应用 `motionSignals` 里那份一致 ——
 * band 走的是同一组频率边界与同一条 shape 曲线。
 *
 * ⚠️ 这里**没有频谱**：叠层唯一画频谱的是莫奈底部那条「音频图案」，已于 2026-10-24
 * 随它的两个设置一起删掉，原生侧 `WallpaperAudioTap` 也不再算、不再推 128 段数组 ——
 * 每秒二十次传一份没人读的数组，白白给叠层的 WebView 主线程加活。
 */
export type WallpaperAudioPayload = {
    power: number;
    bass: number;
    lowMid: number;
    mid: number;
    vocal: number;
    treble: number;
};

declare global {
    interface Window {
        __foliaWallpaperPush?: (payload: WallpaperPayload) => void;
        /**
         * "第一帧画面已经画出来了"的信号，原生据此才开始淡入。
         *
         * 为什么需要它：可视化是懒加载的（chunk 下载 + Pixi/WebGL 初始化），
         * 从"收到数据"到"真的画出东西"中间有一段空窗。原生如果按固定延时淡入，
         * 就会淡入到一个还没画完的页面 —— 用户看到的是"闪一下黑，然后突然出现"。
         * 让它回过头来问页面准备到哪一步，才治本。
         */
        __foliaWallpaperPainted?: boolean;
        /**
         * 已经收到过多少份数据。原生推完会把它读回去当"送达回执"。
         *
         * 为什么需要回执：evaluateJavascript 在页面还在导航时会**静默丢掉**调用而不报错，
         * 原生那边看起来是成功的，于是把「推过了」记进去重签名 —— 之后状态没变就再也不推，
         * 页面永远停在空状态（表现是"切到下一首再也不出来"）。有个计数，原生才能分清
         * "真的送到了"和"我以为送到了"。
         */
        __foliaWallpaperPushCount?: number;
        /**
         * 页面手里这份数据的歌名。原生会隔几秒回来对一次：
         * 对不上就说明有推送被丢了（桥调用在页面导航期会被静默丢掉），补推一次。
         */
        __foliaWallpaperLastTitle?: string;
        /**
         * 最近一份推送的原文和时间戳，供原生核对「页面手里的状态有没有过期」。
         * 原生拿它对三样：歌名、时间轴（行数 + 首行）、两边各自外推的位置差 ——
         * 推送被签名吞掉时页面会停在「新歌名 + 旧歌词 / 旧锚点」上，
         * 光看歌名发现不了，必须连时间轴和位置一起核对。
         */
        __foliaWallpaperLatest?: WallpaperPayload;
        __foliaWallpaperReceivedAt?: number;
        /**
         * 封面单独那条通道：`{ url?, data? }`。
         *
         * 和整包分开是为了不被「签名去重」吞掉 —— 封面是 App 异步抓图之后才到的，
         * 挤在整包里时只要那一次桥调用没送达，封面就永远停在上一首，
         * 而歌词看起来还在正常走（位置是页面自己按墙钟外推的），症状很隐蔽。
         */
        __foliaWallpaperPushCover?: (payload: { url?: string; data?: string }) => void;
        /**
         * 群唱自定义头像 / 表情图那条通道。
         *
         * 与封面同一条纪律：几百 KB 的 base64 不能跟着整包每 250ms 走一遍，也不能被
         * 签名去重吞掉 —— 图是主应用从 IndexedDB 现解出来的，晚到一步就意味着叠层上
         * 这一整首歌都在显示封面。
         */
        __foliaWallpaperPushCappellaImages?: (payload: {
            avatars?: CappellaAvatarImage[];
            emojis?: CappellaEmojiImage[];
        }) => void;
        /**
         * 音频单独那条通道。
         *
         * 同样不能挤进整包：整包是「签名变了才推」的离散模型，而音频是每秒 20 次的
         * 连续流，既塞不进签名也过不了那道去重的门。传 `null` = 暂停 / 没数据，
         * 页面把频谱落回 0。
         */
        __foliaWallpaperPushAudio?: (payload: WallpaperAudioPayload | null) => void;
    }
}

