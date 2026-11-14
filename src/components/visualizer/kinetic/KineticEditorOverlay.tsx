import React, { useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../ui/Button';
import { resolveThemeFontStack } from '../../../utils/fontStacks';
import { saveExportFile } from './saveExportFile';
import { readKineticProject, writeKineticProject } from './kineticProjectMemory';
import {
    handOverPlayback,
    pushTimeToEditor,
    readEditorVolume,
    syncEditorTransport,
} from './kineticEditorBridge';
import type { KineticProjectSnapshot } from './kineticProjectTypes';
import { kineticPlanMatchesLyrics, resolveKineticProjectLyrics } from './kineticEditorIdentity';
import type { Line, Theme } from '../../../types';

// src/components/visualizer/kinetic/KineticEditorOverlay.tsx
// 文字PV 的原版编辑台：JIZURA 官方单文件版（由官方仓库 build.py 生成）装进 public/jizura/editor.html。
// 打开时把 folia 当前的歌词（LRC）、主题四色、AI 关键字色与主题字体注进去，
// 参数与界面完全用原版那份，不做任何改写；右上角退出回原样式。

type Props = {
    /** 当前歌词行（转成 LRC 注入原版）。 */
    lines: Line[];
    /** null 歌词等待期间只清显示，不覆盖原工程。 */
    lyricsReady?: boolean;
    /** folia 主题：四色 + 字体 + AI 关键字色。 */
    theme: Theme | undefined;
    /** 右上角退出：关掉编辑台，回到 folia 原样式。 */
    onClose: () => void;
    /** 当前歌曲的键：编辑结果按它存下来，换歌/重启都能还原。 */
    songKey?: string | null;
    /** folia 播放器当前的播放头（秒）：进编辑台时用它对齐，播放中不断喂给它。 */
    currentTime?: number;
    /** folia 播放器是否在播放。 */
    playing?: boolean;
    /** 用户在编辑台里拖进度 → 让 folia 跳过去。 */
    onSeek?: (time: number) => void;
    /** 用户在编辑台里播放 / 暂停 → 让 folia 跟着动。 */
    onTogglePlay?: (playing: boolean) => void;
    /** 用户在编辑台里调音量 → 让 folia 的音量跟着变。 */
    onVolumeChange?: (volume: number) => void;
};

/** 歌词行转 LRC 文本（原版 parseLyrics 认这个格式）。 */
const toLrc = (lines: Line[]): string => (
    lines.map((line) => {
        const minutes = Math.floor(Math.max(0, line.startTime) / 60);
        const seconds = Math.max(0, line.startTime) - minutes * 60;
        return `[${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}]${line.fullText}`;
    }).join('\n')
);

/**
 * 允许的时间轴偏差（秒）。
 *
 * 用户手动微调通常在一两秒内；超过这个量级的差异就不是调整，而是卡顿算出来的脏值。
 */
const TIMING_TOLERANCE_SEC = 2;

/** 编辑台打开后先静默多久才开始记录/保存（毫秒）：躲开它启动时的那阵卡顿。 */
const SNAPSHOT_SETTLE_MS = 3000;

/**
 * 把 timing 里不可信的逐行时间剔掉。
 *
 * 原版 timing.lineTimes 是手动逐行时间，优先级高于歌词的 LRC 时间（08_planner.js:212），
 * 所以一份脏的 lineTimes 会一直盖住正确时间、造成音画不同步，而且会被保存下来、重启还在。
 * 这里拿 folia 当前的歌词时间去核对：偏差超过容差、或者歌词根本没这一行，就丢掉这条。
 *
 * 其余时间轴字段（bpm / offset / tail / lineScale / snap）原样保留。
 */
const sanitizeTiming = (
    timing: Record<string, unknown> | undefined,
    lrcTimes: number[],
): Record<string, unknown> | undefined => {
    if (!timing || typeof timing !== 'object') return timing;
    const raw = (timing as { lineTimes?: unknown }).lineTimes;
    if (!raw || typeof raw !== 'object') return timing;

    const kept: Record<string, number> = {};
    let dropped = 0;
    Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
        const index = Number(key);
        const time = Number(value);
        if (!Number.isInteger(index) || !Number.isFinite(time)) {
            dropped += 1;
            return;
        }
        const reference = lrcTimes[index];
        // 歌词里没有这一行，或者偏差太大：当成脏值丢掉。
        if (!Number.isFinite(reference) || Math.abs(time - reference) > TIMING_TOLERANCE_SEC) {
            dropped += 1;
            return;
        }
        kept[key] = Math.max(0, time);
    });

    if (dropped > 0) {
        console.warn('[Kinetic] 时间轴有不可信的逐行时间，已剔除后再保存', {
            kept: Object.keys(kept).length,
            dropped,
        });
    }
    return { ...timing, lineTimes: kept };
};

const KineticEditorOverlay: React.FC<Props> = ({
    lines,
    lyricsReady = true,
    theme,
    onClose,
    songKey,
    currentTime = 0,
    playing = false,
    onSeek,
    onTogglePlay,
    onVolumeChange,
}) => {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    // 播放键监听器只绑一次，闭包拿不到最新值：用 ref 保证每次都读到当前状态。
    const playingRef = useRef(playing);
    playingRef.current = playing;
    const onTogglePlayRef = useRef(onTogglePlay);
    onTogglePlayRef.current = onTogglePlay;
    const currentTimeRef = useRef(currentTime);
    currentTimeRef.current = currentTime;

    const lrc = useMemo(() => toLrc(lines), [lines]);
    /**
     * inject 只读 ref 里的值。
     *
     * inject 是普通闭包，定义时就把 lrc / songKey / 配色固定下来了；
     * 切歌时再从 effect 里调它，写进编辑台的仍是打开那一刻的歌词 ——
     * 那就是「编辑台里的歌词不更新」的原因。ref 保证每次都读到最新值。
     */
    const injectDataRef = useRef({ lrc: '', songKey: null as string | null, lines, lyricsReady });
    injectDataRef.current = { lrc, songKey: songKey ?? null, lines, lyricsReady };
    /** folia 歌词的原始时间：保存前用它核对编辑台算出来的逐行时间。 */
    const lrcTimesRef = useRef<number[]>([]);
    lrcTimesRef.current = lines.map(line => Math.max(0, line.startTime));
    /** 上一次发出的 plan 签名：没变就不重发整包。 */
    const lastPlanSigRef = useRef('');
    const themeColors = useMemo(() => ({
        bg: theme?.backgroundColor || '#0a0a0a',
        fg: theme?.primaryColor || '#f4f4f5',
        sub: theme?.secondaryColor || '#a1a1aa',
        accent: theme?.accentColor || '#f4f4f5',
    }), [theme?.backgroundColor, theme?.primaryColor, theme?.secondaryColor, theme?.accentColor]);
    const fontFamily = useMemo(() => {
        if (!theme) return '';
        try {
            const stack = resolveThemeFontStack({ fontStyle: theme.fontStyle, fontFamily: theme.fontFamily, fontFamilyStack: theme.fontFamilyStack });
            return stack.split(',')[0]?.replace(/["']/g, '').trim() || '';
        } catch {
            return '';
        }
    }, [theme]);

    // 编辑台盖在播放页上面时，让渲染页彻底停画（两个合成层一起跑是卡顿主因）。
    React.useEffect(() => {
        // 必须发给渲染页所在的 iframe 窗口，发给 window 它收不到（那是本窗口自己）。
        const send = (paused: boolean) => {
            frameRef.current?.contentWindow?.postMessage(
                { target: 'jizura-render', type: 'pause', paused },
                '*',
            );
        };
        // 编辑台是全屏浮层，外面那层渲染完全看不见 —— 直接停掉，把算力全留给编辑台。
        // 刚挂载时 iframe 可能还没加载完，连发几次保证收到（渲染页对重复 pause 是幂等的）。
        send(true);
        const timers = [150, 600, 1500].map(delay => window.setTimeout(() => send(true), delay));
        return () => {
            timers.forEach(timer => window.clearTimeout(timer));
            send(false);
            /*
             * 退出编辑台：把 folia 的当前播放头显式推回渲染页。
             *
             * 暂停状态下 folia 的 currentTime 不会变化、也就不会触发跨句 seek，
             * 渲染页就停在「进编辑台那一刻」的位置 —— 回到播放页就是
             * 「时间轴对不上，手动重新匹配一下才好」。补一次 seek，两边立刻对齐。
             */
            frameRef.current?.contentWindow?.postMessage({
                target: 'jizura-render',
                type: 'seek',
                time: currentTimeRef.current,
                playing: playingRef.current,
            }, '*');
            console.log('[Kinetic] 退出编辑台，已把 folia 播放头推回渲染页', {
                time: currentTimeRef.current,
                playing: playingRef.current,
            });
        };
    }, []);

    /**
     * 播放联动：编辑台与 folia 播放器共用同一份时间轴与播放状态。
     *
     * 之前两边各走各的 —— 编辑台有自己的预览播放器，拖它自己的进度条只动它自己，
     * 播放页完全不知道；反过来播放页在放，编辑台也不会跟。
     * 这里把编辑台的预览播放停掉，改由 folia 喂时间，两边就永远看同一个位置。
     */
    React.useEffect(() => {
        const target = frameRef.current?.contentWindow;
        if (!target) return undefined;
        // 接管前先等原版的 boot 跑完（它一启动就自己播）。
        // 原版 boot 里可能还会再调一次 play()，所以对齐不能只做一次 —— 连做几次直到稳定。
        const timers = [400, 900, 1600, 2500].map(delay => window.setTimeout(() => {
            handOverPlayback(target);
            // 进来对齐到播放页当前的位置，而不是从头开始。
            pushTimeToEditor(target, currentTimeRef.current);
            syncEditorTransport(target, playingRef.current);
        }, delay));
        return () => timers.forEach(timer => window.clearTimeout(timer));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** folia 播放头只向编辑台单向校时；boot 的代表帧 seek 不再参与用户操作判断。 */
    React.useEffect(() => {
        const target = frameRef.current?.contentWindow;
        if (!target) return;
        pushTimeToEditor(target, currentTime);
    }, [currentTime]);

    // 不靠播放器下一次 tick 轮询：暂停时没有 tick，也必须响应真实 timeline/scrub 操作。
    React.useEffect(() => {
        const listener = (event: MessageEvent) => {
            if (event.source !== frameRef.current?.contentWindow) return;
            const data = event.data;
            if (data?.source === 'jizura-editor' && data.type === 'set-playing' && typeof data.playing === 'boolean') {
                onTogglePlayRef.current?.(data.playing);
                return;
            }
            if (data?.source === 'jizura-editor' && data.type === 'toggle-play') {
                onTogglePlayRef.current?.(!playingRef.current);
                return;
            }
            if (data?.source !== 'jizura-editor' || data.type !== 'user-seek'
                || typeof data.time !== 'number' || !Number.isFinite(data.time)) return;
            console.log('[Kinetic] 编辑台用户跳转，同步到播放器', { time: data.time, songKey });
            onSeek?.(Math.max(0, data.time));
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }, [onSeek, songKey]);

    /** 播放 / 暂停：folia 的状态变了就同步给编辑台（让它的播放键显示对的状态）。 */
    React.useEffect(() => {
        const target = frameRef.current?.contentWindow;
        if (!target) return;
        // 只显示宿主状态，原版 tick 仍保持暂停，避免两个时钟争夺播放头。
        syncEditorTransport(target, playing);
    }, [playing]);

    /**
     * 拦下编辑台的播放键，交给 folia 播放器处理。
     *
     * 原版点击会跑它自己的 play()/pause()，音源对不上（它没有 folia 的音频），
     * 状态一乱就是「点了没反应 / 暂停后又自己播」。这里把点击截住，只发事件出去，
     * 由播放器真正切换，再用 syncEditorTransport 把图标对齐回来。
     */
    React.useEffect(() => {
        const timer = window.setInterval(() => {
            const doc = frameRef.current?.contentWindow?.document;
            const button = doc?.getElementById('btnPlay');
            if (!button || button.dataset.foliaBound === '1') return;
            button.dataset.foliaBound = '1';
            // 用捕获阶段先于原版自己的监听器执行，再阻止它继续冒泡到原版处理器。
            button.addEventListener('click', (event) => {
                event.stopImmediatePropagation();
                event.preventDefault();
                // 必须读 ref 而不是闭包里的 playing：监听器只绑一次，
                // 闭包会一直记着首次绑定时那个值 —— 那就是「点一次后永远走同一个分支，
                // 表现成点了反而暂停、再也播不了」的原因。
                const currentlyPlaying = playingRef.current;
                const nowPlaying = !currentlyPlaying;
                console.log('[Kinetic] 编辑台播放键 → 交给播放器', { from: currentlyPlaying, to: nowPlaying });
                onTogglePlayRef.current?.(nowPlaying);
            }, true);
            console.log('[Kinetic] 已接管编辑台播放键');
        }, 400);
        return () => window.clearInterval(timer);
    }, []);

    /**
     * 编辑台里的播放键与音量。
     *
     * 两个都要反着听：原版的播放键只控制它自己的预览，音量只调它自己的 audio 元素 ——
     * 用户在编辑台里按播放 / 拉音量，听到的应该和播放页一致。
     */
    React.useEffect(() => {
        const target = frameRef.current?.contentWindow;
        if (!target) return undefined;
        let lastVolume: number | null = null;
        const timer = window.setInterval(() => {
            // 播放状态不在这里反向上报：播放键已在捕获阶段接管（见上面那个 effect），
            // 再监听一次 S.playing 的变化会让一次点击触发两次切换 —— 那就是
            // 「暂停了立刻又开始播放」的原因。播放状态的唯一来源必须是 folia。
            const volume = readEditorVolume(target);
            if (volume !== null && lastVolume !== null && Math.abs(volume - lastVolume) > 0.02) {
                onVolumeChange?.(volume);
            }
            lastVolume = volume;
        }, 300);
        return () => window.clearInterval(timer);
    }, [onVolumeChange]);

    /**
     * 编辑台 → 渲染页的工程同步。
     *
     * 原版的每一处改动最后都调 replan()（换样式、拖布局、改种子、调 fx 都一样），
     * 所以盯住 J.ui.project 的快照就够了：变了就把整份工程经 BroadcastChannel 发出去，
     * 渲染页收到后重建 plan。这样编辑台里改完，退回播放页立刻就是新画面。
     */
    React.useEffect(() => {
        const target = frameRef.current?.contentWindow;
        if (!target) return undefined;
        let lastSerialized = '';
        const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('kinetic-project');
        /*
         * 打开之后先静默一段时间，不给保存。
         *
         * 编辑台刚启动时原版要建样式缩略图、预热字形、算第一份 plan，真机上会卡一下。
         * 卡顿期间 timeline 状态还没稳定，这时候读到的 timing 可能就是错的 ——
         * 一旦存进去，之后每次播放都被这份错时间覆盖，音画不同步而且自己恢复不了。
         * 等它稳下来再开始记录。
         */
        const settleAt = Date.now() + SNAPSHOT_SETTLE_MS;
        const pushSnapshot = (final = false) => {
            if (!final && Date.now() < settleAt) return;
            try {
                const ui = (target as unknown as {
                    J?: {
                        ui?: {
                            project?: Record<string, unknown>;
                            uiApi?: { replan?: () => void };
                        };
                    };
                }).J?.ui;
                const project = ui?.project;
                if (!project) return;
                // boot 的示例工程不能存到当前歌曲；只采集本 iframe 已确认完成注入的工程。
                const current = injectDataRef.current;
                if (!current.lyricsReady || current.songKey !== (songKey ?? null) || injectedDocumentRef.current !== target.document
                    || injectedOkRef.current !== `${current.songKey ?? ''}\u0000${current.lrc}`) return;
                let plan = (target as unknown as { J?: { ui?: { plan?: Record<string, unknown> } } }).J?.ui?.plan ?? null;
                if (final && typeof project.lyrics === 'string') {
                    // textarea 的 replanSoon 可能尚未执行，退出前先同步刷新，不能丢最后一次输入。
                    (target as unknown as { J?: { uiApi?: { replan?: () => void } } }).J?.uiApi?.replan?.();
                    plan = (target as unknown as { J?: { ui?: { plan?: Record<string, unknown> } } }).J?.ui?.plan ?? null;
                }
                if (typeof project.lyrics !== 'string' || !kineticPlanMatchesLyrics(plan, project.lyrics)) return;
                const serialized = JSON.stringify({ project, plan });
                if (serialized === lastSerialized) return;
                lastSerialized = serialized;
                // 说明：下面先发 project、再发 plan。plan 是编辑台算好的排版快照，
                // 播放页采用它就不再自己重算 —— 两边重算用的输入不同（编辑台带音频 beats，
                // 播放页没有），结果自然不一样，这正是「编辑台与播放页样式不一致」的根因。
                // 只挑渲染需要的字段：歌词、样式、种子、配色、字体、fx、比例、fps、逐行覆盖。
                /*
                 * 时间轴要过一遍校验再存。
                 *
                 * 原版的 timing.lineTimes 是「手动逐行时间」，优先级高于歌词自带的 LRC 时间
                 * （08_planner.js:212）。编辑台卡顿时算出来的这份值可能是错的，
                 * 一旦存下来，之后每次播放都会被它覆盖 —— 音画不同步且自己恢复不了。
                 *
                 * 所以存之前拿 folia 的歌词时间核对：与 LRC 偏差过大的条目直接丢掉，
                 * 只保留用户真的手动调过、且与歌词对得上的那些。
                 */
                const cleanTiming = sanitizeTiming(
                    project.timing as Record<string, unknown> | undefined,
                    lrcTimesRef.current,
                );
                const snapshot = {
                    lyrics: project.lyrics,
                    sourceLyrics: current.lrc,
                    style: project.style,
                    seed: project.seed,
                    aspect: project.aspect,
                    res: project.res,
                    fps: project.fps,
                    fx: project.fx,
                    timing: cleanTiming,
                    colors: project.colors,
                    fonts: project.fonts,
                    wordColors: project.wordColors,
                    overrides: project.overrides,
                    lang: project.lang,
                };
                /*
                 * 把编辑台算好的 plan 一起带上（发送和保存都要用它）。
                 *
                 * 只同步参数是不够的：J.plan 依赖音频 beats、背景使用历史、随机历史、
                 * 逐行锁定顺序这些运行时状态，播放页重算一遍结果会变 ——
                 * 那就是「编辑完是好的，重启之后完全不一样」的原因。
                 */
                let editorPlan: Record<string, unknown> | null = null;
                try {
                    editorPlan = (target as unknown as {
                        J?: { ui?: { plan?: Record<string, unknown> } };
                    }).J?.ui?.plan ?? null;
                } catch (planReadError) {
                    console.warn('[Kinetic] 读取编辑台 plan 失败', planReadError);
                }

                channel?.postMessage({ type: 'project', songKey, project: snapshot });
                // plan 没变就不重发（快照循环 500ms 一次，plan 大整包重发很浪费）。
                const planSig = editorPlan
                    ? JSON.stringify(editorPlan)
                    : '';
                const planUnchanged = planSig !== '' && planSig === lastPlanSigRef.current;
                if (!planUnchanged) lastPlanSigRef.current = planSig;
                if (editorPlan && !planUnchanged) {
                    channel?.postMessage({ type: 'plan', songKey, sourceLyrics: current.lrc, plan: editorPlan });
                    console.log('[Kinetic] 已发出编辑台 plan', {
                        W: editorPlan.W,
                        H: editorPlan.H,
                        style: editorPlan.styleKey,
                    });
                } else {
                    console.warn('[Kinetic] 编辑台还没有 plan，跳过同步');
                }

                // 按歌曲存下来：连同 plan 一起，换歌、重启应用都能原样还原。
                // 保存单独 try：plan 数据量大，写失败也只是回退到重算，不能丢其余字段。
                const toSave: KineticProjectSnapshot = editorPlan
                    ? { ...snapshot, plan: editorPlan } as KineticProjectSnapshot
                    : snapshot as KineticProjectSnapshot;
                try {
                    writeKineticProject(songKey, toSave);
                    console.log('[Kinetic] 编辑台工程已保存', {
                        songKey,
                        style: project.style,
                        seed: project.seed,
                        hasPlan: Boolean(editorPlan),
                    });
                } catch (saveError) {
                    console.warn('[Kinetic] 保存编辑台工程失败', saveError);
                }
            } catch (error) {
                console.warn('[Kinetic] 读取编辑台工程失败', error);
            }
        };
        // 原版 replan 是节流的（replanSoon 220ms），这里按 500ms 采一次快照足够跟上。
        const timer = window.setInterval(pushSnapshot, 500);
        return () => {
            window.clearInterval(timer);
            // 必须先抓最后一份再关闭 channel，否则 postMessage 抛错会连保存一起跳过。
            pushSnapshot(true);
            channel?.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [songKey]);

    /**
     * 接管原版的保存：导出 MP4 / PNG 序列 / AE 时改走安卓原生保存。
     *
     * 原版 J.saveFile 最后是 `a.download` + `a.click()`，在 Capacitor WebView 里既不落盘
     * 也不弹任何「保存到哪里」的面板 —— 用户按了导出像什么都没发生。
     * 这里换掉它，把 Blob 交给宿主（folia 用 Capacitor Filesystem 写公共下载目录 + Share 弹面板）。
     */
    const patchSaveFile = (target: Window) => {
        try {
            const jizura = (target as unknown as { J?: { saveFile?: (name: string, data: unknown) => Promise<string> } }).J;
            if (!jizura || typeof jizura.saveFile !== 'function') return false;
            if ((jizura as unknown as { __foliaSavePatched?: boolean }).__foliaSavePatched) return true;
            jizura.saveFile = async (filename: string, data: unknown) => {
                try {
                    const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
                    const buffer = await blob.arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    // 分块转 base64：一次 btoa 大文件会栈溢出（导出视频动辄几十 MB）。
                    let binary = '';
                    const CHUNK = 0x8000;
                    for (let i = 0; i < bytes.length; i += CHUNK) {
                        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
                    }
                    const base64 = window.btoa(binary);
                    const result = await saveExportFile({ filename, base64, mime: blob.type || 'application/octet-stream' });
                    if (result === 'cancelled') {
                        return 'declined';
                    }
                    return 'saved';
                } catch (error) {
                    console.warn('[Kinetic] 导出保存失败', error);
                    throw error;
                }
            };
            (jizura as unknown as { __foliaSavePatched?: boolean }).__foliaSavePatched = true;
            console.log('[Kinetic] 已接管原版保存：导出改走安卓原生保存');
            return true;
        } catch (error) {
            console.warn('[Kinetic] 接管原版保存失败', error);
            return false;
        }
    };

    /**
     * 编辑台加载完成后注入工程。
     *
     * 顺序很重要：先铺这首歌存过的编辑结果（用户真正在用的那份），
     * 再用 folia 当前的歌词与主题补齐没被编辑过的字段 ——
     * 这样「编辑台里看到的」和「播放页画的」是同一份东西，改了才有意义。
     */
    /*
     * 注入的代次与去重。
     *
     * 之前 inject 的重试链没有门闩：onLoad、[songKey, lrc] effect、重试 setTimeout
     * 可能并发注入多次；卸载/重挂载后旧闭包的定时器还会跑，向新 iframe 注入旧数据
     * （切歌时尤其明显 —— 这就是「歌词区还是旧词」的候选元凶之一）。
     * 现在每次 inject 调用拿一个代次号，重试前比对代次，旧链自动作废；
     * 同一 key 成功注入过一次就不再重复注入。
     */
    const injectionSeqRef = useRef(0);
    const retryTimersRef = useRef<number[]>([]);
    const injectedOkRef = useRef('');
    const injectedDocumentRef = useRef<Document | null>(null);
    React.useEffect(() => () => {
        // 卸载/重挂载：废掉所有未触发的重试。
        retryTimersRef.current.forEach(timer => window.clearTimeout(timer));
        retryTimersRef.current = [];
    }, []);
    const inject = () => {
        const target = frameRef.current?.contentWindow;
        if (!target) return;
        const seq = ++injectionSeqRef.current;
        /*
         * boot 未就绪就重试：iframe 的 onLoad 早于编辑台自己的 boot()
         * （boot 在 DOMContentLoaded 里跑，还要 bind/replan 一整套），
         * 此刻 J.ui 还不存在 —— 日志里的「工程对象未找到，跳过注入」就是它。
         * 空跑一次等于没注入，必须补几次。重试前比对代次，旧链作废。
         */
        const editor = (target as unknown as { J?: { ui?: { project?: unknown }; uiApi?: { replan?: unknown; syncUI?: unknown } } }).J;
        if (!editor?.ui?.project
            || typeof editor.uiApi?.replan !== 'function' || typeof editor.uiApi.syncUI !== 'function') {
            [200, 600, 1400, 2600].forEach(delay => {
                const timer = window.setTimeout(() => {
                    if (seq !== injectionSeqRef.current) return; // 已有更新的注入发起，这条链作废
                    const t = frameRef.current?.contentWindow;
                    if (t && (t as unknown as { J?: { ui?: unknown } }).J?.ui) inject();
                }, delay);
                retryTimersRef.current.push(timer);
            });
            console.warn('[Kinetic] 编辑台 boot 未就绪，稍后重试注入');
            return;
        }
        /*
         * 说明：这里不做「songKey 为空就跳过」的拦截。
         *
         * 之前配合同面板的归属校验加过这道防线，结果校验几乎恒为 false
         * （歌词文件的标题标签与播放器显示名经常不同），inject 被全部拦掉，
         * 编辑台一直显示原版示例歌词。旧词的真正根源（过渡歌词 selector）已修，
         * 这里恢复无条件注入 injectDataRef 里的当前歌词。
         */
        try {
            const jizura = (target as unknown as { J?: Record<string, unknown>; J_ui?: { project?: Record<string, unknown> } }).J;
            // 原版把工程暴露在 J.ui.project；直接改它再触发 replan 最可靠。
            const ui = (target as unknown as { J?: { ui?: { project?: Record<string, unknown>; uiApi?: { replan?: () => void; syncUI?: () => void } } } }).J?.ui;
            if (ui && ui.project) {
                const current = injectDataRef.current;
                const api = (target as unknown as { J?: { uiApi?: { replan?: () => void; syncUI?: () => void } } }).J?.uiApi;
                // J.ui 在脚本末尾已暴露，但 project 要等 DOMContentLoaded boot 才建立。
                if (!api?.replan || !api.syncUI) return;
                const okKey = `${current.songKey ?? ''}\u0000${current.lrc}`;
                if (injectedDocumentRef.current === target.document && injectedOkRef.current === okKey) return;
                const saved = readKineticProject(current.songKey);
                if (saved) {
                    /*
                     * 还原参数，但不还原存下来的 plan。
                     *
                     * plan 是当次编辑台会话算出来的排版快照，里面的 cuts 对应的是**当时的歌词**。
                     * 把它也铺回 project，编辑台 replan 时会用它、而不是按新歌词重算 ——
                     * 歌词就"还是旧的"（画面上是一份排版，文字对不上）。
                     * plan 只用于宿主与渲染页之间的还原（那边会先校验比例），
                     * 编辑台内部始终按当前歌词重新 plan。
                     */
                    const { plan: _stalePlan, ...params } = saved as Record<string, unknown>;
                    Object.assign(ui.project, params);
                    console.log('[Kinetic] 已还原这首歌保存的编辑结果（不含 plan）', { songKey, style: saved.style, seed: saved.seed });
                }
                // 歌词永远以 folia 当前的为准（歌换了歌词就变了）。
                // 从 ref 取：闭包里的 lrc 会停在打开编辑台那一刻。
                ui.project.lyrics = resolveKineticProjectLyrics(saved, current.lrc);
                // 没存过配色才用主题四色；存过就尊重用户在编辑台里调的那份。
                if (!saved?.colors) {
                    ui.project.colors = { ...(ui.project.colors as Record<string, unknown> || {}), ...themeColors, accentOn: true, enabled: true };
                }
                if (!saved?.fonts && fontFamily) {
                    ui.project.fonts = { ...(ui.project.fonts as Record<string, unknown> || {}), display: fontFamily };
                }
                if (theme?.wordColors) ui.project.wordColors = theme.wordColors;
                api.replan();
                api.syncUI();
                /*
                 * 日志带上注入歌词的首行与 songKey：
                 * 行数区分不了新旧歌（两首都可能 32 行），首行文本一眼可辨。
                 * 之前「注入成功但用户看到的还是旧词」无法定位是注入错还是显示错，就缺这条。
                 */
                const actualPlan = (target as unknown as { J?: { ui?: { plan?: Record<string, unknown> } } }).J?.ui?.plan ?? null;
                const textarea = target.document.getElementById('lyrics') as HTMLTextAreaElement | null;
                if (textarea?.value !== ui.project.lyrics || !kineticPlanMatchesLyrics(actualPlan, String(ui.project.lyrics))) {
                    console.warn('[Kinetic] 注入未确认，暂不保存工程', { songKey: current.songKey, seq });
                    return;
                }
                injectedOkRef.current = okKey;
                injectedDocumentRef.current = target.document;
                if (jizura) jizura.__foliaHosted = true;
                handOverPlayback(target);
                pushTimeToEditor(target, currentTimeRef.current);
                syncEditorTransport(target, playingRef.current);
                console.log('[Kinetic] 已注入原版编辑台', {
                    songKey: current.songKey,
                    lines: lines.length,
                    firstLine: (current.lrc || '').split('\n').find(row => row.replace(/\[[^\]]*\]/, '').trim())?.slice(0, 30) ?? '(空)',
                    accent: themeColors.accent,
                    restored: Boolean(saved),
                });
                // 顺手接管保存：导出/下载走安卓原生保存。
                patchSaveFile(target);
            } else {
                console.warn('[Kinetic] 原版编辑台工程对象未找到，跳过注入');
            }
            void jizura;
        } catch (error) {
            // 跨域或时机问题：编辑台仍可用，只是没带上 folia 的歌词。
            console.warn('[Kinetic] 注入原版编辑台失败', error);
        }
    };

    /**
     * 编辑台开着的时候切歌：重新注入歌词。
     *
     * 之前 inject 只挂在 iframe 的 onLoad 上，切歌时 iframe 不重载，歌词就一直是旧的。
     * 这里跟着 songKey / lrc 变化再注入一次，并把当前播放头对齐过去。
     */
    const injectRef = useRef(inject);
    injectRef.current = inject;
    React.useEffect(() => {
        const onReady = (event: MessageEvent) => {
            if (event.source !== frameRef.current?.contentWindow || event.data?.source !== 'jizura-editor'
                || event.data.type !== 'ready') return;
            injectRef.current();
        };
        window.addEventListener('message', onReady);
        return () => window.removeEventListener('message', onReady);
    }, []);
    const injectedKeyRef = useRef('');
    React.useEffect(() => {
        const target = frameRef.current?.contentWindow;
        if (!target) return;
        const key = `${songKey ?? ''}\u0000${lrc}`;
        // 首帧由 iframe 的 onLoad 负责注入，但这里也要把 key 记下来 ——
        // 之前这里是 return 而不记录，等于每次变化都被当成"首次"，反而漏掉了真正的那次变化。
        if (injectedKeyRef.current === key) return;
        injectedKeyRef.current = key;
        inject();
        // 歌词可能在暂停/恢复进度后才到达，不能假设这次变化等于从 0 开始播放。
        pushTimeToEditor(target, currentTimeRef.current);
        console.log('[Kinetic] 歌曲/歌词变了，已重新注入编辑台', { songKey, lines: lines.length });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [songKey, lrc]);

    return (
        <div className="fixed inset-0 z-[80] flex flex-col bg-black" data-kinetic-editor>
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 bg-neutral-950 px-3">
                <span className="text-xs text-neutral-300">JIZURA 原版编辑台</span>
                <Button variant="quiet" size="sm" onClick={onClose} aria-label="退出编辑台">
                    <X className="h-4 w-4" />
                    <span className="ml-1 text-xs">退出</span>
                </Button>
            </div>
            <iframe
                ref={frameRef}
                src="/jizura/editor.html"
                title="JIZURA 原版编辑台"
                className="h-full w-full flex-1 border-0 bg-black"
                allow="clipboard-write"
                onLoad={inject}
            />
        </div>
    );
};

export default KineticEditorOverlay;
