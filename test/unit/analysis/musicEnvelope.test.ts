import { describe, expect, it } from 'vitest';
import { ingestMusicEnvelope, sampleMusicEnvelope } from '../../../src/services/analysis/musicEnvelope';

// src/services/analysis/musicEnvelope.ts: the four curves the htdemucs separation gives, which
// 凝彩's 低频涌动 / 人声泛光 / 情绪明暗 / 和声错位 read.

const block = (fromSec: number, untilSec: number, bass: number[], vocals: number[] = bass, other: number[] = bass, energy: number[] = bass) => ({
    fps: 20,
    fromSec,
    untilSec,
    bass: Float32Array.from(bass),
    vocals: Float32Array.from(vocals),
    other: Float32Array.from(other),
    energy: Float32Array.from(energy),
});

describe('the four music envelopes', () => {
    it('joins blocks end to end, and reads them back by time', () => {
        const key = 'joined';
        ingestMusicEnvelope(key, block(0, 0.1, [0.1, 0.1]));
        const envelope = ingestMusicEnvelope(key, block(0.1, 0.2, [0.2, 0.2]));
        expect(envelope.bass.length).toBe(4);
        expect(envelope.fps).toBe(20);
        // 0.05s 只看第一帧（0.1，顶点 0.2）；0.15s 的窗口跨过两段，平均在 0.5 与 1 之间。
        expect(sampleMusicEnvelope(envelope, 'bass', 0.05)).toBeCloseTo(0.5, 1);
        expect(sampleMusicEnvelope(envelope, 'bass', 0.15)).toBeGreaterThan(0.7);
        expect(sampleMusicEnvelope(envelope, 'bass', 0.15)).toBeLessThan(1);
    });

    it('puts a block at its own time instead of appending it, padding a gap with silence', () => {
        const key = 'gap';
        ingestMusicEnvelope(key, block(0, 0.1, [0.5, 0.5]));
        // 第二块从 0.3s 开始：中间 0.1~0.3s 没人交过，必须是 0，不能让后面的曲线提前。
        const envelope = ingestMusicEnvelope(key, block(0.3, 0.4, [0.5, 0.5]));
        expect(envelope.bass.length).toBe(8);
        expect(Array.from(envelope.bass.subarray(2, 6))).toEqual([0, 0, 0, 0]);
        expect(envelope.bass[6]).toBeCloseTo(0.5, 5);
        expect(envelope.until).toBeCloseTo(0.4, 5);
    });

    it('drops a block that repeats what is already there', () => {
        const key = 'repeat';
        ingestMusicEnvelope(key, block(0, 0.2, [0.1, 0.2, 0.3, 0.4]));
        const envelope = ingestMusicEnvelope(key, block(0, 0.2, [0.1, 0.2, 0.3, 0.4]));
        expect(envelope.bass.length).toBe(4);
    });

    it('normalises against the track’s own loudest part, so a quiet intro stays quiet', () => {
        const key = 'normalise';
        const envelope = ingestMusicEnvelope(key, block(0, 0.5, [
            0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.5,
        ]));
        // 前奏接近 0；末尾那一下被 0.15 秒的窗口摊开，仍然明显高于前奏。
        expect(sampleMusicEnvelope(envelope, 'bass', 0.1)).toBeLessThan(0.1);
        expect(sampleMusicEnvelope(envelope, 'bass', 0.45)).toBeGreaterThan(0.3);
    });

    it('smooths a single-frame spike over the 0.15s window', () => {
        const key = 'smooth';
        const values = new Array(20).fill(0);
        values[10] = 1;
        const envelope = ingestMusicEnvelope(key, block(0, 1, values));
        // 一帧的尖峰被摊到窗口里，不会在画面上闪一下就没了。
        expect(sampleMusicEnvelope(envelope, 'bass', 0.5)).toBeGreaterThan(0.15);
        expect(sampleMusicEnvelope(envelope, 'bass', 0.5)).toBeLessThan(0.6);
    });

    it('answers 0 for a track with no curves yet', () => {
        const envelope = ingestMusicEnvelope('empty', block(0, 0, []));
        expect(sampleMusicEnvelope(envelope, 'bass', 1)).toBe(0);
    });
});
