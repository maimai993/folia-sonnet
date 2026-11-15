#!/usr/bin/env node
// test/manual/kineticOverlap.mjs
// 量文字PV（kinetic）的字与字重叠、行与行重叠、横向出界。挂在 dev/probes/kineticLayout 探针上：
//   ?probe=kineticLayout&start=<秒>&layout=<布局>&enter=<入场>
// 字形节点是 [data-probe-mode="kinetic"] span.kinetic-glyph（渲染层自己的字形池），
// 只算可见（opacity > 0.05 且 display 不是 none）的字；按纵向中心聚类成行再统计。
//
// 用法：node test/manual/kineticOverlap.mjs --width 390 --height 844 --offset 1.2（行内位置，秒）
//      node test/manual/kineticOverlap.mjs --all      # 17 种布局 × 13 种入场全跑一遍

import { parseArgs, readOptions, withRenderSession } from '../render/renderSession.mjs';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1] : fallback;
};

const LAYOUTS = ['center', 'mixed', 'vcols', 'marquee', 'tile', 'scatter', 'ring', 'wave', 'huge',
    'labels', 'condensed', 'gloss', 'type', 'diag', 'circle', 'stack', 'pill'];
const ENTERS = ['cut', 'assemble', 'slice', 'type', 'pop', 'drop', 'stretch', 'wipe', 'blur', 'spin', 'flicker', 'scramble', 'zoom'];

const runAll = argv.includes('--all');
const cases = runAll
    ? LAYOUTS.flatMap(layout => ENTERS.map(enter => ({ layout, enter })))
    : [{ layout: flagValue('layout', ''), enter: flagValue('enter', '') }];

/** 页内：量当前画面的字形占位。 */
const collect = () => {
    const round = (value) => Math.round(value * 100) / 100;
    const intersect = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const nodes = Array.from(document.querySelectorAll('[data-probe-mode="kinetic"] span.kinetic-glyph'));
    const chars = nodes
        .filter((element) => element.style.display !== 'none' && parseFloat(getComputedStyle(element).opacity || '0') > 0.05)
        .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                text: (element.textContent || '').slice(0, 2),
                top: round(rect.top), bottom: round(rect.bottom),
                left: round(rect.left), right: round(rect.right),
            };
        });
    if (chars.length === 0) return { error: '没有可见的字' };

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let horizontalOut = 0;
    let verticalOut = 0;
    chars.forEach((char) => {
        if (char.left < -1 || char.right > viewport.width + 1) horizontalOut += 1;
        if (char.top < -1 || char.bottom > viewport.height + 1) verticalOut += 1;
    });

    // 按纵向中心聚类成行（同一行的字中心相差不到半个字高）。
    const sorted = [...chars].sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
    const rows = [];
    sorted.forEach((char) => {
        const center = (char.top + char.bottom) / 2;
        const row = rows.find(entry => Math.abs(entry.center - center) < (char.bottom - char.top) * 0.5);
        if (row) {
            row.items.push(char);
            row.center = (row.center * (row.items.length - 1) + center) / row.items.length;
        } else {
            rows.push({ center, items: [char] });
        }
    });

    let charOverlaps = 0;
    rows.forEach((row) => {
        const items = [...row.items].sort((a, b) => a.left - b.left);
        for (let i = 0; i < items.length - 1; i++) {
            if (intersect(items[i], items[i + 1])) charOverlaps += 1;
        }
    });

    // 行与行：盒高含字体自身的行距/上伸下伸，紧排时盒边相接不算重叠；按字身（fontSize）判，
    // 再多给 2px 的描边余量。
    const inkOf = (items) => {
        const size = items[0] ? (items[0].bottom - items[0].top) : 0;
        const top = Math.min(...items.map(c => c.top));
        const bottom = Math.max(...items.map(c => c.bottom));
        const pad = Math.max(2, (bottom - top - size) / 2);
        return { top: top + pad, bottom: bottom - pad };
    };
    let rowOverlaps = 0;
    for (let i = 0; i < rows.length - 1; i++) {
        const a = inkOf(rows[i].items);
        const b = inkOf(rows[i + 1].items);
        if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) rowOverlaps += 1;
    }

    return { visibleChars: chars.length, rowCount: rows.length, charOverlaps, rowOverlaps, horizontalOut, verticalOut, viewport };
};

const results = [];
for (const testCase of cases) {
    const query = new URLSearchParams({
        probe: 'kineticLayout',
        start: flagValue('start', '0'),
        offset: flagValue('offset', '1.2'),
    });
    if (testCase.layout) query.set('layout', testCase.layout);
    if (testCase.enter) query.set('enter', testCase.enter);
    const options = readOptions(parseArgs(argv));
    options.page = `/dev-probe.html?${query.toString()}`;
    options.noServer = false;
    options.url = undefined;

    // eslint-disable-next-line no-await-in-loop
    await withRenderSession(options, async (session) => {
        const { page, url } = session;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        const result = await page.evaluate(collect);
        results.push({ ...testCase, ...result });
        const label = `${testCase.layout || 'auto'}/${testCase.enter || 'auto'}`;
        const bad = result.error || result.charOverlaps > 0 || result.rowOverlaps > 0 || result.horizontalOut > 0 || result.verticalOut > 0;
        console.log(`${bad ? 'FAIL' : 'ok  '} ${label} ${JSON.stringify(result)}`);
    });
}

const failed = results.filter(r => r.error || r.charOverlaps > 0 || r.rowOverlaps > 0 || r.horizontalOut > 0 || r.verticalOut > 0);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
