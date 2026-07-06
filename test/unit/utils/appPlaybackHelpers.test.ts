import { describe, expect, it } from 'vitest';
import { hasPlayableMediaSource, isNearReportedMediaEnd } from '@/utils/appPlaybackHelpers';

// test/unit/utils/appPlaybackHelpers.test.ts

const NETWORK_EMPTY = 0;
const NETWORK_NO_SOURCE = 3;

const createMediaSource = (overrides: {
    currentSrc?: string;
    src?: string | null;
    networkState?: number;
    attrSrc?: string | null;
} = {}) => ({
    currentSrc: overrides.currentSrc ?? '',
    src: overrides.src ?? '',
    networkState: overrides.networkState ?? NETWORK_EMPTY,
    getAttribute: (name: string) => (name === 'src' ? overrides.attrSrc ?? null : null),
});

describe('hasPlayableMediaSource', () => {
    it('rejects an element with no requested or DOM source', () => {
        expect(hasPlayableMediaSource(createMediaSource(), null)).toBe(false);
    });

    it('rejects an element after the browser reports no supported source', () => {
        expect(hasPlayableMediaSource(
            createMediaSource({
                currentSrc: 'blob:http://localhost/old-track',
                networkState: NETWORK_NO_SOURCE,
            }),
            'blob:http://localhost/old-track',
        )).toBe(false);
    });

    it('accepts a requested source before the DOM currentSrc is populated', () => {
        expect(hasPlayableMediaSource(createMediaSource(), 'blob:http://localhost/new-track')).toBe(true);
    });

    it('accepts an existing DOM source when requestedSrc is temporarily absent', () => {
        expect(hasPlayableMediaSource(
            createMediaSource({ currentSrc: 'blob:http://localhost/current-track' }),
            null,
        )).toBe(true);
    });
});

describe('isNearReportedMediaEnd', () => {
    it('treats small metadata tail drift as the media end', () => {
        expect(isNearReportedMediaEnd({
            currentTime: 230.087,
            duration: 232,
        }, 232)).toBe(true);
    });

    it('does not treat normal mid-track pauses as the media end', () => {
        expect(isNearReportedMediaEnd({
            currentTime: 180,
            duration: 232,
        }, 232)).toBe(false);
    });

    it('uses fallback duration when the element duration is unavailable', () => {
        expect(isNearReportedMediaEnd({
            currentTime: 230.087,
            duration: Number.NaN,
        }, 232)).toBe(true);
    });
});
