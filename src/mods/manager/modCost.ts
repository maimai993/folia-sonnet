import { useEffect, useState } from 'react';
import { getFoliumClientStart, type FoliumClientStart } from '../runtime/clientLoader';
import { getFoliumCallStats, type FoliumCallStats } from '../runtime/guard';
import { getFoliumIssues, type FoliumIssue } from '../runtime/status';
import { getModCallStats } from '../ipc';
import type { ModMainCallStats } from '../types';

// src/mods/manager/modCost.ts
// What a mod costs, for its row in the manager: how long it took to start,
// how much time its code takes while its pieces are up, how often it failed
// and in how many places, and what its Node entry took in the main process.
//
// All of it is what the gates already count (src/mods/runtime/guard.ts for this
// window, electron/modSystem/guard.cjs for the main process) plus the failure
// record. Nothing is measured for this display. The numbers are read on a slow
// timer by the manager while it is on screen, so with the settings page closed
// showing the cost costs nothing.
//
// "Slow" is a mark on the row. Folia switches nothing off for being slow.
//
// The one exception is a Node entry that stopped responding (issue M15): on
// Android every mod shares one thread, so a mod frozen in a synchronous loop
// stalls every other mod's calls with it, and nothing can interrupt it. The host
// then answers that mod's calls with `mod-hung` at once instead of making them
// wait out the timeout, and says so in its stats (guard.cjs). The row shows it,
// with the two actions that get out of it: stop the mod, or reload with it off.

/** A start this long uses up the whole wait of the first screen by itself (src/bootstrap.tsx). */
export const SLOW_START_MS = 1500;
/** About a quarter of the time while its pieces are up, taken by one mod: 240 of every 1000 milliseconds. */
export const SLOW_RUNNING_MS = 240;
/** One call this long in the main process holds up every window for as long. */
export const SLOW_MAIN_CALL_MS = 100;
/** How often the manager reads the numbers while it is on screen. */
const READ_INTERVAL_MS = 2000;

/** 宿主的应答：这个模组无响应（它的调用现在会立刻回 mod-hung）。 */
export const MOD_HUNG_ERROR = 'mod-hung';

export interface ModCost {
    /** Where the start of its client stands (a finished start in whole milliseconds); undefined when it has none running here. */
    start: FoliumClientStart | undefined;
    /**
     * The time its code takes in each second in which it runs, milliseconds; null before any of
     * its repeated code ran. This is what the gate counts: the time its listeners took, over the
     * number of different seconds in which one of them ran. It is not a time per frame: the gate
     * does not know where a frame ends, and the share of a second is the same on any screen.
     */
    runningMs: number | null;
    /** How many times its code failed, in all places together. */
    failures: number;
    /** In how many places. */
    failurePlaces: number;
    /** What its Node entry took in the main process; null for a mod without one that ran. */
    main: { totalMs: number; longestMs: number } | null;
    /** Its start took long, or has run past the start limit and is still going. */
    slowStart: boolean;
    slowRunning: boolean;
    slowMain: boolean;
    /** Its Node entry stopped responding: a synchronous call never came back (Android host, issue M15). */
    hung: boolean;
    /** Where it stopped, as the host named it (for the row's tooltip); null when it did not. */
    hungWhere: string | null;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** One mod's cost from what was counted. Pure: the caller reads the counters. */
export const describeModCost = (
    start: FoliumClientStart | undefined,
    stats: FoliumCallStats | null,
    issues: readonly FoliumIssue[],
    main: ModMainCallStats | null,
): ModCost => {
    const runningMs = stats && stats.listenerSeconds > 0
        ? round(stats.listenerMs / stats.listenerSeconds, 1)
        : null;
    return {
        start: start?.state === 'started' ? { state: 'started', ms: Math.round(start.ms) } : start,
        runningMs,
        failures: issues.reduce((sum, issue) => sum + issue.count, 0),
        failurePlaces: issues.length,
        main: main ? { totalMs: round(main.totalMs, 1), longestMs: round(main.longestMs, 1) } : null,
        slowStart: start?.state === 'started' ? start.ms >= SLOW_START_MS : start?.state === 'starting' && start.late,
        slowRunning: runningMs !== null && runningMs >= SLOW_RUNNING_MS,
        slowMain: main !== null && main.longestMs >= SLOW_MAIN_CALL_MS,
        // The hung mark only ever comes from the host gate; the desktop's main process has none.
        hung: main?.hung === true,
        hungWhere: typeof main?.hungWhere === 'string' ? main.hungWhere : null,
    };
};

export const isModSlow = (cost: ModCost | undefined) => Boolean(cost && (cost.slowStart || cost.slowRunning || cost.slowMain));

/** The mod is frozen and its calls are being refused: shown before "slow", which it also is. */
export const isModHung = (cost: ModCost | undefined) => cost?.hung === true;

const readCosts = async (modIds: readonly string[]): Promise<Record<string, ModCost>> => {
    const main = await getModCallStats();
    return Object.fromEntries(modIds.map((modId) => [
        modId,
        describeModCost(getFoliumClientStart(modId), getFoliumCallStats(modId), getFoliumIssues(modId), main[modId] ?? null),
    ]));
};

/**
 * The cost of each of `modIds`, read now and then every two seconds for as long as the calling
 * component is mounted. One call for the whole list: one timer and one request to the main process
 * per read.
 */
export const useModCosts = (modIds: readonly string[]): Record<string, ModCost> => {
    const [costs, setCosts] = useState<Record<string, ModCost>>({});
    const key = modIds.join('\n');
    useEffect(() => {
        // No mods listed (none installed, or the mod system is off): nothing to read.
        if (!key) return undefined;
        const ids = key.split('\n');
        let stopped = false;
        const read = () => {
            void readCosts(ids).then((next) => {
                if (stopped) return;
                // The same numbers again draw nothing.
                setCosts((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
            });
        };
        read();
        const timer = setInterval(read, READ_INTERVAL_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [key]);
    return costs;
};
