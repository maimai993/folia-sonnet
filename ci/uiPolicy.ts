// ci/uiPolicy.ts
// 两条重构门禁：控件只能来自控件库、单文件不得超过 800 行。
//   node ci/uiPolicy.ts controls        检查手写控件（CI: npm run check:ui）
//   node ci/uiPolicy.ts size            检查文件行数（CI: npm run check:size）
//   node ci/uiPolicy.ts all --update    把当前状态写回基线（只应该在收紧基线时手跑）
//
// 基线是「只许变小」的白名单：文件已在基线里，只要不超过基线的数就通过；新文件或比基线更大
// 直接失败。重构把数字压下去时不用改基线（found <= allowed 就过），全做完再 --update 收紧。
//
// 行数看哪些文件见下面的 `listSizeSources`（issue M17）：`src/` 下的 `.ts` / `.tsx` 与
// `android/app/src/main/java` 下的 Kotlin / Java 一起数；控件仍然只看 `.tsx`。

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

// ---- 行数门禁扫哪些文件（issue M17）------------------------------------------
//
// 原来只数 `src/` 下的 `.tsx`：仓库里最大的那些 `.ts`（`omni.ts`、`kugouProvider.ts`、`localMusicService.ts`）
// 和 `android/app/src/main/java/` 下的 Kotlin / Java 从来不进统计，门禁报「通过」时它们已经涨到上限的两倍。
// 现在按下面三组扫，口径（内容行、800、基线只减不增）完全一致：
//
//   SRC_EXTENSIONS        `src/` 下带界面的源码 + 所有 `.ts`（`.d.ts` / `.d.tsx` 是声明，不数）
//   ANDROID_SRC_ROOTS     安卓原生源码根目录（Kotlin / Java 同样按内容行数）
//   EXEMPT_SIZE_FILES     生成或按语言交付的文件，不按行数管（理由见每条注释）
//
// 控件的统计仍然只看 `.tsx`（只有它们能写 JSX 标签），所以两组各用各的清单。
export const SRC_EXTENSIONS = ['.tsx', '.ts'] as const;
export const ANDROID_SRC_ROOTS = ['android/app/src/main/java'] as const;
export const SIZE_EXTENSIONS = ['.tsx', '.ts', '.kt', '.java'] as const;
export const EXEMPT_SIZE_FILES: readonly string[] = [
    // 三份（加上构建时从 zh-CN 转出的繁中）语言文件：一条文案一行，天然几千行。
    // 它们不是「一个功能堆在一个文件里」，拆开只会让文案查重和补翻译都变难。
    'src/i18n/locales/',
];
// 这些后缀是声明或直接照抄的产物，不是手写实现。
const SIZE_EXEMPT_SUFFIXES = ['.d.ts', '.d.tsx'];

export interface SizeScope {
    /** 进统计的文件，相对仓库根、`/` 分隔、已排序。 */
    files: string[];
    /** 扫到的根目录（相对仓库根），说明这次到底看了哪些代码。 */
    roots: string[];
    /** 因结构原因跳过的文件数（`.d.ts` 一类），便于解释「为什么某个文件不在里面」。 */
    skippedDeclarations: number;
}

const isSizeExempt = (file: string): boolean => (
    EXEMPT_SIZE_FILES.some(prefix => file.startsWith(prefix))
    || SIZE_EXEMPT_SUFFIXES.some(suffix => file.endsWith(suffix))
);

/**
 * 行数门禁要看的文件：`src/` 下的 `.ts` / `.tsx` 加上安卓原生源码，按路径排序。
 *
 * `EXEMPT_SIZE_FILES` 与声明文件在遍历时就跳过 —— 它们不该出现在基线里，也不该被算成「基线陈旧」。
 */
export function listSizeSources(root: string = repoRoot): SizeScope {
    const files: string[] = [];
    let skippedDeclarations = 0;
    const visit = (relative: string) => {
        const full = path.join(root, relative);
        // 临时仓库里可以没有安卓那一半：缺目录就当没有这类文件。
        if (!fs.existsSync(full)) return;
        for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
            const next = relative + '/' + entry.name;
            if (entry.isDirectory()) {
                visit(next);
                continue;
            }
            if (!SIZE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue;
            if (SIZE_EXEMPT_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) skippedDeclarations++;
            else if (!isSizeExempt(next)) files.push(next);
        }
    };
    for (const sourceRoot of ['src', ...ANDROID_SRC_ROOTS]) visit(sourceRoot);
    return { files: files.sort(), roots: ['src', ...ANDROID_SRC_ROOTS], skippedDeclarations };
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
    const { files } = listSizeSources(root);
    for (const file of files) {
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
        if (isExempt(file)) continue;
        const total = Object.values(countControlsIn(fs.readFileSync(path.join(root, file), 'utf8'))).reduce((sum, n) => sum + n, 0);
        if (total > 0) controls[file] = total;
    }
    for (const file of listSizeSources(root).files) {
        const lines = countLines(fs.readFileSync(path.join(root, file), 'utf8'));
        if (lines > MAX_LINES) sizes[file] = lines;
    }
    const sort = (object: Record<string, number>) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
    const grown = describeGrowth(readBaseline(root, SIZE_BASELINE), sizes);
    fs.writeFileSync(path.join(root, CONTROL_BASELINE), JSON.stringify(sort(controls), null, 2) + '\n');
    fs.writeFileSync(path.join(root, SIZE_BASELINE), JSON.stringify(sort(sizes), null, 2) + '\n');
    if (grown.length > 0) {
        console.warn('这次重写把下面这些条目调大了（基线只许变小，调大要在 PR 里写明理由）：');
        for (const line of grown) console.warn('  ' + line);
    }
}

/**
 * 比较新旧基线，列出被调大的条目。
 *
 * `--update` 本来是无条件重写，于是一次「顺手跑一下」就能把「只许变小」悄悄放宽 ——
 * 文件从 3846 涨到 3883 也被照单全收，事后没人知道它是怎么变大的。这里把它喊出来：
 * 增长本身不会让命令失败（有时确实要涨，比如修 bug 补了防护），但必须有人看见。
 */
function describeGrowth(previous: Record<string, number>, next: Record<string, number>): string[] {
    const grown: string[] = [];
    for (const [file, now] of Object.entries(next)) {
        const before = previous[file];
        // 新进基线的文件不算「调大」：它以前压根不在名单里，是这次扩范围才被抓到的。
        if (before === undefined || now <= before) continue;
        grown.push(file + '  ' + before + ' → ' + now + '（+' + (now - before) + '）');
    }
    return grown;
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
    const scope = listSizeSources();
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
    else {
        const files = scope.roots.join(' / ');
        console.log('UI 门禁通过：没有新增手写控件；' + files + ' 下 ' + scope.files.length
            + ' 个文件（' + SIZE_EXTENSIONS.join(' / ') + '，除 ' + EXEMPT_SIZE_FILES.join('、')
            + '）没有超过 ' + MAX_LINES + ' 行的，基线等于实测。');
    }
}

// 只有直接运行才走 CLI；单测 import 时没有副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
