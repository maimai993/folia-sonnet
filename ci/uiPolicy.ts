// ci/uiPolicy.ts
// 两条重构门禁：控件只能来自控件库、单文件不得超过 800 行。
//   node ci/uiPolicy.ts controls        检查手写控件（CI: npm run check:ui）
//   node ci/uiPolicy.ts size            检查文件行数（CI: npm run check:size）
//   node ci/uiPolicy.ts all --update    把当前状态写回基线（只应该在收紧基线时手跑）
//
// 基线是「只许变小」的白名单：文件已在基线里，只要不超过基线的数就通过；新文件或比基线更大
// 直接失败。重构把数字压下去时不用改基线（found <= allowed 就过），全做完再 --update 收紧。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTROL_TAGS = ['button', 'input', 'select', 'textarea'] as const;
// 控件库自身与设置页 kit 是「合法的实现处」：它们内部必须写真实标签。
export const EXEMPT_PREFIXES = ['src/components/ui/', 'src/components/modal/settings/kit/'];
export const MAX_LINES = 800;
const CONTROL_BASELINE = 'ci/uiControlBaseline.json';
const SIZE_BASELINE = 'ci/fileSizeBaseline.json';

// 行数按「内容行」算：文件末尾的换行不算一行（否则每个文件都会多算 1，800 行的文件会被判成 801）。
export function countLines(source: string): number {
    if (source.length === 0) return 0;
    return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

export function countControlsIn(source: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const tag of CONTROL_TAGS) {
        const matches = source.match(new RegExp('<' + tag + '(?=[\\s/>])', 'g'));
        if (matches) counts[tag] = matches.length;
    }
    return counts;
}

function listSources(root: string): string[] {
    const out: string[] = [];
    const visit = (relative: string) => {
        for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const next = relative + '/' + entry.name;
            if (entry.isDirectory()) visit(next);
            else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.d.tsx')) out.push(next);
        }
    };
    visit('src');
    return out.sort();
}

const isExempt = (file: string): boolean => EXEMPT_PREFIXES.some(prefix => file.startsWith(prefix));

function readBaseline(root: string, relative: string): Record<string, number> {
    const file = path.join(root, relative);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

export interface Violation {
    file: string;
    found: number;
    allowed: number;
    /**
     * `lines` = 实测超过允许值（真的超限）；
     * `lines-stale` = 基线记的数字与实测不符（变大或变小都算，issue L7）。
     */
    unit: 'controls' | 'lines' | 'lines-stale';
}

export function scanControls(root: string = repoRoot): Violation[] {
    const baseline = readBaseline(root, CONTROL_BASELINE);
    const violations: Violation[] = [];
    for (const file of listSources(root)) {
        if (isExempt(file)) continue;
        const counts = countControlsIn(fs.readFileSync(path.join(root, file), 'utf8'));
        const found = Object.values(counts).reduce((sum, n) => sum + n, 0);
        const allowed = baseline[file] ?? 0;
        if (found > allowed) violations.push({ file, found, allowed, unit: 'controls' });
    }
    return violations;
}

export function scanSizes(root: string = repoRoot): Violation[] {
    const baseline = readBaseline(root, SIZE_BASELINE);
    const violations: Violation[] = [];
    const actual = new Map<string, number>();
    for (const file of listSources(root)) {
        const lines = countLines(fs.readFileSync(path.join(root, file), 'utf8'));
        actual.set(file, lines);
        const allowed = baseline[file] ?? MAX_LINES;
        if (lines > allowed) violations.push({ file, found: lines, allowed, unit: 'lines' });
    }
    /*
     * 基线只许变小，而且要跟实测一致（issue L7）。
     *
     * 原来只抓「变大」，于是 `App.tsx` 从 2990 行拆到 37 行、`SettingsModal.tsx` 从 1496
     * 降到 1436，基线里还是旧数 —— 门禁照样绿，可它报出来的「超限清单」已经不是事实了。
     * 这里把「基线里记着一个已经不长这样的文件」也当成失败：拆完要么把它从基线里去掉，
     * 要么把数字改成实测值，两种都得是显式动作。
     *
     * 文件已经不在源码树里（删除或改名）同样算陈旧，一并清掉。
     */
    for (const [file, recorded] of Object.entries(baseline)) {
        const now = actual.get(file);
        if (now === undefined) {
            violations.push({ file, found: 0, allowed: recorded, unit: 'lines-stale' });
            continue;
        }
        if (now !== recorded) violations.push({ file, found: now, allowed: recorded, unit: 'lines-stale' });
    }
    return violations;
}

export function writeBaselines(root: string = repoRoot): void {
    const controls: Record<string, number> = {};
    const sizes: Record<string, number> = {};
    for (const file of listSources(root)) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        if (!isExempt(file)) {
            const total = Object.values(countControlsIn(source)).reduce((sum, n) => sum + n, 0);
            if (total > 0) controls[file] = total;
        }
        const lines = countLines(source);
        if (lines > MAX_LINES) sizes[file] = lines;
    }
    const sort = (object: Record<string, number>) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(path.join(root, CONTROL_BASELINE), JSON.stringify(sort(controls), null, 2) + '\n');
    fs.writeFileSync(path.join(root, SIZE_BASELINE), JSON.stringify(sort(sizes), null, 2) + '\n');
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.includes('--update')) {
        writeBaselines();
        console.log('已按当前状态重写基线：' + CONTROL_BASELINE + ' / ' + SIZE_BASELINE);
        return;
    }
    const controls = scanControls();
    const sizes = scanSizes();
    // 「变大」是超限，「变了但没同步基线」是基线陈旧，两类分开讲，免得混杂看不清。
    const overLimit = sizes.filter(v => v.unit === 'lines');
    const stale = sizes.filter(v => v.unit === 'lines-stale');
    let failed = false;
    if (controls.length) {
        failed = true;
        console.error('手写控件（应改用 src/components/ui 里的控件）：');
        for (const v of controls) console.error('  ' + v.file + '  写了 ' + v.found + ' 个，基线允许 ' + v.allowed);
    }
    if (overLimit.length) {
        failed = true;
        console.error('文件超长（上限 800 行，超了要拆）：');
        for (const v of overLimit) console.error('  ' + v.file + '  ' + v.found + ' 行，基线允许 ' + v.allowed);
    }
    if (stale.length) {
        failed = true;
        console.error('基线陈旧：这些文件的实测行数与基线不符（基线只许变小，且必须等于实测）：');
        for (const v of stale) {
            const now = v.found === 0 ? '已不在源码树里' : v.found + ' 行';
            console.error('  ' + v.file + '  基线记 ' + v.allowed + ' 行，实测 ' + now);
        }
        console.error('  重构完跑 npm run check:size -- --update 重写基线。');
    }
    if (failed) process.exitCode = 1;
    else console.log('UI 门禁通过：没有新增手写控件，没有超过 800 行的文件，基线等于实测。');
}

// 只有直接运行才走 CLI；单测 import 时没有副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
