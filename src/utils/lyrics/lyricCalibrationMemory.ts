import type { AutoAlignSkipReason } from './autoAlignOffset';

// src/utils/lyrics/lyricCalibrationMemory.ts
// Per-song memory for what the automatic calibration concluded last time.
//
// The offset itself is remembered by lyricOffsetMemory; this only remembers the *verdict*, so
// the panel can still say "本来就不用调" the next time the song plays. Without it, a song that
// was scanned and found already aligned looked exactly like one that had never been scanned:
// the attempt was recorded (so it is not scanned again), but nothing described the result.
//
// Only conclusions that say something about the lyrics are kept - applied or skipped. "No local
// audio" is not a conclusion about the song (the cache may arrive later), and storing it would
// make a song look scanned when it never was.
//
// Same storage convention as lyricOffsetMemory: one JSON map under a snake_case key.

const STORAGE_KEY = 'lyric_auto_calibration_results';
const MAX_ENTRIES = 1000;

/**
 * 估计器的版本。换了判据就加一：旧记录一律当「没算过」。
 *
 * 自动校准写进去的是**本曲永久偏移**，判据错一次，那首歌以后每次播放都错同样的量。
 * v2 之前只认「最大的能量跃升」，鼓点比人声响的歌经常锁在鼓上（整首偏一个反拍），
 * 而且没有持续性判据 —— 这些记录留着只会让用户觉得「校准坏了」。
 *
 * v3：符号修正。`estimateAutoAlign` 原来把偏移写反了（正的 offset 在播放端是「歌词更晚」，
 * 而它拿来表示「歌词该更晚」），于是自动校准把每一首歌的偏差**放大一倍**。v2 及以前的
 * 自动记录全都是反向的，必须作废重算；手动偏移不受影响（useAutoLyricCalibration 只清
 * 「当前值 == 记录值」的那一种）。
 */
export const CALIBRATION_VERSION = 3;

export interface LyricCalibrationRecord {
    /** What the last scan concluded. */
    phase: 'applied' | 'skipped' | 'too-long' | 'decode-failed';
    /** The offset it applied; 0 for a skipped verdict. */
    offsetMs: number;
    /** Why it skipped; null for an applied verdict. */
    reason: AutoAlignSkipReason | null;
    /** Which estimator produced it (`CALIBRATION_VERSION`); absent on pre-v2 records. */
    version?: number;
    /** When it was concluded, for the LRU trim. */
    at: number;
}

type SongKey = string | number | null | undefined;

let cache: Map<string, LyricCalibrationRecord> | null = null;

const normalizeKey = (songKey: SongKey): string | null => {
    if (songKey === null || songKey === undefined || songKey === '') {
        return null;
    }
    return String(songKey);
};

const isRecord = (value: unknown): value is LyricCalibrationRecord => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<LyricCalibrationRecord>;
    return (record.phase === 'applied' || record.phase === 'skipped'
        || record.phase === 'too-long' || record.phase === 'decode-failed')
        && typeof record.offsetMs === 'number'
        && typeof record.at === 'number';
};

const hydrate = (): Map<string, LyricCalibrationRecord> => {
    if (cache) {
        return cache;
    }
    cache = new Map();
    if (typeof window === 'undefined') {
        return cache;
    }
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            for (const [key, value] of Object.entries(parsed)) {
                if (isRecord(value)) {
                    cache.set(key, value);
                }
            }
        }
    } catch {
        // Corrupt or blocked storage: start empty. Never throw into the playback path.
    }
    return cache;
};

const persist = (map: Map<string, LyricCalibrationRecord>): void => {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch {
        // Storage full or blocked: keep the in-memory value, silently skip persistence.
    }
};

/** What the last scan concluded for this song, or null when it was never scanned to a verdict. */
export const readCalibrationRecord = (songKey: SongKey): LyricCalibrationRecord | null => {
    const key = normalizeKey(songKey);
    return key ? hydrate().get(key) ?? null : null;
};

/** Drops this song's verdict: the next play scans it again (an old estimator's word is not kept). */
export const forgetCalibrationRecord = (songKey: SongKey): void => {
    const key = normalizeKey(songKey);
    if (!key) return;
    const map = hydrate();
    if (!map.delete(key)) return;
    persist(map);
};

/** Remember this song's verdict. Re-keying keeps the map in least-recently-written order. */
export const writeCalibrationRecord = (
    songKey: SongKey,
    record: Omit<LyricCalibrationRecord, 'at'>,
): void => {
    const key = normalizeKey(songKey);
    if (!key) {
        return;
    }
    const map = hydrate();
    map.delete(key);
    map.set(key, { ...record, version: CALIBRATION_VERSION, at: Date.now() });
    while (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) {
            break;
        }
        map.delete(oldest);
    }
    persist(map);
};
