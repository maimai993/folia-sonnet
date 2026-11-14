import React from 'react';

// src/components/modal/settings/kit/GlassLayer.tsx
// 面板背后那层「玻璃」：底色 + 背景模糊，自己带圆角。
//
// 为什么要单独一层、而不把 backdrop-blur 直接写在面板上：
// 浏览器把 backdrop-filter 单独合成一层，**同一元素上的 border-radius 收不住它的角**，
// overflow-hidden 也管不到（模糊层不是子节点）。所以任何「rounded + backdrop-blur」
// 写在同一元素上的面，圆角处都会露出四个直角，玻璃像贴歪了一张方纸（issue #279）。
//
// 拆成这层之后，模糊发生在它自己的圆角范围里，合成时被自己的圆角裁掉。
// 用法：面板本身 `relative isolate overflow-hidden rounded-*` 并去掉 bg，
// 把这层放在最前面，内容各自 relative 抬到 z 以上。
//
// 这层用 z-0，**不要改成负 z**：负值会把它推出父级的堆叠上下文，
// 既脱离圆角裁剪，又掉到面板背景后面，直角照样露出来。
//
// 带 data-glass-layer：src/shinoinject/ 按它认出「这是玻璃层」，挂折射滤镜。

export interface GlassLayerProps {
    /** 与所在面板完全一致的圆角类，例如 'rounded-2xl'。 */
    radius: string;
    /** 底色，通常是面板原来的背景变量，例如 'bg-[var(--st-win)]'。 */
    tint: string;
    /** 模糊强度，默认 2xl。 */
    blur?: string;
}

export const GlassLayer: React.FC<GlassLayerProps> = ({ radius, tint, blur = 'backdrop-blur-2xl' }) => (
    <span
        aria-hidden
        data-glass-layer=""
        className={`pointer-events-none absolute inset-0 z-0 ${radius} ${tint} ${blur}`}
    />
);

export default GlassLayer;
