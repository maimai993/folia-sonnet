// src/components/visualizer/kinetic/kineticFontBridge.ts
//
// 把 folia 主题用的歌词字体送进渲染页的 iframe。
//
// 为什么需要单独一个文件：渲染页是独立文档，宿主页面里注册的 @font-face 它看不到。
// folia 的歌词字体有两种来路：
//   - 'system'   ：系统自带字体族名，靠 fonts.load 等它可用；
//   - 'uploaded' ：用户上传的字体文件（存在 IndexedDB 里），
//                  字体族名是 FoliaUploadedLyricsFont_<id>，Google Fonts 上根本没有。
// 之前只往 iframe 里插 Google Fonts 的 link，对上传字体必然失败 —— 这就是"接不上字体"的真原因。
// 这里把字体字节取出来，用结构化克隆送进 iframe，由它 new FontFace 注册。

import { getStoredUploadedLyricsFont } from '../../../services/customLyricsFont';

/** 送进 iframe 的字体载荷：要么是字体文件字节，要么只是一个系统族名。 */
export type KineticFontPayload = {
    /** 字体族名，iframe 里注册与引用都用它。 */
    family: string;
    /** 上传字体的字节；系统字体为空。 */
    data?: ArrayBuffer;
    /** 字重，原版排版用它算字号。 */
    weight?: number;
};

/**
 * 从主题的字体栈里挑出「真的可以装进去」的字体族名。
 *
 * 字体栈一般以 system-ui / sans-serif 这类通用关键字打头，它们没法注册进引擎，
 * 得跳过；剩下的才是具体字体族名。
 */
export const pickConcreteFontFamily = (stack: string): string => {
    const generic = new Set([
        'system-ui', '-apple-system', 'blinkmacsystemfont', 'sans-serif', 'serif',
        'monospace', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
        'inherit', 'initial', 'unset', 'revert', 'emoji', 'math', 'fangsong',
    ]);
    const names = stack.split(',')
        .map(token => token.replace(/["']/g, '').trim())
        .filter(Boolean);
    return names.find(name => !generic.has(name.toLowerCase())) || '';
};

/**
 * 准备要送进 iframe 的字体。
 *
 * 识别 folia 上传字体（族名以 FoliaUploadedLyricsFont 开头）并把字节读出来；
 * 其他情况只传族名，让 iframe 去尝试加载系统字体或 Google Fonts。
 * 任何一步失败都返回 null —— 字体装不上只是字不对，不能让画面黑掉。
 */
export const resolveKineticFontPayload = async (
    family: string,
    weight?: number,
): Promise<KineticFontPayload | null> => {
    if (!family) return null;
    try {
        /*
         * 只要 folia 里启用的是「上传字体」，就把字节整份送过去。
         *
         * 不能再按名字匹配：上传字体注册用的族名是 FoliaUploadedLyricsFont_<id>
         * （customLyricsFont.ts 的 buildUploadedFontFamily），而主题里存的 fontFamily
         * 是用户看得见的字体文件名 / 标签。两者永不相等，之前 `stored.family === family`
         * 恒为 false，字体载荷永远是 null —— 这就是「上传字体还是没效果」的真因。
         *
         * 所以：主题里给了具体族名，且 IndexedDB 里存着上传字体，就直接用那份字节，
         * 并把族名换成 stored.family（真正注册过的那个）。
         */
        const stored = await getStoredUploadedLyricsFont();
        if (stored && stored.blob) {
            const data = await stored.blob.arrayBuffer();
            console.log('[Kinetic] 读到上传字体，准备送进渲染页', {
                requested: family,
                family: stored.family,
                bytes: data.byteLength,
                name: stored.name,
            });
            return { family: stored.family, data, weight: weight ?? 400 };
        }
        // 没有上传字体：当成系统字体，只传族名让 iframe 自己去找。
        console.warn('[Kinetic] 没有上传字体，按系统字体处理', { family });
        return { family, weight: weight ?? 700 };
    } catch (error) {
        console.warn('[Kinetic] 准备字体失败', error);
        return null;
    }
};
