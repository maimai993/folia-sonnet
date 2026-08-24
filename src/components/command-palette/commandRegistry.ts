import { ALL_COMMAND_PALETTE_COMMANDS } from './commands';
import { matchesCommandPlatform } from './availability';
import { getQueueSongMatches, getQueueSongMatchesFromEvaluation } from './queueSongMatches';
import type { CommandPaletteCommand, CommandPaletteContext } from './types';

// src/components/command-palette/commandRegistry.ts
// Public entry point for the command list. Definitions live in ./commands/<group>Commands.ts
// and ranking lives in ./commandMatching.ts; this file only assembles and filters.

export { getQueueSongMatches, getQueueSongMatchesFromEvaluation };
export { getCommandPaletteMatches } from './commandMatching';

export const COMMAND_PALETTE_COMMANDS: CommandPaletteCommand[] = ALL_COMMAND_PALETTE_COMMANDS;

// Availability is declared on each command: `platform` gates the environment, `isAvailable`
// gates the current state, and `hidden` keeps mode-carrier commands out of every listing.
// `hidden` is about listing only, so key-driven entry points check enablement without it —
// execute mode's `:` carrier is hidden yet must still answer its key.
export const isCommandPaletteCommandEnabled = (
    command: CommandPaletteCommand,
    context?: CommandPaletteContext,
) => matchesCommandPlatform(command.platform) && (command.isAvailable?.(context) ?? true);

export const getAvailableCommandPaletteCommands = (context?: CommandPaletteContext) => (
    COMMAND_PALETTE_COMMANDS.filter(command => (
        !command.hidden && isCommandPaletteCommandEnabled(command, context)
    ))
);
