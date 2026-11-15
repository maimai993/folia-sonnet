import {
    AUTOMIX_MAX_OVERLAP_SEC,
    AUTOMIX_MIN_OVERLAP_SEC,
    ENTRY_MARGIN_SEC,
    endsOf,
    hardCut,
    type TransitionPlan,
    type TransitionTrack,
} from './transitionPlanner';

// src/services/automix/crossfadePlanner.ts
// The plain crossfade: the length the listener asked for, the same shape every time.
//
// Deliberately blind, by design not shortcut. `transitionPlanner` next door decides whether to blend
// at all, which of four joins, how long, and on which beat; this one decides none of that - it always
// blends, always equal-power, always ending where the music does, for as close to the requested
// seconds as the pair affords. Nothing it reads makes two runs of the same pair differ, which is what
// "predictable" has to mean to be worth choosing.
//
// It does read two numbers off an offline profile when one exists - where each file stops being
// digitally silent - and that is fact, not judgement, the same class as `duration`: without it a
// track with eight seconds of master padding would blend the next song into nothing. Everything else
// on the profile (tempo, key, sections, tone, vocal windows) is ignored here on purpose; the other
// mode's job.

/** Slider floor. Below a second a crossfade stops being one; that is the other mode's cut. */
export const CROSSFADE_MIN_SEC = 1;
/**
 * Slider ceiling, shared with automix.
 *
 * The same number for both modes because it is the same physical limit - past it two masters
 * stacked on each other stop reading as one song ending - not a property of either strategy.
 */
export const CROSSFADE_MAX_SEC = AUTOMIX_MAX_OVERLAP_SEC;
/** Where the slider starts. The length the planner already falls back to when nothing points. */
export const CROSSFADE_DEFAULT_SEC = 5;

/**
 * 音量交叉的曲线。
 *
 * 两首歌重叠时，音量不是简单的「一个升一个降」：如果两条都走直线，中点处两条各是 0.5，
 * 合成功率只有 0.5（-3 dB），听感就是过渡中间「塌一下」。等功率曲线让两条的中点为
 * 0.707，功率正好接上，这是交叉淡化的默认做法。
 *
 * - `equalPower`：sin / cos，中点不塌，最通用（默认）。
 * - `linear`：两条直线，旧行为，A/B 时用来确认「塌陷」确实来自这里。
 * - `fast`：先快后慢的三次曲线，短过渡里两首同时可闻的时间更少，适合差别很大的两首。
 */
export const CROSSFADE_CURVES = ['equalPower', 'linear', 'fast'] as const;
export type CrossfadeCurve = typeof CROSSFADE_CURVES[number];
export const CROSSFADE_DEFAULT_CURVE: CrossfadeCurve = 'equalPower';

/** 存档里读到的未知曲线名一律回到默认，不让一个手改的值把过渡变成静音。 */
export const readCrossfadeCurve = (value: unknown): CrossfadeCurve => (
    CROSSFADE_CURVES.includes(value as CrossfadeCurve)
        ? value as CrossfadeCurve
        : CROSSFADE_DEFAULT_CURVE
);

/**
 * 半秒一格。
 *
 * 整秒对三秒以内的过渡太粗：4 秒和 5 秒之间的差别，在尾奏接前奏时是听得出来的。
 * 再细就没意义了 —— 0.1 秒的差别落在鼓点上反而是随机的。
 */
export const clampCrossfadeSeconds = (seconds: number): number => (
    Number.isFinite(seconds)
        ? Math.min(CROSSFADE_MAX_SEC, Math.max(CROSSFADE_MIN_SEC, Math.round(seconds * 2) / 2))
        : CROSSFADE_DEFAULT_SEC
);

const round = (seconds: number) => Math.round(seconds * 100) / 100;

/**
 * Plans one crossfade of the requested length.
 *
 * `seconds` is a MAXIMUM, as the setting is labelled: three ceilings can shorten it, all facts not
 * taste - how much of the outgoing track is still ahead of the playhead, how much of the incoming
 * track exists after its own leading silence, and a quarter of a short track so a two-minute
 * interlude is not half crossfade. Under the floor there is no fade to schedule and the song change
 * happens as it always did.
 */
export const planCrossfade = (
    from: TransitionTrack,
    to: TransitionTrack,
    seconds: number,
    /** Where the outgoing track is now. Everything behind it is history, not room. */
    at = 0,
): TransitionPlan => {
    if (!Number.isFinite(from.duration) || from.duration <= 0) {
        return hardCut('outgoing duration unknown, nothing to schedule a fade against');
    }

    // Trailing digital silence is not part of the song, so not part of the tail a fade lays against.
    // The decay below it is left alone - judging a fade-out "not really the song" is the other mode's job.
    const { sounding: end } = endsOf(from);
    const inStart = Math.max(0, (to.profile?.leadIn ?? 0) - ENTRY_MARGIN_SEC);
    const asked = clampCrossfadeSeconds(seconds);
    const incoming = Number.isFinite(to.duration) ? Math.max(0, to.duration - inStart) : Infinity;
    const room = Math.min(Math.max(0, end - at), incoming, end / 4);
    const overlap = Math.min(asked, room);

    if (overlap < AUTOMIX_MIN_OVERLAP_SEC) {
        return hardCut(`no room to crossfade - ${round(Math.max(0, room))}s available`);
    }

    const capped = overlap < asked - 0.05 ? `, capped from ${asked}s by ${round(room)}s of room` : '';
    const entry = inStart > 0.05 ? `, entering the next track at ${round(inStart)}s` : '';
    return {
        kind: 'fade',
        style: 'plainBlend',
        // These fields state the crossfade as the absence of automix's four moves - no key argument,
        // no tempo bend, no tone match, no echo throw - spelled out rather than defaulted so it can
        // never quietly grow one and stop being the predictable half of this setting.
        relation: 'unknown',
        tempo: 'unknown',
        stretch: 1,
        tiltDb: [0, 0],
        echoThrow: false,
        outStart: round(end - overlap),
        inStart: round(inStart),
        overlap: round(overlap),
        minOverlap: AUTOMIX_MIN_OVERLAP_SEC,
        reason: `crossfade ${round(overlap)}s${capped}${entry}`,
    };
};
