// src/components/modal/settings/pages/integration/market/applyFontTargets.ts
//
// 把「这个字体用在哪」真正落实下去。
//
// 之前只把它记进 localStorage（useFontMarketTarget），界面上勾了字幕 / 壁纸
// 却什么都没变——因为没有任何代码去拨别处的开关，也没有任何代码把字体字节
// 交给原生。这里补上那两步。
//
// 两处控制点各不相同：
//   · 歌词字体 → 网页侧注册（installFontsCnFont 已经做了），不动
//   · 桌面/锁屏歌词 → **原生渲染**，读不到网页注册的字体，
//     必须把字节 base64 推下去（setWallpaperFont），并把字体来源切成 custom

import { useTypographySettingsStore } from '../../../../../../stores/useTypographySettingsStore';
import { useVisualizerSettingsStore } from '../../../../../../stores/useVisualizerSettingsStore';
import { setWallpaperFont } from '../../../../../../platform/foliaWallpaper';
import { isCapacitorAndroid } from '../../../../../../platform/runtime';
import type { FontMarketTarget } from './useFontMarketTarget';

const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        const result = String(reader.result ?? '');
        // FileReader 给的是 data:...;base64,xxx，原生只要后半个
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取字体失败'));
    reader.readAsDataURL(blob);
});

/**
 * 按勾选结果拨开关，并把字体推给原生。
 *
 * 注意这里**只做「打开」，不做「关闭」**：
 * 用户取消勾选时，不该顺手把他原本单独设过的字体清掉 ——
 * 那属于别处的设置，市场没有权力替他决定。
 *
 * @param targets 勾选的应用范围
 * @param fontFile 可选：刚装好的字体文件。给了才会把它推给原生；
 *                 事后改范围时不给（字体没变，原生那份还在）。
 */
export const applyFontTargets = async (
    targets: readonly FontMarketTarget[],
    fontFile?: File | null,
): Promise<void> => {
    if (targets.includes('wallpaper') && isCapacitorAndroid()) {
        /*
         * 桌面 / 锁屏歌词是原生画的，网页里注册的 FontFace 它拿不到。
         *
         * 所以必须把字体字节推过去 —— setWallpaperFont 落在原生那个
         * 字体文件上，和「系统文件选择器挑一个字体」是同一条路。
         * 少了这一步，用户在桌面上看到的永远是系统 sans-serif，
         * 也就是「勾了系统壁纸但没上传、状态栏没变化」的那个现象。
         */
        if (fontFile) {
            try {
                const base64 = await blobToBase64(fontFile);
                await setWallpaperFont(base64);
            } catch {
                // 推失败时下面的模式切换照做：字体名至少能在设置里看到，
                // 不会因为一次传输失败把整套流程卡死。
            }
        }
        /*
         * 字体来源必须是 'custom'。
         * 'follow' 表示「跟随播放页那套」，而原生在 follow 下只能回落系统字体 ——
         * 不切过来的话，上面推下去的字节根本不会被使用。
         */
        const visualizer = useVisualizerSettingsStore.getState();
        if (visualizer.wallpaperLyricsFontMode !== 'custom') {
            visualizer.handleSetWallpaperLyricsFontMode('custom');
        }
    }

    /*
     * 字幕：现在市场里没有这一项了（字幕设置里没有字体这个选项）。
     * 留个空分支不写，等真加了再补 —— 免得又出现「勾了没用」的假入口。
     */
    void useTypographySettingsStore;
};
