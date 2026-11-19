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
    if (!root && typeof document === 'undefined') return [];
    const scope = root ?? document.body;
    if (!scope) return [];

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const measured: Array<BlueprintBlock & { area: number }> = [];

    /*
     * 选「看起来是界面主体」的元素：卡片、海报、砖块、面板、按钮、标题。
     * 不再用 `[class*="rounded"]` —— 那几乎命中每个元素，量出来全是角标和装饰（实测：
     * 色块被画到屏幕右下角）。这里只认真正参与版面的大块。
     */
    const selector = [
        '[data-folia-build-block]',
        '.lattice-poster',
        '.bravais-tile',
        '[data-grid-card]',
        'main section',
        'button',
        'img',
        'h1', 'h2', 'h3',
    ].join(',');

    for (const node of Array.from(scope.querySelectorAll<HTMLElement>(selector))) {
        const rect = node.getBoundingClientRect();
        /*
         * 只要「稳稳落在视口里、有实际面积」的块：
         *   · 太小的（图标、分隔线）不要；
         *   · 大到几乎盖住整屏的（根容器、遮罩）也不要 —— 它不是「一块」，画出来是个白板；
         *   · 中心点必须在视口内，否则是滚动到外面去的旧节点。
         */
        if (rect.width < MIN_BLOCK || rect.height < MIN_BLOCK) continue;
        if (rect.width > viewportWidth * 0.92 && rect.height > viewportHeight * 0.92) continue;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        if (centerX < 0 || centerX > viewportWidth || centerY < 0 || centerY > viewportHeight) continue;

        const x = Math.max(0, rect.left);
        const y = Math.max(0, rect.top);
        const width = Math.min(rect.width, viewportWidth - x);
        const height = Math.min(rect.height, viewportHeight - y);
        if (width < MIN_BLOCK || height < MIN_BLOCK) continue;

        // 文字块：元素里有直接文本就把它打出来，这才是「打字」那一段。
        const ownText = Array.from(node.childNodes)
            .filter(child => child.nodeType === Node.TEXT_NODE)
            .map(child => child.textContent ?? '')
            .join('')
            .trim();
        const fontSize = ownText ? (Number.parseFloat(getComputedStyle(node).fontSize) || 16) : 0;
        measured.push({
            kind: ownText ? 'text' : 'rect',
            x, y, width, height,
            ...(ownText ? { text: ownText, fontSize } : {}),
            area: width * height,
        });
    }

    /*
     * 按面积从大到小取前 MAX_BLOCKS 个，并丢掉「几乎与已选中的块重合」的那些 ——
     * 卡片里嵌卡片时，内层那块画出来只是同一位置重叠两次。
     */
    measured.sort((a, b) => b.area - a.area);
    const chosen: BlueprintBlock[] = [];
    for (const item of measured) {
        if (chosen.length >= MAX_BLOCKS) break;
        const overlaps = chosen.some(other => (
            Math.abs(other.x - item.x) < 12
            && Math.abs(other.y - item.y) < 12
            && Math.abs(other.width - item.width) < 12
            && Math.abs(other.height - item.height) < 12
        ));
        if (overlaps) continue;
        const { area, ...block1 } = item;
        chosen.push(block1);
    }
    /*
     * 按「从上到下、从左到右」排：动画是一块块建的，顺序跟人的阅读顺序一致才像在画界面。
     */
    return chosen.sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
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
