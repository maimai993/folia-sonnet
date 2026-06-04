import { PlayerState, type HomeViewTab, type VisualizerMode } from '../../types';
import type { PanelTab } from '../UnifiedPanel';
import type {
    CommandPaletteCommand,
    CommandPaletteContext,
    CommandPaletteMatch,
    CommandPaletteSearchSource,
} from './types';

// src/components/command-palette/commandRegistry.ts
// Defines command palette entries and the lightweight matching used for autocomplete.

const MAX_COMMAND_MATCHES = 10;

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const runSearch = async (
    query: string,
    sourceTab: CommandPaletteSearchSource,
    context: CommandPaletteContext
) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return false;
    }

    const didSearch = await context.submitSearch({
        query: trimmedQuery,
        sourceTab,
        deps: {
            localSongs: context.localSongs,
            t: context.t,
        },
    });

    if (didSearch) {
        context.navigateToSearch({
            query: trimmedQuery,
            sourceTab,
            replace: typeof window !== 'undefined' && Boolean(window.history.state?.search),
        });
    }

    return didSearch;
};

const createSearchCommand = (
    id: string,
    title: string,
    description: string,
    keywords: string[],
    resolveSource: (context: CommandPaletteContext) => HomeViewTab
): CommandPaletteCommand => ({
    id,
    group: 'search',
    title,
    description,
    keywords,
    placeholder: `${keywords[0]} ${description}`,
    requiresInput: true,
    execute: (input, context) => runSearch(input, resolveSource(context), context),
});

const createSettingsCommand = (
    id: string,
    title: string,
    description: string,
    keywords: string[],
    initialTab: 'help' | 'options',
    initialSubview: Parameters<CommandPaletteContext['openSettings']>[1] = null
): CommandPaletteCommand => ({
    id,
    group: 'settings',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.openSettings(initialTab, initialSubview);
        return true;
    },
});

const createHomeTabCommand = (
    tab: HomeViewTab,
    title: string,
    description: string,
    keywords: string[]
): CommandPaletteCommand => ({
    id: `home-${tab}`,
    group: 'navigation',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.setHomeViewTab(tab);
        context.navigateToHome();
        return true;
    },
});

const createPanelCommand = (
    tab: PanelTab,
    title: string,
    description: string,
    keywords: string[]
): CommandPaletteCommand => ({
    id: `panel-${tab}`,
    group: 'panel',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.setPanelTab(tab);
        context.setIsPanelOpen(true);
        return true;
    },
});

const createVisualizerCommand = (
    mode: VisualizerMode,
    title: string,
    description: string,
    keywords: string[]
): CommandPaletteCommand => ({
    id: `visualizer-${mode}`,
    group: 'visualizer',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.setVisualizerMode(mode);
        return true;
    },
});

export const COMMAND_PALETTE_COMMANDS: CommandPaletteCommand[] = [
    createSearchCommand('search-current', 'Search songs', 'Search songs in the current source', ['search', 'find', 'song'], context => context.currentSearchSourceTab),
    createSearchCommand('search-local', 'Search local songs', 'Search local library', ['local', 'local search', 'search local'], () => 'local'),
    createSearchCommand('search-navidrome', 'Search Navidrome songs', 'Search Navidrome library', ['navi', 'navidrome', 'search navidrome'], () => 'navidrome'),
    createSearchCommand('search-netease', 'Search NetEase songs', 'Search NetEase Cloud Music', ['netease', 'cloud', 'search netease'], () => 'playlist'),

    createSettingsCommand('settings-help', 'Open Help', 'Open help and shortcuts', ['help'], 'help'),
    createSettingsCommand('settings-options', 'Open Options', 'Open the options center', ['settings', 'options'], 'options'),
    createSettingsCommand('settings-appearance', 'Appearance settings', 'Open visual and appearance settings', ['appearance', 'visual settings'], 'options', 'appearance'),
    createSettingsCommand('settings-playback', 'Playback settings', 'Open playback behavior settings', ['playback settings', 'playback'], 'options', 'playback'),
    createSettingsCommand('settings-integration', 'Integration settings', 'Open Stage, Now Playing, and Navidrome settings', ['integration', 'stage', 'now playing', 'navidrome settings'], 'options', 'integration'),
    createSettingsCommand('settings-storage', 'Storage settings', 'Open cache and storage settings', ['storage', 'cache'], 'options', 'storage'),
    createSettingsCommand('settings-desktop', 'Desktop settings', 'Open desktop app settings', ['desktop', 'electron'], 'options', 'desktop'),
    createSettingsCommand('settings-lab', 'Lab settings', 'Open experimental settings', ['lab', 'experimental'], 'options', 'lab'),
    createSettingsCommand('settings-visualizer', 'Visualizer settings', 'Open lyrics animation workbench', ['visualizer settings', 'visualizer workbench'], 'options', 'visualizer'),
    createSettingsCommand('settings-theme-park', 'Theme Park', 'Open theme editor', ['theme park', 'theme'], 'options', 'themePark'),
    createSettingsCommand('settings-lyric-filter', 'Lyric filter', 'Open lyric filter settings', ['lyric filter', 'lyrics filter'], 'options', 'lyricFilter'),

    {
        id: 'navigate-home',
        group: 'navigation',
        title: 'Go home',
        description: 'Return to home view',
        keywords: ['home'],
        execute: (_input, context) => {
            context.navigateToHome();
            return true;
        },
    },
    {
        id: 'navigate-player',
        group: 'navigation',
        title: 'Go player',
        description: 'Return to player view',
        keywords: ['player'],
        execute: (_input, context) => {
            context.navigateToPlayer();
            return true;
        },
    },
    createHomeTabCommand('playlist', 'Open playlists', 'Open playlist home tab', ['playlist', 'playlists']),
    createHomeTabCommand('local', 'Open local music', 'Open local music tab', ['local music', 'local']),
    createHomeTabCommand('albums', 'Open albums', 'Open albums tab', ['albums', 'album']),
    createHomeTabCommand('navidrome', 'Open Navidrome', 'Open Navidrome tab', ['navidrome', 'navi']),
    createHomeTabCommand('radio', 'Open radio', 'Open radio tab', ['radio', 'fm']),

    createPanelCommand('cover', 'Panel: cover', 'Open the cover panel tab', ['panel cover', 'cover panel']),
    createPanelCommand('controls', 'Panel: controls', 'Open the controls panel tab', ['panel controls', 'controls panel']),
    createPanelCommand('queue', 'Panel: queue', 'Open the queue panel tab', ['panel queue', 'queue panel']),
    createPanelCommand('account', 'Panel: account', 'Open the account panel tab', ['panel account', 'account panel']),
    createPanelCommand('local', 'Panel: local', 'Open the local panel tab', ['panel local', 'local panel']),
    createPanelCommand('navi', 'Panel: Navidrome', 'Open the Navidrome panel tab', ['panel navi', 'panel navidrome', 'navi panel']),
    createPanelCommand('onlineLyrics', 'Panel: lyrics', 'Open the online lyrics panel tab', ['panel lyrics', 'lyrics panel']),

    {
        id: 'playback-play',
        group: 'playback',
        title: 'Play',
        description: 'Start playback when paused',
        keywords: ['play'],
        execute: (_input, context) => {
            if (context.playerState !== PlayerState.PLAYING) {
                context.togglePlay();
            }
            return true;
        },
    },
    {
        id: 'playback-pause',
        group: 'playback',
        title: 'Pause',
        description: 'Pause current playback',
        keywords: ['pause'],
        execute: (_input, context) => {
            if (context.playerState === PlayerState.PLAYING) {
                context.togglePlay();
            }
            return true;
        },
    },
    {
        id: 'playback-next',
        group: 'playback',
        title: 'Next track',
        description: 'Play the next track',
        keywords: ['next'],
        execute: (_input, context) => {
            context.handleNextTrack();
            return true;
        },
    },
    {
        id: 'playback-prev',
        group: 'playback',
        title: 'Previous track',
        description: 'Play the previous track',
        keywords: ['prev', 'previous'],
        execute: (_input, context) => {
            context.handlePrevTrack();
            return true;
        },
    },
    {
        id: 'playback-loop',
        group: 'playback',
        title: 'Toggle loop',
        description: 'Change loop mode',
        keywords: ['loop'],
        execute: (_input, context) => {
            context.toggleLoop();
            return true;
        },
    },
    {
        id: 'playback-shuffle',
        group: 'playback',
        title: 'Shuffle queue',
        description: 'Shuffle current play queue',
        keywords: ['shuffle queue', 'shuffle'],
        execute: (_input, context) => {
            context.shuffleQueue();
            return true;
        },
    },

    createVisualizerCommand('classic', 'Visualizer: Luminous', 'Switch to classic visualizer', ['visualizer classic', 'classic']),
    createVisualizerCommand('cadenza', 'Visualizer: Mindscape', 'Switch to cadenza visualizer', ['visualizer cadenza', 'cadenza', 'mindscape']),
    createVisualizerCommand('partita', 'Visualizer: Partita', 'Switch to partita visualizer', ['visualizer partita', 'partita']),
    createVisualizerCommand('fume', 'Visualizer: Fume', 'Switch to fume visualizer', ['visualizer fume', 'fume']),
    createVisualizerCommand('cappella', 'Visualizer: Cappella', 'Switch to cappella visualizer', ['visualizer cappella', 'cappella']),
    createVisualizerCommand('tilt', 'Visualizer: Tilt', 'Switch to tilt visualizer', ['visualizer tilt', 'tilt']),
];

export const getCommandPaletteMatches = (query: string): CommandPaletteMatch[] => {
    const normalizedQuery = normalize(query);

    if (!normalizedQuery) {
        return COMMAND_PALETTE_COMMANDS.slice(0, MAX_COMMAND_MATCHES).map((command, index) => ({
            command,
            score: 100 - index,
            input: '',
        }));
    }

    const matches = COMMAND_PALETTE_COMMANDS
        .map(command => {
            let bestScore = 0;
            let bestInput = '';

            for (const keyword of command.keywords) {
                const normalizedKeyword = normalize(keyword);
                if (normalizedQuery === normalizedKeyword) {
                    bestScore = Math.max(bestScore, 120);
                } else if (normalizedKeyword.startsWith(normalizedQuery)) {
                    bestScore = Math.max(bestScore, 100 - normalizedKeyword.length);
                } else if (normalizedQuery.startsWith(`${normalizedKeyword} `)) {
                    bestScore = Math.max(bestScore, 90 + normalizedKeyword.length + (command.requiresInput ? 20 : 0));
                    bestInput = query.trim().slice(keyword.length).trim();
                } else if (normalizedKeyword.includes(normalizedQuery)) {
                    bestScore = Math.max(bestScore, 60 - normalizedKeyword.indexOf(normalizedQuery));
                }
            }

            return bestScore > 0 ? { command, score: bestScore, input: bestInput } : null;
        })
        .filter((match): match is CommandPaletteMatch => Boolean(match))
        .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));

    return matches.slice(0, MAX_COMMAND_MATCHES);
};
