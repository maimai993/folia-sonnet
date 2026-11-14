// src/services/lyricDirector/state.ts
// The director's own persistence: behaviour settings, the settings snapshot
// taken before it first touched anything, and the last few modes it handed out.
//
// It used to keep one decision per song here too. That memory is gone — a
// generated result now lives only in the cloud cache (services/aiStage.ts).
// Keeping a local copy meant two sources of truth, and the entries older
// builds had already written were never uploaded, so nobody else could ever
// benefit from work the app had already paid for.
//
// A single localStorage key keeps it away from the app's settings stores —
// everything here is behavioural, and it must never ride into an export,
// a sync payload or an appearance code.
//
// Subscribers get a version number, not the state: `useSyncExternalStore` needs
// a value that is stable between writes, and every reader here is a plain
// function call anyway.
//
// 键名从 _v1 升到 _v2：之前已经把全部布尔开关默认值改成 `true`，但没有换键名，
// 导致老版本落盘的 `false` 继续生效，升级上来的用户看不见新默认值。

const STORAGE_KEY = 'folia_lyric_director_v2';
const RECENT_LIMIT = 8;

export interface LyricDirectorSettings {
    /** Decide for every track once its lyrics are ready. */
    autoOnSongChange: boolean;
    /**
     * 「随机动画」也开着时切歌听谁的。'ai'（默认）：AI 的答案覆盖随机那一票，
     * AI 没给（自动关了、没算出来）时随机兜底；'random'：随机先定，AI 只算不应用。
     */
    autoDecisionPriority: 'ai' | 'random';
    /** Reuse a song's stored pick instead of asking the AI again. */
    rememberPerSong: boolean;
    /** Off means only the mode is switched; your own parameter values stay. */
    applyParams: boolean;
    /** Decide the next queued track ahead of time, into its memory only. */
    prefetchNext: boolean;
    /**
     * Modes the AI must never pick. They are left out of the list it is shown,
     * and an answer naming one falls back to the mode that is playing.
     *
     * Two ship blocked by default: `lumiere` (a light field and a glow that
     * swallows the whole screen) and `still` (no animation at all — if you want
     * that, set it yourself).
     */
    blockedModes: string[];
    /** Optional preference handed to the AI ("calmer", "more transitions"). */
    userHint: string;
}

export interface LyricDirectorSnapshot {
    mode: string;
    tunings: Record<string, Record<string, unknown>>;
    at: number;
}

interface PersistedState {
    settings: LyricDirectorSettings;
    snapshot: LyricDirectorSnapshot | null;
    recentModes: string[];
}

/* Modes the AI is not allowed to pick out of the box. `lumiere` is the glow one:
 * its light field and blooming text bury the lyrics. `still` has no animation at
 * all, which makes the whole feature look broken rather than calm. */
export const DEFAULT_BLOCKED_DIRECTOR_MODES = ['lumiere', 'still'];

export const DEFAULT_DIRECTOR_SETTINGS: LyricDirectorSettings = {
    autoOnSongChange: true,
    autoDecisionPriority: 'ai',
    rememberPerSong: true,
    // The user asked for both switches in Settings → AI to be on by default:
    // the mode follows the song, and the parameters go with it.
    applyParams: true,
    prefetchNext: true,
    blockedModes: [...DEFAULT_BLOCKED_DIRECTOR_MODES],
    userHint: '',
};

const emptyState = (): PersistedState => ({
    settings: { ...DEFAULT_DIRECTOR_SETTINGS },
    snapshot: null,
    recentModes: [],
});

const storage = (): Storage | null => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
};

let state: PersistedState = emptyState();
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

const notify = () => {
    version += 1;
    listeners.forEach((listener) => {
        try {
            listener();
        } catch {
            /* a broken listener must not stop the others */
        }
    });
};

const load = (): PersistedState => {
    if (loaded) return state;
    loaded = true;
    const store = storage();
    if (!store) return state;
    try {
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return state;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const settings = { ...DEFAULT_DIRECTOR_SETTINGS };
        const savedSettings = parsed?.settings;
        if (savedSettings && typeof savedSettings === 'object') {
            const candidate = savedSettings as Record<string, unknown>;
            if (typeof candidate.autoOnSongChange === 'boolean') settings.autoOnSongChange = candidate.autoOnSongChange;
            // 只认显式的 'random'，其余（含旧存档缺字段）都回默认的 'ai'。
            settings.autoDecisionPriority = candidate.autoDecisionPriority === 'random' ? 'random' : 'ai';
            if (typeof candidate.rememberPerSong === 'boolean') settings.rememberPerSong = candidate.rememberPerSong;
            if (typeof candidate.applyParams === 'boolean') settings.applyParams = candidate.applyParams;
            if (typeof candidate.prefetchNext === 'boolean') settings.prefetchNext = candidate.prefetchNext;
            if (Array.isArray(candidate.blockedModes)) {
                settings.blockedModes = [...new Set(
                    candidate.blockedModes.filter((mode): mode is string => typeof mode === 'string'),
                )];
            }
            if (typeof candidate.userHint === 'string') settings.userHint = candidate.userHint;
        }
        state = {
            settings,
            snapshot: parsed?.snapshot && typeof parsed.snapshot === 'object'
                ? parsed.snapshot as LyricDirectorSnapshot
                : null,
            recentModes: Array.isArray(parsed?.recentModes)
                ? (parsed.recentModes as unknown[]).filter((mode): mode is string => typeof mode === 'string').slice(0, RECENT_LIMIT)
                : [],
        };
    } catch {
        state = emptyState();
    }
    return state;
};

const persist = () => {
    const store = storage();
    if (!store) return false;
    try {
        store.setItem(STORAGE_KEY, JSON.stringify(state));
        return true;
    } catch {
        return false;
    }
};

/** Writes, dropping the recent-mode history if the quota said no. */
const persistWithEviction = () => {
    if (!storage()) return;
    if (persist()) return;
    // The only thing left that can grow without bound is the recent-mode list,
    // so trim it before giving up on the write rather than losing the settings.
    state.recentModes = state.recentModes.slice(0, Math.max(0, RECENT_LIMIT - 2));
    persist();
};

// ---- settings ----

export const readDirectorSettings = (): LyricDirectorSettings => ({ ...load().settings });

export const updateDirectorSettings = (patch: Partial<LyricDirectorSettings>): LyricDirectorSettings => {
    load();
    state.settings = { ...state.settings, ...patch };
    persistWithEviction();
    notify();
    return { ...state.settings };
};

// ---- settings snapshot ----

export const readSnapshot = (): LyricDirectorSnapshot | null => load().snapshot;

/** Written only when absent, so the state from before the director ever ran survives. */
export const writeSnapshotOnce = (snapshot: LyricDirectorSnapshot): void => {
    load();
    if (state.snapshot) return;
    state.snapshot = snapshot;
    persistWithEviction();
    notify();
};

export const clearSnapshot = (): void => {
    load();
    state.snapshot = null;
    persistWithEviction();
    notify();
};

// ---- recently used modes ----

export const readRecentModes = (): string[] => [...load().recentModes];

export const noteRecentMode = (mode: string): void => {
    if (!mode) return;
    load();
    state.recentModes = [mode, ...state.recentModes.filter((entry) => entry !== mode)].slice(0, RECENT_LIMIT);
    persistWithEviction();
    notify();
};

// ---- subscription ----

export const subscribeDirectorState = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const getDirectorStateVersion = (): number => {
    load();
    return version;
};

/** Test/utility hook: drops the in-memory copy so the next read reloads. */
export const resetDirectorStateForTest = (): void => {
    state = emptyState();
    loaded = false;
    notify();
};
