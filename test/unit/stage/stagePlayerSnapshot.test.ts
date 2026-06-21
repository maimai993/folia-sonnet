import { describe, expect, it } from 'vitest';
import { resolveStagePlayerPositionSec } from '@/utils/stagePlayerSnapshot';

// Keeps Stage player snapshot clock selection stable across stage-session variants.

describe('stage player snapshot clock selection', () => {
    it('uses the synthetic lyrics clock for stage sessions without an audio element', () => {
        const positionSec = resolveStagePlayerPositionSec({
            activePlaybackContext: 'stage',
            isExternalPlaybackSourceActive: false,
            audioCurrentTimeSec: null,
            motionCurrentTimeSec: 5,
            syntheticStageLyricsTimeSec: 1.75,
        });

        expect(positionSec).toBe(1.75);
    });

    it('keeps audio element time authoritative for external pushed media sessions', () => {
        const positionSec = resolveStagePlayerPositionSec({
            activePlaybackContext: 'stage',
            isExternalPlaybackSourceActive: false,
            audioCurrentTimeSec: 2.25,
            motionCurrentTimeSec: 5,
            syntheticStageLyricsTimeSec: 1.75,
        });

        expect(positionSec).toBe(2.25);
    });

    it('does not use the stage lyrics clock for external playback source snapshots', () => {
        const positionSec = resolveStagePlayerPositionSec({
            activePlaybackContext: 'stage',
            isExternalPlaybackSourceActive: true,
            audioCurrentTimeSec: null,
            motionCurrentTimeSec: 5,
            syntheticStageLyricsTimeSec: 1.75,
        });

        expect(positionSec).toBe(5);
    });
});
