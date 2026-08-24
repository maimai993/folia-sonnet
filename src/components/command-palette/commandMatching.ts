import { getAvailableCommandPaletteCommands } from './commandRegistry';
import { DEFAULT_LANDING_COMMAND_IDS } from './commands';
import type { CommandPaletteCommand, CommandPaletteContext, CommandPaletteMatch } from './types';

// src/components/command-palette/commandMatching.ts
// Keyword ranking for the palette input, plus the landing list shown before anything is typed.

const MAX_COMMAND_MATCHES = 10;
const MATCH_QUALITY = {
    contains: 1,
    prefix: 2,
    input: 3,
    exact: 4,
} as const;

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

type RankedCommandPaletteMatch = CommandPaletteMatch & {
    matchQuality: number;
};

// Before any input, show recents first, then the declared landing set, then whatever is left in
// registration order. Declaring the landing set keeps "what the palette shows on open" from
// depending on where a command happens to sit in its group file.
const buildLandingCommands = (
    filteredCommands: CommandPaletteCommand[],
    recentCommandIds: string[],
): CommandPaletteMatch[] => {
    const recentCommands = recentCommandIds
        .map(commandId => filteredCommands.find(command => command.id === commandId))
        .filter((command): command is CommandPaletteCommand => command !== undefined);
    const taken = new Set(recentCommands.map(command => command.id));

    const landingCommands = DEFAULT_LANDING_COMMAND_IDS
        .map(commandId => filteredCommands.find(command => command.id === commandId))
        .filter((command): command is CommandPaletteCommand => command !== undefined && !taken.has(command.id));
    landingCommands.forEach(command => taken.add(command.id));

    const remaining = filteredCommands.filter(command => !taken.has(command.id));

    return [...recentCommands, ...landingCommands, ...remaining]
        .slice(0, MAX_COMMAND_MATCHES)
        .map((command, index) => ({
            command,
            score: recentCommandIds.includes(command.id) ? 130 - index : 100 - index,
            input: '',
        }));
};

export const getCommandPaletteMatches = (
    query: string,
    context?: CommandPaletteContext,
    recentCommandIds: string[] = []
): CommandPaletteMatch[] => {
    const normalizedQuery = normalize(query);

    const filteredCommands = getAvailableCommandPaletteCommands(context);

    if (!normalizedQuery) {
        return buildLandingCommands(filteredCommands, recentCommandIds);
    }

    const recentCommandRanks = new Map<string, number>();
    recentCommandIds.forEach((commandId, index) => {
        if (!recentCommandRanks.has(commandId)) {
            recentCommandRanks.set(commandId, index);
        }
    });

    const matches = filteredCommands
        .map(command => {
            let bestScore = 0;
            let bestInput = '';
            let matchQuality = 0;

            for (const keyword of command.keywords) {
                const normalizedKeyword = normalize(keyword);
                if (normalizedQuery === normalizedKeyword) {
                    bestScore = Math.max(bestScore, 120);
                    matchQuality = Math.max(matchQuality, MATCH_QUALITY.exact);
                } else if (normalizedKeyword.startsWith(normalizedQuery)) {
                    bestScore = Math.max(bestScore, 100 - normalizedKeyword.length);
                    matchQuality = Math.max(matchQuality, MATCH_QUALITY.prefix);
                } else if (normalizedQuery.startsWith(`${normalizedKeyword} `)) {
                    bestScore = Math.max(bestScore, 90 + normalizedKeyword.length + (command.requiresInput ? 20 : 0));
                    bestInput = query.trim().slice(keyword.length).trim();
                    matchQuality = Math.max(matchQuality, MATCH_QUALITY.input);
                } else if (normalizedKeyword.includes(normalizedQuery)) {
                    bestScore = Math.max(bestScore, 60 - normalizedKeyword.indexOf(normalizedQuery));
                    matchQuality = Math.max(matchQuality, MATCH_QUALITY.contains);
                }
            }

            return bestScore > 0 ? { command, score: bestScore, input: bestInput, matchQuality } : null;
        })
        .filter((match): match is RankedCommandPaletteMatch => Boolean(match))
        .sort((a, b) => {
            if (a.matchQuality !== b.matchQuality) {
                return b.matchQuality - a.matchQuality;
            }

            const aRecentRank = recentCommandRanks.get(a.command.id);
            const bRecentRank = recentCommandRanks.get(b.command.id);
            if (aRecentRank !== undefined || bRecentRank !== undefined) {
                if (aRecentRank === undefined) return 1;
                if (bRecentRank === undefined) return -1;
                if (aRecentRank !== bRecentRank) return aRecentRank - bRecentRank;
            }

            return b.score - a.score || a.command.title.localeCompare(b.command.title);
        });

    return matches.slice(0, MAX_COMMAND_MATCHES);
};
