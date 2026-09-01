import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/stores/storeContract.test.ts
// Guards the invariants the settings-store split can silently break.
//
// These are not style rules. Each one corresponds to a failure that is invisible in review, and
// that no existing test covers:
//
//   storage keys — a renamed key does not fail anything, it just loses the listener's setting.
//   dependency graph — a cycle between stores surfaces as a default being `undefined` while a
//                      store initialises, not as a warning (see the note in automix/stems.ts).
//   per-frame values — a MotionValue's value in store state re-renders the tree at frame rate.
//
// Written against the source text rather than by importing the stores: several of them pull the
// visualizer registry, which is deliberately kept out of node-environment tests.

const STORES_DIR = path.resolve(__dirname, '../../../src/stores');
const storeFiles = readdirSync(STORES_DIR).filter(name => name.endsWith('.ts'));
const readStore = (name: string) => readFileSync(path.join(STORES_DIR, name), 'utf8');

describe('store contract', () => {
    it('keeps every localStorage key the stores read or write', () => {
        const keys = new Set<string>();
        for (const name of storeFiles) {
            const source = readStore(name);
            for (const match of source.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*'([^']+)'/g)) {
                keys.add(match[1]);
            }
            // Keys held in a constant, which is how most of them are written.
            for (const match of source.matchAll(/^(?:export )?const \w*(?:KEY|Key) = '([^']+)';$/gm)) {
                keys.add(match[1]);
            }
        }
        // A key that changes name does not break a build or a test — it silently drops whatever the
        // listener had chosen. This snapshot is the only thing standing between a rename and that.
        expect([...keys].sort()).toMatchSnapshot();
    });

    it('keeps the store dependency graph acyclic', () => {
        const graph = new Map<string, string[]>();
        for (const name of storeFiles) {
            const id = name.replace(/\.ts$/, '');
            const deps = [...readStore(name).matchAll(/from '\.\/(\w+)'/g)].map(match => match[1]);
            graph.set(id, deps);
        }

        const state = new Map<string, 'visiting' | 'done'>();
        const cycles: string[] = [];
        const walk = (id: string, trail: string[]) => {
            if (state.get(id) === 'done') return;
            if (state.get(id) === 'visiting') {
                cycles.push([...trail.slice(trail.indexOf(id)), id].join(' -> '));
                return;
            }
            state.set(id, 'visiting');
            for (const dep of graph.get(id) ?? []) walk(dep, [...trail, id]);
            state.set(id, 'done');
        };
        for (const id of graph.keys()) walk(id, []);

        expect(cycles).toEqual([]);
    });

    it('keeps no per-frame value in store state', () => {
        // motionSignals is the one module allowed to hold MotionValues: it holds the instances and
        // never their values, which is the whole distinction. Everything else must stay clear.
        const offenders = storeFiles
            .filter(name => name !== 'motionSignals.ts')
            .filter(name => /\bmotionValue\(|\buseMotionValue\(/.test(readStore(name)));

        expect(offenders).toEqual([]);
    });

    it('keeps store-to-store coupling to the edges that were argued for', () => {
        // tsc already rejects an import of something that does not exist. What it cannot see is a
        // NEW dependency between two domain stores, which is how a set of independent stores turns
        // back into one tangle. Every edge below had a reason; a new one needs the same.
        const ALLOWED: Record<string, string[]> = {
            // Clearing a monet/cappella asset has to fall its tuning back, so the settings store
            // drives the asset store. The reverse edge is deliberately absent: it would close a cycle.
            useVisualizerSettingsStore: ['useVisualizerAssetStore'],
        };
        const INFRASTRUCTURE = new Set([
            'storagePrimitives', 'useStatusMessageStore', 'visualizerSettingsPersistence', 'motionSignals',
        ]);

        const edges: string[] = [];
        for (const name of storeFiles) {
            const from = name.replace(/\.ts$/, '');
            if (INFRASTRUCTURE.has(from)) continue;
            for (const match of readStore(name).matchAll(/^import [^;]*from '\.\/(\w+)';$/gm)) {
                const to = match[1];
                if (INFRASTRUCTURE.has(to) || ALLOWED[from]?.includes(to)) continue;
                edges.push(`${from} -> ${to}`);
            }
        }

        expect(edges).toEqual([]);
    });

    it('leaves no reference to a store module that no longer exists', () => {
        // Two ways to name a store that tsc cannot check, both of which fail silently:
        //   a Playwright spec importing a store by runtime path string inside page.evaluate
        //   a vi.mock naming a store by alias - mocking a missing module is a no-op, so the suite
        //   quietly runs the real store instead of the fixture it thinks it installed
        // Splitting a store leaves both behind. This is the only thing that reports it.
        const ROOTS = ['src', 'test', 'dev'].map(dir => path.resolve(__dirname, '../../..', dir));
        const known = new Set(storeFiles.map(name => name.replace(/\.ts$/, '')));
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
            return /\.tsx?$/.test(entry.name) ? [full] : [];
        });

        const dangling: string[] = [];
        for (const file of ROOTS.flatMap(walk)) {
            const source = readFileSync(file, 'utf8');
            const named = [
                ...source.matchAll(/['"]\/src\/stores\/(\w+)\.ts['"]/g),
                ...source.matchAll(/['"]@\/stores\/(\w+)['"]/g),
                ...source.matchAll(/\bsrc\/stores\/(\w+)\.ts\b/g),
            ].map(match => match[1]);
            for (const name of new Set(named)) {
                if (!known.has(name)) {
                    dangling.push(`${path.relative(path.resolve(__dirname, '../../..'), file)} -> ${name}`);
                }
            }
        }

        expect(dangling).toEqual([]);
    });
});
