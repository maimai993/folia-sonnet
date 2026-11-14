// src/services/backgroundMarket/apply.ts
//
// 把市场里选中的背景真正应用到目标位置。
//
// 这一步的核心不是「下载」，而是**让选中的东西真的显示出来**。
// 下载成功只代表素材到位；不把对应的开关打开、不把来源切过去，
// 文件就只是躺在那里，画面一点变化都没有。
//
// 两个目标各有一套开关，都要显式拨到位：
//
//   桌面壁纸  → 原生壁纸层的 background 模式（video / image）
//   可视化页面 → 图片：切到 monet 模式 **且** 把来源设为自定义图
//               视频：走「歌词后方视频层」，填地址并自动启用
//
// 「只切模式、不切来源」是踩过的坑：monet 默认画的是封面派生图，
// 用户从市场选了图却仍看到封面，只会认为功能无效。

import { isCapacitorAndroid } from '../../platform/runtime';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { useVideoLayerSettingsStore } from '../../stores/useVideoLayerSettingsStore';
import { resolveMarketMediaUrl, type BackgroundMarketItem } from './index';
import { emitBackgroundProgress } from './progress';
import {
    adoptDownloadedVideoAsWallpaperFile,
    downloadWallpaperImageFromUrl,
    downloadWallpaperVideoFromUrl,
    openLyricsWallpaperPicker,
} from '../../platform/foliaWallpaper';
import { uploadMonetBackgroundImage } from '../../components/visualizer/backgrounds/monet/imageUpload';
import { downloadNativeVideoLayerFile } from '../../platform/foliaNative';
import type { BackgroundTarget } from '../../components/modal/settings/pages/integration/market/useBackgroundApplyTarget';

/** 可视化页面里能吃自定义图片的那一档背景模式。 */
const VISUALIZER_IMAGE_MODE = 'monet';

/**
 * 视频背景时选的底层背景。
 *
 * `sora` 是「静态纯色，不渲染星空」，正是官方说明里用来搭配视频层的模式 ——
 * 背景不抢画面，视频层在上面才看得清。
 */
const VISUALIZER_VIDEO_FRIENDLY_MODE = 'sora';

export interface ApplyBackgroundResult {
    ok: boolean;
    error: string | null;
    /** 应用成功但需要告诉用户的一句话（比如要先去授权）。 */
    notice?: string;
}

/**
 * 先把网络图抓成 File。
 *
 * 为什么不直接把远程 URL 塞进 <img>：站点图片地址带防盗链与临时签名，
 * 今天能看、过两天就 403。落成本地文件才稳，而且能和用户手选上传的图走同一条路。
 */
const fetchAsFile = async (url: string, name: string): Promise<File | null> => {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        /*
         * 「App 内」这条路原先是没有进度的：一个 `response.blob()` 闷头下完，
         * 设置页那条进度条只在桌面壁纸（原生下载）时才动 —— 用户看到的就是
         * 「选桌面会走进度，选 App 内不走」。
         *
         * 这里改成按流读、边读边报：总长已知就报真实比例，不知道就按已读字节
         * 缓慢逼近 0.9（留出编码与写库那一段，和 progress.ts 的 5% 同一个道理）。
         */
        const total = Number(response.headers.get('content-length') || 0);
        if (!response.body) {
            const fallback = await response.blob();
            const type = fallback.type || 'image/jpeg';
            const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
            return new File([fallback], `${name}.${extension}`, { type });
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                received += value.byteLength;
                if (total > 0) {
                    emitBackgroundProgress(Math.min(0.95, received / total));
                } else {
                    emitBackgroundProgress(Math.min(0.9, received / (received + 2_000_000)));
                }
            }
        }
        const type = response.headers.get('content-type') || 'image/jpeg';
        const blob = new Blob(chunks as BlobPart[], { type });
        const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
        /*
         * 读完了报满。图片通常只有几百 KB，一轮流可能一帧都刷不出来 ——
         * 不补这一下，进度条会停在 0% 或者停在某个中间值，看起来就是「没动」。
         */
        emitBackgroundProgress(0.95);
        return new File([blob], `${name}.${extension}`, { type });
    } catch {
        return null;
    }
};

/**
 * 把图片设成**歌词样式·莫奈的自定义肖像**，但不动当前选中的歌词样式。
 *
 * 注意走的不是背景图那一套：莫奈的肖像（`portraitSource` / `handleUploadMonetPortraitImage`）
 * 和它的背景图（`backgroundSource` / `handleUploadMonetBackgroundImage`）是两处独立的存储，
 * 画的位置也不同 —— 市场里选「莫奈」要换的是前面那张肖像。
 *
 * 不切 visualizerMode：用户可能正用着别的歌词样式，只是想先把莫奈这张备好。
 */
const applyImageToMonetPortrait = async (
    url: string,
    itemId: string,
    shared?: File | null,
): Promise<string | null> => {
    // 已经为别的目标下过同一张图就直接用，不再走一次网络（见 applyMarketBackground 里的共用逻辑）。
    const file = shared ?? await fetchAsFile(url, itemId);
    if (!file) return '图片下载失败';

    const uploadPortrait = useVisualizerSettingsStore.getState().handleUploadMonetPortraitImage;
    if (!uploadPortrait) return '当前版本不支持设置莫奈肖像';

    // 走莫奈自己那套上传 action（写库 + 更新 store + 提示），这里不另写实现。
    const uploaded = await uploadPortrait([file]);
    if (!uploaded.ok) return uploaded.error ?? '图片保存失败';

    /*
     * 传完要把来源拨到位，否则用户看到的就是「上传成功但画面上没变」：
     *   portraitSource → custom，不然画的还是封面。
     *
     * 不再需要另设 `showPortrait`：#1124 之后「显不显示肖像」就是 `portraitSource`
     * 的一个取值（`none` 表示不显示），`custom` 本身就意味着要把它画出来。
     */
    const store = useVisualizerSettingsStore.getState();
    store.handleSetMonetTuning({
        ...store.monetTuning,
        portraitSource: 'custom',
    });
    return null;
};

/**
 * 把图片设成可视化页面的背景。
 *
 * 两步都必须做：
 *   1. 切到 monet 模式（当前若停在别的背景样式，图存得再好也不会被画出来）
 *   2. 把 monet 的来源设成 uploaded-global（默认是封面派生图）
 */
const applyImageToVisualizer = async (
    url: string,
    itemId: string,
    shared?: File | null,
): Promise<{ error: string | null; file: File | null }> => {
    // 同上：同一张图只下一次。
    const file = shared ?? await fetchAsFile(url, itemId);
    if (!file) return { error: '图片下载失败', file: null };

    const uploaded = await uploadMonetBackgroundImage([file]);
    if (!uploaded.ok) return { error: uploaded.error ?? '图片保存失败', file: null };

    const settings = useVisualizerSettingsStore.getState();
    settings.handleSetVisualizerBackgroundMode(VISUALIZER_IMAGE_MODE);
    /*
     * 切完模式再取一次 state：handleSetVisualizerBackgroundMode 会写 store，
     * 但签名这一份里 backgroundSource 还是旧值，直接展开会把来源带回封面。
     */
    const tuning = useVisualizerSettingsStore.getState().monetBackgroundTuning;
    useVisualizerSettingsStore.getState().handleSetMonetBackgroundTuning({
        ...tuning,
        backgroundSource: 'uploaded-global',
    });

    /*
     * 把视频层关掉。
     *
     * 视频层和背景图是两层叠着画的：它不关的话，用户明明选了图片，
     * 屏幕上还是被那段视频盖住 —— 看起来像「换图没生效」。
     * 之前只有设视频时才会碰视频层，设图片时没人管它，于是留下了这个洞。
     */
    const video = useVideoLayerSettingsStore.getState();
    if (video.videoLayerEnabled) {
        video.setVideoLayerEnabled(false);
    }
    // 把这份 File 交回去：同一张图还要存进「莫奈肖像」时不必再下一次。
    return { error: null, file };
};

/**
 * 把视频设成可视化页面的背景。
 *
 * 全程「下载到本地 → 走视频层那条上传路径」，不把网络地址直接塞给 <video>：
 * 视频地址带签名和防盗链，今天能播、过几天就 403 黑屏。
 *
 * 设置要一起拨对，否则看起来就是「设了没反应」：
 *   1. 清掉旧的本地视频 —— 它的优先级高于新文件
 *   2. 打开开关 —— 没开就一层都不画
 *   3. 不透明度拉满 —— 之前调低过的话视频淡得几乎看不见
 *   4. 背景切到不抢画面的那一档 —— 否则视频被不透明的背景整个盖住
 */
/**
 * 把视频设成可视化页面的背景。
 *
 * 全程「下载到本地 → 走视频层那条上传路径」，不把网络地址直接塞给 <video>：
 * 视频地址带签名和防盗链，今天能播、过几天就 403 黑屏。
 *
 * 设置要一起拨对，否则看起来就是「设了没反应」：
 *   0. 卸掉并删除旧的本地视频 —— 排在下载之前，见下面的注释
 *   1. 清掉旧的本地视频 —— 它的优先级高于新文件
 *   2. 打开开关 —— 没开就一层都不画
 *   3. 不透明度拉满 —— 之前调低过的话视频淡得几乎看不见
 *   4. 背景切到不抢画面的那一档 —— 否则视频被不透明的背景整个盖住
 */
const applyVideoToVisualizer = async (
    mediaUrl: string,
): Promise<{ error: string | null; path: string | null }> => {
    /*
     * 顺序很要紧：**先把旧的卸掉并删除，再去下新的**。
     *
     * 两个原因：
     *   · 播放时 localFileUrl 的优先级高于 videoLayerUrl（见 VideoLayer），
     *     旧地址还留着，新下载的这个就永远不会被播放 —— 看起来就是「换了没反应」；
     *   · 原生那边新文件写的还是同一个 cache 路径，旧文件还在被播放器占着的话
     *     既删不干净也覆盖不完全，换上去常常还是旧内容。
     *
     * clearLocalFile 是视频层自己的清理入口（卸载 + 删 IndexedDB + 删原生副本），
     * 这里直接用它，不另写一套。
     */
    /*
     * 清理失败也绝不能把下载堵住。
     *
     * clearLocalFile 里有原生调用（删私有目录里的副本），原生那侧一旦不 resolve，
     * 整个应用流程就卡在这一句 —— 表现是「进度条一直 0%，而且压根没在下」。
     * 所以给它一个上限，超时就往下走：最坏情况只是旧的没删干净，
     * 但新视频下得下来、也能播。
     */
    const stale = useVideoLayerSettingsStore.getState();
    if (stale.localFileUrl || stale.localFileName) {
        /*
         * 清理超时也**必须**把 localFileUrl 从界面上摘掉。
         *
         * VideoLayer 取源是 `localFileUrl ?? videoLayerUrl`（见 VideoLayer.tsx），
         * 前者优先。clearLocalFile 里有一段原生调用，原生不 resolve 时整条链就卡住，
         * 超时之后我们往下走、视频也下好了 —— 但那个旧的 localFileUrl 还挂着，
         * 于是画面放的始终是上一支视频，看起来就是「换了没反应，重启才好」。
         * 先把它清空，让 source 回落到新下载的 videoLayerUrl。
         */
        await Promise.race([
            stale.clearLocalFile(),
            new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
        ]).catch(() => undefined);
        const afterClear = useVideoLayerSettingsStore.getState();
        if (afterClear.localFileUrl || afterClear.localFileName) {
            try {
                afterClear.setLocalFileDropped();
            } catch {
                // 极端情况下拿不到这个方法也不该挡住后面的下载。
            }
        }
    }

    /*
     * 必须带 progressId：原生那边没有它就直接跳过发进度事件，
     * 几十 MB 的视频在界面上就是「一直转圈、进度条不动」。
     * 和桌面壁纸那条路用的是同一个 id —— 同一时刻只会有一个背景在下载。
     */
    const downloaded = await downloadNativeVideoLayerFile(mediaUrl, 'background-market');
    if (!downloaded.ok || !downloaded.url) {
        return { error: downloaded.error ?? '视频下载失败', path: null };
    }

    // 重新取一次：clearLocalFile 会改 store，上面那份是旧快照。
    const next = useVideoLayerSettingsStore.getState();
    /*
     * 换源时必须把上一份的地址显式覆盖掉。
     *
     * setVideoLayerUrl 只写新值，但上一次设置留下的 blob / 回环地址还在；
     * 先清成空串再写，避免中间那一帧拿到过期的地址去加载，
     * 那就是「打开显示加载失败的黑白缩略图」的来源。
     */
    next.setVideoLayerUrl('');
    const fresh = useVideoLayerSettingsStore.getState();
    fresh.setVideoLayerUrl(downloaded.url);
    fresh.setVideoLayerEnabled(true);
    fresh.setVideoLayerOpacity(1);
    fresh.setVideoLayerFit('cover');

    const settings = useVisualizerSettingsStore.getState();
    if (settings.visualizerBackgroundMode !== VISUALIZER_VIDEO_FRIENDLY_MODE) {
        settings.handleSetVisualizerBackgroundMode(VISUALIZER_VIDEO_FRIENDLY_MODE);
    }
    // 落盘路径带回给调用方：桌面壁纸要用同一份文件，不再下一次。
    return { error: null, path: downloaded.path };
};

/**
 * 把已经下好的那份视频装成桌面壁纸。
 *
 * 「桌面壁纸 + App 内」同时勾选时，视频由视频层那一路下一次（带进度），
 * 壁纸层这里只安装那份文件，不再按地址下一遍 —— 否则同一个几十 MB 的文件
 * 会下两次，进度条也会来回跳。
 *
 * 拿不到文件路径（比如原生没回 path）就返回 false，调用方退回按地址下载。
 */
const adoptDownloadedVideoAsWallpaper = async (path: string): Promise<boolean> => (
    adoptDownloadedVideoAsWallpaperFile(path)
);

/**
 * 应用一个市场背景。
 *
 * @param item     市场条目
 * @param targets  应用到哪些地方（用户在弹窗里勾的，可以多选）
 * @param rotation 旋转角度（桌面壁纸用；取景框已经拿掉，只剩自动轮换会带这个值）
 */
export const applyMarketBackground = async (
    item: BackgroundMarketItem,
    targets: BackgroundTarget[],
    rotation = 0,
): Promise<ApplyBackgroundResult> => {
    if (!isCapacitorAndroid()) {
        return { ok: false, error: '背景市场目前只支持安卓' };
    }

    let mediaUrl: string | null = null;
    try {
        mediaUrl = await resolveMarketMediaUrl(item);
    } catch {
        return { ok: false, error: '解析下载地址失败' };
    }
    if (!mediaUrl) {
        return { ok: false, error: '拿不到可下载的地址' };
    }

    let applied = false;
    const problems: string[] = [];
    let notice: string | undefined;

    /*
     * 同一张图只下一次，两个目标共用这份 File。
     *
     * 「App 内」和「莫奈」同时勾选时，以前各走一次 fetchAsFile —— 同一张图下两遍，
     * 进度条来回跳。但两处存储确实是独立的（一个是莫奈的背景图，一个是它的肖像），
     * 所以**文件要存两份，网络只需要走一次**。
     */
    let sharedImage: File | null = null;

    /*
     * 视频只下一次，两个目标共用同一份字节。
     *
     * 以前是各下各的：桌面壁纸走 `downloadWallpaperVideoFromUrl`、App 内走
     * `downloadNativeVideoLayerFile`，两个都勾就是**同一个几十 MB 的视频下两遍**。
     *
     * 现在由「App 内」那一路负责下载：它本来就是先卸旧、再下新（见
     * applyVideoToVisualizer 开头），拿到的路径再交给桌面壁纸安装。
     * 所以这里的顺序不能反 —— 先跑 App 内，桌面壁纸那段才有一份可复用的文件。
     */
    let sharedVideoPath: string | null = null;

    /*
     * ---- 先做 App 内 ----
     *
     * 顺序要紧：视频要先在 App 内这条路上「卸旧 → 下载新」，桌面壁纸才有一份
     * 干净的本地文件可装。反过来做的话，桌面壁纸装的还是上一次的 cache 文件。
     */
    if (targets.includes('app')) {
        /*
         * 注意：只有勾了「App 内」才碰视频层。
         *
         * 视频层（歌词后方那层跟播放页走的视频）和桌面壁纸是两个东西。
         * 之前不管勾了什么都去设置视频层，结果「只设桌面壁纸」也会把
         * App 内那层视频打开 —— 用户看到的就是「桌面也在放视频层的视频」。
         */
        if (item.kind === 'video') {
            const video = await applyVideoToVisualizer(mediaUrl);
            if (video.error) {
                problems.push(video.error);
            } else {
                applied = true;
                // 视频层刚下好的那份，桌面壁纸接着用（见下面的 adopt）。
                sharedVideoPath = video.path;
            }
        } else {
            const result = await applyImageToVisualizer(mediaUrl, item.id, sharedImage);
            if (result.error) {
                problems.push(result.error);
            } else {
                applied = true;
                sharedImage = result.file;
            }
        }
    }

    // ---- 桌面壁纸（原生层）----
    if (targets.includes('wallpaper')) {
        if (item.kind === 'video') {
            /*
             * 视频走壁纸层自己那套（WallpaperBackgroundVideo）。
             *
             * 旋转也要一起带过去：壁纸站几乎全是横屏，手机竖屏下不转过来
             * 就只能看到中间一条。原生在装载时按 rotation 处理。
             *
             * 已经为「App 内」下过一份时不再重复下载：那个文件就在应用的 cache
             * 目录里，壁纸层读得到，直接拿它上线即可（用落盘路径，不是回环地址）。
             */
            const adopted = sharedVideoPath
                ? await adoptDownloadedVideoAsWallpaper(sharedVideoPath)
                : false;
            const downloaded = adopted || await downloadWallpaperVideoFromUrl(mediaUrl, rotation);
            if (downloaded) {
                useVisualizerSettingsStore.getState().handleSetLyricsWallpaperBackground('video');
                /*
                 * 角度写进 store（会持久化），而不是只下发一次。
                 *
                 * tuning 是每次 setAppearance 整体下发的，只下发一次的话
                 * 重启后 Web 侧重建的那份里没有它，旋转就丢了。
                 * 写进 store 之后，withGlobalSettings 每次都会带上。
                 *
                 * 0 也要写：从 90° 改回 0° 是合法操作，用 `if (rotation)` 判掉的话
                 * 用户把角度调回「不旋转」时 store 里还留着旧值，下次打开又自己转回去。
                 */
                if (Number.isFinite(rotation)) {
                    useVisualizerSettingsStore.getState().handleSetWallpaperVideoRotation(rotation);
                }
                applied = true;
                const outcome = await openLyricsWallpaperPicker();
                if (outcome === 'needsPermission') {
                    notice = '需要先允许设置壁纸，已跳到系统设置';
                } else if (outcome === 'unavailable') {
                    notice = '下载完成，但系统没提供壁纸设置入口';
                }
            } else {
                problems.push('壁纸视频下载失败');
            }
        } else {
            /*
             * 取景框已经拿掉：整张图都收（0,0,1,1），只把旋转带过去。
             * 原生那边默认会按 90° 摆好，所以多数竖屏场景不用额外处理。
             */
            const downloaded = await downloadWallpaperImageFromUrl(mediaUrl, {
                crop: { left: 0, top: 0, right: 1, bottom: 1 },
                rotation,
            });
            if (downloaded) {
                // 素材到位后必须把模式切过去，否则壁纸层还在画上一档。
                useVisualizerSettingsStore.getState().handleSetLyricsWallpaperBackground('image');
                applied = true;

                /*
                 * 素材有了不代表壁纸在生效 —— 用户可能还没把 Folia 设成当前壁纸。
                 * 主动拉起系统选择器；被系统拦住时会跳到设置页并给出提示。
                 */
                const outcome = await openLyricsWallpaperPicker();
                if (outcome === 'needsPermission') {
                    notice = '需要先允许设置壁纸，已跳到系统设置';
                } else if (outcome === 'unavailable') {
                    notice = '下载完成，但系统没提供壁纸设置入口';
                }
            } else {
                problems.push('壁纸下载失败');
            }
        }
    }

    // ---- 可视化页面（网页层）----
    // ---- 歌词样式·莫奈的自定义肖像（只有静图能去）----
    if (targets.includes('monet') && item.kind === 'image') {
        /*
         * 不能复用「App 内」存的图：那一份是莫奈的**背景图**，这里要的是**肖像**，
         * 两处独立存储、画的位置也不同，所以这张图在这里必须自己再存一次。
         */
        const failure = await applyImageToMonetPortrait(mediaUrl, item.id, sharedImage);
        if (failure) {
            problems.push(failure);
        } else {
            applied = true;
        }
    }

    if (applied) {
        return { ok: true, error: null, notice };
    }
    return { ok: false, error: problems[0] ?? '应用失败' };
};
