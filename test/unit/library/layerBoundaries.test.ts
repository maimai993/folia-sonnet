import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/library/layerBoundaries.test.ts
// src/library 的分层约束，按源码文本检查（与 storeContract 同样的做法），和 codemap.mjs 的 BOUNDARY_RULES 同一套规则：
// - core 不依赖 React 动画、组件目录、suites、app 与 registry——换 suite 不该牵动它；
// - core 内部按 contracts ← model ← services / state ← bindings 的方向：契约只引用契约与 src/types，
//   纯变换（model）是叶子，不读 store、不调 service、不碰 React；services / state 不碰绑定；
// - stores / services / utils / types 不依赖 suites 与 app；suites 之间互不依赖，也不直接用 core/services；
// - 列表 renderer（TUI）不拉进网格、hex 视口与打开转场；
// - 变更动作层只用注入的 omni 与缓存，默认装配集中在一处。

const ROOT = path.resolve(__dirname, '../../..');
const listSources = (dir: string): string[] => {
    if (!existsSync(path.join(ROOT, dir))) return [];
    return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
        const relative = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) return listSources(relative);
        return /\.tsx?$/.test(entry.name) ? [relative] : [];
    });
};
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** 值导入（运行时真的会加载的那些），不含 `import type`。 */
const importsOf = (file: string) => [...read(file).matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)]
    .filter(match => !/^import\s+type\s/.test(match[0]))
    .map(match => match[1]);

/** 全部模块说明符：值导入、`import type`、re-export 和动态 import()。用于「只能引用谁」这类规则。 */
const allSpecifiersOf = (file: string) => [
    ...[...read(file).matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)';/gms)].map(match => match[1]),
    ...[...read(file).matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map(match => match[1]),
];

/** 把相对说明符解析成仓库内的路径（不带扩展名）；裸包名原样返回。 */
const resolveSpecifier = (file: string, specifier: string) => {
    if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`;
    if (!specifier.startsWith('.')) return specifier;
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.tsx?$/, '');
};

const offendersOf = (
    files: string[],
    isForbidden: (target: string, file: string) => boolean,
    imports: (file: string) => string[] = importsOf,
) => files.flatMap(file => imports(file)
    .filter(specifier => isForbidden(resolveSpecifier(file, specifier), file))
    .map(specifier => `${file} -> ${specifier}`));

const CORE = 'src/library/core';
const CONTRACTS = listSources(`${CORE}/contracts`);
const MODEL = listSources(`${CORE}/model`);
const SERVICES = listSources(`${CORE}/services`);
const STATE = listSources(`${CORE}/state`);
const BINDINGS = listSources(`${CORE}/bindings`);
const CORE_FILES = listSources(CORE);
/** 不含 React 的 core 部分：契约、纯变换与资源 / 动作层（state 的 zustand 自带 React，单独看）。 */
const HEADLESS_FILES = [...CONTRACTS, ...MODEL, ...SERVICES];

const isUiTarget = (target: string) => /^src\/(components\/|library\/(suites\/|app\/|registry$))/.test(target);
const suiteOf = (file: string) => /^src\/library\/suites\/([^/]+)\//.exec(file)?.[1] ?? null;

describe('library core layer boundaries', () => {
    it('finds every core sublayer where the rules expect it', () => {
        for (const layer of [CONTRACTS, MODEL, SERVICES, STATE, BINDINGS]) expect(layer.length).toBeGreaterThan(0);
        // 旧位置不留转发文件。
        expect([
            ...listSources('src/utils/libraryUi'),
            ...listSources('src/services/libraryUi'),
            ...listSources('src/hooks/libraryUi'),
        ]).toEqual([]);
        expect(existsSync(path.join(ROOT, 'src/types/libraryUi.ts'))).toBe(false);
        expect(existsSync(path.join(ROOT, 'src/types/libraryCollection.ts'))).toBe(false);
    });

    it('keeps contracts, transforms and resources free of React, animation and components', () => {
        const offenders = offendersOf(HEADLESS_FILES, target => (
            target === 'react' || target === 'framer-motion' || /^src\/components\//.test(target)
        ));
        expect(offenders).toEqual([]);
    });

    it('keeps all of core away from the UI: components, suites, app and the registry', () => {
        expect(offendersOf(CORE_FILES, isUiTarget, allSpecifiersOf)).toEqual([]);
    });

    it('lets contracts reference only other contracts and the plain data types in src/types', () => {
        const offenders = offendersOf(CONTRACTS, target => (
            !/^src\/(types$|types\/|library\/core\/contracts\/)/.test(target)
        ), allSpecifiersOf);
        expect(offenders).toEqual([]);
    });

    it('keeps pure transforms a leaf: no stores, services, hooks, bindings or React', () => {
        const offenders = offendersOf(MODEL, target => (
            target === 'react'
            || /^src\/(stores|services|hooks|components)\//.test(target)
            || /^src\/library\/core\/(state|services|bindings)\//.test(target)
        ));
        expect(offenders).toEqual([]);
    });

    it('keeps services and state independent of the React bindings', () => {
        const offenders = offendersOf([...SERVICES, ...STATE], target => (
            /^src\/hooks\//.test(target) || /^src\/library\/core\/bindings\//.test(target)
        ));
        expect(offenders).toEqual([]);
    });

    it('keeps the library hooks free of components and animation', () => {
        const offenders = offendersOf(BINDINGS, target => target === 'framer-motion' || /^src\/components\//.test(target));
        expect(BINDINGS).toContain(`${CORE}/bindings/useCollectionMutations.ts`);
        expect(offenders).toEqual([]);
    });

    it('keeps stores, services, utils and types away from suites and the app assembly', () => {
        const files = [
            ...listSources('src/stores'),
            ...listSources('src/services'),
            ...listSources('src/utils'),
            ...listSources('src/types'),
            'src/types.ts',
        ];
        const offenders = offendersOf(files, target => /^src\/library\/(suites|app)\//.test(target), allSpecifiersOf);
        expect(offenders).toEqual([]);
    });

    it('keeps suites independent of each other and off core/services', () => {
        // suites 目录在 R2 才出现；规则先就位，空目录时自然通过。
        const offenders = offendersOf(listSources('src/library/suites'), (target, file) => (
            (/^src\/library\/suites\//.test(target) && suiteOf(`${target}/`) !== suiteOf(file))
            || /^src\/library\/core\/services\//.test(target)
        ), allSpecifiersOf);
        expect(offenders).toEqual([]);
    });

    it('keeps the list renderer independent of the grid, its hex viewport and the open transition', () => {
        const FORBIDDEN = [
            /\/GridView$/, /\/Grid3D$/, /\/GridMap$/, /\/ArtistGridView$/,
            /folia-grid\/(PolaroidCard|polaroidCardParts|hex\w*|useFoliaHexViewport)$/,
            /collectionOpenMorph\//,
        ];
        const tui = listSources('src/components/library-tui');
        const offenders = tui.flatMap(file => importsOf(file)
            .filter(source => FORBIDDEN.some(pattern => pattern.test(source)))
            .map(source => `${file} -> ${source}`));
        expect(tui.length).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });

    it('keeps the mutation layer injectable: omni and the cache are wired in one place only', () => {
        expect(CORE_FILES).toEqual(expect.arrayContaining([
            `${CORE}/model/collectionMutationCapabilities.ts`,
            `${CORE}/services/collectionMutations.ts`,
            `${CORE}/services/collectionMutationDeps.ts`,
        ]));
        // 控制器只拿注入的 omni 子集与缓存删除函数；默认装配在 collectionMutationDeps，单测不经过它。
        const offenders = importsOf(`${CORE}/services/collectionMutations.ts`)
            .filter(source => /onlineMusic\/omni$|\/db$|\/stores\/|\/core\/state\//.test(source));
        expect(offenders).toEqual([]);
    });
});
