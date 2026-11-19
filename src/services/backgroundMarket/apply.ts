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
//
// 下载与应用是分开的两步（#428）：
//
//   ensureDownloaded()  一次网络请求，拿到一份本地素材
//   applyXxx(target)    只读那份素材，把它装到某一处
//
// 勾 N 处时下载只发生一次；任何组合（包括只勾桌面壁纸）都走同一条下载路径。
// 失败语义：下载失败整批失败，不必逐处重试同一个地址；应用失败只影响那一处。

import { isCapacitorAndroid } from '../../platform/runtime';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { useVideoLayerSettingsStore } from '../../stores/useVideoLayerSettingsStore';
import { resolveMarketMediaUrl, type BackgroundMarketItem } from './index';
import {
    createImageMarketAssetSource,
    createNativeMarketAssetSource,
    type MarketAsset,
    type MarketAssetRef,
    type MarketAssetSource,
} from './assetSource';
import {
    adoptDownloadedVideoAsWallpaperFile,
    downloadWallpaperImageFromUrl,
    downloadWallpaperVideoFromUrl,
    openLyricsWallpaperPicker,
    type WallpaperPickerOutcome,
} from '../../platform/foliaWallpaper';
import { uploadMonetBackgroundImage } from '../../components/visualizer/backgrounds/monet/imageUpload';
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

/** 下载阶段的产出：要么拿到素材，要么带一句能直接给用户看的原因。 */
type DownloadOutcome =
    | { ok: true; asset: MarketAsset }
    | { ok: false; error: string };

export interface ApplyBackgroundResult {
    ok: boolean;
    error: string | null;
    /** 应用成功但需要告诉用户的一句话（比如要先去授权）。 */
    notice?: string;
}

/**
 * 把资源下载到本地，**整次应用只调一次**。
 *
 * 这里不按目标去重：谁是目标都不影响下载走哪条路。
 * 以前是各目标自己下载（只勾桌面壁纸时不走图片共用的那份），
 * 于是同一张图会被拉两遍。
 */
const ensureDownloaded = async (
    item: BackgroundMarketItem,
    mediaUrl: string,
    source?: MarketAssetSource,
): Promise<DownloadOutcome> => {
    const ref: MarketAssetRef = { id: item.id, mediaUrl };
    // 不传就按内容类型选：视频走原生，静图在 WebView 里抓成 File。
    const downloader = source ?? (item.kind === 'video'
        ? createNativeMarketAssetSource()
        : createImageMarketAssetSource());
    try {
        return { ok: true, asset: await downloader.download(ref) };
    } catch (error) {
        console.warn('[backgroundMarket] 背景素材下载失败', error);
        return { ok: false, error: item.kind === 'video' ? '视频下载失败' : '图片下载失败' };
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
const applyImageToMonetPortrait = async (file: File): Promise<string | null> => {
    const uploadPortrait = useVisualizerSettingsStore.getState().handleUploadMonetPortraitImage;

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
const applyImageToVisualizer = async (file: File): Promise<string | null> => {
    const uploaded = await uploadMonetBackgroundImage([file]);
    if (!uploaded.ok) return uploaded.error ?? '图片保存失败';

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
    return null;
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
 *
 * 下载已经在 ensureDownloaded 里做完了，这里只安装（#428）。
 */
const applyVideoToVisualizer = async (videoUrl: string): Promise<string | null> => {
    /*
     * **先把旧的卸掉并删除**。
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
     * 清理失败也绝不能把安装堵住。
     *
     * clearLocalFile 里有原生调用（删私有目录里的副本），原生那侧一旦不 resolve，
     * 整个应用流程就卡在这一句。所以给它一个上限，超时就往下走：
     * 最坏情况只是旧的没删干净，但新视频装得上去、也能播。
     */
    const stale = useVideoLayerSettingsStore.getState();
    if (stale.localFileUrl || stale.localFileName) {
        /*
         * 清理超时也**必须**把 localFileUrl 从界面上摘掉。
         *
         * VideoLayer 取源是 `localFileUrl ?? videoLayerUrl`（见 VideoLayer.tsx），
         * 前者优先。clearLocalFile 里有一段原生调用，原生不 resolve 时整条链就卡住，
         * 超时之后我们往下走 —— 但那个旧的 localFileUrl 还挂着，
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
                // 极端情况下拿不到这个方法也不该挡住后面的应用。
            }
        }
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
    fresh.setVideoLayerUrl(videoUrl);
    fresh.setVideoLayerEnabled(true);
    fresh.setVideoLayerOpacity(1);
    fresh.setVideoLayerFit('cover');

    const settings = useVisualizerSettingsStore.getState();
    if (settings.visualizerBackgroundMode !== VISUALIZER_VIDEO_FRIENDLY_MODE) {
        settings.handleSetVisualizerBackgroundMode(VISUALIZER_VIDEO_FRIENDLY_MODE);
    }
    return null;
};

/** 应用过程中可能需要告诉用户的一句话。 */
type Notice = string | undefined;

/** 应用一处的结果：error 为 null 表示这一处成功了。 */
interface TargetOutcome {
    error: string | null;
    notice?: Notice;
}

const pickNotice = (outcome: WallpaperPickerOutcome): Notice => {
    if (outcome === 'needsPermission') return '需要先允许设置壁纸，已跳到系统设置';
    if (outcome === 'unavailable') return '下载完成，但系统没提供壁纸设置入口';
    return undefined;
};

/**
 * 把已下载的素材装成桌面壁纸（原生层）。
 *
 * 旋转也要一起带过去：壁纸站几乎全是横屏，手机竖屏下不转过来就只能看到中间一条。
 * 原生在装载时按 rotation 处理。
 *
 * **视频不重复下载**：ensureDownloaded 拿到的本地路径直接装（adopt），
 * 拿不到路径时（原生没回 path）才退回按地址下载 —— 这是唯一的兜底。
 *
 * **图片仍然按地址下载**：壁纸层要的是原生解码后压好的高质量 JPEG（铺满一屏，体积敏感），
 * 而 App 内那份是原图。两者产物不同，共用一个文件会掉画质（见
 * android/.../WallpaperBackgroundImage.kt 里 downloadImage 上方的说明），
 * 所以这里不是「同一份资源的重复应用」，只是壁纸层自己的产物。
 */
const applyToWallpaper = async (
    item: BackgroundMarketItem,
    mediaUrl: string,
    asset: MarketAsset,
    rotation: number,
): Promise<TargetOutcome> => {
    if (item.kind === 'video') {
        const adopted = asset.kind === 'video' && asset.path
            ? await adoptDownloadedVideoAsWallpaperFile(asset.path)
            : false;
        const downloaded = adopted || await downloadWallpaperVideoFromUrl(mediaUrl, rotation);
        if (!downloaded) return { error: '壁纸视频下载失败' };
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
        /*
         * 素材有了不代表壁纸在生效 —— 用户可能还没把 Folia 设成当前壁纸。
         * 主动拉起系统选择器；被系统拦住时会跳到设置页并给出提示。
         */
        return { error: null, notice: pickNotice(await openLyricsWallpaperPicker()) };
    }

    /*
     * 取景框已经拿掉：整张图都收（0,0,1,1），只把旋转带过去。
     * 原生那边默认会按 90° 摆好，所以多数竖屏场景不用额外处理。
     */
    const downloaded = await downloadWallpaperImageFromUrl(mediaUrl, {
        crop: { left: 0, top: 0, right: 1, bottom: 1 },
        rotation,
    });
    if (!downloaded) return { error: '壁纸下载失败' };
    // 素材到位后必须把模式切过去，否则壁纸层还在画上一档。
    useVisualizerSettingsStore.getState().handleSetLyricsWallpaperBackground('image');
    return { error: null, notice: pickNotice(await openLyricsWallpaperPicker()) };
};

/** 把已下载的素材应用到一处；失败只返回这一处的原因，不影响别的目标。 */
const applyToTarget = async (
    target: BackgroundTarget,
    item: BackgroundMarketItem,
    mediaUrl: string,
    asset: MarketAsset,
    rotation: number,
): Promise<TargetOutcome> => {
    if (target === 'wallpaper') {
        return applyToWallpaper(item, mediaUrl, asset, rotation);
    }
    if (target === 'app') {
        /*
         * 视频层（歌词后方那层跟播放页走的视频）和桌面壁纸是两个东西。
         * 之前不管勾了什么都去设置视频层，结果「只设桌面壁纸」也会把
         * App 内那层视频打开 —— 用户看到的就是「桌面也在放视频层的视频」。
         */
        if (asset.kind === 'video') {
            if (!asset.url) return { error: '视频下载失败' };
            return { error: await applyVideoToVisualizer(asset.url) };
        }
        return { error: await applyImageToVisualizer(asset.file) };
    }
    /*
     * 歌词样式·莫奈的自定义肖像：只有静图能去。
     *
     * 不能复用「App 内」存的那份：那一份是莫奈的**背景图**，这里要的是**肖像**，
     * 两处独立存储、画的位置也不同 —— 但**文件**是同一份，只存两份、网络只走一次。
     */
    if (asset.kind !== 'image') return { error: null };
    return { error: await applyImageToMonetPortrait(asset.file) };
};

/**
 * 应用一个市场背景。
 *
 * @param item     市场条目
 * @param targets  应用到哪些地方（用户在弹窗里勾的，可以多选）
 * @param rotation 旋转角度（桌面壁纸用；取景框已经拿掉，只剩自动轮换会带这个值）
 * @param source   取字节的方式；不传按内容类型自动选，测试会换成假的（见 assetSource.ts）
 */
export const applyMarketBackground = async (
    item: BackgroundMarketItem,
    targets: BackgroundTarget[],
    rotation = 0,
    source?: MarketAssetSource,
): Promise<ApplyBackgroundResult> => {
    if (!isCapacitorAndroid()) {
        return { ok: false, error: '背景市场目前只支持安卓' };
    }

    let mediaUrl: string | null;
    try {
        mediaUrl = await resolveMarketMediaUrl(item);
    } catch {
        return { ok: false, error: '解析下载地址失败' };
    }
    if (!mediaUrl) {
        return { ok: false, error: '拿不到可下载的地址' };
    }

    // ---- 第一步：下载一次 ----
    // 下载失败就是整批失败：同一个地址逐处重试只会让弱网下更慢、更费流量。
    const download = await ensureDownloaded(item, mediaUrl, source);
    if (!download.ok) {
        return { ok: false, error: download.error };
    }

    // ---- 第二步：分发到每一处 ----
    /*
     * 顺序要紧：视频要先在「App 内」那条路上把旧的卸掉，桌面壁纸那一份才算干净。
     * 只勾桌面壁纸时不碰视频层（见 applyToTarget 里 app 分支的注释）。
     */
    const ordered: BackgroundTarget[] = targets.includes('app')
        ? ['app', ...targets.filter((target) => target !== 'app')]
        : targets;

    let applied = false;
    const problems: string[] = [];
    let notice: Notice;

    for (const target of ordered) {
        const outcome = await applyToTarget(target, item, mediaUrl, download.asset, rotation);
        if (outcome.error) {
            problems.push(outcome.error);
            continue;
        }
        applied = true;
        notice = notice ?? outcome.notice;
    }

    if (applied) {
        return { ok: true, error: null, notice };
    }
    return { ok: false, error: problems[0] ?? '应用失败' };
};
