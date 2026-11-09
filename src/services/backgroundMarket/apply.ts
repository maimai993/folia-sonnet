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
import {
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
        const blob = await response.blob();
        const type = blob.type || 'image/jpeg';
        const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
        return new File([blob], `${name}.${extension}`, { type });
    } catch {
        return null;
    }
};

/**
 * 把图片设成可视化页面的背景。
 *
 * 两步都必须做：
 *   1. 切到 monet 模式（当前若停在别的背景样式，图存得再好也不会被画出来）
 *   2. 把 monet 的来源设成 uploaded-global（默认是封面派生图）
 */
const applyImageToVisualizer = async (url: string, itemId: string): Promise<string | null> => {
    const file = await fetchAsFile(url, itemId);
    if (!file) return '图片下载失败';

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
 */
const applyVideoToVisualizer = async (mediaUrl: string): Promise<string | null> => {
    const downloaded = await downloadNativeVideoLayerFile(mediaUrl);
    if (!downloaded.ok || !downloaded.url) {
        return downloaded.error ?? '视频下载失败';
    }

    /*
     * 顺序很要紧：先清干净，再写新的。
     *
     * 播放时 localFileUrl 的优先级高于 videoLayerUrl（见 VideoLayer），
     * 所以旧文件的 URL 只要还留着，新下载的这个就永远不会被播放 ——
     * 用户看到的就是「换了视频但还是旧的 / 直接加载失败」。
     */
    const stale = useVideoLayerSettingsStore.getState();
    if (stale.localFileUrl || stale.localFileName) {
        await stale.clearLocalFile();
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
    return null;
};

/**
 * 应用一个市场背景。
 *
 * @param item     市场条目
 * @param targets  应用到哪些地方（用户在弹窗里勾的，可以多选）
 * @param crop     裁切范围（桌面壁纸用）
 * @param rotation 旋转角度（桌面壁纸用）
 */
export const applyMarketBackground = async (
    item: BackgroundMarketItem,
    targets: BackgroundTarget[],
    crop?: { left: number; top: number; right: number; bottom: number },
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

    // ---- 桌面壁纸（原生层）----
    if (targets.includes('wallpaper')) {
        if (item.kind === 'video') {
            /*
             * 视频走壁纸层自己那套（WallpaperBackgroundVideo）。
             *
             * 旋转也要一起带过去：壁纸站几乎全是横屏，手机竖屏下不转过来
             * 就只能看到中间一条。原生在装载时按 rotation 处理。
             */
            const downloaded = await downloadWallpaperVideoFromUrl(mediaUrl, rotation);
            if (downloaded) {
                useVisualizerSettingsStore.getState().handleSetLyricsWallpaperBackground('video');
                /*
                 * 角度写进 store（会持久化），而不是只下发一次。
                 *
                 * tuning 是每次 setAppearance 整体下发的，只下发一次的话
                 * 重启后 Web 侧重建的那份里没有它，旋转就丢了。
                 * 写进 store 之后，withGlobalSettings 每次都会带上。
                 */
                if (rotation) {
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
            const downloaded = await downloadWallpaperImageFromUrl(mediaUrl, { crop, rotation });
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
    if (targets.includes('app')) {
        /*
         * 注意：只有勾了「App 内」才碰视频层。
         *
         * 视频层（歌词后方那层跟播放页走的视频）和桌面壁纸是两个东西。
         * 之前不管勾了什么都去设置视频层，结果「只设桌面壁纸」也会把
         * App 内那层视频打开 —— 用户看到的就是「桌面也在放视频层的视频」。
         */
        const failure = item.kind === 'video'
            ? await applyVideoToVisualizer(mediaUrl)
            : await applyImageToVisualizer(mediaUrl, item.id);
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
