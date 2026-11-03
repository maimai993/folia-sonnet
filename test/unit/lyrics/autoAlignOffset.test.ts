import { describe, expect, it } from 'vitest';
import { buildVocalBandEnvelope, estimateAutoAlign, type AutoAlignLine } from '@/utils/lyrics/autoAlignOffset';

const FPS = 100;
const SILENCE_DB = -80;
const VOICE_DB = -22;

/** 每 4 秒一句、每句唱 2 秒的包络；`shiftSec` 让「真正的人声」相对歌词时间戳错开。 */
const buildEnvelope = (lineCount: number, shiftSec: number, irregular = false): { envelope: Float32Array; lines: AutoAlignLine[] } => {
    const totalFrames = Math.round((lineCount * 4 + 6) * FPS);
    const envelope = new Float32Array(totalFrames).fill(SILENCE_DB);
    const lines: AutoAlignLine[] = [];
    for (let index = 0; index < lineCount; index += 1) {
        const stamp = 2 + index * 4;
        const voiceStart = stamp + shiftSec + (irregular && index % 2 === 1 ? 0.6 : 0);
        for (let frame = Math.round(voiceStart * FPS); frame < Math.round((voiceStart + 2) * FPS); frame += 1) {
            envelope[frame] = VOICE_DB;
        }
        lines.push({ startTime: stamp, endTime: stamp + 2, fullText: `第${index + 1}句歌词` });
    }
    return { envelope, lines };
};

describe('estimateAutoAlign', () => {
    it('says nothing when the lyrics already line up with the voice', () => {
        const { envelope, lines } = buildEnvelope(20, 0);
        const result = estimateAutoAlign(envelope, FPS, lines);
        expect(result.applied).toBe(false);
        expect(result.reason).toBe('negligible');
        expect(Math.abs(result.offsetMs)).toBeLessThan(80);
    });

    it('finds a whole-song offset of a few hundred milliseconds', () => {
        // 歌词时间戳比人声晚 300 ms：整首都要往前挪，offset 应为 +300。
        const { envelope, lines } = buildEnvelope(20, -0.3);
        const result = estimateAutoAlign(envelope, FPS, lines);
        expect(result.applied).toBe(true);
        expect(result.offsetMs).toBeGreaterThanOrEqual(270);
        expect(result.offsetMs).toBeLessThanOrEqual(330);
        expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('refuses to guess from a handful of lines', () => {
        const { envelope, lines } = buildEnvelope(3, -0.3);
        const result = estimateAutoAlign(envelope, FPS, lines);
        expect(result.applied).toBe(false);
        expect(result.reason).toBe('not-enough-lines');
        expect(result.samples).toBeLessThan(8);
    });

    it('refuses when the lines disagree with each other', () => {
        // 每三行有一行偏 0.6 秒：方向不一致，说明不是整曲偏移。
        const { envelope, lines } = buildEnvelope(21, -0.3, true);
        const result = estimateAutoAlign(envelope, FPS, lines);
        expect(result.applied).toBe(false);
        expect(['low-confidence', 'negligible']).toContain(result.reason);
    });

    it('ignores interlude placeholders and one-word lines', () => {
        const { envelope, lines } = buildEnvelope(20, -0.3);
        const withNoise: AutoAlignLine[] = [
            ...lines,
            { startTime: 1, endTime: 1.2, fullText: '啊' },
            { startTime: 3, endTime: 3.1, fullText: '……' },
        ];
        const result = estimateAutoAlign(envelope, FPS, withNoise);
        expect(result.applied).toBe(true);
        expect(result.offsetMs).toBeGreaterThanOrEqual(270);
        expect(result.offsetMs).toBeLessThanOrEqual(330);
    });
});

describe('buildVocalBandEnvelope', () => {
    it('reports a clear level step between silence and a voice-band tone', () => {
        // 8 kHz、1 秒：前半静音，后半 1 kHz 正弦（落在人声带内）。
        const sampleRate = 8000;
        const samples = new Float32Array(sampleRate);
        for (let index = sampleRate / 2; index < sampleRate; index += 1) {
            samples[index] = 0.3 * Math.sin((2 * Math.PI * 1000 * index) / sampleRate);
        }
        const envelope = buildVocalBandEnvelope(samples, sampleRate, FPS);
        const silent = envelope[20];
        const voiced = envelope[70];
        expect(voiced - silent).toBeGreaterThan(30);
    });

    it('puts a low-frequency rumble well below the voice band', () => {
        const sampleRate = 8000;
        const tone = (frequency: number) => {
            const samples = new Float32Array(sampleRate);
            for (let index = sampleRate / 2; index < sampleRate; index += 1) {
                samples[index] = 0.4 * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
            }
            return buildVocalBandEnvelope(samples, sampleRate, FPS);
        };
        // 同样振幅下，60 Hz 的底鼓被高通切掉二三十 dB，才轮不到它冒充人声起唱。
        expect(tone(1000)[70] - tone(60)[70]).toBeGreaterThan(15);
    });
});
