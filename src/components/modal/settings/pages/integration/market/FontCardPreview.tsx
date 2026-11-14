// src/components/modal/settings/pages/integration/market/FontCardPreview.tsx
//
// 字体卡片的预览图。
//
// 两条路，按可靠性排序：
//   1. 站点的 canvas.php 用**当前预览文字**实时渲染（`data-font-file` 做键）。
//      这是用户真正想看的「我的文字在这个字体下什么样」。
//   2. 站点给的静态封面图（`cover-*.jpg`，固定的样例句）。
//
// 顺带一个坑：canvas.php 传错参数时**照样返回 200**，只是给一张空白图。
// 所以不能靠 HTTP 状态判断成没成，只能靠图片能不能 load —— 这里的 onError
// 会退回封面图，两张都失败就显示字名。

import React, { useState } from 'react';
import { buildFontsCnPreviewUrl, type FontsCnItem } from '../../../../../../services/fontMarket/fontsNetCn';

interface FontCardPreviewProps {
    item: FontsCnItem;
    /** 用户输入的预览文字。 */
    text: string;
}

const FontCardPreview: React.FC<FontCardPreviewProps> = ({ item, text }) => {
    const [failed, setFailed] = useState(false);

    // 列表页已经带上了 fontFile，所以自定义预览不用额外请求详情页。
    const previewUrl = item.fontFile && text.trim()
        ? buildFontsCnPreviewUrl(item.fontFile, text.trim())
        : '';

    const source = failed || !previewUrl ? item.coverUrl : previewUrl;

    if (!source) {
        return (
            <div className="flex h-[54px] items-center justify-center bg-[var(--glass-bg)] px-2 text-center text-[11px] text-[var(--text-secondary)]">
                {item.name}
            </div>
        );
    }

    return (
        <div className="flex h-[54px] items-center justify-center overflow-hidden bg-white/90 px-1.5">
            <img
                src={source}
                alt={item.name}
                loading="lazy"
                /*
                 * 图本身是白底的横条（831x56），用 contain 保证完整显示，
                 * 不用 cover —— 裁掉字形就看不出字体长什么样了。
                 */
                className="max-h-full max-w-full object-contain"
                onError={() => setFailed(true)}
            />
        </div>
    );
};

export default FontCardPreview;
