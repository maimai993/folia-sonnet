import { describe, expect, it } from 'vitest';
import {
    ingestMusicEnvelope,
    nextUnrefinedFrom,
    refinedSeconds,
    sampleMusicEnvelope,
} from '../../../src/services/analysis/musicEnvelope';

// src/services/analysis/musicEnvelope.ts: the two-layer envelope.
//
// 基线（原生整曲频段分析）先把十条曲线铺满整首，分轨结果随后按区间盖上去。
// 这两层必须严格区分：基线是「大概」，分轨是「这一段的真值」，而 `refined` 是唯一
// 能说明「哪里已经换成真值」的账本 —— 它决定后台还要不要跑、缓存能不能命中。

const FPS = 25;

/** 一段 [fromSec, untilSec) 的曲线，值全是 `value`。 */
const block = (fromSec: number, untilSec: number, value: number) => {
    const frames = Math.round((untilSec - fromSec) * FPS);
    const curve = new Float32Array(frames).fill(value);
    return {
        fps: FPS,
        fromSec,
        untilSec,
        bass: curve,
        vocals: curve,
        other: curve,
        energy: curve,
    };
};

describe('baseline and refined layers', () => {
    it('lays a baseline across the whole track, and leaves nothing refined', () => {
        const key = 'baseline';
        const envelope = ingestMusicEnvelope(key, block(0, 10, 0.5));
        expect(envelope.bass.length).toBe(250);
        expect(envelope.until).toBeCloseTo(10, 5);
        // 一条基线不等于精修过：后台还得去补真分轨。
        expect(refinedSeconds(envelope)).toBe(0);
        expect(nextUnrefinedFrom(envelope, 10)).toBe(0);
    });

    it('overwrites the middle of the baseline without changing its length', () => {
        const key = 'overwrite';
        ingestMusicEnvelope(key, block(0, 10, 0.5));
        const envelope = ingestMusicEnvelope(key, block(4, 6, 0.9), { refine: true });
        // 长度不变：这是覆盖，不是往后接。
        expect(envelope.bass.length).toBe(250);
        expect(envelope.until).toBeCloseTo(10, 5);
        // 4~6 秒被真分轨换掉，两侧仍是基线。
        expect(envelope.bass[4 * FPS + 1]).toBeCloseTo(0.9, 5);
        expect(envelope.bass[2 * FPS]).toBeCloseTo(0.5, 5);
        expect(envelope.bass[8 * FPS]).toBeCloseTo(0.5, 5);
    });

    it('keeps the refined ledger in order and merges touching blocks', () => {
        const key = 'ledger';
        ingestMusicEnvelope(key, block(0, 20, 0.5));
        ingestMusicEnvelope(key, block(0, 5, 0.9), { refine: true });
        const envelope = ingestMusicEnvelope(key, block(5, 10, 0.9), { refine: true });
        // 两块首尾相接，应该合并成一段，而不是碎成两段。
        expect(envelope.refined).toEqual([0, 10]);
        expect(refinedSeconds(envelope)).toBeCloseTo(10, 5);
        expect(nextUnrefinedFrom(envelope, 20)).toBeCloseTo(10, 5);
    });

    it('points at the first hole when a later stretch is refined out of order', () => {
        const key = 'hole';
        ingestMusicEnvelope(key, block(0, 20, 0.5));
        // 先补 10~15，再补 0~4：中间 4~10 仍是空的。
        ingestMusicEnvelope(key, block(10, 15, 0.9), { refine: true });
        const envelope = ingestMusicEnvelope(key, block(0, 4, 0.9), { refine: true });
        expect(nextUnrefinedFrom(envelope, 20)).toBeCloseTo(4, 5);
        expect(refinedSeconds(envelope)).toBeCloseTo(9, 5);
    });

    it('counts a fully refined track as done', () => {
        const key = 'done';
        ingestMusicEnvelope(key, block(0, 8, 0.5));
        const envelope = ingestMusicEnvelope(key, block(0, 8, 0.9), { refine: true });
        expect(nextUnrefinedFrom(envelope, 8)).toBeCloseTo(8, 5);
        expect(refinedSeconds(envelope)).toBeCloseTo(8, 5);
    });

    it('reads the refined band louder than the baseline around it', () => {
        const key = 'read';
        ingestMusicEnvelope(key, block(0, 10, 0.1));
        const envelope = ingestMusicEnvelope(key, block(4, 6, 0.9), { refine: true });
        expect(sampleMusicEnvelope(envelope, 'bass', 5)).toBeGreaterThan(0.8);
        expect(sampleMusicEnvelope(envelope, 'bass', 2)).toBeLessThan(0.2);
    });
});
