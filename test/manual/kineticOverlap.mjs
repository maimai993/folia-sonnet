#!/usr/bin/env node
// test/manual/kineticOverlap.mjs
// 量文字PV（kinetic）的字与字重叠、行与行重叠、横向出界。挂在 dev/probes/kineticLayout 探针上：
//   ?probe=kineticLayout&start=<秒>
// 每个字取正文 span 的 bbox（含 scale/位移后的实际占位）；waiting 态（opacity 0）的字不算。
// 行按探针里每行 wrapper（height 为行高）分组，上下两行的 bbox 相交即 overlap。
//
// 用法：node test/manual/kineticOverlap.mjs --width 390 --height 844 --start 1.5

import { parseArgs, readOptions, withRenderSession } from '../render/renderSession.mjs';

const options = readOptions(parseArgs(process.argv.slice(2)));
const startSeconds = typeof process.argv[process.argv.indexOf('--start') + 1] === 'string'
    ? Number(process.argv[process.argv.indexOf('--start') + 1])
    : 1.5;
const PAGE = `/dev-probe.html?probe=kineticLayout&start=${startSeconds}`;
options.page = PAGE;
options.noServer = false;
options.url = undefined;

const round = (value) => Math.round(value * 100) / 100;
const intersect = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

const collect = () => {
    const round = (value) => Math.round(value * 100) / 100;
    const intersect = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const chars = Array.from(document.querySelectorAll('[data-probe-mode="kinetic"] span.origin-center'))
        .filter((element) => parseFloat(getComputedStyle(element).opacity || '0') > 0.05)
        .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                text: element.textContent || '',
                top: round(rect.top), bottom: round(rect.bottom),
                left: round(rect.left), right: round(rect.right),
            };
        });
    if (chars.length === 0) return { error: '没有可见的字' };

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let charOverlaps = 0;
    let rowOverlaps = 0;
    let horizontalOut = 0;
    let verticalOut = 0;

    // 按行 wrapper（style.top 的行容器）聚类：同一 wrapper 里的字是一行；
    // bbox 只量正文 span（origin-center），装饰残影/下划线不算占位。
    const wrappers = Array.from(document.querySelectorAll('[data-probe-mode="kinetic"] div'))
        .filter((d) => d.style.top && d.style.width && d.style.transform?.includes('translateX'));
    const rows = wrappers
        .map((row) => Array.from(row.querySelectorAll('span.origin-center'))
            .filter((element) => parseFloat(getComputedStyle(element).opacity || '0') > 0.05)
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return { top: round(rect.top), bottom: round(rect.bottom), left: round(rect.left), right: round(rect.right) };
            }))
        .filter((row) => row.length > 0)
        .sort((a, b) => Math.min(...a.map((c) => c.top)) - Math.min(...b.map((c) => c.top)));

    rows.forEach((row) => {
        const sorted = [...row].sort((a, b) => a.left - b.left);
        for (let i = 0; i < sorted.length - 1; i++) {
            if (intersect(sorted[i], sorted[i + 1])) charOverlaps += 1;
        }
        sorted.forEach((char) => {
            if (char.left < -0.5 || char.right > viewport.width + 0.5) horizontalOut += 1;
            if (char.top < -0.5 || char.bottom > viewport.height + 0.5) verticalOut += 1;
        });
    });

    // 行与行：上下两行bbox区间相交即 overlap。
    for (let i = 0; i < rows.length - 1; i++) {
        const aTop = Math.min(...rows[i].map((c) => c.top));
        const aBottom = Math.max(...rows[i].map((c) => c.bottom));
        const bTop = Math.min(...rows[i + 1].map((c) => c.top));
        const bBottom = Math.max(...rows[i + 1].map((c) => c.bottom));
        if (Math.min(aBottom, bBottom) - Math.max(aTop, bTop) > 0.5) rowOverlaps += 1;
    }

    return {
        visibleChars: chars.length,
        rowCount: rows.length,
        charOverlaps,
        rowOverlaps,
        horizontalOut,
        verticalOut,
        viewport,
    };
};

const LABEL = 'kinetic-overlap';

await withRenderSession(options, async (session) => {
    const { page, url } = session;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const result = await page.evaluate(collect);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.error || result.charOverlaps > 0 || result.rowOverlaps > 0 || result.horizontalOut > 0 ? 1 : 0);
});
