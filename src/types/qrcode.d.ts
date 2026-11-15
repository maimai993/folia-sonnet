// src/types/qrcode.d.ts
//
// `qrcode` 这个包没带类型声明（package.json 里也没有 @types/qrcode）。
// 我们只用到其中一个函数：把一段文本画成 PNG 的 data URL。
//
// 与其加一个依赖，不如在这里把用到的部分写清楚 —— 顺便让调用点有类型。

declare module 'qrcode' {
    export interface QrToDataUrlOptions {
        /** 图片边长（像素）。 */
        width?: number;
        /** 静区宽度（模块数），默认 4。 */
        margin?: number;
        /** 纠错等级。屏幕上扫描用 M 就够。 */
        errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
        /** 颜色：浅色块。 */
        color?: { dark?: string; light?: string };
        type?: string;
    }

    /** 画成 PNG 的 data URL。 */
    export function toDataURL(text: string, options?: QrToDataUrlOptions): Promise<string>;

    const QRCode: {
        toDataURL: typeof toDataURL;
    };
    export default QRCode;
}
