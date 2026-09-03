import { ALL_COMMAND_PALETTE_COMMANDS } from './commands';
import { matchesCommandPlatform, matchesCommandScope } from './availability';
import { getQueueSongMatches, getQueueSongMatchesFromEvaluation } from './queueSongMatches';
import type { CommandPaletteCommand, CommandPaletteContext } from './types';

// src/components/command-palette/commandRegistry.ts
// Public entry point for the command list. Definitions live in ./commands/<group>Commands.ts
// and ranking lives in ./search/; this file only assembles and filters.

export { getQueueSongMatches, getQueueSongMatchesFromEvaluation };
export { getCommandPaletteMatches, rankCommands } from './search/rankCommands';

export const COMMAND_PALETTE_COMMANDS: CommandPaletteCommand[] = ALL_COMMAND_PALETTE_COMMANDS;

// Availability is declared on each command: `platform` gates the environment, `scope` gates the
// surroundings, `isAvailable` gates the current state, and `hidden` keeps mode-carrier commands out
// of every listing. `hidden` is about listing only, so key-driven entry points check enablement
// without it — execute mode's `:` carrier is hidden yet must still answer its key.
export const isCommandPaletteCommandEnabled = (
    command: CommandPaletteCommand,
    context?: CommandPaletteContext,
) => (
    matchesCommandPlatform(command.platform)
    && matchesCommandScope(command.scope, context)
    && (command.isAvailable?.(context) ?? true)
);

// Deliberately NOT memoized here.
//
// `isAvailable` is documented to be asked afresh every time the palette opens, precisely because
// some predicates read a getter whose answer changes with nothing re-rendering the app — see
// `canUseTransitionPerformance` in ./types.ts, which flips when a model download finishes. A
// module-level cache keyed on context identity would serve those a stale answer, which is the one
// bug this whole gating design exists to avoid.
//
// The cost this used to carry — two full passes per rank cycle — is gone anyway: the palette hook
// now hands its already-filtered list to `rankCommands`, so the pass below runs once, inside one
// React memo. Identity stabilization lives there too, next to the `isOpen` key that invalidates it.
export const getAvailableCommandPaletteCommands = (context?: CommandPaletteContext) => (
    COMMAND_PALETTE_COMMANDS.filter(command => (
        !command.hidden && isCommandPaletteCommandEnabled(command, context)
    ))
);
