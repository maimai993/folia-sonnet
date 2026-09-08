import { useEffect, useRef } from 'react';
import { requestPlaybackEntryViewPrompt } from '../stores/usePlaybackEntryViewStore';
import { useSettingsModalStore } from '../stores/useSettingsModalStore';

// src/hooks/usePlaybackEntryViewPromptGate.ts

/**
 * Opens the entry-view prompt once the release notes are out of the way.
 *
 * Hung off the guide modal closing rather than off the version check that opens it, so a listener
 * who is already past this version's notes still gets asked the next time they open the guide.
 * The store's own gate is what makes it happen only once; this only decides when to try.
 */
export const usePlaybackEntryViewPromptGate = (): void => {
    const isUserGuideModalOpen = useSettingsModalStore(state => state.isUserGuideModalOpen);
    const wasGuideOpenRef = useRef(false);

    useEffect(() => {
        if (isUserGuideModalOpen) {
            wasGuideOpenRef.current = true;
            return;
        }
        if (!wasGuideOpenRef.current) {
            return;
        }
        wasGuideOpenRef.current = false;
        requestPlaybackEntryViewPrompt();
    }, [isUserGuideModalOpen]);
};
