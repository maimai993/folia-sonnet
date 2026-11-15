#!/usr/bin/env node
// test/manual/classicRowOverlap.mjs
// 量流光（classic）折行后行与行的纵向间距 / 重叠。挂在现成的 dev/probes/visualizerMemory 台架上：
//   ?probe=visualizerMemory&vis=classic&cjk=1&speed=0.02&start=<秒>
// start 决定停在哪一行（第 i 行 = i*3 秒起，取 +1.5 秒停在该行中间，字有 active 也有 passed）。
//
// 每行的「视觉上下边界」取自 GlowWord 正文层的 bbox（含 scale / y 偏移 / 旋转）；行按不受 transform
// 影响的 offsetTop 分组；waiting 态的词 opacity 是 0，不算进去。overlap > 0 就是上下两行压在一起。
//
// 用法：node test/manual/classicRowOverlap.mjs --width 390 --height 844 --start 28.5

import { parseArgs, readOptions, withRenderSession } from '../render/renderSession.mjs';

const startSeconds = process.argv.includes('--start')
    ? Number(process.argv[process.argv.indexOf('--start') + 1])
    : 7.5;
/** 不能把 speed 设成 0：时间不动，GlowWord 的 waiting→passed 状态就不会推进，量到的是入场姿势。 */
const PAGE = `/dev-probe.html?probe=visualizerMemory&vis=classic&cjk=1&speed=0.02&start=${startSeconds}`;

const collect = () => {
    const round = (value) => Math.round(value * 100) / 100;
    const containers = Array.from(document.querySelectorAll('div.flex-wrap'))
        .filter((element) => element.querySelectorAll('div.inline-block.whitespace-nowrap').length > 1);
    if (containers.length === 0) {
        return { error: '没找到流光的折行容器' };
    }
    const container = containers[0];
    const allWordElements = Array.from(container.querySelectorAll('div.inline-block.whitespace-nowrap'));
    // waiting 态的词 opacity: 0（还没唱到，飘在远处），它们的 bbox 叠不叠看不见，不能算进「行挤在一起」。
    const wordElements = allWordElements.filter((element) => parseFloat(getComputedStyle(element).opacity || '1') > 0.05);
    const hiddenWords = allWordElements.length - wordElements.length;
    if (wordElements.length === 0) {
        return { error: '这一行没有可见的词' };
    }
    const fontPx = round(parseFloat(getComputedStyle(wordElements[0]).fontSize) || 0);
    const readWord = (element) => {
        // 量正文层（body span）而不是词根：合唱涟漪是 150% 的绝对定位圆，会把 bbox 撑大。
        const body = element.querySelector('span.relative.z-10.block') || element;
        const rect = body.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return {
            text: body.textContent || '',
            layoutTop: element.offsetTop,
            layoutHeight: element.offsetHeight,
            itemWidth: round(element.offsetWidth + (parseFloat(getComputedStyle(element).marginRight) || 0)),
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            scale: round(Math.hypot(matrix.a, matrix.b) || 1),
        };
    };
    // 折行数要按「全部词」数：waiting 的词 opacity 是 0，但它们照样占位、照样把整块撑高。
    const layoutRows = new Set(allWordElements.map((element) => element.offsetTop)).size;
    const allWordBoxes = allWordElements.map(readWord);
    const totalItemWidth = round(allWordBoxes.reduce((sum, word) => sum + word.itemWidth, 0));
    // 用 DOM 里的真实字宽 + 边距贪心装行，和组件里的估算对照。
    let greedyRows = 1;
    let rowWidth = 0;
    allWordBoxes.forEach((word, index) => {
        if (index > 0 && rowWidth + word.itemWidth > container.offsetWidth) {
            greedyRows += 1;
            rowWidth = word.itemWidth;
            return;
        }
        rowWidth += word.itemWidth;
    });
    const words = wordElements.map(readWord).sort((a, b) => a.layoutTop - b.layoutTop || a.left - b.left);

    const rows = [];
    for (const word of words) {
        const row = rows.find((candidate) => Math.abs(candidate.layoutTop - word.layoutTop) <= 2);
        if (row) {
            row.words.push(word);
        } else {
            rows.push({ layoutTop: word.layoutTop, words: [word] });
        }
    }
    rows.sort((a, b) => a.layoutTop - b.layoutTop);

    const summary = rows.map((row) => ({
        chars: row.words.map((word) => word.text).join(''),
        layoutTop: row.layoutTop,
        layoutHeight: Math.max(...row.words.map((word) => word.layoutHeight)),
        visualTop: round(Math.min(...row.words.map((word) => word.top))),
        visualBottom: round(Math.max(...row.words.map((word) => word.bottom))),
        visualHeight: round(Math.max(...row.words.map((word) => word.bottom)) - Math.min(...row.words.map((word) => word.top))),
        maxScale: Math.max(...row.words.map((word) => word.scale)),
        left: round(Math.min(...row.words.map((word) => word.left))),
        right: round(Math.max(...row.words.map((word) => word.right))),
    }));

    const overlaps = [];
    for (let index = 1; index < summary.length; index += 1) {
        const previous = summary[index - 1];
        const current = summary[index];
        overlaps.push({
            above: previous.chars,
            below: current.chars,
            pitch: round(current.layoutTop - previous.layoutTop),
            visualGap: round(current.visualTop - previous.visualBottom),
        });
    }

    return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        fontPx,
        hiddenWaitingWords: hiddenWords,
        layoutRows,
        greedyRows,
        totalItemWidth,
        containerWidth: round(container.offsetWidth),
        containerHeight: round(container.offsetHeight),
        blockTop: round(Math.min(...allWordBoxes.map((word) => word.top))),
        blockBottom: round(Math.max(...allWordBoxes.map((word) => word.bottom))),
        rows: summary,
        overlaps,
        verticalOverlaps: overlaps.filter((entry) => entry.visualGap < 0).length,
        worstVisualGap: overlaps.length ? Math.min(...overlaps.map((entry) => entry.visualGap)) : null,
        outOfViewport: summary.filter((row) => row.left < 0 || row.right > window.innerWidth).length,
        outOfVertical: summary.filter((row) => row.visualTop < 0 || row.visualBottom > window.innerHeight).length,
    };
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const options = readOptions({ ...args, page: PAGE });
    let result = null;
    await withRenderSession(options, async ({ page }) => {
        // 等入场 / 状态动画收敛（waiting→active/passed 的 0.4~0.5s 过渡）。
        await page.waitForTimeout(1600);
        result = await page.evaluate(collect);
    });
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error('[classicRowOverlap] 失败：' + error.message);
    process.exitCode = 1;
});
