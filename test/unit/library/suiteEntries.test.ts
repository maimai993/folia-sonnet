import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/library/suiteEntries.test.ts
// suite 的 entry.ts 按源码文本检查（registry 用 eager glob 发现它们，谁碰 registry 谁就加载全部 entry）：
// - 除默认 suite 外，entry 不能静态 import 任何组件，组件一律 React.lazy(() => import('./…'))——
//   否则一个开发版专用的 suite 会把它的整套 UI 拉进首页外壳；
// - 默认 suite（grid）是唯一的例外（首屏与移形换影，理由写在 grid/entry.ts），而且只限下面这份清单：
//   新加的组件要么 lazy，要么有意识地加进清单；
// - 开发版专用的 TUI 用 import.meta.env.DEV 门控组件与可用性，生产构建里组件连同动态 import 一起被摇掉。

const ROOT = path.resolve(__dirname, '../../..');
const SUITES_DIR = 'src/library/suites';
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const suiteIds = readdirSync(path.join(ROOT, SUITES_DIR), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
const entryOf = (suiteId: string) => `${SUITES_DIR}/${suiteId}/entry.ts`;

/** 静态的值导入（`import type` 不算，它在运行时不存在）。 */
const staticValueImports = (source: string) => [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)]
    .filter(match => !/^import\s+type\s/.test(match[0]))
    .map(match => match[1]);
const lazyImports = (source: string) => [...source.matchAll(/React\.lazy\(\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)/g)].map(match => match[1]);

const DEFAULT_SUITE = 'grid';
const DEFAULT_SUITE_EAGER_IMPORTS = [
    './home/Grid3D',
    './collection/GridCollectionSurface',
    './artist/GridArtistSurface',
    './transitions/CollectionMorphOverlay',
    './transitions/gridHostTransitions',
];

describe('library suite entries', () => {
    it('every suite folder has an entry', () => {
        expect(suiteIds).toEqual(expect.arrayContaining(['grid', 'tui']));
        for (const suiteId of suiteIds) expect(existsSync(path.join(ROOT, entryOf(suiteId)))).toBe(true);
    });

    it('non-default entries load their components lazily only', () => {
        for (const suiteId of suiteIds.filter(id => id !== DEFAULT_SUITE)) {
            const source = read(entryOf(suiteId));
            // 只允许 react 本身；组件、转场、store 一律不静态 import。
            expect(staticValueImports(source), suiteId).toEqual(staticValueImports(source).filter(source => source === 'react'));
            expect(lazyImports(source).length, suiteId).toBeGreaterThan(0);
        }
    });

    it('the default suite imports eagerly only what the first screen and the morph need', () => {
        const relativeImports = staticValueImports(read(entryOf(DEFAULT_SUITE))).filter(source => source.startsWith('.'));
        expect(relativeImports.filter(source => !DEFAULT_SUITE_EAGER_IMPORTS.includes(source))).toEqual([]);
    });

    it('keeps the TUI out of production builds', () => {
        const source = read(entryOf('tui'));
        expect(source).toMatch(/=\s*import\.meta\.env\.DEV\s*\?\s*React\.lazy\(\(\)\s*=>\s*import\('\.\/LibraryTuiView'\)\)\s*:\s*null;/);
        expect(source).toContain('available: import.meta.env.DEV,');
    });

    it('has no barrel files that would pull a suite in sideways', () => {
        const barrels = readdirSync(path.join(ROOT, 'src/library'), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile() && /^index\.tsx?$/.test(entry.name));
        expect(barrels).toEqual([]);
    });
});
