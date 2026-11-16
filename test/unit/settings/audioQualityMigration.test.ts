import { describe, expect, it } from 'vitest';
import { resolveStoredAudioQuality } from '@/stores/useAudioSettingsStore';

// test/unit/settings/audioQualityMigration.test.ts

describe('audio quality migration', () => {
    it('maps the old NetEase exhigh preference to provider-neutral high', () => {
        expect(resolveStoredAudioQuality('exhigh')).toBe('high');
        expect(resolveStoredAudioQuality('high')).toBe('high');
    });

    it.each(['standard', 'ultra', 'lossless', 'hires'] as const)('preserves %s', quality => {
        expect(resolveStoredAudioQuality(quality)).toBe(quality);
    });

    // 没存过时给 1080P（ultra）：视频站的曲目几乎都是 1080P 源，默认 720P 太亏。
    it('falls back to 1080P for a listener who never chose', () => {
        expect(resolveStoredAudioQuality(null)).toBe('ultra');
        expect(resolveStoredAudioQuality('')).toBe('ultra');
        expect(resolveStoredAudioQuality('nonsense')).toBe('ultra');
    });
});
