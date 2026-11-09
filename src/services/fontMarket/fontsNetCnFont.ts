// src/services/fontMarket/fontsNetCnFont.ts
//
// 把市场下载的字体变成「用户上传的字体」。
//
// 为什么不自己注册 FontFace：应用里字体要生效的地方不止一处（主歌词、字幕、
// PV 拼贴的装饰字、系统壁纸），各自都有一份缓存与冷启动恢复逻辑。
// 自己新开一条注册路径，必然出现「这里变了那里没变」。
//
// 所以走同一条路：原生下载 → 读成 File → handleUploadLyricsCustomFont(file)。
// 那条链路内部已经处理了注册、落盘、缓存、通知以及所有生效点。

import { downloadMarketFont, readMarketFontFile } from '../../platform/foliaWallpaper';
import { useTypographySettingsStore } from '../../stores/useTypographySettingsStore';
import { describeFontsCnError } from './fontsNetCn';

export interface InstallMarketFontResult {
    ok: boolean;
    /** 字体家族名（供界面显示，实际生效由 store 决定）。 */
    family: string | null;
    error: string | null;
    fileName: string;
    /**
     * 读出来的字体文件。
     *
     * 交给调用方是为了推给原生 —— 桌面 / 锁屏歌词由原生渲染，
     * 拿不到网页注册的 FontFace，必须把字节送过去（见 applyFontTargets）。
     */
    file: File | null;
}

/**
 * 下载并安装一个字体天下的字体。
 *
 * @param fontId  字体天下的数字 ID
 * @param label   展示名，会成为上传后的字体标签
 * @param options applyToApp 是否把它设成 **App 内歌词字体**。
 *                默认 false：桌面歌词（悬浮窗）和 App 内是两套东西，
 *                只勾了悬浮窗时不该顺手把播放页的歌词字体也改掉。
 *                文件本身总会被下载并返回，调用方拿去推给原生。
 */
export const installFontsCnFont = async (
    fontId: string,
    label?: string,
    options?: { applyToApp?: boolean },
): Promise<InstallMarketFontResult> => {
    const applyToApp = options?.applyToApp === true;
    const download = await downloadMarketFont(fontId);
    if (!download.downloaded || !download.path) {
        return {
            ok: false,
            family: null,
            error: describeFontsCnError(download.error ?? 'DownloadFailed'),
            fileName: '',
            file: null,
        };
    }

    const read = await readMarketFontFile(download.path, download.fileName);
    if (!read.file) {
        return {
            ok: false,
            family: null,
            error: read.error ?? '读不到下载好的字体文件',
            fileName: download.fileName,
            file: null,
        };
    }
    const file = read.file;

    /*
     * 上传接口只认 File，不认「这是市场来的」。
     * 把展示名塞进文件名，上传后的标签就是字体本名而不是 folia_market_font_xxx。
     */
    const extension = download.fileName.includes('.')
        ? download.fileName.slice(download.fileName.lastIndexOf('.'))
        : '.ttf';
    const named = label
        ? new File([file], `${label}${extension}`, { type: file.type })
        : file;

    try {
        if (!applyToApp) {
            /*
             * 只给悬浮窗 / 桌面歌词用：**不碰 App 内歌词字体**。
             *
             * 以前这里无条件调 handleUploadLyricsCustomFont，而它会把
             * lyricsCustomFont 整个换掉 —— 于是「只勾悬浮窗」也会把播放页
             * 的歌词字体一起改掉。用户看到的就是「两个地方都被覆盖了」。
             *
             * 文件照常带出去，由 applyFontTargets 推给原生。
             */
            return {
                ok: true,
                family: label ?? null,
                error: null,
                fileName: download.fileName,
                file: named,
            };
        }

        const result = await useTypographySettingsStore.getState().handleUploadLyricsCustomFont(named);
        if (!result.ok) {
            return {
                ok: false,
                family: null,
                error: result.error ?? '注册失败',
                fileName: download.fileName,
                file: null,
            };
        }
        const family = useTypographySettingsStore.getState().lyricsCustomFont?.family ?? null;
        // 把文件带出去：网页侧已经注册好了，但原生那边还没拿到字节。
        return { ok: true, family, error: null, fileName: download.fileName, file: named };
    } catch (error) {
        return {
            ok: false,
            family: null,
            error: (error as Error)?.message ?? '注册失败',
            fileName: download.fileName,
            file: null,
        };
    }
};
