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
        /*
         * 人声比歌词时间戳早 300 ms（词比声音晚出）：整首都要往前挪。
         *
         * 播放端是 `lyricTimeSec = audioTime - offset / 1000`，正的 offset 让歌词更晚，
         * 所以「往前挪」是负数。原来这里断言 +300 —— 符号反了，自动校准会把偏差放大一倍。
         */
        const { envelope, lines } = buildEnvelope(20, -0.3);
        const result = estimateAutoAlign(envelope, FPS, lines);
        expect(result.applied).toBe(true);
        expect(result.offsetMs).toBeLessThanOrEqual(-270);
        expect(result.offsetMs).toBeGreaterThanOrEqual(-330);
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

    it('does not follow a drum hit that lands before the voice', () => {
        /*
         * 每句之前 350 ms 有一记比人声还响的鼓（60 ms 的瞬态）。它是「最大的能量跃升」，
         * 但撑不住 —— 人声才是这一行的起唱点。跟着鼓走会把整首歌词往后推 350 ms，
         * 而且写进本曲偏移之后一直跟着这首歌。
         */
        const { envelope, lines } = buildEnvelope(20, 0);
        for (const line of lines) {
            const from = Math.round((line.startTime - 0.35) * FPS);
            for (let frame = from; frame < from + 6; frame += 1) {
                envelope[frame] = VOICE_DB + 6;
            }
        }
        const result = estimateAutoAlign(envelope, FPS, lines);
        expect(result.applied).toBe(false);
        expect(Math.abs(result.offsetMs)).toBeLessThan(80);
    });

    it('ignores interlude placeholders and one-word lines', () => {        const { envelope, lines } = buildEnvelope(20, -0.3);
        const withNoise: AutoAlignLine[] = [
            ...lines,
            { startTime: 1, endTime: 1.2, fullText: '啊' },
            { startTime: 3, endTime: 3.1, fullText: '……' },
        ];
        const result = estimateAutoAlign(envelope, FPS, withNoise);
        expect(result.applied).toBe(true);
        expect(result.offsetMs).toBeLessThanOrEqual(-270);
        expect(result.offsetMs).toBeGreaterThanOrEqual(-330);
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
