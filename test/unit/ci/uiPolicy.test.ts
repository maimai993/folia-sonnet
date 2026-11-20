// test/unit/ci/uiPolicy.test.ts
// UI 门禁的两条规则：手写控件与 800 行上限。CI 的 ui-gates job 跑的是同一份实现。
//
// 另外钉住「基线只许变小」（issue L7）：基线记的数字跟实测不符就要红，无论变大还是变小。
// 原实现只抓「变大」，于是 App.tsx 从 2990 行拆到 38 行，基线里还写着 2990，门禁照样绿。

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_LINES, countControlsIn, countLines, listSizeSources, scanControls, scanSizes } from '../../../ci/uiPolicy.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('手写控件计数', () => {
    it('只数真实标签，大小写与相似标签不算', () => {
        const counts = countControlsIn('<button/><Button /><buttonish /><input /><select></select><textarea />');
        expect(counts).toEqual({ button: 1, input: 1, select: 1, textarea: 1 });
    });

    it('多行标签也算', () => {
        const counts = countControlsIn('<button\n  type="button"\n  onClick={f}\n>');
        expect(counts.button).toBe(1);
    });
});

describe('门禁阈值', () => {
    it('行数上限是 800', () => {
        expect(MAX_LINES).toBe(800);
    });

    it('行数不把文件末尾的换行算成一行', () => {
        expect(countLines('a\nb\n')).toBe(2);
        expect(countLines('a\nb')).toBe(2);
        expect(countLines('')).toBe(0);
    });
});

describe('仓库当前状态', () => {
    it('没有新增手写控件', () => {
        expect(scanControls(repoRoot)).toEqual([]);
    });

    it('没有超过 800 行且不在基线里的文件，基线也只记着实测值', () => {
        expect(scanSizes(repoRoot)).toEqual([]);
    });
});

/*
 * 基线陈旧（issue L7）。
 *
 * 这些用例在临时目录里造一个最小仓库，所以能精确控制「基线写多少 / 文件实际多少」。
 * 原来的实现只报 `lines > allowed`，下面三条都会静默通过 —— 正是 L7 描述的失真。
 */
describe('基线只许变小且必须等于实测（issue L7）', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** 造一个只有 src/ 与基线的临时仓库；files 是「相对路径 → 内容」。 */
    const makeRepo = (files: Record<string, string>, sizeBaseline: Record<string, number>): string => {
        const root = mkdtempSync(path.join(tmpdir(), 'ui-policy-'));
        dirs.push(root);
        for (const [relative, content] of Object.entries(files)) {
            const full = path.join(root, relative);
            mkdirSync(path.dirname(full), { recursive: true });
            writeFileSync(full, content);
        }
        mkdirSync(path.join(root, 'ci'), { recursive: true });
        writeFileSync(path.join(root, 'ci', 'fileSizeBaseline.json'), JSON.stringify(sizeBaseline));
        return root;
    };

    const lines = (count: number): string => Array.from({ length: count }, (_, i) => `// ${i}`).join('\n') + '\n';

    it('基线比实测大（文件拆小了但没同步基线）要报出来', () => {
        const root = makeRepo({ 'src/shrunk.tsx': lines(38) }, { 'src/shrunk.tsx': 2990 });
        const violations = scanSizes(root);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ file: 'src/shrunk.tsx', found: 38, allowed: 2990, unit: 'lines-stale' });
    });

    it('基线比实测小（文件长回去了）同样要报出来', () => {
        // 长回去但还没破 800 的绝对上限：老逻辑不看这条，因为它只比 allowed。
        const root = makeRepo({ 'src/grew.tsx': lines(900) }, { 'src/grew.tsx': 850 });
        const violations = scanSizes(root);
        const stale = violations.find(v => v.unit === 'lines-stale');
        expect(stale).toMatchObject({ file: 'src/grew.tsx', found: 900, allowed: 850 });
    });

    it('基线里记着已经不在源码树里的文件，也要报出来', () => {
        const root = makeRepo({ 'src/other.tsx': lines(10) }, { 'src/deleted.tsx': 1200 });
        const violations = scanSizes(root);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ file: 'src/deleted.tsx', found: 0, allowed: 1200, unit: 'lines-stale' });
    });

    it('基线等于实测时通过', () => {
        const root = makeRepo({ 'src/steady.tsx': lines(900) }, { 'src/steady.tsx': 900 });
        expect(scanSizes(root)).toEqual([]);
    });
});

/*
 * 行数门禁的覆盖面（issue M17）。
 *
 * 原来只数 `src/` 下的 `.tsx`：仓库里最大的那些 `.ts` 与 `android/app/src/main/java` 下的
 * Kotlin / Java 根本不进统计，门禁报「通过」时它们已经涨到上限的两倍以上。
 * 这里把口径钉住：`.ts` 与 `.kt` / `.java` 都数、声明与语言文件不数、安卓目录算在内。
 */
describe('行数门禁覆盖 .ts 与安卓目录（issue M17）', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** 与 L7 那组同款的最小仓库；`baseline` 不写就是空基线。 */
    const makeRepo = (files: Record<string, string>, baseline: Record<string, number> = {}): string => {
        const root = mkdtempSync(path.join(tmpdir(), 'ui-scope-'));
        dirs.push(root);
        for (const [relative, content] of Object.entries(files)) {
            const full = path.join(root, relative);
            mkdirSync(path.dirname(full), { recursive: true });
            writeFileSync(full, content);
        }
        mkdirSync(path.join(root, 'ci'), { recursive: true });
        writeFileSync(path.join(root, 'ci', 'fileSizeBaseline.json'), JSON.stringify(baseline));
        return root;
    };

    const lines = (count: number): string => Array.from({ length: count }, (_, i) => `// ${i}`).join('\n') + '\n';

    it('一个 900 行的 .ts 会失败（原来根本不进统计）', () => {
        const root = makeRepo({ 'src/services/big.ts': lines(900) });
        expect(scanSizes(root)).toEqual([
            { file: 'src/services/big.ts', found: 900, allowed: MAX_LINES, unit: 'lines' },
        ]);
    });

    it('一个 900 行的 .kt / .java 会失败（原来 android/ 不在扫描范围内）', () => {
        const root = makeRepo({
            'android/app/src/main/java/top/izuna/foliamajor/Big.kt': lines(900),
            'android/app/src/main/java/top/izuna/foliamajor/mods/Big.java': lines(901),
        });
        expect(scanSizes(root).map(v => [v.file, v.found])).toEqual([
            ['android/app/src/main/java/top/izuna/foliamajor/Big.kt', 900],
            ['android/app/src/main/java/top/izuna/foliamajor/mods/Big.java', 901],
        ]);
    });

    it('声明文件与语言文件不数：它们不是「一个功能堆在一个文件里」', () => {
        const root = makeRepo({
            'src/types/big.d.ts': lines(2000),
            'src/i18n/locales/zh-CN.ts': lines(9000),
            'src/vite-env.d.ts': lines(1200),
        });
        expect(scanSizes(root)).toEqual([]);
        expect(listSizeSources(root).files).toEqual([]);
    });

    it('已有的超长文件进了基线就放行，长回去仍然失败', () => {
        const root = makeRepo({ 'src/legacy.ts': lines(900) }, { 'src/legacy.ts': 900 });
        expect(scanSizes(root)).toEqual([]);
        writeFileSync(path.join(root, 'src/legacy.ts'), lines(950));
        expect(scanSizes(root).some(v => v.unit === 'lines')).toBe(true);
    });

    it('仓库里真的有 .ts 与 Kotlin / Java 进统计，而不只是 .tsx', () => {
        const { files, roots } = listSizeSources(repoRoot);
        expect(roots).toEqual(['src', 'android/app/src/main/java']);
        expect(files.some(file => file.endsWith('.ts') && !file.endsWith('.tsx'))).toBe(true);
        expect(files.some(file => file.endsWith('.kt'))).toBe(true);
        expect(files.some(file => file.endsWith('.d.ts'))).toBe(false);
        expect(files.some(file => file.startsWith('src/i18n/locales/'))).toBe(false);
    });
});
