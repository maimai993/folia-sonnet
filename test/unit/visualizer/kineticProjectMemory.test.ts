import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearAllKineticProjects,
    readKineticProject,
    writeKineticProject,
} from '@/components/visualizer/kinetic/kineticProjectMemory';

// test/unit/visualizer/kineticProjectMemory.test.ts
// 文字PV 的编辑结果按歌曲存：换歌、重启都不该丢，也不该串到别的歌上。
// 这组用例钉住「按歌曲隔离」「覆盖写」「清空回默认」「坏数据不炸」四件事。
//
// 单测跑在 node 环境里没有 localStorage，按项目惯例用 vi.stubGlobal 装一个内存实现。

const STORAGE_KEY = 'kinetic_projects';

const createMemoryStorage = () => {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
        removeItem: (key: string) => { map.delete(key); },
        clear: () => { map.clear(); },
        key: (index: number) => [...map.keys()][index] ?? null,
        get length() { return map.size; },
    };
};

describe('kineticProjectMemory', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createMemoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns null for a song that was never edited', () => {
        expect(readKineticProject('song-a')).toBeNull();
    });

    it('returns null without a song key', () => {
        expect(readKineticProject(null)).toBeNull();
        expect(readKineticProject(undefined)).toBeNull();
        expect(readKineticProject('')).toBeNull();
    });

    it('round-trips a project for one song', () => {
        writeKineticProject('song-a', { style: 'noir', seed: 42, fx: { motion: 0.9 } });
        const restored = readKineticProject('song-a');
        expect(restored?.style).toBe('noir');
        expect(restored?.seed).toBe(42);
        expect(restored?.fx).toEqual({ motion: 0.9 });
    });

    it('keeps each song separate', () => {
        writeKineticProject('song-a', { style: 'noir', seed: 1 });
        writeKineticProject('song-b', { style: 'zine', seed: 2 });
        expect(readKineticProject('song-a')?.style).toBe('noir');
        expect(readKineticProject('song-b')?.style).toBe('zine');
        expect(readKineticProject('song-a')?.seed).toBe(1);
    });

    it('overwrites the previous project for the same song', () => {
        writeKineticProject('song-a', { seed: 1 });
        writeKineticProject('song-a', { seed: 2 });
        expect(readKineticProject('song-a')?.seed).toBe(2);
    });

    it('drops the entry when written as null', () => {
        writeKineticProject('song-a', { seed: 1 });
        writeKineticProject('song-a', null);
        expect(readKineticProject('song-a')).toBeNull();
    });

    it('clears every song at once', () => {
        writeKineticProject('song-a', { seed: 1 });
        writeKineticProject('song-b', { seed: 2 });
        clearAllKineticProjects();
        expect(readKineticProject('song-a')).toBeNull();
        expect(readKineticProject('song-b')).toBeNull();
    });

    it('survives a corrupted storage value', () => {
        localStorage.setItem(STORAGE_KEY, 'not json at all');
        expect(readKineticProject('song-a')).toBeNull();
        // 写一次应该把坏数据盖掉，之后照常可读。
        writeKineticProject('song-a', { seed: 7 });
        expect(readKineticProject('song-a')?.seed).toBe(7);
    });
});
