// src/components/visualizer/kinetic/saveExportFile.ts
// 文字PV 导出落盘：把原版编辑器生成的 Blob（MP4 / PNG 序列 zip / AE 数据）交给安卓原生保存。
//
// WebView 里 <a download> 在安卓上要么静默丢进 Download、要么根本没反应 ——
// 用户点「导出」看不到任何「存到哪儿」的界面。这里改走原生 saveFile：
// ACTION_CREATE_DOCUMENT 弹系统保存位置选择器，选完由原生写字节。
//
// ⚠️ 不能把 base64 塞进 plugin call：Capacitor 的 startActivityForResult 会把整个 call
// 暂时存进 activity 的 savedInstanceState，几十 MB 的导出直接撞 Binder 1MB 上限，
// 崩在 TransactionTooLargeException。所以先写缓存文件，只把路径传给原生。

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

export type SaveExportResult = 'saved' | 'cancelled';

type SaveFilePlugin = {
    /** 按缓存文件路径保存：原生弹保存位置选择器，选完从路径读字节写过去。 */
    saveFileFromPath: (options: {
        fileName: string;
        sourcePath: string;
        mimeType: string;
    }) => Promise<{ saved: boolean; cancelled?: boolean; uri?: string }>;
};

// 原生侧实现见 android/app/src/main/java/top/izuna/foliamajor/FoliaNativePlugin.kt。
const FoliaNative = registerPlugin<SaveFilePlugin>('FoliaNative');

const isNative = () => Capacitor.isNativePlatform();

/** 导出用的缓存子目录：和音频缓存分开，方便单独清理。 */
const EXPORT_DIR = 'kinetic-export';

/**
 * 保存导出文件，返回用户是存了还是取消了。
 *
 * 原生端先把字节写进应用缓存，再弹系统保存位置选择器；
 * 桌面 / 浏览器退回普通下载链接，行为和改动前一致。
 */
export const saveExportFile = async (input: {
    filename: string;
    base64: string;
    mime: string;
}): Promise<SaveExportResult> => {
    const { filename, base64, mime } = input;

    if (isNative()) {
        // 先落到应用缓存：一条 plugin call 里只带路径，不会再撞 Binder 上限。
        const cachePath = `${EXPORT_DIR}/${filename}`;
        await Filesystem.mkdir({ directory: Directory.Cache, path: EXPORT_DIR, recursive: true }).catch(() => undefined);
        const written = await Filesystem.writeFile({
            path: cachePath,
            data: base64,
            directory: Directory.Cache,
            recursive: true,
        });
        console.log('[Kinetic] 导出文件已写入缓存，准备弹保存位置', { filename, uri: written.uri });
        try {
            const result = await FoliaNative.saveFileFromPath({
                fileName: filename,
                sourcePath: written.uri,
                mimeType: mime,
            });
            if (result.cancelled || !result.saved) {
                console.log('[Kinetic] 用户取消了导出保存', { filename });
                return 'cancelled';
            }
            console.log('[Kinetic] 导出文件已保存', { filename, uri: result.uri });
            return 'saved';
        } catch (error) {
            console.warn('[Kinetic] 原生保存失败', error);
            throw error;
        } finally {
            // 缓存里的副本用完就删：导出文件可能几十 MB，不该一直占着。
            void Filesystem.deleteFile({ directory: Directory.Cache, path: cachePath }).catch(() => undefined);
        }
    }

    // 浏览器 / Electron：普通下载。
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'saved';
};
