import type { LucideIcon } from 'lucide-react';
import type { LineRenderHints } from './utils/lyrics/renderHints';
import type { LyricProviderSource } from './utils/lyrics/lyricSources';
import type { MediaId, OnlineProviderId, PlaybackSourceRef, ProviderCatalogRef } from './types/onlineMusic';

export interface LyricRuby {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
}

export interface LyricSyllable {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  endsWithSpace?: boolean;
  ruby?: LyricRuby[];
  obscene?: boolean;
  emptyBeat?: number;
}

export interface LyricAlternateText {
  role: 'translation' | 'romanization' | string;
  language?: string;
  text: string;
  syllables?: LyricSyllable[];
}

export interface Word {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  syllables?: LyricSyllable[];
}

export interface LyricBackgroundVocal {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  words: Word[];
  agentId?: string;
  translation?: string;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
}

// 'both' stacks romanization above translation.
// Modes that lay translation out inside their own lyric layout (Monet, Pendolo, Lattice, Still) fall back to translation only.
// The shared bottom subtitle overlay does not read this: it has its own rows (SubtitleOverlayLayout).
export type SubtitleContentMode = 'translation' | 'romanization' | 'both' | 'none';

// One row of the shared bottom subtitle overlay: the line on screen, the line after it, or the line on screen's translation / romanization.
export type SubtitleOverlayRowSource = 'current' | 'next' | 'translation' | 'romanization';
export type SubtitleOverlayFollowRow = Exclude<SubtitleOverlayRowSource, 'current'>;
// The shared bottom subtitle overlay's rows, top to bottom, joined with '+' (stored and carried as this string).
// One row is the current line, its translation or its romanization; two or three rows open with the current line,
// and each row after it is the next line, the translation or the romanization.
export type SubtitleOverlayLayout =
  | Exclude<SubtitleOverlayRowSource, 'next'>
  | `current+${SubtitleOverlayFollowRow}`
  | `current+${SubtitleOverlayFollowRow}+${SubtitleOverlayFollowRow}`;

export interface LyricAgent {
  id: string;
  name?: string;
  type?: string;
}

export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  id?: string;
  agentId?: string;
  songPart?: string;
  blockIndex?: number;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
  backgroundVocal?: LyricBackgroundVocal;
  backgroundVocals?: LyricBackgroundVocal[];
  renderHints?: LineRenderHints;
  isChorus?: boolean;
  chorusEffect?: 'bars' | 'circles' | 'beams';
  // User-saved fine word boundaries for fullText, baked in upstream by the lyric setter.
  // join('') must equal fullText. When present it wins over every automatic segmentation.
  wordSegments?: string[];
  // icu-folia's automatic word boundaries for fullText (utils/lyrics/icuFolia), baked in by the
  // lyric setter once its engines have loaded. Used when there is no wordSegments; absent until
  // then, and the line falls back to plain Intl.Segmenter.
  autoWordSegments?: string[];
}

export interface LyricData {
  lines: Line[];
  title?: string;
  artist?: string;
  isWordByWord?: boolean;
  ttml?: {
    timingMode?: 'Word' | 'Line';
    agents?: Record<string, LyricAgent>;
  };
}

export interface Theme {
  name: string;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  secondaryColor: string;
  fontStyle: 'sans' | 'serif' | 'mono';
  fontFamily?: string;
  fontFamilyStack?: string[];
  fontWeight?: number;
  animationIntensity: 'calm' | 'normal' | 'chaotic';
  wordColors?: { word: string; color: string; }[];
  lyricsIcons?: string[];
  provider?: string;
  description?: string;
}

export type CustomLyricsFontSource = 'system' | 'uploaded';

export interface StoredCustomLyricsFont {
  source: CustomLyricsFontSource;
  family: string;
  label?: string | null;
  fontId?: string;
}

export interface DualTheme {
  light: Theme;
  dark: Theme;
}

export type ThemeMode = 'default' | 'ai' | 'custom';

export type BuiltinVisualizerMode = 'classic' | 'cadenza' | 'partita' | 'fume' | 'monet';
export type VisualizerMode = BuiltinVisualizerMode | (string & {});
export type VisualizerFrameRate = 'off' | 120 | 90 | 60 | 30;
/** 鐢诲竷娓叉煋鍒嗚鲸鐜囩殑涓婇檺锛岃 utils/renderPixelRatio.ts銆?*/
export type RenderPixelRatio = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

export type HomeViewTab = 'playlist' | 'local' | 'albums' | 'navidrome' | 'radio' | 'cloud' | 'explore';

export type PlaybackContext = 'main' | 'stage';
export type StageSource = 'stage-api' | 'now-playing' | 'playercap';
export type StageLoopMode = 'off' | 'all' | 'one' | 'shuffle';
export type QueueAddBehavior = 'append' | 'next';
export type StageActiveEntryKind = 'lyrics' | 'media';

export interface StageEmbeddedUsltTag {
  language?: string;
  descriptor?: string;
  text: string;
}

export interface StageEmbeddedLyricSource {
  type: 'embedded';
  usltTags?: StageEmbeddedUsltTag[];
  textContent?: string;
  translationContent?: string;
}

export interface StageLocalLyricSource {
  type: 'local';
  lrcContent: string;
  tLrcContent?: string;
  formatHint?: 'lrc' | 'enhanced-lrc' | 'vtt' | 'ttml' | 'yrc' | 'qrc' | 'krc';
}

export interface StageNeteaseLyricBranch {
  lyric?: string;
  pureMusic?: boolean;
}

export interface StageNeteaseLyricSource {
  type: 'netease';
  lrc?: StageNeteaseLyricBranch & {
    yrc?: StageNeteaseLyricBranch;
    ytlrc?: StageNeteaseLyricBranch;
  };
  yrc?: StageNeteaseLyricBranch;
  ytlrc?: StageNeteaseLyricBranch;
  tlyric?: StageNeteaseLyricBranch;
  pureMusic?: boolean;
}

export interface StageNavidromeStructuredLyricLine {
  start?: number;
  value?: string;
}

export interface StageNavidromeLyricSource {
  type: 'navidrome';
  structuredLyrics?: StageNavidromeStructuredLyricLine[];
  plainLyrics?: string;
}

export interface StageQrcLyricSource {
  type: 'qrc';
  qrcContent: string;
  translationContent?: string;
}

export type StageLyricSource =
  | StageEmbeddedLyricSource
  | StageLocalLyricSource
  | StageNeteaseLyricSource
  | StageNavidromeLyricSource
  | StageQrcLyricSource;

export interface StageLyricsSession {
  title?: string;
  artist?: string;
  album?: string;
  lyricSource: StageLyricSource;
  updatedAt: number;
}

export interface StageMediaSession {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number | null;
  coverUrl?: string | null;
  coverArtUrl?: string | null;
  audioUrl?: string | null;
  audioSrc: string;
  audioMimeType?: string;
  coverMimeType?: string;
  lyricsText?: string | null;
  lyricsFormat?: 'lrc' | 'enhanced-lrc' | 'vtt' | 'ttml' | 'yrc' | 'qrc' | null;
  updatedAt: number;
}

export type StageSession = StageMediaSession;

export interface StageSearchResult {
  songId: number;
  title: string;
  artists: string[];
  album: string;
  durationMs: number | null;
  coverUrl: string | null;
}

export interface StageExternalPlayRequest {
  requestId: string;
  songId: number;
  appendToQueue?: boolean;
}

export interface StageExternalPlayResult {
  requestId: string;
  ok: boolean;
  error?: string | null;
  baseSnapshot?: StagePlayerSnapshot;
  snapshot?: StagePlayerSnapshot;
  result?: unknown;
}

export interface StageStatus {
  domain?: 'stage-input';
  direction?: 'outside-in';
  enabled: boolean;
  modeEnabled?: boolean;
  source?: StageSource | null;
  port: number;
  token: string | null;
  activeEntryKind: StageActiveEntryKind | null;
  lyricsSession: StageLyricsSession | null;
  mediaSession: StageMediaSession | null;
}

export type StagePlayerPlaybackContext = 'normal-playback' | 'stage-session' | 'external-playback-source';

export interface StagePlayerCurrent {
  id: string;
  source: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  coverUrl: string | null;
}

export interface StagePlayerControlCapabilities {
  play: boolean;
  pause: boolean;
  resume: boolean;
  seek: boolean;
  previous: boolean;
  next: boolean;
}

export interface StagePlayerQueueCapabilities {
  append: boolean;
  insertNext: boolean;
  remove: boolean;
  move: boolean;
  select: boolean;
  clear: boolean;
}

export interface StagePlayerQueueItem extends StagePlayerCurrent {
  queueItemId: string;
}

export interface StagePlayerQueueSummary {
  currentIndex: number;
  length: number;
  revision?: string;
}

export interface StagePlayerQueueSnapshot extends StagePlayerQueueSummary {
  items: StagePlayerQueueItem[];
}

export interface StagePlayerQueueWindow extends StagePlayerQueueSummary {
  items: StagePlayerQueueItem[];
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export type StagePlayerQueueDiffOp =
  | { op: 'insert'; index: number; item: StagePlayerQueueItem }
  | { op: 'remove'; index: number }
  | { op: 'move'; from: number; to: number }
  | { op: 'clear' }
  | { op: 'select'; index: number };

export interface StagePlayerQueueDiff {
  baseRevision: string;
  revision: string;
  ops: StagePlayerQueueDiffOp[];
  requiresReload?: true;
}

export interface StagePlayerSnapshot {
  playbackContext: StagePlayerPlaybackContext;
  current: StagePlayerCurrent | null;
  playerState: PlayerState;
  positionMs: number;
  durationMs: number;
  sampledAtMs: number;
  updatedAt: number;
  controlCapabilities: StagePlayerControlCapabilities;
  queueCapabilities: StagePlayerQueueCapabilities;
  queue: StagePlayerQueueSnapshot;
}

export interface StagePlayerControlRequest {
  requestId: string;
  action: 'next' | 'prev' | 'pause' | 'resume' | 'seek';
  positionMs?: number;
}

export interface StagePlayerQueueRequest {
  requestId: string;
  action: 'append' | 'insert-next' | 'remove' | 'move' | 'select' | 'clear';
  songId?: number;
  songIds?: number[];
  queueItemId?: string;
  fromQueueItemId?: string;
  fromIndex?: number;
  toIndex?: number;
  index?: number;
}

export interface StagePlayerRequestResult {
  requestId: string;
  ok: boolean;
  error?: string | null;
  snapshot?: StagePlayerSnapshot;
  result?: unknown;
}

export type NowPlayingConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'error';

export interface NowPlayingTrackSnapshot {
  id: string | null;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  durationMs: number | null;
  isVideo?: boolean;
  isAdvertisement?: boolean;
}

export interface NowPlayingLyricPayload {
  source: string | null;
  title: string;
  artist: string;
  durationMs: number | null;
  hasLyric: boolean;
  hasTranslatedLyric: boolean;
  hasKaraokeLyric: boolean;
  lrc: string | null;
  translatedLyric: string | null;
  karaokeLyric: string | null;
}

export interface ClassicTuning {
  enableWordRotation: boolean;
  breathingFloatMultiplier: number;
  useLegacyLayout?: boolean;
  wordSpacing?: number;
}

export const DEFAULT_CLASSIC_TUNING: ClassicTuning = {
  enableWordRotation: true,
  breathingFloatMultiplier: 1,
  useLegacyLayout: false,
  wordSpacing: 0.7,
};

export interface CadenzaTuning {
  fontScale: number;
  widthRatio: number;
  motionAmount: number;
  glowIntensity: number;
  beamIntensity: number;
}

export const DEFAULT_CADENZA_TUNING: CadenzaTuning = {
  fontScale: 1.12,
  widthRatio: 0.72,
  motionAmount: 1,
  glowIntensity: 1,
  beamIntensity: 0,
};

export interface PartitaTuning {
  showGuideLines: boolean;
  useSemanticLayout: boolean;
  staggerMin: number;
  staggerMax: number;
}

export const DEFAULT_PARTITA_TUNING: PartitaTuning = {
  showGuideLines: true,
  useSemanticLayout: true,
  staggerMin: 20,
  staggerMax: 100,
};

export interface FumeTuning {
  hidePrintSymbols: boolean;
  disableGeometricBackground: boolean;
  backgroundObjectOpacity: number;
  textHoldRatio: number;
  cameraTrackingMode: 'stepped' | 'smooth';
  cameraSpeed: number;
  glowIntensity: number;
  heroScale: number;
}

export const DEFAULT_FUME_TUNING: FumeTuning = {
  hidePrintSymbols: false,
  disableGeometricBackground: true,
  backgroundObjectOpacity: 0.5,
  textHoldRatio: 1,
  cameraTrackingMode: 'smooth',
  cameraSpeed: 1,
  glowIntensity: 1,
  heroScale: 1,
};

export interface CladdaghTuning {
  focusScaleRatio: number;
  radiusScale: number;
  ellipseTiltDeg: number;
  showAxisLine: boolean;
  letterSpacingOffset: number;
}

export const DEFAULT_CLADDAGH_TUNING: CladdaghTuning = {
  focusScaleRatio: 0.65,
  radiusScale: 1.0,
  ellipseTiltDeg: 45,
  showAxisLine: true,
  letterSpacingOffset: 0,
};

export type CappellaEmojiPackSource = 'builtin' | 'custom';
export type CappellaAvatarSource = 'cover' | 'builtin' | 'color' | 'custom';

export interface CappellaTuning {
  showEmoMessages: boolean;
  emojiPackSource: CappellaEmojiPackSource;
  avatarSource: CappellaAvatarSource;
}

export const DEFAULT_CAPPELLA_TUNING: CappellaTuning = {
  showEmoMessages: true,
  emojiPackSource: 'builtin',
  avatarSource: 'cover',
};

export type TiltColorScheme = 'default' | 'swap' | 'accentAll' | 'primaryAll';

export interface TiltTuning {
  splitProbability: number;
  tiltStyleProbability: number;
  colorScheme?: TiltColorScheme;
}

export const DEFAULT_TILT_TUNING: TiltTuning = {
  splitProbability: 0.75,
  tiltStyleProbability: 0.35,
  colorScheme: 'default',
};

export interface PendoloTuning {
  arcRadius: number;
  arcAngleDeg: number;
  wheelCenterX: number;
  wheelCenterY: number;
  tickSnappiness: number;
  activeScale: number;
  showGearDecor: 'none' | 'subtle' | 'full';
  showCenterGradient?: boolean;
  showCoverOnWatchFace?: boolean;
  enableLineGlow?: boolean;
}

export const DEFAULT_PENDOLO_TUNING: PendoloTuning = {
  arcRadius: 0.42,
  arcAngleDeg: 100,
  wheelCenterX: 0.0,
  wheelCenterY: 0.50,
  tickSnappiness: 2.0,
  activeScale: 1.25,
  showGearDecor: 'subtle',
  showCenterGradient: true,
  showCoverOnWatchFace: false,
  enableLineGlow: false,
};

export type SonnetOuterFrameMode = 'none' | 'frame' | 'full';

export interface SonnetTuning {
  cameraIntensity: number;
  typographyMotion: number;
  mgDensity: number;
  showOnlyText: boolean;
  showGuide: boolean;
  showBackgroundMg: boolean;
  showFixedGeo: boolean;
  showGiantDecorativeText: boolean;
  showBackgroundDecor: boolean;
  enableTransitions: boolean;
  outerFrameMode: SonnetOuterFrameMode;
  textureResolution: number;
  /** Master switch for the scene-wide post-process stack (grain + contrast). */
  postProcessEnabled: boolean;
  /** Film grain amount, 0..1. */
  postProcessGrain: number;
  /** Contrast boost, 0..1. */
  postProcessContrast: number;
  /** Fixed print-style passes riding the master switch; strength sliders, 0 disables the pass. */
  postProcessRgbShift: number;
  postProcessHalftone: number;
  /** Vignette strength, 0..2 (2 = double the base darkening). */
  postProcessVignette: number;
  /** Radial lens curvature amount, 0..2. */
  postProcessLensDistortion: number;
  /** Radial chromatic dispersion amount, 0..1. */
  postProcessLensDispersion: number;
}

/**
 * 鍟嗗锛坰onnet锛夐暅澶磋繍鍔ㄥ己搴︾殑涓婇檺 鈥斺€?涔熷氨鏄畠鐨勯粯璁ゅ€笺€? *
 * 杩欎竴妗ｇ殑鐩告満杩愬姩鏄彔鍦ㄥ垎闀滀笌杞満涓婄殑锛氭暟鍊煎啀楂橈紝闀滃ご鎺ㄦ媺寰堝鏄撴妸鐢婚潰鐢╁嚭灞忓箷澶栵紙鐢诲箙
 * 杈圭紭闇查粦銆佹瓕璇嶈鎺ㄥ嚭鐢婚潰锛夈€傛墍浠ャ€岃兘璋冨灏戙€嶅氨瀹氬湪 0.7锛岄粯璁や篃鐩存帴钀藉湪 0.7 鈥斺€?榛樿鍗? * 瀹夊叏涓婇檺锛屾粦鍧楀彧鑳藉線涓嬫敹銆? *
 * 鏀硅繖閲屼竴澶勫嵆鍙細AI 瀵兼紨鐨勫彲璋冭寖鍥达紙services/lyricDirector/catalog锛夈€乻tore 鐨勫啓鍏ュす鍙栥€? * 璇诲彇 localStorage 鏃剁殑鏃ф暟鎹吋瀹广€佸瑙傜爜瀵煎叆锛屽叏閮藉紩杩欎釜甯搁噺銆? * 鍑濆僵锛坱empera锛夌殑 cameraIntensity 鏄彟涓€鍥炰簨锛屼笉鍙楀畠绾︽潫銆? */
export const SONNET_CAMERA_INTENSITY_MAX = 0.7;

export const DEFAULT_SONNET_TUNING: SonnetTuning = {
  cameraIntensity: SONNET_CAMERA_INTENSITY_MAX,
  typographyMotion: 1,
  mgDensity: 1,
  showOnlyText: false,
  showGuide: true,
  showBackgroundMg: true,
  showFixedGeo: true,
  showGiantDecorativeText: true,
  showBackgroundDecor: true,
  enableTransitions: true,
  outerFrameMode: 'full',
  textureResolution: 1.5,
  postProcessEnabled: false,
  postProcessGrain: 0.2,
  postProcessContrast: 0,
  postProcessRgbShift: 0,
  postProcessHalftone: 0,
  postProcessVignette: 0.85,
  postProcessLensDistortion: 0.3,
  postProcessLensDispersion: 0.6,
};

/**
 * One beat effect's own setting under 鏅鸿兘鍔ㄦ劅妯″紡 (services/beatFx/beatEffects.ts): whether it plays,
 * and its strength, 0..2, 1 being the look it was tuned to.
 */
export interface BeatEffectSetting {
  on: boolean;
  strength: number;
  /**
   * An effect made of parts, each with its own slider (BeatEffectDef `parts`, 雾笺's 疏雨轻车): their
   * strengths by part key, 0..2, a part never touched at 1. `strength` is then unused.
   */
  parts?: Record<string, number>;
}

/** 鏅鸿兘鍔ㄦ劅妯″紡's three settings (2026-10-17, the user's 鍏ㄥ紑 / 鍗婂紑 / 涓嶅紑):
 * - `on`: the effects play, and a track with nothing stored is analysed now on the GPU.
 * - `cached`: the effects play from what is already stored - a track analysed before under `on`, or
 *   whose beats automix analysed - and nothing is ever started for them: no model run, no decode, no
 *   stream read. A track with nothing stored keeps its original picture. Runs already in flight
 *   elsewhere (automix's) are waited for and used, as they cost nothing more. Automix itself is not
 *   changed by this setting.
 * - `off`: every picture exactly as it was; nothing read, nothing run.
 */
export type SmartBeatMode = 'off' | 'cached' | 'on';

/**
 * 鏅鸿兘鍔ㄦ劅妯″紡, one setting for every visualizer and background that draws beat FX, and each effect's
 * own setting. The effects a picture has are declared on its registry entry (`beatEffects`), each
 * reading beat_this' beats or htdemucs' drum hits (src/services/beatFx). An effect with nothing
 * stored plays at strength 1. Read `mode` through `smartBeatActive` / `smartBeatMayAnalyse`
 * (services/beatFx/beatEffects.ts), never by comparing it in place.
 */
export interface SmartBeatSettings {
  mode: SmartBeatMode;
  /** Keyed by effect id (`sonnet.lensTear`); only the effects the user has touched. */
  effects: Readonly<Record<string, BeatEffectSetting>>;
}

export const DEFAULT_SMART_BEAT_SETTINGS: SmartBeatSettings = {
  mode: 'off',
  effects: {},
};

/**
 * `gradient` fills every tone shape with a four-colour ramp built from the cover art's
 * extracted colours mixed with the theme, instead of a flat tone.
 */
export type TemperaColorMode = 'duo' | 'mono' | 'gradient';

/** Where an image tends to sit; the exact spot is picked per shot from the seed. */
export type TemperaLayerImageAlign = 'left' | 'center' | 'right' | 'free';

/** Vertical counterpart to `TemperaLayerImageAlign`; `free` lets each shot choose a band. */
export type TemperaLayerImageVerticalAlign = 'top' | 'center' | 'bottom' | 'free';

/**
 * One image in the user's Tempera pool - character art, a logo, a texture. Each shot picks one
 * of them and places it itself, so an image carries a *tendency* rather than coordinates:
 * hand-placing every picture would defeat the point of a pool. The file itself sits in
 * IndexedDB under the same `id`, keeping the tuning small enough to sync.
 */
export interface TemperaLayerImage {
  id: string;
  name: string;
  align: TemperaLayerImageAlign;
  verticalAlign: TemperaLayerImageVerticalAlign;
  /** Height as a fraction of the viewport height; width follows the source aspect. */
  scale: number;
  opacity: number;
}

export const TEMPERA_MAX_LAYER_IMAGES = 16;

export const DEFAULT_TEMPERA_LAYER_IMAGE: Omit<TemperaLayerImage, 'id' | 'name'> = {
  align: 'free',
  // Preserve the original character-art composition, which placed images low in the frame.
  verticalAlign: 'bottom',
  scale: 0.7,
  opacity: 1,
};

export interface TemperaTuning {
  cameraIntensity: number;
  /** Per-glyph entrance motion strength, 0..2. */
  glyphMotion: number;
  /** Keep each source lyric line in one shot instead of slicing it into half-phrases. */
  wholeLineLyrics: boolean;
  /**
   * 閫愬瓧鍏ュ満鏃跺簭, 0..1. How much of the way to the shot's lyric end each glyph's entrance
   * stretches, past its 0.34s floor. 0 gives every glyph the same short window - percussive,
   * and the shot is fully at rest well before it cuts. 1 lands the whole shot exactly on its
   * lyric end - continuous, but nothing is ever still. See temperaLayout for the measurements.
   */
  glyphSettleStretch: number;
  /** 澧ㄦ煋濂ヨ 鏅繁, 0..2锛氭櫙娣辨ā绯婁笌鍚勫眰瑙嗗樊銆傚彧鍦ㄥⅷ鏌撳ゥ琛屽紑鐫€鏃剁敓鏁堛€?*/
  depthOfField: number;
  /** 澧ㄦ煋濂ヨ 闀滃ご骞崇Щ, 0..2锛氭瘡涓暅澶存帹澶氳繙銆佹紓澶氬皯銆傚彧鍦ㄥⅷ鏌撳ゥ琛屽紑鐫€鏃剁敓鏁堛€?*/
  depthPan: number;
  /** 澧ㄦ煋濂ヨ 姝岃瘝杩滆繎, 0..2锛氬皬瀛楅€€澶氳繙銆佸ぇ瀛楅澶氬墠銆傚彧鍦ㄥⅷ鏌撳ゥ琛屽紑鐫€鏃剁敓鏁堛€?*/
  glyphDepth: number;
  /** duo derives blocks from theme hues; mono collapses to a grayscale ink/paper ladder. */
  colorMode: TemperaColorMode;
  showBlocks: boolean;
  showDecor: boolean;
  /** 杈硅绾挎: the two registration marks in the top-left and bottom-right corners. */
  showCornerMarks: boolean;
  /**
   * 鏂囧瓧鍔ㄦ€佸弽鑹? the lyric samples the artwork under it and picks whichever of ink/paper
   * contrasts more, per pixel. This is how the mode colours type, not a post-process, so it
   * has its own switch rather than riding `postProcessEnabled`.
   */
  textInversion: boolean;
  /** Pool of user images; each shot picks one. The files themselves live in IndexedDB. */
  layerImages: TemperaLayerImage[];
  /** `back` lets the lyric invert against the picture; `front` puts it over the lyric. */
  layerImageDepth: 'back' | 'front';
  /** 0..1 chance that a given shot shows an image at all. */
  layerImageFrequency: number;
  enableTransitions: boolean;
  textureResolution: number;
  /** Master switch for the scene-wide post-process stack (grain + contrast + print passes). */
  postProcessEnabled: boolean;
  /**
   * 鍚庡鐞嗙汗鐞嗗帇缂? renders the post-process pass at 1x and stretches it onto the canvas
   * instead of running it at `textureResolution`. Costs sharpness on hatch, screentone and
   * type; buys back the fill rate a full-resolution full-screen pass costs.
   */
  postProcessTextureCompression: boolean;
  /** Film grain amount, 0..1. */
  postProcessGrain: number;
  /** Contrast boost, 0..1. */
  postProcessContrast: number;
  /** RGB shift pass strength, 0..1 (0 disables the pass). */
  postProcessRgbShift: number;
  /** Vignette strength, 0..2 (2 = double the base darkening). */
  postProcessVignette: number;
  /** Radial lens curvature amount, 0..2. */
  postProcessLensDistortion: number;
}

export const DEFAULT_TEMPERA_TUNING: TemperaTuning = {
  cameraIntensity: 1,
  glyphMotion: 1,
  wholeLineLyrics: false,
  glyphSettleStretch: 0.5,
  depthOfField: 1,
  depthPan: 1,
  glyphDepth: 1,
  colorMode: 'duo',
  showBlocks: true,
  showDecor: true,
  showCornerMarks: true,
  textInversion: true,
  layerImages: [],
  layerImageDepth: 'back',
  layerImageFrequency: 0.6,
  enableTransitions: true,
  textureResolution: 1.5,
  postProcessEnabled: true,
  postProcessTextureCompression: false,
  postProcessGrain: 0.2,
  postProcessContrast: 0,
  postProcessRgbShift: 0,
  postProcessVignette: 0.85,
  postProcessLensDistortion: 0.3,
};

/**
 * 缁樺厜鐢昏川妗ｄ綅銆俙full` 鍏ㄥ垎杈ㄧ巼锛沗balanced` / `low` 鎶婂厜鍦轰笌杈夊厜闄嶉噰鏍枫€佺儫闆惧€嶉鏁板皝椤讹紝鐢ㄤ簬鐪佺數銆? */
export type LumiereRenderQuality = 'full' | 'balanced' | 'low';

export interface LumiereTuning {
  /** 鍏夊己鍊嶇巼, 0.3..2. */
  lightIntensity: number;
  /** 闅忛煶涔愬彉浜? 0..2 (0 = 涓嶉殢闊充箰鍙?. */
  audioResponse: number;
  /** 鐑熼浘娴撳害, 0..2. */
  fogDensity: number;
  /**
   * 鏆楀満寮哄害, 0..1锛氬厜鍚庨潰閾轰竴灞備富棰樿儗鏅壊鍘嬫殫鐨勫簳锛屽帇浣?folia 鐨勫叡浜儗鏅紙0 = 鍏变韩鑳屾櫙鍘熸牱閫忓嚭锛夈€?   * 娴呰壊涓婚淇濆簳 0.94锛堢粯鍏夊缁堝湪鏆楀満閲岋級銆?   */
  darkField: number;
  /** 娴皹鏁伴噺, 0..2. */
  moteAmount: number;
  /** 鍥惧舰杈夊厜, 0..2. */
  bloom: number;
  /** 鏂囧瓧杈夊厜, 0..2. */
  textBloom: number;
  /** 鏈敱瀛楅€忔槑搴? 0.05..0.6. */
  unlitOpacity: number;
  /** 閭昏锛? = 涓婁竴琛?+ 褰撳墠琛岋紝2 = 涓婁竴琛?+ 褰撳墠琛?+ 涓嬩竴琛? */
  windowNeighbors: 1 | 2;
  /** 宕╄В寮哄害, 0..2. */
  decay: number;
  /** 鑳屾櫙姝岃瘝浜害, 0..2 (0 = 鍏?. */
  echo: number;
  /** 鐑熼浘缁嗚妭锛堝€嶉鏁帮級, integer 2..6. */
  fogOctaves: number;
  /** 绾跨. */
  lineArt: boolean;
  /** 鍓嶆櫙鏁ｆ櫙. */
  frontBokeh: boolean;
  /** 鎵€鏈夋崲浣嶉兘璧拌建杩圭嚎. */
  trails: boolean;
  /** 闅愯棌鎵€鏈夋瓕璇嶆崲浣嶇殑杞ㄨ抗绾匡紝淇濈暀瀛楃殑椋炶涓庤建杩硅繃娓? */
  hideTrails: boolean;
  /**
   * 杞ㄨ抗杩囨浮锛氭钀戒箣闂翠篃鍜屾鍐呮崲闀滃ご涓€鏍峰湪鍚屼竴涓厜鍦洪噷浜ゆ帴锛堟暣棣栨瓕缂栨垚涓€涓満鏅崟鍏冿級锛?   * 娌℃湁鐔勭伅 / 闂櫧 / 鎷夌劍 / 浜ゅ弶娓愬彉銆傛敼瀹冧細閲嶆柊缂栬瘧绋嬪簭.
   */
  seamlessTransitions: boolean;
  /** 鐢绘. */
  overlayFrame: boolean;
  /**
   * 浠呮樉绀烘瓕璇嶆枃瀛楋細鍙敾姝岃瘝涓庡瓧涓婄殑鏁堟灉锛堢偣浜€佸厜鏅曘€侀棯鐐广€佸崄瀛楃垎闂€佸緞杩广€佽拷瀛楀厜鏂戯級锛?   * 鍏夊満銆佺儫闆俱€佹槦绌恒€佺嚎绋裤€佹诞灏樸€佽儗鏅瓕璇嶃€佷富棰樺浘鏍囥€佺敾妗嗕笌鐗囧熬鍗＄殑鍏夐兘涓嶇敾銆傚瓧鐨勬槑鏆椾粛鎸夊厜鏉熺畻.
   */
  textOnly: boolean;
  /** 涓婚鍥炬爣锛堜富棰?lyricsIcons 鐢绘垚绾跨锛? */
  themeIcons: boolean;
  /** 涓婚鑹插崰姣? 0..1锛? = 棣欐閲戝厜锛涜秺楂樺厜鑹茶秺鎺ヨ繎寮鸿皟鑹层€佺偣浜?/ 鏈敱鐨勫瓧瓒婃帴杩戜富鑹?/ 娆¤壊. */
  themeColorMix: number;
  /** 鐢昏川. */
  renderQuality: LumiereRenderQuality;
}

export const DEFAULT_LUMIERE_TUNING: LumiereTuning = {
  lightIntensity: 1,
  audioResponse: 1,
  fogDensity: 1,
  darkField: 0.75,
  moteAmount: 1,
  bloom: 1,
  textBloom: 1,
  unlitOpacity: 0.22,
  windowNeighbors: 2,
  decay: 1,
  echo: 1,
  fogOctaves: 5,
  lineArt: true,
  frontBokeh: true,
  trails: true,
  hideTrails: false,
  seamlessTransitions: true,
  overlayFrame: true,
  textOnly: false,
  themeIcons: true,
  themeColorMix: 0.3,
  renderQuality: 'full',
};

// Diorama's camera STYLE (calm/standard/chaotic) is not part of its tuning: like every other
// visualizer it follows theme.animationIntensity (the player-panel intensity chip / AI themes), so
// the theme system stays the single source of truth. The tuning only carries diorama-specific knobs.
/** The two mutually-exclusive shapes the point-cloud layer can take. */
export type DioramaGeometryMode = 'clouds' | 'corridor';

export interface DioramaGeometryVisibility {
  /** Parent switch: hides the whole point-cloud layer without discarding child preferences. */
  enabled: boolean;
  /**
   * 'clouds' = per-lyric point-cloud formations (the family switches below apply).
   * 'corridor' = one always-on point tunnel threaded along the flight path (families ignored).
   * The two never render together - picking one replaces the other.
   */
  mode: DioramaGeometryMode;
  /** Point-cloud cubes used by architectural formations. */
  strands: boolean;
  /** Open cylindrical point-cloud shells. */
  blobs: boolean;
  /** Triangular tetrahedron point-cloud crystals. */
  ribbons: boolean;
  /** Circular point-cloud loops. */
  rings: boolean;
}

export const DEFAULT_DIORAMA_GEOMETRY_VISIBILITY: DioramaGeometryVisibility = {
  enabled: true,
  mode: 'clouds',
  strands: true,
  blobs: true,
  ribbons: true,
  rings: true,
};

export const DIORAMA_PARTICLE_DENSITY_MIN = 96;
export const DIORAMA_PARTICLE_DENSITY_MAX = 1536;
export const DIORAMA_PARTICLE_DENSITY_STEP = 24;
// Background dust motes PER LINE of the resident window (see dioramaMoteField.ts). The motes sit in a
// shell around the flight axis, and the two axes are INDEPENDENT: 鍦嗗懆 = motes around each ring, 寰勫悜 =
// how many layers across the shell's thickness (inner鈫抩uter). Motes-per-line = 鍦嗗懆 x 寰勫悜; the window
// holds 8 lines, so MAX x MAX bounds the layer at 8*48*4 = 1536 points for low-end GPUs / OBS sources
// however far the sliders are dragged. Default 28 x 2 = 56 matches the old single-slider default.
export const DIORAMA_MOTE_CIRCUMFERENCE_MIN = 4;
export const DIORAMA_MOTE_CIRCUMFERENCE_MAX = 48;
export const DIORAMA_MOTE_CIRCUMFERENCE_STEP = 2;
export const DIORAMA_MOTE_RADIAL_MIN = 1;
export const DIORAMA_MOTE_RADIAL_MAX = 4;
export const DIORAMA_MOTE_RADIAL_STEP = 1;
export const DIORAMA_PARTICLE_SCALE_MIN = 0.65;
export const DIORAMA_PARTICLE_SCALE_MAX = 1.6;
export const DIORAMA_PARTICLE_SCALE_STEP = 0.05;
// Compatibility aliases for the uncommitted tuning UI while it migrates from point size to cluster scale.
export const DIORAMA_PARTICLE_SIZE_MIN = DIORAMA_PARTICLE_SCALE_MIN;
export const DIORAMA_PARTICLE_SIZE_MAX = DIORAMA_PARTICLE_SCALE_MAX;
export const DIORAMA_PARTICLE_SIZE_STEP = DIORAMA_PARTICLE_SCALE_STEP;
export const DIORAMA_PARTICLE_GLOW_INTENSITY_MIN = 0.1;
export const DIORAMA_PARTICLE_GLOW_INTENSITY_MAX = 1.5;
export const DIORAMA_PARTICLE_GLOW_INTENSITY_STEP = 0.05;

export interface DioramaTuning {
  cameraSpeed: number;
  motionAmount: number;
  audioReactivity: number;
  geometryVisibility: DioramaGeometryVisibility;
  /** Number of points requested for each formation anchor; the renderer also enforces a global cap. */
  particleDensity: number;
  /** Spatial scale multiplier for each complete point-cloud formation. */
  particleScale: number;
  /** One soft gradient aura per point-cloud cluster, separate from lyric sung-glow. */
  particleGlowEnabled: boolean;
  particleGlowIntensity: number;
  showParticles: boolean;
  /** Background dust shell, two INDEPENDENT axes (motes-per-line = the product; field clamps to its cap):
   *  鑳屾櫙绮掑瓙路鍦嗗懆瀵嗗害 = motes around each ring, 鑳屾櫙绮掑瓙路寰勫悜瀵嗗害 = layers across the shell thickness. */
  backgroundParticleCircumference: number;
  backgroundParticleRadial: number;
  /** 鏅€氳緣鍏夎窡鍞? soft glow on the unit being sung. Independent toggle + strength. */
  glowEnabled: boolean;
  glowIntensity: number;
  /** 鐏甸瓊鍑虹獚璺熷敱: a ghost copy of the sung glyph drifts out of the text. Independent toggle + strength. */
  soulEnabled: boolean;
  soulIntensity: number;
  /** 褰撳墠瀛楁紓绉? a plain ON/OFF sub-switch of 鐏甸瓊鍑虹獚. ON lets the glyph CURRENTLY being sung drift at the
   *  same 鐏甸瓊鍑虹獚寮哄害 as every other glyph; OFF holds it perfectly registered (no doubling / reading
   *  obstruction) until it finishes, after which it detaches and flies like the rest. No strength of its
   *  own - it borrows soulIntensity. Only has a visible effect when soulEnabled. */
  soulActiveEnabled: boolean;
  /** 娓愬彉璺熷敱: the line's fill progressively deepens with the sung progress. Independent toggle + strength. */
  gradientEnabled: boolean;
  gradientIntensity: number;
}

export const DEFAULT_DIORAMA_TUNING: DioramaTuning = {
  cameraSpeed: 1,
  motionAmount: 1,
  audioReactivity: 1,
  geometryVisibility: DEFAULT_DIORAMA_GEOMETRY_VISIBILITY,
  particleDensity: 576,
  particleScale: 1,
  particleGlowEnabled: true,
  particleGlowIntensity: 0.65,
  showParticles: true,
  backgroundParticleCircumference: 28,
  backgroundParticleRadial: 2,
  glowEnabled: true,
  glowIntensity: 1,
  soulEnabled: true,
  soulIntensity: 1,
  soulActiveEnabled: false,
  gradientEnabled: false,
  gradientIntensity: 1,
};

export type MonetBackgroundSource = 'cover-derived' | 'uploaded-global';
export type MonetBackgroundLayout = 'full-overlay' | 'half-pane-gradient';
export type MonetBackgroundWashColorMode = 'theme' | 'custom';
export type NomandBackgroundSource = 'cover-derived' | 'uploaded-global';
export type NomandBackgroundDitheringType = '2x2' | '4x4' | '8x8';
export type NomandBackgroundEffect = 'dithering' | 'fluted-glass' | 'paper-texture' | 'halftone-dots' | 'lens-distortion';
export type LatentBackgroundDisplayMode = 'dithering' | 'mesh' | 'both';
export type LatentBackgroundColorSource = 'cover-theme' | 'cover-only';
export type MonetAudioStyle = 'bar' | 'line';
export type MonetPortraitSource = 'cover' | 'custom';
export type BuiltinVisualizerBackgroundMode = 'common' | 'monet' | 'nomand' | 'latent' | 'url' | 'sora';
export type VisualizerBackgroundMode = BuiltinVisualizerBackgroundMode | (string & {});

export interface UrlBackgroundItem {
  id: string;
  url: string;
  note: string;
}

export interface MonetBackgroundTuning {
  backgroundSource: MonetBackgroundSource;
  backgroundLayout: MonetBackgroundLayout;
  backgroundBlurPx: number;
  backgroundOverlayOpacity: number;
  backgroundGrayscale: number;
  backgroundSaturation: number;
  backgroundWash: number;
  backgroundHalfPaneOffsetX: number;
  backgroundWashColorMode: MonetBackgroundWashColorMode;
  backgroundWashCustomColor: string;
  /** 鏁村紶鑳屾櫙鍥剧殑缂撴參缂╂斁婕傜Щ锛涚函 CSS 鍚堟垚灞傚姩鐢伙紝涓嶅弬涓庤儗鏅儤鐒欍€?*/
  backgroundDriftEnabled: boolean;
  /** 婕傜Щ骞呭害 0..1锛屽悓鏃跺喅瀹氫綅绉昏窛绂诲拰涓洪槻姝㈤湶杈硅€岄鏀惧ぇ鐨勫€嶇巼銆?*/
  backgroundDriftStrength: number;
  /** 鏄惁鍦ㄧ儤鐒欑殑 overlay 閲岀粯鍒堕偅鍑犳潯 1px 绔栧悜绾圭悊銆?*/
  backgroundStreaksEnabled: boolean;
}

export interface NomandBackgroundTuning {
  imageSource: NomandBackgroundSource;
  effect: NomandBackgroundEffect;
  ditheringType: NomandBackgroundDitheringType;
  size: number;
  colorSteps: number;
  originalColors: boolean;
  inverted: boolean;
  flutedGlassSize: number;
  flutedGlassDistortion: number;
  flutedGlassBlur: number;
  paperTextureContrast: number;
  paperTextureRoughness: number;
  paperTextureFiber: number;
  halftoneDotsSize: number;
  halftoneDotsRadius: number;
  halftoneDotsContrast: number;
  halftoneDotsOriginalColors: boolean;
  halftoneDotsInverted: boolean;
  lensDistortionSpread: number;
  lensDistortionBulge: number;
  lensDistortionDispersion: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
}

export interface LatentBackgroundTuning {
  displayMode: LatentBackgroundDisplayMode;
  colorSource: LatentBackgroundColorSource;
  dynamicOnlyInPlayer: boolean;
  enhancedBeatResponse: boolean;
  ditheringSpeed: number;
  ditheringAudioSpeed: number;
  ditheringSize: number;
  ditheringOpacity: number;
  meshSpeed: number;
  meshAudioSpeed: number;
  meshDistortion: number;
  meshSwirl: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
}

export interface SoraBackgroundTuning {
  /** Skips the WebGL starfield and shows a static solid black (night) / white (daylight) frame. */
  blank: boolean;
}

export interface MonetTuning {
  showDescription: boolean;
  fontScale: number;
  portraitSource: MonetPortraitSource;
  portraitOffsetX?: number;
  portraitStyle?: 'square' | 'rectangular';
  showPortraitDragHanger?: boolean;
}

export const DEFAULT_MONET_BACKGROUND_TUNING: MonetBackgroundTuning = {
  backgroundSource: 'cover-derived',
  backgroundLayout: 'full-overlay',
  backgroundBlurPx: 6,
  backgroundOverlayOpacity: 0.74,
  backgroundGrayscale: 0,
  backgroundSaturation: 1.05,
  backgroundWash: 0.34,
  backgroundHalfPaneOffsetX: 0,
  backgroundWashColorMode: 'theme',
  backgroundWashCustomColor: '#8fb7ff',
  backgroundDriftEnabled: true,
  backgroundDriftStrength: 0.5,
  backgroundStreaksEnabled: true,
};

export const DEFAULT_NOMAND_BACKGROUND_TUNING: NomandBackgroundTuning = {
  imageSource: 'cover-derived',
  effect: 'dithering',
  ditheringType: '8x8',
  size: 3,
  colorSteps: 4,
  originalColors: false,
  inverted: false,
  flutedGlassSize: 0.5,
  flutedGlassDistortion: 0.5,
  flutedGlassBlur: 0.08,
  paperTextureContrast: 0.32,
  paperTextureRoughness: 0.42,
  paperTextureFiber: 0.3,
  halftoneDotsSize: 0.5,
  halftoneDotsRadius: 1.25,
  halftoneDotsContrast: 0.4,
  halftoneDotsOriginalColors: false,
  halftoneDotsInverted: false,
  lensDistortionSpread: 0.45,
  lensDistortionBulge: 0.3,
  lensDistortionDispersion: 0.65,
  overlayEnabled: true,
  overlayOpacity: 0.35,
};

export const DEFAULT_LATENT_BACKGROUND_TUNING: LatentBackgroundTuning = {
  displayMode: 'both',
  colorSource: 'cover-theme',
  dynamicOnlyInPlayer: true,
  enhancedBeatResponse: true,
  ditheringSpeed: 0.1,
  ditheringAudioSpeed: 1.2,
  ditheringSize: 2.5,
  ditheringOpacity: 0.55,
  meshSpeed: 0.3,
  meshAudioSpeed: 2,
  meshDistortion: 0.8,
  meshSwirl: 0.1,
  overlayEnabled: true,
  overlayOpacity: 0.35,
};

export const DEFAULT_SORA_BACKGROUND_TUNING: SoraBackgroundTuning = {
  blank: false,
};

export const DEFAULT_MONET_TUNING: MonetTuning = {
  showDescription: true,
  fontScale: 1.2,
  portraitSource: 'cover',
  portraitOffsetX: 0,
  portraitStyle: 'square',
  showPortraitDragHanger: true,
};

export interface StoredCappellaEmojiImage {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
}

export interface CappellaEmojiImage {
  id: string;
  name: string;
  url: string;
}

export interface StoredCappellaAvatarImage {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
}

export interface CappellaAvatarImage {
  id: string;
  name: string;
  url: string;
}

export interface StoredMonetBackgroundImage {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
}

export interface MonetBackgroundImage {
  id: string;
  name: string;
  url: string;
}

export interface StoredMonetPortraitImage {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
}

export interface MonetPortraitImage {
  id: string;
  name: string;
  url: string;
}

export enum PlayerState {
  IDLE = 'IDLE',
  PLAYING = 'PLAYING',
  PAUSED = 'PAUSED',
}

export interface StatusMessage {
  type: 'error' | 'success' | 'info';
  text: string;
  /** A second line under the text: what to do about it. */
  note?: string;
  /** Words quoted from outside the app (a platform's own answer), with their code. */
  quote?: { text: string; code?: string };
  /** A count down to the action happening on its own (the skip to the next song): its line ("5 绉掑悗璺冲埌涓嬩竴棣?),
   *  the whole seconds left and the whole time, so the action button fills over it without stepping. Kept out
   *  of `text` so the toast stays the same one while it counts. */
  countdown?: { text: string; seconds: number; totalMs: number };
  /** The online platform the message is about: its mark stands before the text, in place of the type's icon. */
  providerId?: OnlineProviderId;
  nonce?: number;
  durationMs?: number;
  actionLabel?: string;
  /** Icon drawn before actionLabel inside the action button. */
  actionIcon?: LucideIcon;
  onAction?: () => void;
  cancelLabel?: string;
  onCancel?: () => void;
  /**
   * 杩欐潯鎻愮ず**涓嶅悆鐐瑰嚮**锛堟彁绀烘潯榛樿鏄?`pointer-events: auto`锛屼細娴湪鍙鍖栭偅涓€灞備笂闈?   * 鎶婄偣鍑绘帴璧帮級銆傜粰銆岀偣涓€涓嬬┖鐧?鈫?寮规彁绀?鈫?鍐嶇偣涓€涓嬩换鎰忓銆嶈繖绉嶇敤娉曠敤锛氫笉鐒剁敤鎴疯ˉ鐨?   * 閭ｄ竴涓嬭惤鍦ㄦ彁绀烘潯涓婏紝灏辨案杩滃埌涓嶄簡涓嬮潰閭ｄ竴灞傦紝浜庢槸鍙兘鍙嶅寮瑰悓涓€鍙ユ彁绀恒€?   */
  inert?: boolean;
  persistent?: boolean;
}

// Search API Types

export interface Artist {
  id: MediaId;
  name: string;
  entityId?: string;
  catalogRef?: ProviderCatalogRef;
}

export interface Album {
  id: MediaId;
  name: string;
  coverUrl?: string;
  entityId?: string;
  catalogRef?: ProviderCatalogRef;
}

export interface SongPrivilege {
  id?: number;
  fee?: number;
  payed?: number;
  st?: number;
  pl?: number;
  dl?: number;
  flag?: number;
  cs?: boolean;
}

export interface NoCopyrightRecommendation {
  type?: number;
  typeDesc?: string;
  songId?: string | number;
  thirdPartySong?: unknown | null;
  expInfo?: unknown | null;
}

// The names of the lyric sources, read off the table in utils/lyrics/lyricSources.ts.
export type { LyricProviderSource };

/**
 * 璁剧疆閲屽瓨鐨勯偅涓€椤癸細鍙互鏄竴涓叿浣撳钩鍙帮紝涔熷彲浠ユ槸銆岃窡闅忔挱鏀惧钩鍙版潵婧愩€嶃€? *
 * 涓ゅ眰涓嶆槸澶氭涓€涓?鈥斺€?鍏蜂綋骞冲彴鎵嶈兘鍙戣姹傦紝鑰屻€岃窡闅忋€嶈绛夋嬁鍒版瓕鎵嶇煡閬撴槸鍝釜骞冲彴锛? * 鎵€浠ユ瘡涓秷璐圭偣浼?preferredSource 涔嬪墠閮借杩?resolveLyricSourcePreference 瑙ｆ瀽涓€娆°€? */
export type LyricSourcePreference = LyricProviderSource | 'follow-source';
export type AmllDbPlatform = 'ncm' | 'qq';

export interface ReplayGainInfo {
  /** ReplayGain gain values in decibels. */
  trackGain?: number;
  albumGain?: number;
  /** ReplayGain peak values as positive linear ratios. */
  trackPeak?: number;
  albumPeak?: number;
}

export interface SongResult {
  id: MediaId;
  name: string;
  artists: Artist[];
  album: Album;
  durationMs: number;
  isPureMusic?: boolean;
  aliases?: string[];
  translatedNames?: string[];
  t?: 0 | 1 | 2;
  sourceType?: 'netease' | 'cloud';
  sourceRef?: PlaybackSourceRef;
  /** Identity of the concrete bytes selected for playback; used to reject stale derived media. */
  playbackSourceRevision?: string;
  fee?: number;
  noCopyrightRcmd?: NoCopyrightRecommendation | null;
  resourceState?: boolean;
  privilege?: SongPrivilege;
  onlineLyricsState?: OnlineLyricsState;
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;
  replayGain?: ReplayGainInfo;
  qqMid?: string;
  kgHash?: string;
  amllDbPlatform?: AmllDbPlatform;
  /**
   * 浜戠缂撳瓨閲岄偅鏉′富棰橀敭 鈥斺€?鍙湁浠庛€孉I 涓婚銆嶉偅涓€灞忥紙浜戠姝屽悕娓呭崟锛夋寫鍑烘潵鐨勬瓕鎵嶆湁銆?   *
   * 鐐逛簡鎾斁瑕?*鐩存帴鐢ㄤ笂浜戜笂閭ｄ竴鏉?*锛岃€屼笉鏄啀鐢熸垚涓€閬嶏細鐢熸垚瑕佹湁姝岃瘝銆佽鏈?API Key锛?   * 鑰岃繖鏉＄紦瀛樺瓨鍦ㄧ殑鎰忎箟灏辨槸涓嶅繀鍐嶇畻涓€娆°€傝 services/aiThemeCloud.ts銆?   */
  aiCloudThemeKey?: string;
}

export interface OnlineLyricsState {
  lyricsSource: 'online' | 'imported';
  importedLyrics?: LyricData | null;
  importedLyricsName?: string | null;
  hasOnlineOverride?: boolean;
  onlineOverrideLyrics?: LyricData | null;
  matchedSongId?: MediaId;
  matchedIsPureMusic?: boolean;
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;
}

export interface SearchResponse {
  result?: {
    songs?: SongResult[];
    songCount?: number;
  };
  code: number;
}

// Local Music Types

export type LocalLyricsPriority = 'local' | 'online';
export type ActiveLocalLyricsSource = 'local' | 'embedded' | 'online';
// Where a local song's `local*LyricsContent` came from: a sidecar file picked by the import, or a
// file the user uploaded from the panel. Records written before this field existed have none.
export type LocalLyricsOrigin = 'sidecar' | 'upload';

export interface LocalSong {
  id: string; // UUID for local file
  fileName: string;
  filePath: string; // File path for reference
  fileHandle?: FileSystemFileHandle; // For re-accessing the file (not persisted, stored in memory)
  /**
   * 瀹夊崜鍘熺敓鏇插簱鐨勯煶棰戞爣璇嗭紙MediaStore 鐨?id锛屾垨瀵煎叆鏃跺啓杩涚鏈夌洰褰曠殑鏂囦欢鍚嶏級銆?   *
   * 涓嶅瓨鎾斁 URL锛氶偅涓湴鍧€鏄師鐢熶复鏃惰捣鐨勫皬鏈嶅姟锛堢鍙ｆ瘡娆″惎鍔ㄩ兘鍙兘鍙橈級锛?   * 瀛樹笅鏉ラ噸鍚氨澶辨晥銆傛挱鏀惧墠鐢ㄥ畠鎸夊綋鍓嶇鍙ｉ噸鏂版嫾锛堣 nativeAudioUrlForRef锛夈€?   */
  nativeAudioRef?: string;
  duration: number; // milliseconds
  fileSize: number; // bytes
  fileLastModified?: number; // milliseconds since epoch
  fileSignature?: string; // Lightweight file identity for incremental scans
  mimeType: string;
  bitrate?: number; // bps
  addedAt: number; // timestamp

  // Canonical metadata and retained source snapshots
  title: string;
  titleOrigin: import('./types/localLibrary').LocalSongTitleOrigin;
  importedMetadata: import('./types/localLibrary').LocalSongImportedMetadata;
  onlineMetadata?: import('./types/localLibrary').LocalSongOnlineMetadata;
  trackNumber?: number;
  discNumber?: number;
  embeddedMetadataVersion?: number;

  localCoverAssetId?: string; // Content-addressed preferred local cover stored in local_cover_assets
  localCoverSource?: import('./types/localCover').LocalCoverSourceKind;
  localCoverNeedsAssetMigration?: boolean; // Retries local cover hashing/persistence during the next rescan
  replayGain?: number; // ReplayGain track gain in dB
  replayGainTrackGain?: number; // ReplayGain track gain in dB
  replayGainTrackPeak?: number; // ReplayGain track peak ratio
  replayGainAlbumGain?: number; // ReplayGain album gain in dB
  replayGainAlbumPeak?: number; // ReplayGain album peak ratio

  // Lyrics matching result
  matchedLyrics?: LyricData;
  matchedIsPureMusic?: boolean;
  matchedLyricsSongId?: number | string; // Provider-scoped ID used for the saved lyric result
  hasManualLyricSelection?: boolean;
  markedPureMusic?: boolean; // User marked the song as instrumental: automatic lyric matching never runs for it
  folderName?: string; // Name of the folder if imported via folder import
  noAutoMatch?: boolean; // If true, do not attempt to auto-match metadata
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;

  // User preferences for online data override (set via LocalSongLyricMatch)
  lyricsSource?: 'local' | 'embedded' | 'online';  // Explicit lyrics source selection; undefined = the configured automatic priority
  useOnlineCover?: boolean;     // Prefer online cover over embedded cover

  // Local Lyrics (.lrc / .vtt / .ttml / .qrc / .yrc / .krc files)
  hasLocalLyrics?: boolean;
  localLyricsContent?: string;
  localLyricsFormat?: 'vtt' | 'ttml' | 'yrc' | 'qrc' | 'krc';
  localLyricsOrigin?: LocalLyricsOrigin;
  hasLocalTranslationLyrics?: boolean;
  localTranslationLyricsContent?: string;
  localTranslationLyricsOrigin?: LocalLyricsOrigin;

  // Embedded Lyrics (from file tags: ID3 USLT, Vorbis LYRICS, etc.)
  hasEmbeddedLyrics?: boolean;
  embeddedLyricsContent?: string;
  hasEmbeddedTranslationLyrics?: boolean;
  embeddedTranslationLyricsContent?: string;
}

export interface LocalLibrarySnapshotFile {
  name: string;
  relativePath: string;
  kind: 'audio' | 'lyric' | 'translationLyric' | 'cover' | 'other';
  size: number;
  lastModified: number;
  signature: string;
}

export interface LocalLibrarySnapshotNode {
  name: string;
  ignored?: boolean;
  relativePath: string;
  hash: string;
  files: LocalLibrarySnapshotFile[];
  children: LocalLibrarySnapshotNode[];
}

export interface LocalLibrarySnapshot {
  rootFolderName: string;
  /**
   * 銆屽垹闄ゆ枃浠跺す銆嶇暀涓嬬殑澧撶銆?   *
   * 鍒犳牴鐩綍鍙垹鎺変簡搴撻噷鐨勬瓕锛岃€?*鍒锋柊**鍦ㄥ畨鍗撲笂绛変簬鏁村簱閲嶆壂涓€娆★紙resyncAllFolders 鈫?   * scanAndroidDeviceMusic锛夛紝姝屼細琚師鏍锋壂鍥炴潵 鈥斺€?浜庢槸銆屽垹浜嗐€佷竴鍒锋柊鍙堝洖鏉ヤ簡銆嶃€?   * 鎵€浠ュ垹鏍规椂鐣欎竴鏉¤褰曪細鍒锋柊閭ｆ潯璺収瀹冭烦杩囷紝鍙湁鐢ㄦ埛**鏄惧紡**鐐广€屾壂鎻忚澶囬煶涔愩€嶆墠娓呮帀銆?   */
  rootRemoved?: boolean;
  ignoredFolderPaths?: string[];
  lyricFormatOrder?: import('./utils/lyrics/localLyricFormatOrder').LocalLyricFileFormat[]; // Sidecar lyric format order this scan used; undefined = default order
  scannedAt: number;
  tree: LocalLibrarySnapshotNode;
}

export interface LocalPlaylist {
  id: string;
  name: string;
  songIds: string[];
  createdAt: number;
  updatedAt: number;
  isFavorite?: boolean;
}

export type LocalLibraryGroupType = 'folder' | 'album' | 'artist' | 'playlist';

export interface LocalLibraryGroup {
  type: LocalLibraryGroupType;
  name: string;
  songs: LocalSong[];
  coverUrl?: string | Blob;
  id: string;
  isVirtual?: boolean;
  trackCount?: number;
  description?: string;
  albumId?: number;
  entityId?: string;
  playlistId?: string;
}

export type {
  LocalLibraryAssignment,
  LocalLibraryAssignmentOrigin,
  LocalLibraryEntity,
  LocalLibraryEntityKind,
  LocalSongImportedMetadata,
  LocalSongMetadataSource,
  LocalSongOnlineMetadata,
  LocalSongReference,
  LocalSongTitleOrigin,
} from './types/localLibrary';

// Extend SongResult to support local files and Navidrome files
export interface UnifiedSong extends SongResult {
  sourceRef: PlaybackSourceRef;
  // The row this song was read from, where its collection names its rows: a YouTube Music
  // playlist may hold a song twice, and a removal names the row. It says nothing of the song.
  collectionRowId?: string;
  isLocal?: boolean;
  localRef?: import('./types/localLibrary').LocalSongReference;
  isNavidrome?: boolean;
  navidromeData?: any;
}

export type ReplayGainMode = 'off' | 'track' | 'album';

// Audio Analysis Types
import { MotionValue } from 'framer-motion';

export interface AudioBands {
    bass: MotionValue<number>;    // 20-150Hz (Circles)
    lowMid: MotionValue<number>;  // 150-400Hz (Squares)
    mid: MotionValue<number>;     // 400-1200Hz (Triangles)
    vocal: MotionValue<number>;   // 1000-3500Hz (Icons)
    treble: MotionValue<number>;  // 3500Hz+ (Crosses)
    spectrum?: MotionValue<Uint8Array<ArrayBuffer>>; // Raw analyser FFT magnitude bins for full-spectrum visualizers
  }
