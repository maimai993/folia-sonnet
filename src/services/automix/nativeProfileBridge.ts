// src/services/automix/nativeProfileBridge.ts
// 把 Web 侧已经算好的 TrackProfile 送进原生过渡内核的缓存。
//
// 为什么是「送」而不是「让原生自己算」：原生分析要经 LocalAudioServer 取流再解码，和正在
// 播放的播放器抢同一份资源 —— 装源时分析会卡起播，预取时分析会让拖动进度条报错、自动切歌
// 断掉。而这份档案 Web 侧本来就为 ReplayGain 与画面算过一遍，直接复用不需要任何额外解码。
//
// 送的是原生 `TrackProfile.fromJson` 认的同一套字段（与原生 `toJson` 对称），所以原生侧
// 只是解析 + 写缓存，没有第二条解析路径。

import { ingestTrackProfiles, isNativeTransitionAvailable } from '../nativeTransitionClient';

/** 送过原生缓存的版本，避免每次 remember 都重复推同一份。 */
const published = new Map<string, number>();

const PROFILE_VERSION = 1;

type NativeBand = { low: number; mid: number; high: number };

/** `introTone` / `outroTone` 已经是归一化的 [低, 中, 高]，与原生 BandBalance 同构。 */
/** 档案经 JSON 序列化/版本演进后字段可能缺失，读取一律按可能缺字段处理。 */
type LooseProfile = object;

const toBand = (tone: unknown): NativeBand => {
    const list = tone as number[] | undefined;
    if (!Array.isArray(list) || list.length < 3) return { low: 1 / 3, mid: 1 / 3, high: 1 / 3 };
    return { low: list[0], mid: list[1], high: list[2] };
};

/**
 * 结尾形态。原生只用它区分「有衰减尾巴」「硬断开」「满电平到底」三种，判据也就这三条：
 * 结尾还在满电平是 fullLevel；比开头低一截（有衰减）是 resolve；其余当硬断开。
 */
/** 数值字段读取：缺失或非数字都落回缺省（档案可能来自旧版本，字段不保证在）。 */
const numOf = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** p 可能是旧版本的档案（字段缺失），这里全部按 unknown 读并给缺省。 */
const endingShapeOf = (p: LooseProfile): string => {
    if (field(p, 'endsHot') === true) return 'fullLevel';
    const head = numOf(field(p, 'headDb'), -20);
    const rawTail = field(p, 'tailDb');
    if (rawTail === null || rawTail === undefined) return 'unknown';
    const tail = numOf(rawTail, -20);
    return head - tail > 6 ? 'resolve' : 'cut';
};

/** 字段访问入口：LooseProfile 只是「某个对象」，真正取值在这里转成 Record。 */
const field = (p: LooseProfile, name: string): unknown =>
    (p as Record<string, unknown>)[name];

const toNativeProfile = (songKey: string, profile: LooseProfile): Record<string, unknown> => ({
    key: songKey,
    durationMs: Math.round(numOf(field(profile, 'duration'), 0) * 1_000),
    sampleRate: 44_100,
    bpm: numOf(field(profile, 'bpm'), 0) > 0 ? numOf(field(profile, 'bpm'), 0) : undefined,
    // 拍点网格：Web 侧测到速度就有相位与小节长度，confidence 用它自己的判断。
    beatGrid: numOf(field(profile, 'bpm'), 0) > 0
        ? {
            bpm: numOf(field(profile, 'bpm'), 0),
            phaseMs: Math.round(numOf(field(profile, 'beatOffset'), 0) * 1_000),
            beatsPerBar: numOf(field(profile, 'beatsPerBar'), 4) || 4,
            confidence: 0.8,
        }
        : undefined,
    loudnessLufs: numOf(field(profile, 'loudness'), -20),
    headDb: numOf(field(profile, 'headDb'), -20),
    // 尾部没测到时用头部顶上：宁可说「差不多响」，也不要说成「静音」而让规划器以为这首空着结束。
    tailDb: field(profile, 'tailDb') === null ? numOf(field(profile, 'headDb'), -20) : numOf(field(profile, 'tailDb'), -20),
    silenceHeadMs: Math.round(numOf(field(profile, 'leadIn'), 0) * 1_000),
    silenceTailMs: Math.round(numOf(field(profile, 'leadOut'), 0) * 1_000),
    introEndMs: Math.round(numOf(field(profile, 'sectionStart'), 0) * 1_000),
    keyHead: numOf(field(profile, 'keyHead'), -1),
    keyTail: numOf(field(profile, 'keyTail'), -1),
    bandHead: toBand(field(profile, 'introTone')),
    bandTail: toBand(field(profile, 'outroTone')),
    endingShape: endingShapeOf(profile),
    startsHot: field(profile, 'startsHot') === true,
    hasVocalTail: field(profile, 'vocalStart') != null,
    tier: 'enhanced',
});

/**
 * 推一份档案给原生。同一首歌的同一份档案只推一次；重新分析过（对象换了）会再推。
 * 失败一律静默：拿不到档案时原生只是退回等功率交叉，不该影响播放。
 */
export const publishProfileToNative = (songKey: string, profile: LooseProfile | null): void => {
    if (!profile || !isNativeTransitionAvailable() || !songKey) return;
    const stamp = numOf(field(profile, 'version'), 0) * 1_000 + PROFILE_VERSION;
    if (published.get(songKey) === stamp) return;
    published.set(songKey, stamp);
    void ingestTrackProfiles([toNativeProfile(songKey, profile)]).catch(() => {
        // 推失败就撤掉记录，下一轮 remember 还有机会再推一次。
        published.delete(songKey);
    });
};
