import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

// test/unit/mod-system/androidModuleFence.test.ts
// The Android Node host runs mods in its own process, so the only thing between a mod and
// `child_process` is the module fence (assets/folia-node/moduleFence.js). These pin that a mod
// gets the read-only core modules, that everything else needs the capability it declares in
// mod.json, that the host itself is never fenced, and that the table the fence reads is the one
// mod.json is validated against.

const require = createRequire(import.meta.url);

const fencePath = path.resolve('android/app/src/main/assets/folia-node/moduleFence.js');
const sharedPath = path.resolve('electron/modSystem/foliumShared.json');
const androidSharedPath = path.resolve('android/app/src/main/assets/folia-node/modSystem/foliumShared.json');
const { createModuleFence, makeChildProcessFacade, bareName } = require(fencePath);
const { KNOWN_PROCESS_CAPABILITIES, PROCESS_CAPABILITY_MODULES, CORE_MODULES, validateManifest } = require(
    path.resolve('electron/modSystem/manifest.cjs'),
);

const shared = JSON.parse(fs.readFileSync(sharedPath, 'utf8')) as {
    coreModules: string[];
    capabilities: Record<string, { modules: string[] }>;
};

describe('the module fence', () => {
    const fence = createModuleFence({
        coreModules: shared.coreModules,
        capabilities: shared.capabilities,
        hostRoots: [path.resolve('android/app/src/main/assets/folia-node')],
    });

    it('names a module the same whichever way it is written', () => {
        for (const request of ['fs', 'node:fs', 'fs/promises']) {
            expect(bareName(request)).toBe('fs');
        }
        expect(bareName('node:worker_threads')).toBe('worker_threads');
    });

    it('lets a mod read the core modules with nothing declared', () => {
        for (const name of ['fs', 'path', 'crypto', 'zlib', 'worker_threads']) {
            // worker_threads is not core: it belongs to the worker-threads capability.
            const granted = name === 'worker_threads' ? ['worker-threads'] : [];
            expect(fence.admits('m', granted, `node:${name}`).ok, name).toBe(true);
        }
    });

    it('refuses child_process to a mod that did not declare process.run', () => {
        const decision = fence.admits('m', [], 'child_process');
        expect(decision).toMatchObject({ ok: false, name: 'child_process' });
        expect(decision.reason).toContain('process.run');
    });

    it('refuses raw sockets to a mod that did not declare network.socket', () => {
        for (const name of ['net', 'dgram', 'tls']) {
            expect(fence.admits('m', [], name).ok, name).toBe(false);
        }
    });

    it('admits a module once its capability is declared', () => {
        expect(fence.admits('m', ['process.run'], 'child_process').ok).toBe(true);
        expect(fence.admits('m', ['network.socket'], 'dgram').ok).toBe(true);
    });

    it('refuses a module no capability covers, whatever is declared', () => {
        const decision = fence.admits('m', ['process.run', 'network.socket', 'worker-threads'], 'vm');
        expect(decision.ok).toBe(false);
        expect(decision.reason).toContain('not available to mods');
    });

    it('never fences the host itself', () => {
        expect(fence.admits(null, [], 'child_process').ok).toBe(true);
        expect(fence.isHostFile(path.resolve('android/app/src/main/assets/folia-node/host.js'))).toBe(true);
        expect(fence.isHostFile(path.resolve('android/app/src/main/assets/folia-node/modSystem/modApi.cjs'))).toBe(true);
        expect(fence.isHostFile(path.join(os.tmpdir(), 'folia-userdata/mods/m/index.cjs'))).toBe(false);
    });
});

describe('the child_process the fence hands out', () => {
    it('cannot be made to bypass the host nvidia-smi shim', () => {
        const real = { execFile: () => 'native', exec: () => 'exec' };
        const shim = { execFile: () => 'nvidia-smi shim', exec: () => 'exec' };
        const facade = makeChildProcessFacade(shim);
        // The mod sees the shim...
        expect((facade as { execFile: () => string }).execFile()).toBe('nvidia-smi shim');
        // ...and changing it does nothing, because the facade is frozen.
        expect(Object.isFrozen(facade)).toBe(true);
        expect(() => { (facade as { execFile: unknown }).execFile = real.execFile; }).toThrow();
        expect((facade as { execFile: () => string }).execFile()).toBe('nvidia-smi shim');
    });
});

describe('the capability table', () => {
    it('is the same table the Android host ships', () => {
        const androidShared = JSON.parse(fs.readFileSync(androidSharedPath, 'utf8')) as Record<string, unknown>;
        expect(androidShared.capabilities).toEqual(shared.capabilities);
        expect(androidShared.coreModules).toEqual(shared.coreModules);
    });

    it('is what mod.json is validated against', () => {
        expect([...KNOWN_PROCESS_CAPABILITIES].sort()).toEqual(Object.keys(shared.capabilities).sort());
        for (const id of Object.keys(shared.capabilities)) {
            expect(PROCESS_CAPABILITY_MODULES[id], id).toEqual(new Set(shared.capabilities[id].modules));
        }
        expect([...CORE_MODULES].sort()).toEqual([...shared.coreModules].sort());
    });

    // The builtin mods ship in the same bundle and must keep loading after the fence landed.
    //
    // 内置模组连同宿主一起签名发布，它们的 mod.json 改一个字官方签名就失效，所以不能靠
    // 声明 `processes` 放行（listening-archive 要 worker_threads 就是这种情况）。围栏对内置
    // 模组整体放行；这条用例同时守住「照 mod.json 声明 + 核心模块也能跑通」这两条路里至少一条。
    it('covers every module a builtin mod requires, so builtin mods keep loading', () => {
        const builtinRoot = path.resolve('public/mods/builtin');
        const declared = new Map<string, string[]>();
        const required = new Map<string, Set<string>>();
        for (const entry of fs.readdirSync(builtinRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const manifestPath = path.join(builtinRoot, entry.name, 'mod.json');
            if (!fs.existsSync(manifestPath)) continue;
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id: string; processes?: string[] };
            declared.set(manifest.id, manifest.processes ?? []);
            const names = new Set<string>();
            const walk = (directory: string) => {
                for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
                    const full = path.join(directory, file.name);
                    if (file.isDirectory()) {
                        // The hosts' own node_modules are not the mod's requires.
                        if (file.name !== 'node_modules') walk(full);
                        continue;
                    }
                    if (!/\.c?js$/.test(file.name)) continue;
                    const text = fs.readFileSync(full, 'utf8');
                    for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                        names.add(bareName(match[1]));
                    }
                }
            };
            walk(path.join(builtinRoot, entry.name));
            required.set(manifest.id, names);
        }
        expect(required.size).toBeGreaterThan(0);

        const builtinIds = [...required.keys()];
        // 宿主装的那份围栏（含 builtinModIds）必须放行内置模组要的每一个模块。
        const asShipped = createModuleFence({
            coreModules: shared.coreModules,
            capabilities: shared.capabilities,
            hostRoots: [],
            builtinModIds: builtinIds,
        });
        // 另一条路：按 mod.json 声明 + 核心模块。不是每个内置模组都走这条（签名不能改），
        // 但要复核「哪些走不了」是已知的那几个，而不是悄悄多出来。
        const declarationOnly = createModuleFence({ coreModules: shared.coreModules, capabilities: shared.capabilities, hostRoots: [] });

        const needsBuiltinExemption: string[] = [];
        for (const [modId, names] of required) {
            for (const name of names) {
                expect(asShipped.admits(modId, declared.get(modId) ?? [], name).ok, `${modId} requires ${name} (as shipped)`).toBe(true);
                if (!declarationOnly.admits(modId, declared.get(modId) ?? [], name).ok) {
                    needsBuiltinExemption.push(`${modId}:${name}`);
                }
            }
        }
        // listening-archive 用 worker_threads 做后台统计，而它的 mod.json 带签名不能改。
        expect(needsBuiltinExemption.sort()).toEqual(['listening-archive:worker_threads']);
    });

    it('does not hand a third-party mod the modules of a builtin one', () => {
        const asShipped = createModuleFence({
            coreModules: shared.coreModules,
            capabilities: shared.capabilities,
            hostRoots: [],
            builtinModIds: ['listening-archive'],
        });
        expect(asShipped.admits('listening-archive', [], 'worker_threads').ok).toBe(true);
        // 同样的 require 换成别的模组 id 就被拒绝。
        expect(asShipped.admits('some-third-party', [], 'worker_threads').ok).toBe(false);
        expect(asShipped.admits('some-third-party', [], 'child_process').ok).toBe(false);
    });

    it('accepts the builtin manifests and refuses a capability that does not exist', () => {
        const manifest = {
            folium: 1,
            id: 'sample',
            name: 'Sample',
            version: '1.0.0',
            main: 'index.cjs',
            processes: ['process.run'],
        };
        expect(validateManifest(manifest).ok).toBe(true);
        expect(validateManifest({ ...manifest, processes: ['everything'] }).errors.join()).toContain('unknown process capability');
        expect(validateManifest({ ...manifest, processes: ['process.run', 'process.run'] }).errors.join()).toContain('duplicate');
        // Nothing to require the modules with, and no main entry.
        expect(validateManifest({ ...manifest, main: null, client: 'client.mjs' }).errors.join()).toContain('processes requires a "main"');
    });
});
