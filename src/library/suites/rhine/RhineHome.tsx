import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryHomeSurfaceProps } from '../../core/suite/suite.contract';
import { useLibraryHomeFeed } from '../../core/home/online/useLibraryHomeOnlineFeeds';
import { buildRhinePayload, queueOf, searchIdOf, songToSearchRecord, type RhinePayload } from './rhinePayload';
import { omni } from '../../../services/onlineMusic/omni';
import { activeProviderId } from '../../../services/onlineMusic/omni/activeProvider';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { useSettingsModalStore } from '../../../stores/useSettingsModalStore';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { getPhoneInsets, subscribePhoneInsets } from '../../../services/phoneInsets';
import { usePlaybackStore, selectDisplayPlayerState } from '../../../stores/usePlaybackStore';
import { useRhineOverlayStore } from '../../../stores/useRhineOverlayStore';
import { PlayerState } from '../../../types';
import RhineVisualOverlay, { type RhineCardRect } from './RhineVisualOverlay';

/**
 * 当前是否有一个**登录了**的在线平台。
 *
 * `omni.searchSongs` 在没登录时不会报错，只是安静地回一个空页；界面那边就
 * 分不清「搜不到」和「没登录」。这里补上这个判断，好让提示说人话。
 */
const hasActiveOnlineProvider = (): boolean => {
    const accounts = useOnlineProviderAccountStore.getState();
    const id = activeProviderId();
    const record = (accounts as { accounts?: Record<string, { loggedIn?: boolean }> }).accounts?.[id];
    return Boolean(record?.loggedIn);
};
import { openLoginWindow } from '../../../components/login/loginWindowStore';
import { Button } from '../../../components/ui/Button';
import { LogIn } from 'lucide-react';

// src/library/suites/rhine/RhineHome.tsx
//
// 「莱茵生命」首页。
//
// 三维档案阵列**不再由原生 Filament 渲染**：那套桥太重，一个相机参数或贴图生命周期
// 出问题就整屏黑、点不中、滑不动。这里直接嵌入 RhineLabUI
// （https://github.com/LBEILC/RhineLabUI，TypeScript + Three.js）的构建产物，
// 它自带五列循环档案阵列、开屏动画、音效与 BGM，全部在网页层完成，
// 不会再和原生窗口抢前台。
//
// 静态资源在 `public/rhinelab/`，构建后随 `dist` 一起进 APK。

const RHINE_PAGE = './rhinelab/rhine.htm#folia';

/*
 * 清掉三维阵列的「续播」标记。
 *
 * RhineLabUI 在用户点播放时往 sessionStorage 写 `rhine-resume=1`，之后每次加载
 * 只要读到它就 `ei("archive")` —— 直接跳到档案阵列，**整段开屏连同 `array`
 * 阶段（`SELECTING FILES...`）一起跳过**。表现就是「开屏动画还是在完成播放」：
 * 一进来几秒就到底了，那 22 秒的 ACCESS / LOGO / AUTH 全没有。
 *
 * 这个标记本来是给「切走再切回来别重放开屏」用的，但 Folia 这边首页是常驻挂载
 * 的，iframe 不会重载 —— 能走到这里的都是真正重新进入。所以每次挂载都清掉，
 * 让开屏老老实实播完。
 *
 * 必须由**宿主**清：iframe 是独立 browsing context，读的是同一个 origin 的
 * sessionStorage，宿主先写掉、它启动时自然读到空。iframe 内联脚本跑得比 onLoad
 * 早，所以挂在组件挂载期，不能挂在 onLoad 里。
 */
const clearResumeFlag = (): void => {
    try {
        window.sessionStorage.removeItem('rhine-resume');
    } catch (error) {
        // 私密模式等场景下 sessionStorage 可能不可写，开屏本来也就不受影响。
        console.warn('[rhine] 无法清除续播标记', error);
    }
};

const RhineHome = (props: LibraryHomeSurfaceProps): React.ReactElement => {
    const { t, i18n } = useTranslation();
    const { cloudPlaylist } = props;
    // 宿主会 filter 出新数组；集合对象和顺序没变时沿用输入，切歌不重新读曲目。
    const playlistsRef = useRef(props.playlists);
    if (playlistsRef.current !== props.playlists && (
        playlistsRef.current?.length !== props.playlists?.length
        || !playlistsRef.current?.every((collection, index) => collection === props.playlists?.[index])
    )) {
        playlistsRef.current = props.playlists;
    }
    const playlists = playlistsRef.current;
    // 资源实例寿命稳定，收藏专辑内容的变化必须订阅；只看 data，状态切换不重抓曲目。
    const { data: favoriteAlbums } = useLibraryHomeFeed(props.homeResources.favoriteAlbums);
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    /*
     * 开屏前先清续播标记：否则整段开屏（含 SELECTING FILES）会被跳过。
     *
     * 用 layout effect 而不是普通 effect：iframe 的 src 在首次绘制时就生效了，
     * 内联脚本随时可能跑；layout effect 在浏览器绘制前、且早于 iframe 加载，
     * 是能稳定赶在它前面的那一档。
     */
    useLayoutEffect(() => {
        clearResumeFlag();
    }, []);
    const [ready, setReady] = useState(false);
    /** 转换好的曲库载荷；iframe 就绪后推给它。 */
    const payloadRef = useRef<RhinePayload | null>(null);
    /*
     * 叠层显不显示。
     *
     * 两个条件都要满足：用户在设置里打开了「卡片变成歌词可视化」，且有歌可显示。
     * 开关在设置 → 播放页里（见 useRhineOverlayStore 的注释）。
     */
    const currentSong = usePlaybackStore(state => state.currentSong);
    const cardVisualizer = useRhineOverlayStore(state => state.cardVisualizer);
    const overlayVisible = cardVisualizer && Boolean(currentSong);
    /*
     * 卡片的屏幕矩形。
     *
     * 卡片在三维空间里，位置由相机投影决定，**不跟屏幕尺寸成比例**，宿主算不出来。
     * 所以由 iframe 那边用 bundle 自己的 projectCard 投影四个角，postMessage 送过来
     * （见 folia-rhine-overlay.js 的 publishCardRect）。
     *
     * 它跟着渲染循环跑，但只在像素级变化时才发，静止时没有消息。
     */
    const [overlayRect, setOverlayRect] = useState<RhineCardRect | null>(null);
    /** iframe 那边量矩形失败的原因；有值就说明链路断在里面。 */
    const [overlayRectError, setOverlayRectError] = useState<string | null>(null);
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const data = event.data as
                | { type?: string; rect?: RhineCardRect; reason?: string }
                | null;
            if (!data) return;
            if (data.type === 'rhine-card-rect-failed') {
                setOverlayRectError(String(data.reason ?? '未知原因'));
                return;
            }
            if (data.type !== 'rhine-card-rect' || !data.rect) return;
            const { left, top, width, height } = data.rect;
            if (![left, top, width, height].every(value => Number.isFinite(value))) return;
            setOverlayRectError(null);
            setOverlayRect({ left, top, width, height });
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    /*
     * 临时自检：把叠层链路的状态写到 document.title。
     *
     * 上一版把诊断画在屏幕上，结果「左上角什么都没有」—— 要么组件没渲染，要么
     * 被别的层盖住，屏幕上分不出来。title 不受任何层叠、裁切影响，写上去就一定
     * 反映真实执行情况。确认完删掉。
     */
    useEffect(() => {
        document.title = [
            'R',
            `v=${overlayVisible ? 1 : 0}`,
            `cv=${cardVisualizer ? 1 : 0}`,
            `s=${currentSong ? 1 : 0}`,
            `r=${overlayRect ? Math.round(overlayRect.width) : 0}`,
            `e=${overlayRectError ? 1 : 0}`,
        ].join(' ');
    }, [overlayVisible, cardVisualizer, currentSong, overlayRect, overlayRectError]);

    /*
     * 告诉 iframe「叠层要不要占这块卡片」。
     *
     * 开关打开时它会把两个圆环藏掉 —— 不藏的话，环和宿主那层可视化会叠成双层图，
     * 看起来像画面花掉。有歌就开、没歌就关，圆环恢复原样。
     */
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame?.contentWindow) return;
        frame.contentWindow.postMessage(
            { type: 'rhine-overlay', overlay: { enabled: overlayVisible } },
            '*',
        );
    }, [overlayVisible, ready]);

    /** 当前界面语言，跟着 Folia 的设置走。 */
    const language = i18n.resolvedLanguage || i18n.language || 'en';
    /** 把载荷 postMessage 进 iframe。曲目对象原样带走，点开档案时要用它播放。 */
    const pushPayload = useCallback((): void => {
        const frame = frameRef.current;
        const payload = payloadRef.current;
        if (!frame?.contentWindow || !payload) return;
        frame.contentWindow.postMessage({ type: 'rhine-library', payload }, '*');
    }, []);

    /*
     * 把语言、明暗主题和安全区送进三维阵列。
     *
     * 那边是独立的网页，取不到 Folia 的 i18n / 主题 store / CSS 变量，只能
     * 由这里推过去。单独发一条消息而不是塞进载荷：换语言或切主题时不用重算
     * 整个曲库，那边收到就地重绘。
     *
     * 安全区尤其重要：安卓 WebView 里 `env(safe-area-inset-*)` 基本报 0，
     * iframe 里更拿不到宿主的 `--folia-safe-area-*` 变量。真实值由原生侧算好
     * （phoneInsets），这里必须显式送进去，否则顶部那排按钮永远压在状态栏下面。
     */
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const pushInsets = useCallback((frame: HTMLIFrameElement | null): void => {
        if (!frame?.contentWindow) return;
        const insets = getPhoneInsets();
        frame.contentWindow.postMessage({ type: 'rhine-insets', insets }, '*');
    }, []);
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame?.contentWindow) return;
        frame.contentWindow.postMessage({ type: 'rhine-language', language }, '*');
        frame.contentWindow.postMessage(
            { type: 'rhine-theme', theme: isDaylight ? 'light' : 'dark' },
            '*',
        );
        pushInsets(frame);
    }, [language, isDaylight, ready, pushInsets]);
    // 转屏、进全屏、状态栏收放都会改变安全区，跟着推。
    useEffect(() => subscribePhoneInsets(() => pushInsets(frameRef.current)), [pushInsets]);

    /*
     * 开屏只从 SELECTING FILES 那一段开始播。
     *
     * 完整开屏是 22 秒：ACCESS → LOGO → AUTH → SCAN → WELCOME，然后才轮到
     * `SELECTING FILES...`（n=22）和卡片入场（n≈25.7）。用户要的是**跳过前面那段**，
     * 直接看后面这部分。
     *
     * RhineLabUI 自己暴露了 `window.rhine.seek(n)`：它做的是 `Gi = now - n`，
     * 于是时间轴立刻落到第 n 秒。这里等 iframe 就绪后调一次，n 取 22。
     *
     * 为什么不是更早或更晚：
     *   - 开屏的解锁条件是 `e - Gi >= 22.76`。seek 到 22 之后，这个条件在
     *     0.76 秒后自然满足，`Sf` 正常置位，时间轴继续往前走 —— 不会卡死。
     *   - 取 22 是因为那正是 `SELECTING FILES...` 开始打字的时刻；更早会带出
     *     WELCOME 那一段，更晚就错过打字机了。
     *
     * 只在这一个挂载周期里跳一次：iframe 常驻挂载，重复 seek 会把已经走到的
     * 动画拽回去。
     */
    const bootSeekedRef = useRef(false);
    useEffect(() => {
        const frame = frameRef.current;
        if (!ready || !frame?.contentWindow || bootSeekedRef.current) return;

        /*
         * `window.rhine` 是 bundle 尾部才挂上的，比 iframe 的 load 事件晚一档；
         * 场景就绪（`ri`）之前调 seek 也没有意义。所以这里短轮询几次，
         * 拿到就跳、跳完就停 —— 不是无限轮询，5 秒还没等到就放弃。
         */
        let tries = 0;
        const timer = window.setInterval(() => {
            tries += 1;
            const target = frame.contentWindow as (Window & {
                rhine?: { seek?: (seconds: number) => void };
            }) | null;
            if (typeof target?.rhine?.seek === 'function') {
                try {
                    target.rhine.seek(22);
                    bootSeekedRef.current = true;
                } catch (error) {
                    console.warn('[rhine] 跳过开屏失败', error);
                }
                window.clearInterval(timer);
                return;
            }
            if (tries >= 25) window.clearInterval(timer);
        }, 200);

        return () => window.clearInterval(timer);
    }, [ready]);

    /*
     * 首页被盖住时让三维场景停下来。
     *
     * 首页现在是常驻挂载的（为了从歌词页退回来时 iframe 不被销毁），代价是
     * 它会在后台继续跑 raf：一边是 Three.js 的全速渲染，一边是歌词可视化
     * 自己在画的东西，两个抢 GPU，表现出来就是「进了可视化特别卡」。
     *
     * `isInteractive` 就是「首页此刻真的在台前」——它由宿主的可见性算出来，
     * 进集合页、进歌词页、被弹窗盖住都会变 false。跟着它暂停/恢复最省心，
     * 也不用在 iframe 里猜自己是不是被挡住了。
     */
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame?.contentWindow) return;
        frame.contentWindow.postMessage(
            { type: 'rhine-visibility', visible: Boolean(props.isInteractive) },
            '*',
        );
    }, [props.isInteractive, ready]);

    /*
     * 渲染策略。
     *
     * 三维阵列自己已经有视锥剔除和「画面没变就不重画」，缺的是**上限**：它在
     * 台前时按屏幕刷新率全速跑，安卓上一小时就是实打实的发热和耗电。
     *
     * 这里只给上限，不规定它内部怎么画：台前 60 帧 / 静止 12 帧 / DPR 压到 1.5。
     * 像素比是这里面最有效的一条 —— 高 DPR 屏按 2.5 倍画，像素量是 1.5 倍的近三倍。
     *
     * `activeMs` 给到 9 秒、`bootGraceMs` 给到 40 秒都是有原因的：开屏那 22 秒、
     * 卡片入场那约 6 秒的波浪都是时间驱动的，没有手指输入。窗口太短（原来是
     * 900ms / 无宽限期）它们就被当成「静止」压到 12 帧，看着就是动画在掉帧。
     * 补丁脚本在 rhinelab/folia-rhine-patch.js，消息在 rhine.htm 的桥里落地。
     */
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame?.contentWindow) return;
        frame.contentWindow.postMessage(
            {
                type: 'rhine-policy',
                policy: {
                    maxFps: 60,
                    idleFps: 12,
                    activeMs: 9000,
                    bootGraceMs: 40000,
                    maxPixelRatio: 1.5,
                },
            },
            '*',
        );
    }, [ready]);

    /*
     * 曲库 → 三维阵列。
     *
     * iframe 一上来就加载，开屏动画立刻开始播 —— 它本身就是这期间的加载动画，
     * 比之前「先白屏等数据算完再挂 src」体感好得多。
     *
     * 三维阵列那边已经配合改成「先跑开屏，收到曲库再建场景」，
     * 所以这里不需要再等：数据一到就推，推早了那边会先存着。
     */
    useEffect(() => {
        let disposed = false;
        void buildRhinePayload({ playlists, cloudPlaylist, favoriteAlbums })
            .then(payload => {
                if (disposed || !payload) return;
                payloadRef.current = payload;
                pushPayload();
            })
            .catch(error => console.warn('[rhine] 曲库转换失败', error));
        return () => {
            disposed = true;
        };
    }, [playlists, cloudPlaylist, favoriteAlbums, pushPayload]);

    /*
     * 播放 / 入队。
     *
     * 三维阵列那侧只认 `record.id`，认不出这是 Folia 的哪一首歌；这里用 `songs`
     * 表把它翻回原始曲目。
     *
     * **第二个参数是队列**：之前传 `undefined`，于是点一首歌就真的只播那一首，
     * 播完即停。这里把同一列（同一个歌单）的歌按列内顺序整段传进去，
     * 播放列表就是「这个歌单全部歌曲」，和网格界面双击歌单的行为一致。
     */
    useEffect(() => {
        const play = props.onPlaySong;
        const enqueueAll = props.onAddAllToQueue;
        const onMessage = (event: MessageEvent): void => {
            const frame = frameRef.current?.contentWindow;
            if (!frame || event.source !== frame) return;
            const data = event.data as { type?: string; id?: string; query?: string } | null;
            if (!data) return;

            /*
             * 平台搜索。
             *
             * 三维阵列里的 ARCHIVE INDEX 原本只能搜已经进了歌单的歌。这里让
             * 它直接问 Folia 的在线曲库（`omni.searchSongs`），结果按同一套
             * 档案格式回传 —— 搜到什么就能直接播、直接入队。
             */
            /*
             * 直接开 Folia 自己的设置 / 搜索。
             *
             * 三维阵列里那套 SYSTEM SETTINGS 和 ARCHIVE INDEX 只覆盖它自己
             * 那几个项；Folia 的设置（主题、语言、资料库界面、播放……）和原版
             * 搜索框才是完整的那一份。与其在 iframe 里复刻一遍，不如把这两个
             * 入口指回宿主 —— 用户点「设置」看到的就是他熟悉的那个设置。
             */
            if (data.type === 'rhine-open-settings') {
                useSettingsModalStore.getState().openSettings('options');
                return;
            }
            if (data.type === 'rhine-open-search') {
                const query = typeof data.query === 'string' ? data.query.trim() : '';
                if (query) {
                    const store = useSearchNavigationStore.getState();
                    store.setSearchQuery(query);
                    void store.submitSearch({
                        query,
                        sourceTab: 'all',
                        deps: {
                            localSongs: props.localSongs,
                            localLibraryCatalog: props.localLibraryCatalog,
                            t: (key: string, fallback?: string) => fallback ?? t(key),
                        },
                        returnView: 'player',
                    });
                }
                return;
            }

            if (data.type === 'rhine-search') {
                const query = typeof data.query === 'string' ? data.query.trim() : '';
                if (!query) {
                    frame.postMessage({ type: 'rhine-search-result', query, records: [] }, '*');
                    return;
                }
                void omni
                    .searchSongs(query, { limit: 24, offset: 0 })
                    .then(page => {
                        const songs = (page?.items ?? []) as unknown[];
                        /*
                         * `omni.searchSongs` 在没有登录平台、或者当前平台不支持
                         * 搜索时**不抛错**，直接回一个空页。那种情况下界面只是
                         * 「没结果」，用户完全看不出是没登录还是真的搜不到。
                         * 带上 `reason` 让三维阵列那边把话说清楚。
                         */
                        const reason = songs.length
                            ? undefined
                            : hasActiveOnlineProvider()
                              ? 'empty'
                              : 'no-provider';
                        frame.postMessage(
                            {
                                type: 'rhine-search-result',
                                query,
                                records: songs.map(songToSearchRecord),
                                songs: Object.fromEntries(
                                    songs.map(song => [searchIdOf(song), song]),
                                ),
                                reason,
                            },
                            '*',
                        );
                    })
                    .catch((error: unknown) => {
                        frame.postMessage(
                            {
                                type: 'rhine-search-result',
                                query,
                                records: [],
                                error: String((error as { message?: string })?.message ?? error),
                            },
                            '*',
                        );
                    });
                return;
            }

            if (typeof data.id !== 'string') return;
            if (data.type !== 'rhine-play' && data.type !== 'rhine-enqueue') return;
            const payload = payloadRef.current;
            const song = payload?.songs[data.id];
            if (!payload || !song) return;

            // 这个 id 在哪一列，就把整列当作队列。
            const queue = queueOf(payload, data.id);

            if (data.type === 'rhine-enqueue') {
                const list = queue.length > 1 ? queue : [song];
                if (enqueueAll) enqueueAll(list as never[]);
                else if (props.onAddSongToQueue) props.onAddSongToQueue(song as never);
                return;
            }

            play(song as never, queue.length ? (queue as never[]) : undefined, false, undefined);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [props.onPlaySong, props.onAddAllToQueue, props.onAddSongToQueue, props.localSongs, props.localLibraryCatalog, t]);


    /*
     * 登录入口。
     *
     * 三维阵列整块是 iframe，网页层这边只剩这一个常驻按钮 —— 曲库为空（没登录、
     * 没本地扫描）时它是唯一的出路。
     *
     * 放**顶部左侧**：底部那一条被 RhineLab 自己的东西占满了
     * （ARCHIVE / SELECT、COLUMN 导航、SESSION AUTHORIZED、REINITIALIZE），
     * 再叠一个按钮就会压住它们；顶部这一行只有品牌标题，左边正好是空的。
     */
    const loginButton = (
        <div
            /*
             * 不要 `lattice-back`：那个类是别的 suite 给「浮在磁贴墙上」的按钮
             * 配的毛玻璃圆环底。这里背后是一整块浅色三维场景，圆环和 Button
             * 自己的实心底叠在一起就是两个形状打架。
             *
             * 位置让开顶部安全区：三维阵列的 `.brand` 就在左上角，按钮压在它
             * 身上会盖住大半个 RHINE LAB 标题。往下放到品牌块下面那一带，
             * 仍然贴着左边，不挡任何东西。
             */
            className="absolute z-50"
            style={{
                left: 'calc(12px + var(--folia-safe-area-left, 0px))',
                top: 'calc(96px + var(--folia-safe-area-top, 0px))',
            }}
        >
            <Button
                variant="fill"
                icon={LogIn}
                onClick={(event: React.MouseEvent<HTMLElement>) => openLoginWindow(null, event.currentTarget)}
            >
                {t('home.login')}
            </Button>
        </div>
    );

    return (
        <div className="relative h-full w-full overflow-hidden" data-rhine-home="1" style={{ background: '#e8e5e1' }}>
            {/*
                内嵌的三维档案阵列。不带 sandbox：它要自己用 WebAudio / localStorage /
                IndexedDB 缓存模型和音频，sandbox 一加这些全被挡掉、开屏动画直接静音失败。
            */}
            <iframe
                ref={frameRef}
                title={t('libraryRhine.stageTitle')}
                src={RHINE_PAGE}
                className="absolute inset-0 h-full w-full border-0"
                style={{ background: '#e8e5e1' }}
                allow="autoplay; fullscreen"
                onLoad={() => {
                    setReady(true);
                    pushPayload();
                }}
            />

            {/*
                可视化叠层：压在三维画布上，盖住那两个圆环（见 RhineVisualOverlay.tsx）。
                它是 `pointer-events-none`，不抢 iframe 的手势 —— 拖动仍然由里面的
                三维阵列处理，叠层只是跟着 `rotation` 平移。
            */}
            <RhineVisualOverlay
                state={{ visible: overlayVisible, rect: overlayRect, rectError: overlayRectError }}
            />

            {/*
                开屏完成前先盖一层同色底，避免 iframe 白闪。
                它不拦截任何事件，只是遮住加载瞬间。
            */}
            {!ready && (
                <div
                    className="pointer-events-none absolute inset-0 z-40"
                    style={{ background: '#e8e5e1' }}
                />
            )}

            {loginButton}
        </div>
    );
};

export default RhineHome;
