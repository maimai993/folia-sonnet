// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { motionValue } from 'framer-motion';
import type * as ReactI18next from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Lattice from '@/components/app/lattice/Lattice';
import { useVisualizerSettingsStore } from '@/stores/useVisualizerSettingsStore';
import { PlayerState } from '@/types';
import { DEFAULT_THEME } from '@/services/baseThemes';

// Exercise the real Lattice hook order while isolating its wall and lyric rendering from GPU/browser APIs.
vi.mock('@/stores/useVisualizerSettingsStore', async () => {
    const { create } = await import('zustand');
    return { useVisualizerSettingsStore: create(() => ({ keywordColoringEnabled: true })) };
});
vi.mock('react-i18next', async importOriginal => ({
    ...await importOriginal<typeof ReactI18next>(),
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/app/lattice/LatticePlaybackProvider', () => ({
    default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/app/lattice/lyrics/LatticeLyricsProvider', () => ({
    default: ({ children, keywordColoringEnabled }: { children: ReactNode; keywordColoringEnabled: boolean }) => (
        createElement('div', { 'data-keyword-coloring': String(keywordColoringEnabled) }, children)
    ),
}));
vi.mock('@/components/app/lattice/PosterWall', () => ({ default: () => null }));
vi.mock('@/components/app/lattice/radio/RadioWall', () => ({ default: () => null }));
vi.mock('@/components/app/lattice/LatticeFocusButton', () => ({ default: () => null }));
vi.mock('@/components/wall/WallBackButton', () => ({ default: () => null }));
vi.mock('@/components/ui', () => ({ Button: () => null }));
vi.mock('@/components/app/lattice/useExploreWall', () => ({
    useExploreWall: () => ({ tiles: [], sections: [] }),
}));
vi.mock('@/hooks/useReducedMotionFor', () => ({ useReducedMotionFor: () => true }));
vi.mock('@/components/app/lattice/wallFlight', () => ({
    isFlightBackArmed: () => false,
    planPageFromWall: () => {},
}));
vi.mock('@/components/app/lattice/wallTripLog', () => ({
    beginWallTrip: () => {},
    WallTripLog: () => null,
}));
vi.mock('@/components/collectionFlight', () => ({ LATTICE_WALL_ATTR: 'data-lattice-wall' }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const time = motionValue(0);
const props: ComponentProps<typeof Lattice> = {
    controls: {
        loopMode: 'off',
        playback: {
            prev: noop,
            next: noop,
            toggleLoop: noop,
            shuffleQueue: noop,
            toggleSongLike: noop,
            isSongLiked: false,
            isFmMode: false,
        },
        invokeCommandById: noop,
        canInvokeCommandById: () => false,
    },
    lyrics: null,
    lyricSource: { currentTime: time, currentLineIndex: -1, lines: [], theme: DEFAULT_THEME },
    currentSong: null,
    playerState: PlayerState.PAUSED,
    currentTime: time,
    lyricCurrentTime: time,
    playbackDuration: 0,
    canTogglePlayback: false,
    queue: [],
    isDaylight: false,
    onBack: noop,
    onOpenPlayer: noop,
    onPlaySong: noop,
    onTogglePlayback: noop,
    onSeek: noop,
};

let container: HTMLDivElement;
let root: Root;
const render = (override?: boolean) => {
    act(() => root.render(createElement(Lattice, {
        ...props,
        ...(override === undefined ? {} : { lyricKeywordColoringEnabled: override }),
    })));
};
const expectColoring = (enabled: boolean) => {
    expect(container.querySelector('[data-keyword-coloring]')?.getAttribute('data-keyword-coloring'))
        .toBe(String(enabled));
};

beforeEach(() => {
    useVisualizerSettingsStore.setState({ keywordColoringEnabled: true });
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Lattice keyword coloring (issue #403)', () => {
    it.each([true, false])('keeps hooks stable when adding and removing the %s prop override', override => {
        render();
        expectColoring(true);
        render(override);
        expectColoring(override);
        render();
        expectColoring(true);
    });

    it.each([true, false])('keeps hooks stable when removing and restoring the initial %s override', override => {
        useVisualizerSettingsStore.setState({ keywordColoringEnabled: !override });
        render(override);
        expectColoring(override);
        render();
        expectColoring(!override);
        render(override);
        expectColoring(override);
    });

    it('follows store updates without a prop and preserves explicit false/true overrides until removed', () => {
        render();
        expectColoring(true);
        act(() => useVisualizerSettingsStore.setState({ keywordColoringEnabled: false }));
        expectColoring(false);
        render(true);
        expectColoring(true);
        act(() => useVisualizerSettingsStore.setState({ keywordColoringEnabled: true }));
        expectColoring(true);
        render(false);
        expectColoring(false);
        act(() => useVisualizerSettingsStore.setState({ keywordColoringEnabled: false }));
        expectColoring(false);
        act(() => useVisualizerSettingsStore.setState({ keywordColoringEnabled: true }));
        expectColoring(false);
        render();
        expectColoring(true);
    });
});
