// src/components/swarmSplash/swarmBlueprint.ts
// 把「要建造出来的东西」变成一组可被光标认领的块。
//
// ★ 这是从**真实界面量出来的**，不是按比例捏一个像样的版式（#420 反馈：「完全就是在假装画，
// 每次启动都是一样的，跟那种把元素画出来完全不一样」）。做法：动画开始时真实界面已经挂在
// 覆盖层下面（AppSplashGate 包着 children），所以直接从 DOM 取元素矩形 —— 每一块都正好落在
// 它会被重建的那个位置，画完看起来就是「界面被一格一格画出来了」。
//
// 量不到（早于布局、或页面没有可量元素）才退回一组按视口比例摆的块，保证动画永远有东西画。

export type BlueprintBlock = {
    /** 块的种类：框、字。 */
    kind: 'rect' | 'text';
    x: number;
    y: number;
    width: number;
    height: number;
    /** kind === 'text' 时要打出来的字。 */
    text?: string;
    /** 字号（text）。 */
    fontSize?: number;
};

export type BlueprintSize = { width: number; height: number };

/** 最多建多少块：多了动画会拖长，也不好看。 */
const MAX_BLOCKS = 14;
/** 小于这个尺寸的元素不建（图标、分隔线之类，建出来只是噪点）。 */
const MIN_BLOCK = 24;

/** 从真实 DOM 里量。返回空数组表示量不到，调用方退回默认版式。 */
export const measureBlueprint = (root?: ParentNode): BlueprintBlock[] => {
    // 没有 DOM 时（单测、SSR）：直接告诉调用方量不到，让它退回兜底版式。
    if (!root && typeof document === 'undefined') return [];
    const scope = root ?? document;
    const nodes = Array.from(scope.querySelectorAll<HTMLElement>(
        // 只认「有面积的容器」：卡片、海报、面板、按钮块、图片、标题。
        '[data-folia-build-block], .lattice-poster, .bravais-tile, button, img, h1, h2, h3, [class*="rounded"]',
    ));
    const blocks: BlueprintBlock[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
        if (blocks.length >= MAX_BLOCKS) break;
        const rect = node.getBoundingClientRect();
        if (rect.width < MIN_BLOCK || rect.height < MIN_BLOCK) continue;
        // 只取视口里的：覆盖层也只画看得见的那一屏。
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (rect.right < 0 || rect.left > window.innerWidth) continue;
        // 同一个位置不要重复建（嵌套元素会量出几乎相同的框）。
        const key = `${Math.round(rect.left / 12)}:${Math.round(rect.top / 12)}:${Math.round(rect.width / 12)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const x = Math.max(0, rect.left);
        const y = Math.max(0, rect.top);
        const width = Math.min(rect.width, window.innerWidth - x);
        const height = Math.min(rect.height, window.innerHeight - y);
        if (width < MIN_BLOCK || height < MIN_BLOCK) continue;
        // 文字块：元素里有直接文本，就把它打出来 —— 这才是「打字」那一段。
        const ownText = Array.from(node.childNodes)
            .filter(child => child.nodeType === Node.TEXT_NODE)
            .map(child => child.textContent ?? '')
            .join('')
            .trim();
        if (ownText) {
            const fontSize = Number.parseFloat(getComputedStyle(node).fontSize) || 16;
            blocks.push({ kind: 'text', x, y, width, height, text: ownText, fontSize });
        } else {
            blocks.push({ kind: 'rect', x, y, width, height });
        }
    }
    return blocks;
};

/**
 * 量不到真实界面时的兜底版式（按视口比例摆）。
 *
 * 只在 `measureBlueprint()` 返回空数组时用；正常路径不会走到这里。
 */
export const buildFallbackBlueprint = ({ width, height }: BlueprintSize): BlueprintBlock[] => {
    const centerX = width / 2;
    const centerY = height / 2;
    const scale = Math.min(width, height) / 720;
    const logo = 96 * Math.max(0.7, Math.min(1.4, scale));

    return [
        { kind: 'rect', x: centerX - logo, y: centerY - logo * 1.7, width: logo * 2, height: logo * 2 },
        {
            kind: 'text',
            x: centerX - logo * 1.2,
            y: centerY + logo * 0.6,
            width: logo * 2.4,
            height: 26,
            text: 'Folia',
            fontSize: Math.round(26 * Math.max(0.85, Math.min(1.3, scale))),
        },
        { kind: 'rect', x: width * 0.08, y: height * 0.12, width: width * 0.22, height: height * 0.1 },
        { kind: 'rect', x: width * 0.7, y: height * 0.12, width: width * 0.22, height: height * 0.1 },
        { kind: 'rect', x: width * 0.08, y: height * 0.78, width: width * 0.22, height: height * 0.1 },
        { kind: 'rect', x: width * 0.7, y: height * 0.78, width: width * 0.22, height: height * 0.1 },
    ];
};

/** 先量真实的，量不到用兜底。 */
export const buildBlueprint = (size: BlueprintSize): BlueprintBlock[] => {
    const measured = measureBlueprint();
    return measured.length >= 3 ? measured : buildFallbackBlueprint(size);
};
