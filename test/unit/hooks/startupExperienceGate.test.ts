import { describe, expect, it } from 'vitest';
import { resolveStartupExperienceStep } from '../../../src/hooks/useStartupExperienceGate';

// test/unit/hooks/startupExperienceGate.test.ts

const readyState = {
    isCurrentRelease: true,
    hasSeenPonder: false,
    hasSeenReleaseNotes: false,
    isReleaseNotesOpen: false,
    hasChosenPlaybackEntryView: false,
    isPlaybackEntryViewPromptOpen: false,
    isPonderOnboardingOpen: false,
};

describe('startup experience gate', () => {
    it('orders release notes, playback entry choice, then Ponder onboarding', () => {
        expect(resolveStartupExperienceStep(readyState)).toBe('release-notes');

        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
        })).toBe('playback-entry-view');

        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
            hasChosenPlaybackEntryView: true,
        })).toBe('ponder');
    });

    it('waits for each blocking surface to close before advancing', () => {
        expect(resolveStartupExperienceStep({
            ...readyState,
            isReleaseNotesOpen: true,
        })).toBeNull();

        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
            hasChosenPlaybackEntryView: true,
            isPlaybackEntryViewPromptOpen: true,
        })).toBeNull();
    });

    it('does nothing after Ponder onboarding has already been completed', () => {
        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenPonder: true,
        })).toBeNull();
    });
});
