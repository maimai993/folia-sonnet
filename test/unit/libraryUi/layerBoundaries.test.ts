import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/libraryUi/layerBoundaries.test.ts
// Library Core 的分层约束，按源码文本检查（与 storeContract 同样的做法）：
// - 契约、纯变换和资源层不依赖 React、framer-motion 或组件目录——换 renderer 不该牵动它们；
// - 纯变换（utils）不读 store、不调 service，可用性这类判定由调用方注入。
// - 绑定（hooks/libraryUi）不碰组件与动画；变更动作层只用注入的 omni 与缓存，默认装配集中在一处。

const ROOT = path.resolve(__dirname, '../../..');
const listSources = (dir: string): string[] => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
});
const importsOf = (file: string) => [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)]
    .filter(match => !/^import\s+type\s/.test(match[0]))
    .map(match => match[1]);

const toPosix = (file: string) => file.split(path.sep).join('/');

const CORE_FILES = [
    'src/types/libraryUi.ts',
    'src/types/libraryCollection.ts',
    ...listSources('src/utils/libraryUi'),
    ...listSources('src/services/libraryUi'),
];

describe('library core layer boundaries', () => {
    it('keeps contracts, transforms and resources free of React, animation and components', () => {
        const offenders = CORE_FILES.flatMap(file => importsOf(file)
            .filter(source => source === 'react' || source === 'framer-motion' || /\/components\//.test(source))
            .map(source => `${file} -> ${source}`));
        expect(offenders).toEqual([]);
    });

    it('keeps the list renderer independent of the grid, its hex viewport and the open transition', () => {
        const FORBIDDEN = [
            /\/GridView$/, /\/Grid3D$/, /\/GridMap$/, /\/ArtistGridView$/,
            /folia-grid\/(PolaroidCard|polaroidCardParts|hex\w*|useFoliaHexViewport)$/,
            /collectionOpenMorph\//,
        ];
        const offenders = listSources('src/components/library-tui').flatMap(file => importsOf(file)
            .filter(source => FORBIDDEN.some(pattern => pattern.test(source)))
            .map(source => `${file} -> ${source}`));
        expect(listSources('src/components/library-tui').length).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });

    it('keeps pure transforms away from stores and services', () => {
        const offenders = listSources('src/utils/libraryUi').flatMap(file => importsOf(file)
            .filter(source => /\/(stores|services)\//.test(source))
            .map(source => `${file} -> ${source}`));
        expect(offenders).toEqual([]);
    });

    it('keeps the library hooks free of components and animation', () => {
        const hooks = listSources('src/hooks/libraryUi');
        const offenders = hooks.flatMap(file => importsOf(file)
            .filter(source => source === 'framer-motion' || /\/components\//.test(source))
            .map(source => `${file} -> ${source}`));
        expect(hooks.map(toPosix)).toContain('src/hooks/libraryUi/useCollectionMutations.ts');
        expect(offenders).toEqual([]);
    });

    it('keeps the mutation layer injectable: omni and the cache are wired in one place only', () => {
        expect(CORE_FILES.map(toPosix)).toEqual(expect.arrayContaining([
            'src/utils/libraryUi/collectionMutationCapabilities.ts',
            'src/services/libraryUi/collectionMutations.ts',
            'src/services/libraryUi/collectionMutationDeps.ts',
        ]));
        // 控制器只拿注入的 omni 子集与缓存删除函数；默认装配在 collectionMutationDeps，单测不经过它。
        const offenders = importsOf('src/services/libraryUi/collectionMutations.ts')
            .filter(source => /onlineMusic\/omni$|\/db$|\/stores\//.test(source));
        expect(offenders).toEqual([]);
    });
});
