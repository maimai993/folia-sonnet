import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// Covers the main-process trust boundary and the intentionally narrow WAV capability fallback.

const require = createRequire(import.meta.url);
const { safeExtension, shouldUseWavFallback, validateSource } = require('../../../electron/transcode/service.cjs') as {
    safeExtension: (name: string) => string;
    shouldUseWavFallback: (error: Error) => boolean;
    validateSource: (source: unknown) => boolean;
};

describe('transcode service request validation', () => {
    it('requires local bytes and never accepts a renderer-provided path by itself', () => {
        const common = { kind: 'local', songKey: 'local:1', sourceRevision: '1:2:3', fileName: 'song.ape' };
        expect(validateSource({ ...common, filePath: 'C:\\secret.txt' })).toBe(false);
        expect(validateSource({ ...common, data: new ArrayBuffer(8) })).toBe(true);
    });

    it('accepts Navidrome bytes or HTTP(S), but rejects other schemes', () => {
        const common = { kind: 'navidrome', songKey: 'navidrome:1', sourceRevision: 'server:1' };
        expect(validateSource({ ...common, data: new Uint8Array(8) })).toBe(true);
        expect(validateSource({ ...common, url: 'https://music.test/rest/stream?id=1' })).toBe(true);
        expect(validateSource({ ...common, url: 'file:///etc/passwd' })).toBe(false);
        expect(validateSource({ ...common, url: 'blob:renderer-only' })).toBe(false);
    });

    it('sanitizes source extensions instead of treating names as paths', () => {
        expect(safeExtension('../../music.APE')).toBe('.ape');
        expect(safeExtension('music.bad-extension-too-long')).toBe('.audio');
    });

    it('uses WAV only when the FLAC encoder or muxer is unavailable', () => {
        expect(shouldUseWavFallback(new Error("Unknown encoder 'flac'"))).toBe(true);
        expect(shouldUseWavFallback(new Error('Invalid data found when processing input'))).toBe(false);
    });
});
