import { describe, expect, it, vi } from 'vitest';
import { PlayerState } from '../../../src/types';
import { getCommandPaletteMatches } from '../../../src/components/command-palette/commandRegistry';
import type { CommandPaletteContext } from '../../../src/components/command-palette/types';

const createContext = (overrides: Partial<CommandPaletteContext> = {}): CommandPaletteContext => ({
    currentSearchSourceTab: 'playlist',
    localSongs: [],
    playerState: PlayerState.PAUSED,
    t: (_key, fallback) => fallback ?? '',
    openSettings: vi.fn(),
    navigateToHome: vi.fn(),
    navigateToPlayer: vi.fn(),
    navigateToSearch: vi.fn(),
    setHomeViewTab: vi.fn(),
    setPanelTab: vi.fn(),
    setIsPanelOpen: vi.fn(),
    submitSearch: vi.fn(async () => true),
    togglePlay: vi.fn(),
    toggleLoop: vi.fn(),
    handleNextTrack: vi.fn(),
    handlePrevTrack: vi.fn(),
    shuffleQueue: vi.fn(),
    setVisualizerMode: vi.fn(),
    ...overrides,
});

describe('command palette registry', () => {
    it('parses source-specific search input', async () => {
        const context = createContext();
        const [match] = getCommandPaletteMatches('local touhou');

        expect(match.command.id).toBe('search-local');
        expect(match.input).toBe('touhou');

        await match.command.execute(match.input, context);

        expect(context.submitSearch).toHaveBeenCalledWith(expect.objectContaining({
            query: 'touhou',
            sourceTab: 'local',
            returnView: 'player',
        }));
        expect(context.navigateToSearch).toHaveBeenCalledWith(expect.objectContaining({
            query: 'touhou',
            sourceTab: 'local',
            returnView: 'player',
        }));
    });

    it('opens settings subviews through the settings command', () => {
        const context = createContext();
        const [match] = getCommandPaletteMatches('integration');

        expect(match.command.id).toBe('settings-integration');
        match.command.execute(match.input, context);

        expect(context.openSettings).toHaveBeenCalledWith('options', 'integration');
    });

    it('matches commands by Chinese keyword and pinyin', () => {
        expect(getCommandPaletteMatches('本地 bad apple')[0].command.id).toBe('search-local');
        expect(getCommandPaletteMatches('bendi bad apple')[0].command.id).toBe('search-local');
        expect(getCommandPaletteMatches('设置')[0].command.id).toBe('settings-options');
        expect(getCommandPaletteMatches('shezhi')[0].command.id).toBe('settings-options');
        expect(getCommandPaletteMatches('心象')[0].command.id).toBe('visualizer-cadenza');
        expect(getCommandPaletteMatches('xinxiang')[0].command.id).toBe('visualizer-cadenza');
    });

    it('limits suggestions to ten commands', () => {
        expect(getCommandPaletteMatches('')).toHaveLength(10);
    });
});
