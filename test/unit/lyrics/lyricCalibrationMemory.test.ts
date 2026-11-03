import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/lyrics/lyricCalibrationMemory.test.ts
// 每首歌「上次自动校准的结论」：存得下、读得回、脏数据不炸、歌与歌之间不串。
//
// 单测跑在 node 环境里，没有 window。模块自己带一层内存缓存，所以每个用例都重新 import
// 一次，免得读到上一条用例留下的缓存。

const createStorage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    };
};

const loadModule = async () => {
    vi.resetModules();
    return import('../../../src/utils/lyrics/lyricCalibrationMemory');
};

describe('lyric calibration result memory', () => {
    beforeEach(() => {
        vi.stubGlobal('window', { localStorage: createStorage() });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ignores rows that are not a verdict', async () => {
        vi.stubGlobal('window', {
            localStorage: createStorage({
                lyric_auto_calibration_results: JSON.stringify({
                    broken: { phase: 'running', offsetMs: 0, at: 1 },
                    alsoBroken: 'skipped',
                    fine: { phase: 'skipped', offsetMs: 0, reason: 'negligible', at: 2 },
                }),
            }),
        });
        const memory = await loadModule();

        expect(memory.readCalibrationRecord('broken')).toBeNull();
        expect(memory.readCalibrationRecord('alsoBroken')).toBeNull();
        expect(memory.readCalibrationRecord('fine')).toMatchObject({ phase: 'skipped', reason: 'negligible' });
    });

    it('has nothing to say about a song it never scanned', async () => {
        const memory = await loadModule();
        expect(memory.readCalibrationRecord('song-a')).toBeNull();
    });

    it('remembers an applied offset and a skipped verdict apart', async () => {
        const memory = await loadModule();
        memory.writeCalibrationRecord('song-a', { phase: 'applied', offsetMs: -140, reason: null });
        memory.writeCalibrationRecord('song-b', { phase: 'skipped', offsetMs: 0, reason: 'low-confidence' });

        expect(memory.readCalibrationRecord('song-a')).toMatchObject({
            phase: 'applied',
            offsetMs: -140,
            reason: null,
        });
        expect(memory.readCalibrationRecord('song-b')).toMatchObject({
            phase: 'skipped',
            offsetMs: 0,
            reason: 'low-confidence',
        });
    });

    it('keeps the newest verdict for the same song', async () => {
        const memory = await loadModule();
        memory.writeCalibrationRecord('song-a', { phase: 'skipped', offsetMs: 0, reason: 'not-enough-lines' });
        memory.writeCalibrationRecord('song-a', { phase: 'applied', offsetMs: 120, reason: null });

        expect(memory.readCalibrationRecord('song-a')).toMatchObject({ phase: 'applied', offsetMs: 120 });
    });

    it('does not throw without a usable song key', async () => {
        const memory = await loadModule();
        memory.writeCalibrationRecord(null, { phase: 'applied', offsetMs: 100, reason: null });
        expect(memory.readCalibrationRecord(undefined)).toBeNull();
    });
});
