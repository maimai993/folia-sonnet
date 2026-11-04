// src/components/visualizer/kinetic/kineticEditorBridge.ts
// 编辑台 ↔ folia 播放器的双向桥：进度、播放/暂停、音量。
//
// 原版编辑台自带一套播放控制（进度条、播放键、音量），folia 播放页也有一套。
// 之前两边各走各的：编辑台里拖进度只动它自己的预览，播放页完全不知道。
// 这个模块把两边缝在一起 —— 同一首歌的时间轴与播放状态只有一份真值（folia 的播放器）。

/** 原版编辑台暴露出来的宿主接口（见 jizura 仓库 src/12_ui.js 末尾的 J.uiApi）。 */
export type JizuraUiApi = {
    /** 暂停原版自己的预览播放（它不再自己走时间）。 */
    pause?: () => void;
    /** 把原版的播放头对到某个时间点。 */
    seek?: (time: number) => void;
    /** 改完参数后重排。 */
    replan?: () => void;
    /** 刷新原版界面上的控件状态。 */
    syncUI?: () => void;
};

/** 原版编辑台的状态对象（J.ui）。 */
export type JizuraUiState = {
    /** 当前播放头（秒）。 */
    t?: number;
    /** 是否在播放。 */
    playing?: boolean;
    /** 预览音量。 */
    volume?: number;
    /** 已载入的工程。 */
    project?: Record<string, unknown>;
};

type EditorWindow = Window & {
    J?: {
        ui?: JizuraUiState;
        uiApi?: JizuraUiApi;
    };
};

const asEditor = (target: Window | null | undefined): EditorWindow | null => (
    target ? target as EditorWindow : null
);

/** 读编辑台当前的播放头（秒）；拿不到就返回 null。 */
export const readEditorTime = (target: Window | null | undefined): number | null => {
    const time = asEditor(target)?.J?.ui?.t;
    return typeof time === 'number' && Number.isFinite(time) ? time : null;
};

/** 读编辑台当前是否在播放；拿不到就返回 null。 */
export const readEditorPlaying = (target: Window | null | undefined): boolean | null => {
    const playing = asEditor(target)?.J?.ui?.playing;
    return typeof playing === 'boolean' ? playing : null;
};

/**
 * 让编辑台停下自己的预览，改由 folia 的播放器驱动。
 *
 * 原版一进来就自己播，两边会各走各的时间轴 —— 必须先把它的自动播放关掉，
 * 之后只用 seek 喂时间，画面才会与播放页一致。
 */
export const handOverPlayback = (target: Window | null | undefined) => {
    const api = asEditor(target)?.J?.uiApi;
    if (!api) return false;
    try {
        api.pause?.();
        console.log('[Kinetic] 编辑台播放已交给 folia 播放器');
        return true;
    } catch (error) {
        console.warn('[Kinetic] 接管编辑台播放失败', error);
        return false;
    }
};


/**
 * 让编辑台的播放键显示与 folia 的播放状态一致。
 *
 * 原版的点击处理是 `S.playing ? pause() : play()`（12_ui.js:1621），
 * 图标由 play()/pause() 顺手改（'❚❚' / '▶'）。只改 S.playing 不同步图标，
 * 就会出现「点在动、图标显示暂停」这种错位，点起来像是没反应或暂停后又自己播。
 *
 * 这里不动它的时钟（时间由 pushTimeToEditor 喂），只把状态与图标对齐。
 */
export const syncEditorTransport = (target: Window | null | undefined, playing: boolean) => {
    const editor = asEditor(target);
    const ui = editor?.J?.ui;
    if (!ui) return;
    try {
        // playing 是原版 tick() 的时钟开关，不是按钮状态。保持暂停，只同步按钮。
        editor?.J?.uiApi?.pause?.();
        // 原版按钮在自家文档里：按 id 取，改的就是它显示的那个图标。
        const doc = target?.document;
        const button = doc ? doc.getElementById('btnPlay') : null;
        if (button) {
            button.textContent = playing ? '❚❚' : '▶';
            button.setAttribute('aria-label', playing ? '一時停止' : '再生');
        }
        console.log('[Kinetic] 编辑台播放键已对齐', { playing });
    } catch (error) {
        console.warn('[Kinetic] 同步编辑台播放状态失败', error);
    }
};

/**
 * 把 folia 的播放头推给编辑台（拖进度、换句、播放中定速对齐都用它）。
 *
 * 原版 seek() 里第一件事是读 S.plan.duration（12_ui.js:301）——
 * plan 还没算出来时直接抛错，日志里那几条「同步播放头到编辑台失败 {}」就是它。
 * 所以先确认 plan 就绪；没就绪就等下一拍，不当作失败。
 */
export const pushTimeToEditor = (target: Window | null | undefined, time: number) => {
    const editor = asEditor(target);
    const api = editor?.J?.uiApi;
    if (!api || !Number.isFinite(time)) return;
    const planReady = Boolean((editor?.J?.ui as { plan?: unknown } | undefined)?.plan);
    // 未就绪时不排捕获旧 time 的定时器；ready 注入成功后会用最新宿主时间校准。
    if (!planReady) return;
    try {
        api.seek?.(Math.max(0, time));
    } catch (error) {
        console.warn('[Kinetic] 同步播放头到编辑台失败', error);
    }
};

/** 用户在编辑台里拖了进度条 → 读出它跳到哪儿了，交给 folia 去 seek。 */
export const pullTimeFromEditor = (target: Window | null | undefined): number | null => readEditorTime(target);

/**
 * 音量：编辑台里的音量控件对应 folia 播放器的音量。
 *
 * 原版只把自己的 audio 元素调小声，folia 的声音还是原来的大小 ——
 * 用户在编辑台里拉音量会以为没生效。这里把值交给调用方去设 folia 的音量。
 */
export const readEditorVolume = (target: Window | null | undefined): number | null => {
    const volume = asEditor(target)?.J?.ui?.volume;
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return null;
    // 原版是 0..1，folia 也是 0..1，直接透传；越界钳一下。
    return Math.min(1, Math.max(0, volume));
};
