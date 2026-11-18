// src/components/swarmSplash/swarmBlueprint.ts
// 把「要建造出来的东西」拆成一组可被光标认领的块。
//
// 启动动画不抓真实 DOM 快照（那要在首帧前遍历整棵树，冷启动会明显变慢，也容易在低端机上掉帧）。
// 这里改成**从真实布局量出几块**：标题、副标题、几个占位块。位置都是相对视口的比例，
// 换屏幕尺寸不用重算；动画只负责「看起来像在建造这个界面」，跑完就撤掉覆盖层、露出真实界面。

export type BlueprintBlock = {
    /** 块的种类：框、字。 */
    kind: 'rect' | 'text';
    /** 目标矩形（画布坐标系）。 */
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

/**
 * 按视口尺寸造一套块。
 *
 * 形状照着我们自己的启动画面来：中央一块大的（logo 位置），下面一条标题、一条副标题，
 * 四周几个小块当作「界面元素」。整体偏居中，避免在窄屏上叠成一团。
 */
export const buildBlueprint = ({ width, height }: BlueprintSize): BlueprintBlock[] => {
    const centerX = width / 2;
    const centerY = height / 2;
    const scale = Math.min(width, height) / 720;
    const logo = 96 * Math.max(0.7, Math.min(1.4, scale));

    return [
        // 中央：一块大的，当作主体。
        { kind: 'rect', x: centerX - logo, y: centerY - logo * 1.7, width: logo * 2, height: logo * 2 },
        // 下方两条文字。
        {
            kind: 'text',
            x: centerX - logo * 1.2,
            y: centerY + logo * 0.6,
            width: logo * 2.4,
            height: 26,
            text: 'Folia',
            fontSize: Math.round(26 * Math.max(0.85, Math.min(1.3, scale))),
        },
        // 四周的「界面元素」：四个小块，位置固定为视口比例，不同屏幕都落得下。
        { kind: 'rect', x: width * 0.08, y: height * 0.12, width: width * 0.22, height: height * 0.1 },
        { kind: 'rect', x: width * 0.7, y: height * 0.12, width: width * 0.22, height: height * 0.1 },
        { kind: 'rect', x: width * 0.08, y: height * 0.78, width: width * 0.22, height: height * 0.1 },
        { kind: 'rect', x: width * 0.7, y: height * 0.78, width: width * 0.22, height: height * 0.1 },
    ];
};
