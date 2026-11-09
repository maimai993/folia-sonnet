/*
 * 从 ZeoSeven Fonts 的打包 chunk 里提取字体目录，落成 JSON。
 *
 * 为什么要这么做：官网的浏览页是静态导出（nextExport），1351 款字体的目录**直接打包
 * 进了 route chunk**，没有 JSON 接口。所以这里把数组字面量取出来求值。
 *
 * 只在开发时跑一次，产物是 src/services/fontMarket/zeosevenCatalog.json。
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHUNK = 'https://fonts.zeoseven.com/_next/static/chunks/route-3ebe5c22caf994ff.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(here, '../src/services/fontMarket/zeosevenCatalog.json');

const source = await fetch(CHUNK).then((response) => {
    if (!response.ok) throw new Error(`chunk ${CHUNK} -> HTTP ${response.status}`);
    return response.text();
});

// 目录是 `r=[{id:...},...]`，从起点一直取到与之配对的 `]`。
const start = source.indexOf('r=[{id:');
if (start < 0) throw new Error('没找到目录数组的起点（站点改版了？）');
const arrayStart = start + 2;

let depth = 0;
let end = -1;
let inString = false;
let quote = '';
for (let i = arrayStart; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) inString = false;
        continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
    }
}
if (end < 0) throw new Error('没找到目录数组的结尾');

const literal = source.slice(arrayStart, end + 1);

/*
 * 用 Function 求值而不是 JSON.parse：片段里是 JS 对象字面量（键不带引号、有 1e3 这种
 * 数字写法），不是严格 JSON。这段代码来自远端，所以只喂给它一个纯字面量、不传任何
 * 变量进来，也不让它访问外层作用域。
 */
// eslint-disable-next-line no-new-func
const rows = new Function(`"use strict";return (${literal});`)();
if (!Array.isArray(rows)) throw new Error('提取结果不是数组');

/*
 * 字段含义（对照官网渲染代码）：
 *   id   字体 ID，决定 FontsAPI 地址 /<id>/<style>/result.css
 *   h4   主名称        h5  别名 / 英文名
 *   p    设计师        x   许可协议
 *   lang 语种（逗号分隔）  fg  风格（逗号分隔）
 *   m    字重列表        zc  字重数量说明
 */
const fonts = rows
    .filter((row) => row && row.id !== undefined && typeof row.h4 === 'string' && row.h4.trim())
    .map((row) => ({
        id: String(row.id),
        name: row.h4.trim(),
        alias: typeof row.h5 === 'string' ? row.h5.trim() : '',
        designer: typeof row.p === 'string' ? row.p.trim() : '',
        license: typeof row.x === 'string' ? row.x.trim() : '',
        languages: typeof row.lang === 'string' ? row.lang.split(',').map((s) => s.trim()).filter(Boolean) : [],
        styles: typeof row.fg === 'string' ? row.fg.split(',').map((s) => s.trim()).filter(Boolean) : [],
        weights: Array.isArray(row.m) ? row.m.length : 0,
    }));

await writeFile(outPath, `${JSON.stringify(fonts, null, 0)}\n`, 'utf8');
console.log(`已写入 ${fonts.length} 款字体 -> ${outPath}`);
console.log('前 3 条:', JSON.stringify(fonts.slice(0, 3)));
