/**
 * src/utils/wallpaperImage.ts
 *
 * 给原生歌词壁纸准备背景图。
 *
 * 这里唯一要小心的就是**别把图压过头**。早期版本把长边压到 512：一张 1080×2400 的手机
 * 壁纸会被缩成 230×512，再被原生按 cover 方式放大回整屏 —— 那就是「壁纸特别模糊」的
 * 真正来源，跟模糊滑杆、跟拉伸都没关系，纯粹是源图只有 512。
 *
 * 反过来也不能无脑送原图：这张图要过一次 Capacitor 的桥，还要落进 localStorage。
 * 所以策略是「先按想要的清晰度编一次，太大就退一档」，而不是一开始就往小里压。
 */

/** 首选长边：够覆盖主流手机的分辨率（1080 / 1440 宽），又不至于让 base64 失控。 */
const PREFERRED_EDGE = 1440;
const PREFERRED_QUALITY = 0.85;
/** 降级档位：依次更糊一点，直到体积落到预算内。 */
const FALLBACK_STEPS: Array<{ edge: number; quality: number }> = [
    { edge: 1080, quality: 0.82 },
    { edge: 900, quality: 0.78 },
    { edge: 720, quality: 0.72 },
];
/** base64 的字符数预算。约等于 1.2 MB 的 JSON 字符串，localStorage 完全放得下。 */
const BUDGET_CHARS = 1_200_000;

const drawScaled = (bitmap: ImageBitmap, edge: number, quality: number): string | null => {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // 缩放插值交给浏览器：drawImage 的双线性过滤比自己算快也更平滑。
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
};

/** 把一张图编成壁纸要的 base64；编不出来（读不了 / 浏览器不支持）时返回 null。 */
export const encodeWallpaperImage = async (file: Blob): Promise<string | null> => {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(file);
        const preferred = drawScaled(bitmap, PREFERRED_EDGE, PREFERRED_QUALITY);
        if (preferred && preferred.length <= BUDGET_CHARS) return preferred;
        for (const step of FALLBACK_STEPS) {
            const candidate = drawScaled(bitmap, step.edge, step.quality);
            if (candidate && candidate.length <= BUDGET_CHARS) return candidate;
        }
        // 全都超预算就取最后一档，总比把设置项写不进去强。
        return drawScaled(bitmap, FALLBACK_STEPS[FALLBACK_STEPS.length - 1].edge,
            FALLBACK_STEPS[FALLBACK_STEPS.length - 1].quality) ?? preferred;
    } catch {
        return null;
    } finally {
        bitmap?.close();
    }
};
