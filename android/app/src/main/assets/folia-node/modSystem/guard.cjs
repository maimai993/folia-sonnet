// electron/modSystem/guard.cjs
// The gate every main-process call into a mod's Node entry goes through. It is
// the .cjs twin of src/mods/runtime/guard.ts (this side cannot load a .ts file):
// a call is timed with two clock reads around its synchronous part, counted per
// mod, and a throw or a rejected promise is caught and handed to `report`.
// Where the loader already turns a failure into a result of its own (a failed
// load on the mod's status, an rpc answer of { ok: false }) the gate only times
// and counts, and the failure goes on to that handling.
//
// On Android all mods share one thread, one isolate and one event loop (host.js):
// a mod that never returns from a synchronous call freezes every other mod with
// it, and nothing can interrupt that code — V8 offers no safe way to. So the gate
// also keeps the two facts the host needs to contain the damage (issue M15),
// without changing what any call returns:
//   · which mod is inside the gate right now, and where;
//   · how many calls each mod finished this run, and its longest one so far.
// The host compares the second of those read to the first, twice, a moment
// apart: no mod inside the gate and no change means nobody is frozen; a mod that
// stays inside through both readings is the one that is. Nothing here decides
// anything by itself: a slow call is still a slow call, and the mod keeps running.

'use strict';

// Reading `then` is itself a read of a mod's object, so it may not throw into the host either.
const isThenable = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return false;
    }
    try {
        return typeof value.then === 'function';
    } catch {
        return false;
    }
};

/*
 * `report(modId, where, error)` is called for a failure the gate caught.
 * Returns { call, getStats, current, progress, getHung, clearHung }.
 */
const createModGuard = (report) => {
    const statsByMod = new Map();
    // Misbehaviour per mod: counted where it is found, and shown on the mod's row (issue M15).
    const faultsByMod = new Map();
    // The calls finished per mod, all of them: a cheap counter the hung watch compares.
    let progress = 0;
    // Hung marks (issue M15). `since` is the time of the reading that found the mod stuck.
    const hungByMod = new Map();

    const statsOf = (modId) => {
        let stats = statsByMod.get(modId);
        if (!stats) {
            stats = { calls: 0, totalMs: 0, longestMs: 0, failures: 0, faults: 0, hung: false };
            statsByMod.set(modId, stats);
        }
        return stats;
    };

    /*
     * The mod inside the gate, or null. A synchronous call is inside from before `fn()` until
     * after it; an asynchronous one until its promise settles. Nested calls (a mod calling its
     * own helper, an activation awaiting an rpc) keep the outermost mod and the innermost place.
     */
    let current = null;

    const markHung = (modId, where, since) => {
        if (hungByMod.has(modId)) return;
        hungByMod.set(modId, { where, since });
        statsOf(modId).hung = true;
    };

    /*
     * One call into mod code. With `rethrow` the failure is the caller's: it is
     * counted, then thrown again, and a rejecting promise is handed back as it
     * is. Without it the failure is reported and the call yields undefined.
     */
    const call = (modId, where, fn, { rethrow = false } = {}) => {
        const stats = statsOf(modId);
        const previous = current;
        current = { modId, where, since: Date.now() };
        let result;
        let failure;
        let failed = false;
        const started = performance.now();
        try {
            result = fn();
        } catch (error) {
            failure = error;
            failed = true;
        } finally {
            progress += 1;
            if (!isThenable(result)) {
                // The synchronous part is over: the mod is no longer inside, even if it failed.
                current = previous;
            }
        }
        const elapsed = performance.now() - started;
        stats.calls += 1;
        stats.totalMs += elapsed;
        if (elapsed > stats.longestMs) {
            stats.longestMs = elapsed;
        }
        if (failed) {
            stats.failures += 1;
            if (rethrow) {
                throw failure;
            }
            report(modId, where, failure);
            return undefined;
        }
        if (isThenable(result)) {
            // Adopted once: a thenable that can be consumed only once is asked for its then() a
            // single time, and the caller awaits the adopted promise (a native promise is itself).
            const followed = Promise.resolve(result);
            // Back out of the gate when it settles, whichever way; the sync part already ended.
            const settle = () => {
                progress += 1;
                if (current && current.where === where && current.modId === modId) {
                    current = previous;
                }
            };
            followed.then(settle, settle);
            followed.then(undefined, (error) => {
                stats.failures += 1;
                if (!rethrow) {
                    report(modId, where, error);
                }
            });
            return followed;
        }
        return result;
    };

    /** A copy of one mod's counters; null while the host never called into it. The mod's row in Settings shows them. */
    const getStats = (modId) => {
        const stats = statsByMod.get(modId);
        return stats ? { ...stats } : null;
    };

    /*
     * A fault the host found in a mod outside the gate: a synchronous call that never came back
     * (`unresponsive`), or the heap it asked for (`heap`). Counted on its row, and the reason is
     * kept on its hung mark. Returns true when this is the first time it is counted.
     */
    const noteFault = (modId, kind, where) => {
        const stats = statsOf(modId);
        const faults = faultsByMod.get(modId) ?? new Set();
        const first = !faults.has(kind);
        if (first) faults.add(kind);
        faultsByMod.set(modId, faults);
        stats.faults = faults.size;
        if (kind === 'unresponsive') {
            markHung(modId, where, Date.now());
        }
        return first;
    };

    /** The mod loader unloaded: it may run again, so a mark from last time no longer holds. */
    const clearHung = (modId) => {
        if (!hungByMod.delete(modId)) return;
        statsOf(modId).hung = false;
    };

    /** The hung mark of a mod: { where, since }, or null. */
    const getHung = (modId) => hungByMod.get(modId) ?? null;

    return {
        call,
        getStats,
        noteFault,
        clearHung,
        getHung,
        /** The mod inside the gate now, { modId, where, since }, or null. */
        current: () => current,
        /** Calls finished, all mods together; it only goes up. */
        progress: () => progress,
    };
};

module.exports = { createModGuard, isThenable };

