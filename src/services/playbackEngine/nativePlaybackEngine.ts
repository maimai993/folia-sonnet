import { nativePlayer, type NativePlaybackEvent, type NativePlaybackSnapshot } from './nativePlayerPlugin';
import { isNativePlaybackReconciling } from './nativePlaybackSync';

// src/services/playbackEngine/nativePlaybackEngine.ts
//
// 原生播放内核在 Web 侧的那一半：一个进程里只有一个播放器，所以这里是单例。
//
// 时钟是这里最容易做错的地方。原生播放器**不给逐帧位置** —— 它只在状态边界
// （ready / playing / paused / buffering / seeked）带一次位置，而歌词、进度条是按帧读的。
// 所以位置要按本地墙钟插值补出来：
//
//     真实位置 ≈ 最后一次上报的位置 + (现在 − 那次上报的时刻) × 倍速
//
// 这也是**不能按固定节拍把位置推过桥**的原因：每推一次就是一次
// `evaluateJavascript`，主线程会周期性多出一帧等待（见 FoliaNativePlayerPlugin）。
//
// 绝不反过来做「Web 侧每秒调 getSnapshot 问一次」：Capacitor 的桥只有一条，
// 轮询会和批量拉取那些操作抢同一条通道（成片 cookie 超时就是这么来的）。
//
// 夹在 duration 之内：缓冲、切歌之后插出来的值可能越过结尾，
// 一首 4 分钟的歌进度条冲到 4:07 再弹回来很难看。

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * 原生播放（P1）总闸：**已打开**。
 *
 * 曾经因为「开原生播放时 App 内那个歌词可视化页面隔几秒顿一下、关掉就好」停用过一阵。
 * 停用期间反而确认了掉帧另有来源：120Hz 下 WebView 每秒 100 次
 * `syncAndDrawFrame` + 周期性 React 提交，关掉原生时也会出现。
 * 真正和原生播放相关的是**位置事件过桥的节拍**（见 FoliaNativePlayerPlugin 的
 * `onEvent`）：现在前台由 Web 侧自己的时钟推进，只有状态边界才过桥，
 * 不再按固定节拍往 WebView 里灌 JS。
 *
 * ⚠️ 代价：走 `blob:` 的本地歌原生吃不下，那种歌整首回落 `<audio>`；
 * 原生出声时均衡器 / 音效 / 淡入淡出 / 混音过渡 / 频谱整体失效（都在 Web Audio 图上）。
 *
 * 设置里那个「原生播放（实验）」开关已经删掉了：安卓上恒开，没有第二条音频栈可选
 * （见 useAppAudioOutput 的三层说明）。这里的总闸留着，只是代码级别的紧急关闭口。
 */
export const NATIVE_PLAYBACK_ENABLED: boolean = true;

class NativePlaybackEngine {
    private positionMs = 0;
    private durationMs = 0;
    private playing = false;
    private hasSource = false;
    private rate = 1;
    private updatedAtMs = 0;
    /**
     * 上一次对外给过的位置（毫秒）。
     *
     * 只进不退 —— 这是「歌词往回抽一下又恢复」的直接解药：暂停 / 缓冲 / 状态事件
     * 带回的位置可能比已经画出去的那一帧稍旧，直接采用会让歌词往回抽一下。
     *
     * 原生不再每 250ms 给采样值，所以这里**不能**再夹「最多领先多少」——那会把
     * 由墙钟推进的时钟卡死。真正需要允许回退的只有显式 seek / 换源，那两处会
     * 把基准一起复位。
     */
    private lastDeliveredMs = 0;
    /**
     * 正在缓冲：位置事件照收，但墙钟先别往前走。
     *
     * ExoPlayer 的 `isPlaying=false` 不等于暂停（缓冲、音频焦点被抢都会翻 false）。
     * 这时候把 `playing` 置 false 会让界面以为停了；但继续按墙钟走又会跑到声音前面。
     * 单独记一个状态：时钟冻在最后一次采样上，等 `playing` 回来再从播放器给的位置接上。
     */
    private stalled = false;
    private repeatMode = 0;
    private volume = 1;
    /**
     * 这一首自己的响度补偿系数（线性，1 = 不动）。
     *
     * ReplayGain 原来乘在 Web Audio 的 gain 节点上；原生出声之后那条链不参与，所以乘进
     * 播放器音量里：真正下发的是 volume × trackGain。两个乘数分开存，用户拖音量时
     * 补偿不会被覆盖，换歌时补偿归 1 由调用方负责（见 usePlaybackAudioBridge.applyReplayGain）。
     */
    private trackGain = 1;
    private currentUrl: string | null = null;
    private songKey: string | null = null;

    /** 认领只重置本地时钟，绝不 prepare / seek / play 原生。 */
    adoptSnapshot(snapshot: NativePlaybackSnapshot & { url: string; speed?: number }): void {
        this.ensureSubscription();
        this.currentUrl = snapshot.url;
        this.songKey = snapshot.songKey ?? null;
        this.hasSource = true;
        this.positionMs = Math.max(0, snapshot.positionMs);
        this.durationMs = Math.max(0, snapshot.durationMs);
        this.playing = snapshot.playing;
        this.rate = snapshot.speed ?? 1;
        this.stalled = false;
        this.updatedAtMs = performance.now();
        this.lastDeliveredMs = this.positionMs;
    }
    private listeners = new Set<(event: NativePlaybackEvent) => void>();
    private subscriptionStarted = false;

    /**
     * 这个地址能不能交给原生。
     *
     * `blob:` 不行 —— 那是 WebView 自己造的对象 URL（本地导入的歌），
     * 原生进程根本看不到它。遇到这种地址整首回落到 `<audio>`，等缓存搬进私有目录
     * （后面的阶段）再说。
     */
    supports(url: string | null | undefined): boolean {
        if (!url) return false;
        if (url.startsWith('blob:')) return false;
        if (url.startsWith('data:')) return false;
        return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('content://') || url.startsWith('file://');
    }

    /** 当前是不是由原生在播（用来决定进度条走哪条时钟）。 */
    activeUrl(): string | null {
        return this.hasSource ? this.currentUrl : null;
    }

    /** 原生手上有没有歌（不论在不在播）。进度条与歌词看这个，不看 isPlaying。 */
    ownsPlayback(): boolean {
        return this.hasSource;
    }

    isPlaying(): boolean {
        return this.hasSource && this.playing;
    }

    /**
     * 墙钟插值后的当前位置（秒）。没有源时给 0。
     *
     * 原生只在这几个时刻报位置：ready / playing / paused / buffering / seek / ended。
     * 其余时间由这里按 `performance.now()` 往前推 —— 这正是把「每 500ms 往 WebView
     * 灌一次 JS」拿掉之后需要的那条时钟。音频与 `performance.now()` 走的是同一个
     * monotonic 时钟，一首歌的长度里漂移可以忽略。
     */
    getPositionSec(): number {
        if (!this.hasSource) return 0;
        const now = performance.now();
        const raw = this.playing && !this.stalled
            ? this.positionMs + Math.max(0, now - this.updatedAtMs) * this.rate
            : this.positionMs;
        const capped = this.durationMs > 0 ? Math.min(raw, this.durationMs) : raw;
        const delivered = Math.max(0, Math.min(Math.max(capped, this.lastDeliveredMs), this.durationMs > 0 ? this.durationMs : Number.POSITIVE_INFINITY));
        this.lastDeliveredMs = delivered;
        return delivered / 1000;
    }

    getDurationSec(): number {
        return this.durationMs > 0 ? this.durationMs / 1000 : 0;
    }

    async setSource(url: string, options: { startPositionMs?: number | null; repeatMode?: number; songKey?: string | null } = {}): Promise<void> {
        if (isNativePlaybackReconciling()) return;
        if (this.hasSource && this.currentUrl === url && (!options.songKey || options.songKey === this.songKey)) return;
        this.ensureSubscription();
        this.songKey = options.songKey ?? null;
        this.currentUrl = url;
        this.hasSource = true;
        this.playing = false;
        this.stalled = false;
        this.positionMs = options.startPositionMs ?? 0;
        this.durationMs = 0;
        this.updatedAtMs = performance.now();
        this.lastDeliveredMs = this.positionMs;
        if (typeof options.repeatMode === 'number') this.repeatMode = options.repeatMode;
        await nativePlayer.prepare({
            url,
            startPositionMs: options.startPositionMs ?? null,
            repeatMode: this.repeatMode,
            songKey: this.songKey,
        });
        await nativePlayer.setVolume(this.volume);
    }

    async play(): Promise<void> {
        await nativePlayer.play();
        // 播放意图先记下：等 `playing` 事件回来之前，进度条不该停在原地不动。
        // 从暂停那一帧的位置接着走，而不是从更旧的采样值重新追。
        this.positionMs = this.getPositionSec() * 1000;
        this.playing = true;
        this.stalled = false;
        this.updatedAtMs = performance.now();
    }

    async pause(): Promise<void> {
        await nativePlayer.pause();
        // 冻在听众正看着的那一帧，别退回最后一次采样值。
        this.positionMs = this.getPositionSec() * 1000;
        this.playing = false;
        this.stalled = false;
        this.updatedAtMs = performance.now();
    }

    async seek(seconds: number): Promise<void> {
        const targetMs = Math.max(0, Math.round(seconds * 1000));
        this.positionMs = targetMs;
        this.updatedAtMs = performance.now();
        this.stalled = false;
        // 跳是唯一允许「往回走」的动作，所以这里必须把只进不退的基准一起复位。
        this.lastDeliveredMs = targetMs;
        await nativePlayer.seek(targetMs);
    }

    async stop(): Promise<void> {
        this.hasSource = false;
        this.playing = false;
        this.stalled = false;
        this.positionMs = 0;
        this.durationMs = 0;
        this.lastDeliveredMs = 0;
        this.currentUrl = null;
        await nativePlayer.stop();
    }

    /** 用户音量（0..1）。与 [trackGain] 分开：拖音量不该把响度补偿抹掉。 */
    setVolume(volume: number): void {
        this.volume = clamp(volume, 0, 1);
        if (!this.hasSource) return;
        void nativePlayer.setVolume(this.effectiveVolume()).catch(() => undefined);
    }

    /**
     * 这一首的响度补偿（线性系数，见 src/utils/replayGain.ts 的 linearGain）。
     *
     * 乘在音量上一起下发，而不是另开一条原生接口：播放器只有一个音量旋钮。
     */
    setTrackGain(gain: number): void {
        this.trackGain = clamp(gain, 0, 4);
        if (!this.hasSource) return;
        void nativePlayer.setVolume(this.effectiveVolume()).catch(() => undefined);
    }

    /** 真正下发给播放器的音量。 */
    private effectiveVolume(): number {
        return clamp(this.volume * this.trackGain, 0, 1);
    }

    setSpeed(speed: number): void {
        this.rate = clamp(speed, 0.1, 4);
        if (!this.hasSource) return;
        void nativePlayer.setSpeed(this.rate).catch(() => undefined);
    }

    setRepeatMode(repeatMode: number): void {
        // 只记下来：下一次 prepare 会带上它。已经在播的这一首不重新装地址 —— 那会把
        // 当前这一首从头再来一遍，而「单曲循环」是随时能按的。
        this.repeatMode = repeatMode;
    }

    /**
     * 立刻改循环模式：对已经在播的播放器直接下发，不重新装地址。
     *
     * `setRepeatMode` 只在下次 prepare 才生效，正在播的这首会丢循环 —— ExoPlayer
     * 还是 OFF，歌放完停在末尾，进度条不动；Web 那条路的 `<audio>.loop` 是元素属性，
     * React 一渲染就生效，原生这里得补上同一个时效性。播放器还没建时退化为只记录。
     */
    setRepeatModeNow(repeatMode: number): void {
        this.repeatMode = repeatMode;
        if (!this.hasSource) return;
        void nativePlayer.setRepeatMode(repeatMode).catch(() => undefined);
    }

    subscribe(listener: (event: NativePlaybackEvent) => void): () => void {
        this.listeners.add(listener);
        this.ensureSubscription();
        return () => {
            this.listeners.delete(listener);
        };
    }

    private ensureSubscription(): void {
        if (this.subscriptionStarted) return;
        this.subscriptionStarted = true;
        void nativePlayer.addListener(event => {
            if (isNativePlaybackReconciling()) return;
            if (event.songKey && this.songKey && event.songKey !== this.songKey) return;
            this.apply(event);
            this.listeners.forEach(listener => listener(event));
        }).catch(() => undefined);
    }

    private apply(event: NativePlaybackEvent): void {
        const now = performance.now();
        if (typeof event.positionMs === 'number') {
            this.positionMs = Math.max(0, event.positionMs);
            this.updatedAtMs = now;
        }
        if (typeof event.durationMs === 'number' && event.durationMs > 0) {
            this.durationMs = event.durationMs;
        }
        switch (event.type) {
            case 'playing':
                this.playing = true;
                this.stalled = false;
                this.updatedAtMs = now;
                /*
                 * 声音这一刻才真的开始。`play()` 到这一下之间可能隔着缓冲 / 起播，
                 * 日志里是几百毫秒；那段时间墙钟已经走了，不能让歌词白白领先。
                 * 以播放器给的位置为准把基准复位（这是允许往回走的状态边界）。
                 */
                this.lastDeliveredMs = this.positionMs;
                break;
            case 'paused':
            case 'ended':
            case 'error':
            case 'idle':
                this.playing = false;
                this.stalled = false;
                break;
            case 'buffering':
                /*
                 * 缓冲期间播放器的 `isPlaying` 会翻成 false（ExoPlayer 的语义：没在出声）。
                 * 但歌并没有停 —— 这里要是跟着置 false，界面会以为停了。所以保留
                 * `playing`，只把墙钟冻在最后一次采样上；等 `playing` 回来时事件会带上
                 * 播放器真实位置，从那里接上，不会跑到声音前面，也不会在恢复时猛跳。
                 */
                this.stalled = true;
                break;
            case 'seeked':
                /*
                 * 用户 seek / 单曲循环回到开头：位置是**允许往回走**的，
                 * 所以把只进不退的基准一起复位。播放状态不变。
                 */
                this.stalled = false;
                this.lastDeliveredMs = this.positionMs;
                break;
            default:
                break;
        }
    }
}

export const nativePlaybackEngine = new NativePlaybackEngine();
