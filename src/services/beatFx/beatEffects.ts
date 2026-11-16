import type { BeatEffectSetting, SmartBeatSettings } from '../../types';

// src/services/beatFx/beatEffects.ts
// The beat effects of 智能动感模式, each one a named thing a picture does on the music: declared on
// the visualizer or background registry entry that draws it (`beatEffects`), switched and scaled one
// by one in that mode's own settings (BeatEffectsGroup.tsx), under the one 智能动感模式 switch.
//
// An effect reads one source, and the source is what decides which model runs for the track on
// screen (components/visualizer/beatClockTargets.ts): 'beats' is Beat This!' beat list (final0, the
// beat clock in beatFxLive.ts), 'drums' htdemucs' drum hits (analysis/drumHits.ts), 'stems' the drum
// hits and the vocal envelope the same htdemucs run reads with them (analysis/vocalEnvelope.ts; 雾笺's
// 疏雨轻车). A picture whose live effects read only htdemucs never runs beat_this, and the other way round.
//
// An effect can be made of parts (`parts`), each with its own slider in place of the one strength:
// 疏雨轻车 is the rain on the voice and the bus jolting on the kicks, one switch, two strengths. A
// part plays at `getBeatEffectStrength(beatEffectPartId(id, key))` (beatFxLive.ts).
//
// A retired effect keeps its code and its declaration but never plays and is not offered: the user
// set it aside (2026-10-17: 时计's 齿轮随拍 and the Latent background's 潮汐脉动) rather than deleting
// it, so it can come back by dropping `retired`.

/**
 * The analysis an effect listens to. 'beats' and 'drums' are what the models hand over directly;
 * 'stems' is the vocal envelope the same htdemucs run reads; 'envelopes' is the four curves that run
 * also gives (低频 / 人声 / 其余乐器 / 整体, analysis/musicEnvelope.ts) - one separation feeds all of
 * them, so a picture may read any of these without costing another run.
 */
export type BeatEffectSource = 'beats' | 'drums' | 'stems' | 'envelopes';

/** A part of an effect with its own slider: a stable key (stored) and the i18n key of its name. */
export interface BeatEffectPart {
    key: string;
    nameKey: string;
}

export interface BeatEffectDef {
    /** Stable, stored in settings and exported configs: `<mode>.<name>`. */
    id: string;
    /** i18n key of its four-character name (options.beatEffect_*). */
    nameKey: string;
    /** i18n key of what it does. */
    descKey: string;
    source: BeatEffectSource;
    /** Its parts, each with its own strength slider in place of the one; see the header. */
    parts?: readonly BeatEffectPart[];
    /** Never plays and is not offered; see the header. */
    retired?: boolean;
}

/** The strength range of every effect; 1 is the look it was tuned to, the middle of the slider. */
export const BEAT_EFFECT_STRENGTH_MAX = 2;
export const BEAT_EFFECT_DEFAULT: BeatEffectSetting = { on: true, strength: 1 };

/** Every effect id in the app, so code that plays one names it rather than spelling it. */
export const BEAT_EFFECT_IDS = {
    sonnetLensTear: 'sonnet.lensTear',
    dioramaRipple: 'diorama.ripple',
    pendoloDrumhead: 'pendolo.drumhead',
    pendoloGearBeats: 'pendolo.gearBeats',
    latentPulse: 'latent.pulse',
    hanabiBeatBursts: 'hanabi.beatBursts',
    hanabiBeatPulse: 'hanabi.beatPulse',
    temperaInkFlash: 'tempera.inkFlash',
    machiNeonPulse: 'machi.neonPulse',
    machiDrumRipple: 'machi.drumRipple',
    machiScreenFlash: 'machi.screenFlash',
    nebbiaDrizzleRide: 'nebbia.drizzleRide',
    nebbiaAquaBeat: 'nebbia.aquaBeat',
    temperaBassSurge: 'tempera.bassSurge',
    temperaVocalGlow: 'tempera.vocalGlow',
    temperaEnergyDrift: 'tempera.energyDrift',
    temperaMelodyShift: 'tempera.melodyShift',
    // 每个歌词样式各自的智能动感：共享同一次分离的曲线，画面各写各的（各样式在自己的
    // 渲染组件里用 useMusicMotion 读一条曲线，绑到自己画面的一个属性上）。
    // source 都是 'envelopes'，所以不会为了某个样式再单独跑一遍 Beat This! 或再做一次分离。
    classicPulseGlow: 'classic.pulseGlow',
    classicVocalShine: 'classic.vocalShine',
    cadenzaHaloBreath: 'cadenza.haloBreath',
    cadenzaScatterDrift: 'cadenza.scatterDrift',
    cappellaVoicePop: 'cappella.voicePop',
    cappellaBubbleSway: 'cappella.bubbleSway',
    claddaghRingTilt: 'claddagh.ringTilt',
    claddaghBeadHop: 'claddagh.beadHop',
    partitaStepTread: 'partita.stepTread',
    partitaTierRise: 'partita.tierRise',
    tiltLeanSway: 'tilt.leanSway',
    tiltMainReveal: 'tilt.mainReveal',
    monetBrushBloom: 'monet.brushBloom',
    monetKeyGlow: 'monet.keyGlow',
    fumeInkWeight: 'fume.inkWeight',
    fumeVeilCalm: 'fume.veilCalm',
    lumiereBeamWidth: 'lumiere.beamWidth',
    lumiereLineSpark: 'lumiere.lineSpark',
    promptTypePace: 'prompt.typePace',
    promptBoxFly: 'prompt.boxFly',
    machiNeonGlow: 'machi.neonGlow',
    nebbiaFogDensity: 'nebbia.fogDensity',
    pendoloJewelGlow: 'pendolo.jewelGlow',
    temperaSeamPulse: 'tempera.seamPulse',
} as const;

/**
 * The effects the old 轻拍 / 重拍 strengths scaled (one pair for every picture, before effects had
 * their own): a stored or imported pair is folded into these.
 */
export const LEGACY_BEAT_LIST_EFFECT_IDS: readonly string[] = [BEAT_EFFECT_IDS.sonnetLensTear, BEAT_EFFECT_IDS.dioramaRipple];

/** The id a part plays under in the live strengths (beatFxLive.ts `getBeatEffectStrength`). */
export const beatEffectPartId = (id: string, part: string): string => `${id}:${part}`;

/** A part's strength in an effect's setting, 1 for one never touched. */
export const resolveBeatEffectPartStrength = (setting: BeatEffectSetting, part: string): number => setting.parts?.[part] ?? 1;

/** The effect's setting, or the default for one never touched. */
export const resolveBeatEffectSetting = (settings: SmartBeatSettings, id: string): BeatEffectSetting =>
    settings.effects[id] ?? BEAT_EFFECT_DEFAULT;

/**
 * The effects that read drum hits (`source: 'drums'`), on any picture. Their declarations live on the
 * registry entries, which this service may not import, so the list is spelled out here.
 */
export const DRUM_BEAT_EFFECT_IDS: readonly string[] = [
    BEAT_EFFECT_IDS.pendoloDrumhead,
    BEAT_EFFECT_IDS.temperaInkFlash,
    BEAT_EFFECT_IDS.machiDrumRipple,
    BEAT_EFFECT_IDS.machiScreenFlash,
];

/** Whether any drum-hit effect is switched on, whichever picture is on screen. */
export const anyDrumBeatEffectOn = (settings: SmartBeatSettings): boolean =>
    DRUM_BEAT_EFFECT_IDS.some(id => resolveBeatEffectSetting(settings, id).on);

/**
 * The effects that read the four music envelopes (`source: 'envelopes'`), on any picture. As with the
 * drum hits, their declarations live on the registry entries, so the list is spelled out here.
 */
export const ENVELOPE_BEAT_EFFECT_IDS: readonly string[] = [
    BEAT_EFFECT_IDS.temperaBassSurge,
    BEAT_EFFECT_IDS.temperaVocalGlow,
    BEAT_EFFECT_IDS.temperaEnergyDrift,
    BEAT_EFFECT_IDS.temperaMelodyShift,
    // 每个歌词样式各自的智能动感。都读同一次分离的四/十条曲线，画面各写各的；
    // 这个列表只用来判断「屏幕上现在有没有开着吃包络的效果」和它的总强度。
    BEAT_EFFECT_IDS.classicPulseGlow, BEAT_EFFECT_IDS.classicVocalShine,
    BEAT_EFFECT_IDS.cadenzaHaloBreath, BEAT_EFFECT_IDS.cadenzaScatterDrift,
    BEAT_EFFECT_IDS.cappellaVoicePop, BEAT_EFFECT_IDS.cappellaBubbleSway,
    BEAT_EFFECT_IDS.claddaghRingTilt, BEAT_EFFECT_IDS.claddaghBeadHop,
    BEAT_EFFECT_IDS.partitaStepTread, BEAT_EFFECT_IDS.partitaTierRise,
    BEAT_EFFECT_IDS.tiltLeanSway, BEAT_EFFECT_IDS.tiltMainReveal,
    BEAT_EFFECT_IDS.monetBrushBloom, BEAT_EFFECT_IDS.monetKeyGlow,
    BEAT_EFFECT_IDS.fumeInkWeight, BEAT_EFFECT_IDS.fumeVeilCalm,
    BEAT_EFFECT_IDS.lumiereBeamWidth, BEAT_EFFECT_IDS.lumiereLineSpark,
    // 提示词的两条按分组定稿①已从 registry 摘掉（纯文字动画画面不做智能动感）；
    // 花火/商籁/镜台那三条新增的「呼吸」效果也随三样式一起退回上游、不再登记。
    // 没声明的效果不该再参与「有没有开着吃包络的效果」的判断。
    BEAT_EFFECT_IDS.machiNeonGlow, BEAT_EFFECT_IDS.nebbiaFogDensity,
    BEAT_EFFECT_IDS.pendoloJewelGlow,
    BEAT_EFFECT_IDS.temperaSeamPulse,
];

/** Whether any envelope effect is switched on, whichever picture is on screen. */
export const anyEnvelopeBeatEffectOn = (settings: SmartBeatSettings): boolean =>
    ENVELOPE_BEAT_EFFECT_IDS.some(id => resolveBeatEffectSetting(settings, id).on);

/** Whether the effects play at all: 智能动感模式 on, or on what is already stored (`cached`). */
export const smartBeatActive = (settings: SmartBeatSettings): boolean => settings.mode !== 'off';

/**
 * Whether a track with nothing stored is analysed now (`on`). Under `cached` no run is ever started
 * for the beat FX - see SmartBeatMode.
 */
export const smartBeatMayAnalyse = (settings: SmartBeatSettings): boolean => settings.mode === 'on';

/** Whether the effect plays: 智能动感模式 active, the effect not retired and switched on itself. */
export const isBeatEffectLive = (settings: SmartBeatSettings, effect: BeatEffectDef): boolean =>
    smartBeatActive(settings) && !effect.retired && resolveBeatEffectSetting(settings, effect.id).on;

/** The effects a registry entry offers in its settings: every one not retired. */
export const offeredBeatEffects = (effects: readonly BeatEffectDef[] | undefined): readonly BeatEffectDef[] =>
    (effects ?? []).filter(effect => !effect.retired);
