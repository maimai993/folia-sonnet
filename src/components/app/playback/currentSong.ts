import type { SongResult } from '../../../types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { setCurrentSong, usePlaybackStore } from '../../../stores/usePlaybackStore';

// src/components/app/playback/currentSong.ts
//
// The only place where "which song is current" changes.
//
// It is recorded twice, and the two do not always move at the same moment:
//   - the store's `currentSong` is the song the app shows;
//   - the key below is the song the player was last ASKED for. It moves at once, before a load
//     starts waiting, and work that finishes later compares its own key with it and drops out when
//     another song was asked for in the meantime. The automix decks read it for the same reason
//     (see `currentSongKeyRef` in useAutomixDecks).
//
// To make a song current from a new place in the app: `makeSongCurrent(song)`. One call.
//
// A load that has to wait between the two takes them as two steps: `askForSong` before the wait,
// `showSong` after it. test/unit/playback/currentSongArchitecture.test.ts lists the files that may.
//
// A play that asked for its song and then gives up before showing it calls `withdrawAsk`: the key
// goes back to the song that is shown, so it never stays on a song nobody sees.
//
// Work that finishes late on the song that is shown (a restore that rebuilt it, a library refresh
// that found its file gone) uses `replaceShownSong`, which never takes the key from a newer ask.
//
// A change to the SAME song (its lyrics state, replay gain, metadata) is not a change of which song
// is current. It stays a plain `setCurrentSong(previous => ...)` on the store, and has no way to
// reach the key.
//
// A play that is still reading its file or fetching its address has not asked for its song yet, so
// the key cannot tell it that it is no longer wanted. Every play (playSong, a local file, a
// Navidrome song) therefore takes `startPlay()` when it starts and asks the answer after each wait:
// no, once a newer play has started, or once a route that empties the player or leaves the main
// player for the stage has called `dropPlaysInFlight`. A play that is answered no writes nothing more.
//
// A restore of a remembered song (the last session, the hand-off to a rebuilt window) is not a
// play: it ends no play, and it makes its song current before its first wait. The key cannot tell
// it from a play of that same song, so it takes `startRestore()` at that moment and asks the answer
// after each wait: no, once a song was asked for again, or once the plays in flight were dropped.

/** The key, for reading only. `usePlaybackRuntimeRefs` hands this out as `currentSongRef`. */
export type AskedSongKeyRef = { readonly current: string | null };

let askedSongKey: string | null = null;

export const askedSongKeyRef: AskedSongKeyRef = {
    get current() {
        return askedSongKey;
    },
};

let playsStarted = 0;
/** 用于只读快照：读取期间新发起的用户播放优先于那份旧快照。 */
export const playRequestsSoFar = (): number => playsStarted;
let playsDropped = 0;
/** How often a song was asked for. The key cannot tell two asks for the same song apart; this can. */
let asks = 0;

/** Every play that has started and has not shown its song yet gives up at its next check. */
export const dropPlaysInFlight = (): void => {
    playsDropped += 1;
};

/**
 * A play calls this when it starts and keeps what it gets: the answer to "is this play still
 * wanted". It is yes until a newer play starts or the plays in flight are dropped.
 */
export const startPlay = (): (() => boolean) => {
    playsStarted += 1;
    const started = playsStarted;
    const dropped = playsDropped;
    return () => playsStarted === started && playsDropped === dropped;
};

/**
 * How often the plays in flight were dropped. For a play that has not started yet (playSong while
 * a mod's before-play hook decides about it): it keeps the count and compares it after that wait.
 * And for the work a play leaves running after it showed its song (a local file's match): the key
 * tells that work of another song, not of a drop that left the key where it was.
 */
export const playsDroppedSoFar = (): number => playsDropped;

/**
 * Which start of a song the song asked for is, for telling one start from the next
 * (previewNotice.ts tells of a preview clip once per start). One more for every ask that starts a
 * song: a play, a restore, the same song played again. An ask that puts back the song asked for
 * just before (`putBack`: a blend cancelled onto the outgoing song, a play that gave up) gives that
 * song its own start back: it never stopped. A new address for the song asked for (the recovery)
 * asks nothing.
 */
let starts = 0;
let askedStart = 0;
let askedBefore: { key: string | null; start: number } = { key: null, start: 0 };

export const startOfAskedSong = (): number => askedStart;

/** Step one: the player is asked for this song (or for none). Writes the key, not the store. */
export const askForSong = (song: SongResult | null, { putBack = false }: { putBack?: boolean } = {}): void => {
    const key = song ? getPlaybackSongKey(song) : null;
    const replaced = { key: askedSongKey, start: askedStart };
    askedStart = putBack && askedBefore.key === key ? askedBefore.start : (starts += 1);
    askedBefore = replaced;
    askedSongKey = key;
    asks += 1;
};

/**
 * A restore of a remembered song calls this right after it made that song current, and keeps what
 * it gets: the answer to "is this restore still wanted". It is yes until a song is asked for again
 * (another song or this same one, by a play, the stage or a route that empties the player), or
 * until the plays in flight are dropped.
 */
export const startRestore = (): (() => boolean) => {
    const asked = asks;
    const dropped = playsDropped;
    return () => asks === asked && playsDropped === dropped;
};

/**
 * Step two: the store shows this song. Writes the store, not the key.
 *
 * The key stays on the song asked for last. So a load that was overtaken while it waited shows its
 * song for a moment and then stops at its next comparison with the key, instead of taking the key
 * back from the load that overtook it.
 */
export const showSong = (song: SongResult | null): void => {
    setCurrentSong(song);
};

/**
 * A play that asked for `song` gives up before showing it. The key goes back to the song the store
 * shows, unless another song was asked for since: that ask stands.
 */
export const withdrawAsk = (song: SongResult): void => {
    if (askedSongKey === getPlaybackSongKey(song)) {
        askForSong(usePlaybackStore.getState().currentSong, { putBack: true });
    }
};

/** Both steps at once: this song (or none) is the one asked for and the one shown. */
export const makeSongCurrent = (song: SongResult | null): void => {
    askForSong(song);
    showSong(song);
};

/**
 * The store shows `next` (or nothing) in the place of `shown`. The key follows only while it still
 * names `shown`: if another song was asked for in the meantime, that ask stands.
 */
export const replaceShownSong = (shown: SongResult, next: SongResult | null): void => {
    if (askedSongKey === getPlaybackSongKey(shown)) {
        // The same ask goes on under the song's new key: this is not a new ask.
        askedSongKey = next ? getPlaybackSongKey(next) : null;
    }
    showSong(next);
};
