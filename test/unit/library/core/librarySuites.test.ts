import { describe, expect, it } from 'vitest';
import {
    buildLibrarySuiteIndex,
    DEFAULT_LIBRARY_SUITE_ID,
    intersectDeclaredActions,
    LIBRARY_ACTION_IDS,
    LIBRARY_ACTION_MUTATION_CAPABILITY,
    LIBRARY_SURFACE_IDS,
    resolveDeclaredMutationActions,
} from '@/library/core/model/librarySuites';
import { EMPTY_COLLECTION_MUTATION_SNAPSHOT } from '@/library/core/model/collectionMutationCapabilities';
import type { LibraryActionId, LibrarySuiteManifest } from '@/library/core/contracts/suite';
import type { CollectionMutationCapabilities } from '@/library/core/contracts/mutations';

// test/unit/library/core/librarySuites.test.ts
// suite 清单的纯规则：回退默认 suite、清单自检、声明与 core 能力取交集。喂的是假清单，不经过 glob。

const component = (name: string) => Object.assign(() => name, { displayName: name });

const gridLike = (): LibrarySuiteManifest => ({
    id: 'grid',
    labelKey: 'grid',
    surfaces: {
        home: { component: component('grid-home'), actions: [] },
        collection: { component: component('grid-collection'), actions: ['play', 'play-scope', 'resync-folder'], extraActions: ['toggle-info-panel'] },
        artist: { component: component('grid-artist'), actions: ['play'] },
    },
});

const listLike = (overrides: Partial<LibrarySuiteManifest> = {}): LibrarySuiteManifest => ({
    id: 'list',
    labelKey: 'list',
    surfaces: { collection: { component: component('list-collection'), actions: ['play', 'play-scope'] } },
    ...overrides,
});

describe('library suite index', () => {
    it('resolves a surface to the selected suite and falls back to the default one', () => {
        const index = buildLibrarySuiteIndex([listLike(), gridLike()]);
        const collection = index.resolve('collection', 'list');
        expect(collection.suite.id).toBe('list');
        expect(collection.isFallback).toBe(false);
        expect(collection.declaredActions).toEqual({ actions: ['play', 'play-scope'], extraActions: [] });

        for (const surface of ['home', 'artist'] as const) {
            const resolved = index.resolve(surface, 'list');
            expect(resolved.suite.id).toBe('grid');
            expect(resolved.isFallback).toBe(true);
            // 回退时用的就是默认 suite 自己的那份声明（同一个对象）。
            expect(resolved.declaredActions).toBe(index.resolve(surface, 'grid').declaredActions);
        }
        expect(index.resolve('collection', 'unknown').suite.id).toBe('grid');
    });

    it('answers with the same object every time, so the result can be passed as props', () => {
        const index = buildLibrarySuiteIndex([gridLike(), listLike()]);
        expect(index.resolve('collection', 'grid')).toBe(index.resolve('collection', 'grid'));
        expect(index.resolve('collection', 'grid').declaredActions.extraActions).toEqual(['toggle-info-panel']);
    });

    it('lists the default suite first and drops unavailable suites', () => {
        const index = buildLibrarySuiteIndex([listLike({ id: 'b' }), listLike({ id: 'a' }), gridLike(), listLike({ id: 'off', available: false })]);
        expect(index.suites.map(suite => suite.id)).toEqual(['grid', 'a', 'b']);
        expect(index.has('off')).toBe(false);
        expect(index.resolve('collection', 'off').suite.id).toBe('grid');
        expect(index.defaultSuite.id).toBe(DEFAULT_LIBRARY_SUITE_ID);
    });

    it('refuses broken manifests at startup', () => {
        expect(() => buildLibrarySuiteIndex([gridLike(), gridLike()])).toThrow(/Duplicate/);
        expect(() => buildLibrarySuiteIndex([listLike()])).toThrow(/Default suite "grid" is missing/);
        const partialGrid = gridLike();
        expect(() => buildLibrarySuiteIndex([{ ...partialGrid, surfaces: { collection: partialGrid.surfaces.collection } }]))
            .toThrow(/must implement every surface; missing home, artist/);
        expect(() => buildLibrarySuiteIndex([gridLike(), listLike({
            surfaces: { collection: { component: component('x'), actions: ['teleport' as LibraryActionId] } },
        })])).toThrow(/unknown action "teleport"/);
        expect(() => buildLibrarySuiteIndex([gridLike(), listLike({
            surfaces: { search: { component: component('x'), actions: [] } } as unknown as LibrarySuiteManifest['surfaces'],
        })])).toThrow(/unknown surface "search"/);
    });

    it('knows the three surfaces', () => {
        expect(LIBRARY_SURFACE_IDS).toEqual(['home', 'collection', 'artist']);
    });
});

describe('declared actions and core capabilities', () => {
    it('keeps only the actions the suite declared, in the order core reports them', () => {
        const declared = { actions: ['play-scope', 'reload', 'sort'] as LibraryActionId[], extraActions: [] };
        expect(intersectDeclaredActions(declared, ['sort', 'play-scope', 'enqueue-scope', 'remove-entry'])).toEqual(['sort', 'play-scope']);
    });

    it('maps every mutation capability except the renderer-owned edit mode to an action id', () => {
        const capabilityKeys = Object.keys(EMPTY_COLLECTION_MUTATION_SNAPSHOT.capabilities).filter(key => key !== 'editCollection');
        expect(Object.values(LIBRARY_ACTION_MUTATION_CAPABILITY).sort()).toEqual(capabilityKeys.sort());
        for (const action of Object.keys(LIBRARY_ACTION_MUTATION_CAPABILITY)) {
            expect(LIBRARY_ACTION_IDS).toContain(action);
        }
        expect(new Set(LIBRARY_ACTION_IDS).size).toBe(LIBRARY_ACTION_IDS.length);
    });

    it('offers a mutation action only when the suite declares it and the collection supports it', () => {
        const supported = { supported: true, enabled: false, pending: true } as const;
        const capabilities: CollectionMutationCapabilities = {
            ...EMPTY_COLLECTION_MUTATION_SNAPSHOT.capabilities,
            removeEntry: supported,
            subscribe: supported,
            rename: supported,
        };
        const declared = { actions: ['play', 'remove-entry', 'rename', 'export-playlist'] as LibraryActionId[], extraActions: [] };
        // 进行中（enabled=false）仍然出现；声明了但不支持的（export-playlist）、支持但没声明的（subscribe）不出现。
        expect(resolveDeclaredMutationActions(declared, capabilities)).toEqual(['remove-entry', 'rename']);
    });
});
