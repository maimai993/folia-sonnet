import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { type MotionValue } from 'framer-motion';
import * as THREE from 'three';
import { type AudioBands, type Line, type Theme } from '../../../types';
import { buildLineGraphemeTimeline, splitLyricGraphemes, type GraphemeTiming } from '../../../utils/lyrics/graphemeTiming';
import { getLineRenderEndTime } from '../../../utils/lyrics/renderHints';
import { resolveThemeFontStack } from '../../../utils/fontStacks';
import {
    buildFormation,
    buildParticleField,
    DIORAMA_HERO_DISTANCE,
    type DioramaFrame,
    type DioramaMotionParams,
    type DioramaShapePlacement,
    type DioramaTextPlacement,
    getDioramaGateShape,
    getDioramaShot,
    getDioramaTextPlacement,
    resolveShapeLifeOpacity,
} from './cameraPath';
import { resolveGlobal, type SequencerState, totalGlobalLines } from './dioramaSequencer';
import {
    buildDioramaFontSpec,
    DIORAMA_RASTER_FONT_PX,
    type DioramaLineRaster,
    measureDioramaText,
    rasterDioramaLine,
    rasterDioramaUnit,
    type DioramaUnitRaster,
} from './dioramaTextRaster';

// src/components/visualizer/diorama/DioramaScene.tsx
// Renders the lyric corridor along the winding path. Each nearby lyric line is staged on its path
// frame (per-line offset, scale, roll, yaw), plus a per-line procedural geometry formation matched to
// that line's camera move. Text, camera and geometry all read from the same shared `frames` +
// placements, so everything stays consistent as the path bends.
//
// TEXT is canvas-rasterised (see dioramaTextRaster.ts for why not SDF): the browser's own text engine
// draws every glyph - perfect stroke continuity for every script and the full shared subtitle font
// stack (theme style, weight, uploaded custom font, fallback). The ACTIVE line renders as INDIVIDUAL
// units (every CJK char / latin word its own plane), laid out by measuring the full line so kerning
// is preserved; behind each unit sits an additive plane holding the cadenza (心象) glow raster of the
// SAME glyph - registration is exact by construction. 辉光跟唱 follows the classic reveal model: the
// sung unit turns accent-coloured and lit, finished units return to plain bright, unsung units wait
// dim; each unit's light swells/decays on its own smoothed envelope, breathing with the music.
//
// The music is expressed HERE, in the world - never in the camera: bass pulses the formations' glow,
// treble quickens their spin, and a liquid-flow shader (injected into the standard material via
// onBeforeCompile) slides bands of emissive energy across every surface so the geometry reads as
// molten/flowing rather than static plastic. Shapes AND text live a distance-based LIFECYCLE: born
// from the far haze (no pop-in) and dissolving gracefully when the camera closes in. Theme colours
// are DAMPED per-frame (fog, lights, materials), so theme/AI theme changes and song switches glide
// instead of snapping. All per-frame values are refs inside useFrame - never React state.
interface DioramaSceneProps {
    theme: Theme;
    // The continuous-tunnel sequencer + the sticky GLOBAL line index. The scene resolves each global
    // index in the mounted window to its segment/local line/world frame, so the window can straddle a
    // graft joint: the outgoing song's tail lines recede/dissolve behind while the incoming song's head
    // lines are born from the far haze ahead - the transition, performed in-world with no overlay.
    sequencer: SequencerState;
    globalIndex: number;
    // During a transition, the global index of the line the camera is LEAVING. The scene mounts a second
    // window around it so the outgoing corridor recedes on-screen instead of vanishing. Null when idle.
    transitionOutgoingIndex: number | null;
    currentTime: MotionValue<number>;
    // Written each frame with the active line's measured WORLD width so CameraRig can size its
    // word-following lateral truck to the actual subtitle - the subtitle/camera coupling.
    activeLineWidthRef: React.MutableRefObject<number>;
    // Live audio levels (0..255) - geometry/light reaction only (the camera stays audio-free).
    audioPower: MotionValue<number>;
    audioBands: AudioBands;
    motion: DioramaMotionParams;
    /** Master lyric visibility (the shared subtitle toggle): hides all 3D text but keeps the world flying. */
    showLyrics: boolean;
    /** Foreground particle dust layer toggle (from the diorama tuning panel). */
    showParticles: boolean;
    /** Global lyric font-size scale (the 通用 字号 setting): scales the 3D text uniformly. */
    lyricsFontScale: number;
    /** 普通辉光跟唱 EFFECTIVE strength (toggle off resolves to 0) - the soft cadenza glow. */
    glowIntensity: number;
    /** 灵魂出窍跟唱 EFFECTIVE strength (toggle off resolves to 0) - the drifting ghost copy. */
    soulIntensity: number;
    /** 渐变跟唱 EFFECTIVE strength (toggle off resolves to 0) - fill deepens with sung progress. */
    gradientIntensity: number;
}

// Which lines get mounted as 3D text + formations, relative to the current line. Past lines stay
// mounted so a finished line recedes visibly instead of vanishing; upcoming lines mount ahead and are
// born out of the far haze by the lifecycle fade.
const LINES_AHEAD = 3;
const LINES_BEHIND = 2;
// The outgoing corridor during a transition needs only a small departing cluster on screen (it is being
// left behind), so its window is tighter than the live one - fewer meshes/rasters mounted per switch.
const OUTGOING_LINES_BEHIND = 2;
const OUTGOING_LINES_AHEAD = 1;
// How many neighbour line textures to rasterise per animation frame - keeps the per-frame cost bounded so
// a song change (several new lines at once) spreads across a few frames instead of hitching one.
const NEIGHBOR_RASTER_BUDGET = 2;
// Opacity for a non-active mounted line, by SIGNED offset from the current line. Past lines stay as a
// receding trail but MUTED - bright enough to exist, dim enough that a lingering credits line can
// never read as a second subtitle stamped over the current one.
const resolveNeighborLineOpacity = (offset: number): number => {
    if (offset === -1) return 0.3;
    if (offset === -2) return 0.1;
    if (offset === 1) return 0.34;
    if (offset === 2) return 0.16;
    if (offset === 3) return 0.06;
    return 0;
};
// Opacity for an OUTGOING corridor's lines during a transition: a soft, uniform departing glow (the
// camera is flying away from them, so the distance fog does the actual fade-out). Its own former-active
// line reads brightest, the rest a touch dimmer, so the leaving scene still looks like a real scene.
const resolveOutgoingLineOpacity = (offsetFromOutgoing: number): number =>
    offsetFromOutgoing === 0 ? 0.7 : Math.abs(offsetFromOutgoing) <= 2 ? 0.45 : 0.25;

// Nominal world size of one em of lyric text. A line is always exactly one row (the rasteriser never
// wraps); longer lines are shrunk to fit via the frame-fit scale below.
const LINE_FONT_SIZE = 0.62;
// Fraction of the visible frame width a full line may occupy AT THE HERO DISTANCE. The fit scale is
// computed against this FIXED reference distance, not the live camera distance, so the camera
// approaching/passing a line genuinely grows/foreshortens it (real dolly motion).
const TARGET_FRAME_WIDTH_FRACTION = 0.72;
// Floor for the fit scale so an extremely long line becomes small-but-readable instead of vanishing.
const MIN_FIT_SCALE = 0.28;
const DEG_TO_RAD = Math.PI / 180;
// World distance within which a shape brightens as the camera approaches - the geometry visibly
// performing with the move (a swept ring lights up as the lens passes it).
const SHAPE_PROXIMITY_RADIUS = 7;
// Fog band: far enough to keep the hero line and its formation crisp, near enough that the +3 line
// and its set-piece are born inside the haze (the lifecycle fade and the fog work together).
const FOG_NEAR = 12;
const FOG_FAR = 30;
// Text-specific near-dissolve band (tighter than the shapes'): a lyric passing right by the lens
// melts away instead of smearing across it, but no shot's normal framing distance ever triggers it.
const TEXT_DISSOLVE_START = 2.0;
const TEXT_DISSOLVE_END = 0.9;
// How quickly the damped theme colours chase their targets (per-second rate for the exp smoothing).
// Deliberately gentle (~1.5s to settle) so on a song change the palette eases over roughly the same span
// the outgoing scene takes to recede into the fog - the departing elements don't visibly snap to the new
// song's theme mid-flight, and manual/AI theme changes glide instead of stepping.
const COLOR_DAMP_RATE = 1.2;
// Per-unit sung-state rendering, copying the project's classic-visualizer reveal model: a unit that
// has not been sung yet sits dim; the unit being sung RIGHT NOW turns accent-coloured and glows; a
// finished unit returns to plain bright text.
const ACTIVE_LINE_OPACITY = 0.92;
const UNSUNG_UNIT_OPACITY = 0.5;
// Ceiling for the glow plane's additive opacity (scaled by the per-frame level and the 辉光 slider).
const UNIT_GLOW_MAX_OPACITY = 0.9;
// 灵魂出窍跟唱: an additive GHOST copy of the sung glyph (the crisp base raster, not the blurred
// glow). While the unit is being sung the ghost hovers just off the text; once the unit finishes,
// its envelope releases slowly and the ghost DETACHES - rising, swelling and fading out, like the
// glyph's energy layer leaving the body. All ceilings scale with the 灵魂出窍 slider.
const SOUL_MAX_OPACITY = 0.6;
const SOUL_ACTIVE_LIFT_EM = 0.06;
const SOUL_DETACH_LIFT_EM = 0.5;
const SOUL_ACTIVE_SWELL = 0.1;
const SOUL_DETACH_SWELL = 0.3;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// Fast-attack / slow-release envelope step: a rising target is chased quickly (beats hit on time), a
// falling one slowly (long notes sustain, then breathe out). Everything music-reactive in the scene
// tracks these smoothed envelopes instead of raw per-frame FFT values, so nothing can flicker.
const stepEnvelope = (current: number, target: number, attack: number, release: number, delta: number): number =>
    current + (target - current) * (1 - Math.exp(-(target > current ? attack : release) * delta));

const resolveTextLife = (distanceToCamera: number): number => {
    const t = clamp01((distanceToCamera - TEXT_DISSOLVE_END) / (TEXT_DISSOLVE_START - TEXT_DISSOLVE_END));
    return t * t * (3 - 2 * t);
};

// Uniform scale that shrinks a rendered line so it occupies at most TARGET_FRAME_WIDTH_FRACTION of
// the visible frame width at `distance`. three.js `fov` is the VERTICAL field of view.
const resolveFrameFitScale = (
    renderedWidth: number,
    distance: number,
    verticalFovDeg: number,
    aspect: number
): number => {
    if (renderedWidth <= 0 || distance <= 0) return 1;
    const frameWidth = 2 * distance * Math.tan((verticalFovDeg * DEG_TO_RAD) / 2) * aspect;
    const targetWidth = frameWidth * TARGET_FRAME_WIDTH_FRACTION;
    return Math.min(1, Math.max(MIN_FIT_SCALE, targetWidth / renderedWidth));
};

// Gradient colour temporaries (no per-frame alloc), all derived live from the theme's damped colours
// so a manual/AI theme switch re-colours the gradient automatically. _sungTint = the theme accent,
// made hue-safe when the palette is degenerate (see useFrame); _gradDeep = a darker, HUE-PRESERVING
// version the sung glyphs are dyed toward; _neutral = scratch for building a neutral grey.
const _sungTint = new THREE.Color();
const _gradDeep = new THREE.Color();
const _neutral = new THREE.Color();

// Reusable temporaries for building a line's text orientation from its path frame (no per-call alloc).
const _basisMatrix = new THREE.Matrix4();
const _basisQuat = new THREE.Quaternion();
const _tiltQuat = new THREE.Quaternion();
const _basisRight = new THREE.Vector3();
const _basisUp = new THREE.Vector3();
const _basisFwd = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

// Orient a line's text to face back along the path toward the trailing camera (local +X -> frame
// right, +Y -> frame up, +Z -> -forward: a proper rotation, never mirrored), then stage it with the
// placement's slight yaw and in-plane roll so the typography sits expressively rather than level.
const frameQuaternion = (frame: DioramaFrame, roll = 0, yaw = 0): [number, number, number, number] => {
    _basisRight.set(frame.right.x, frame.right.y, frame.right.z);
    _basisUp.set(frame.up.x, frame.up.y, frame.up.z);
    _basisFwd.set(-frame.forward.x, -frame.forward.y, -frame.forward.z);
    _basisMatrix.makeBasis(_basisRight, _basisUp, _basisFwd);
    _basisQuat.setFromRotationMatrix(_basisMatrix);
    if (yaw !== 0) _basisQuat.multiply(_tiltQuat.setFromAxisAngle(_axisY, yaw));
    if (roll !== 0) _basisQuat.multiply(_tiltQuat.setFromAxisAngle(_axisZ, roll));
    return [_basisQuat.x, _basisQuat.y, _basisQuat.z, _basisQuat.w];
};

interface ShapeInstance extends DioramaShapePlacement {
    key: string;
}

interface VisibleLineEntry {
    index: number;
    line: Line;
    placement: DioramaTextPlacement;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    /** True for lines belonging to the OUTGOING corridor during a transition (a different segment than
     * the active one): rendered as a receding departing cluster rather than the current-song neighbours. */
    isOutgoing: boolean;
}

interface DampedThemeColors {
    primary: THREE.Color;
    accent: THREE.Color;
    secondary: THREE.Color;
    bg: THREE.Color;
}

// One "unit" of the active line, rendered as its OWN plane: a single grapheme for CJK (每个字单独),
// a whole word for other scripts (每个词单独). charStart/charEnd are code-unit indices into the line
// string, used to measure the unit's exact slot in the full-line layout (kerning preserved).
interface LyricUnit {
    text: string;
    charStart: number;
    charEnd: number;
    startTime: number;
    endTime: number;
}

// Graphemes that split per character: han, kana, compatibility ideographs, half-width kana, PLUS
// bullets/geometric shapes (the interlude countdown dots ●●● must each be their own unit so the
// glow can centre on each dot). Everything else (latin etc.) groups into per-word units.
const CJK_GRAPHEME_RE = /[⺀-鿿぀-ヿ豈-﫿ｦ-ﾟ•·■-◿]/;

// A laid-out, rasterised unit of the active line, in world units at scale 1.
interface PlacedUnitRaster {
    raster: DioramaUnitRaster;
    centerX: number;
    width: number;
    height: number;
}

const DioramaScene: React.FC<DioramaSceneProps> = ({
    theme,
    sequencer,
    globalIndex,
    transitionOutgoingIndex,
    currentTime,
    activeLineWidthRef,
    audioPower,
    audioBands,
    motion,
    showLyrics,
    showParticles,
    lyricsFontScale,
    glowIntensity,
    soulIntensity,
    gradientIntensity,
}) => {
    const shapeRefs = useRef<Array<THREE.Mesh | null>>([]);
    // Neighbour line planes (one rasterised texture per line) - meshes for the fit scale, materials
    // for per-frame colour/opacity. Keyed by GLOBAL line index (which grows without bound across the
    // continuous tunnel), so Maps rather than arrays - entries are added/removed as the window moves.
    const lineMeshRefs = useRef<Map<number, THREE.Mesh>>(new Map());
    const lineMatRefs = useRef<Map<number, THREE.MeshBasicMaterial>>(new Map());
    // The active line's per-unit planes. Each of the three follow-sing effects has its OWN render
    // path so they never stand in for each other: base material (plain glyph; the gradient effect
    // tints it), glow material/mesh (additive cadenza glow raster - 普通辉光), and soul material/mesh
    // (additive crisp ghost copy that drifts out - 灵魂出窍).
    const unitsGroupRef = useRef<THREE.Group>(null);
    const unitBaseMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const unitGlowMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const unitGlowMeshRefs = useRef<Array<THREE.Mesh | null>>([]);
    const unitSoulMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const unitSoulMeshRefs = useRef<Array<THREE.Mesh | null>>([]);
    // Per-unit smoothed values (one slot per unit): lightVals drive the glow (fast release), soulVals
    // the ghost (slow release so it lingers and drifts after the word finishes). gradientEnv is the
    // line-progress ramp for 渐变跟唱. All reset on a line change via prevActiveGlobalRef.
    const unitLightValsRef = useRef<Float32Array | null>(null);
    const unitSoulValsRef = useRef<Float32Array | null>(null);
    const gradientEnvRef = useRef<number>(0);
    // Reset per-unit state when the ACTIVE global line changes. Keyed on the global index (not the line
    // object) so a single-loop restart - which replays the very same line objects in a fresh segment -
    // still resets cleanly instead of carrying the previous round's envelopes.
    const prevActiveGlobalRef = useRef<number>(-1);
    // Overall music-power envelope (fast attack, slow release) shared by the glow and the dust.
    const powerEnvRef = useRef<number>(0);
    // Smoke-dust layer refs, animated per-frame (drift + music breathing).
    const pointsRef = useRef<THREE.Points>(null);
    const pointsMatRef = useRef<THREE.PointsMaterial>(null);
    const ambientRef = useRef<THREE.AmbientLight>(null);
    const accentLightRef = useRef<THREE.PointLight>(null);
    const primaryLightRef = useRef<THREE.PointLight>(null);

    const colors = useMemo(() => ({
        primary: theme.primaryColor,
        accent: theme.accentColor || theme.primaryColor,
        secondary: theme.secondaryColor,
    }), [theme.primaryColor, theme.accentColor, theme.secondaryColor]);

    // Target theme colours as THREE colours; the damped copies chase these per-frame so theme / AI
    // theme / song switches glide the whole scene's colour instead of snapping it.
    const colorTargets = useMemo<DampedThemeColors>(() => ({
        primary: new THREE.Color(colors.primary),
        accent: new THREE.Color(colors.accent),
        secondary: new THREE.Color(colors.secondary),
        bg: new THREE.Color(theme.backgroundColor),
    }), [colors, theme.backgroundColor]);
    const dampedColorsRef = useRef<DampedThemeColors | null>(null);

    // Rasters must rebuild once the app's web fonts (bundled + uploaded custom font) finish loading -
    // a line rasterised before that would keep the fallback face.
    const [fontsEpoch, setFontsEpoch] = useState(0);
    useEffect(() => {
        let mounted = true;
        if (typeof document !== 'undefined' && document.fonts?.ready) {
            document.fonts.ready.then(() => { if (mounted) setFontsEpoch((e) => e + 1); });
        }
        return () => { mounted = false; };
    }, []);
    const fontStack = useMemo(
        () => resolveThemeFontStack(theme),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [theme.fontStyle, theme.fontFamily, fontsEpoch]
    );
    const fontSpec = useMemo(() => buildDioramaFontSpec(fontStack), [fontStack]);

    // Shared uniforms for the living-material shader below - one object each drives every shape
    // material; useFrame writes them once per frame (clock + smoothed audio envelopes).
    const flowTimeRef = useRef({ value: 0 });
    const bassEnvUniformRef = useRef({ value: 0 });
    const trebleEnvUniformRef = useRef({ value: 0 });
    // Injected into the standard material (fog, lighting, transparency all keep working) to make the
    // geometry read as LIVING fluid rather than static plastic, all driven by the smoothed envelopes:
    // - VERTEX: the surface undulates along its normals like liquid, swelling with the bass envelope.
    // - FRAGMENT: slow diagonal bands of theme-coloured emissive energy flow across the surface (their
    //   contrast pumps with the bass), and a fresnel rim makes the silhouette edge catch light like
    //   glass - shimmering harder as the treble envelope rises.
    const handleShapeBeforeCompile = useMemo(() => {
        const timeUniform = flowTimeRef.current;
        const bassUniform = bassEnvUniformRef.current;
        const trebleUniform = trebleEnvUniformRef.current;
        return (shader: THREE.WebGLProgramParametersWithUniforms) => {
            shader.uniforms.uFlowTime = timeUniform;
            shader.uniforms.uBassEnv = bassUniform;
            shader.uniforms.uTrebleEnv = trebleUniform;
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nuniform float uFlowTime;\nuniform float uBassEnv;')
                .replace(
                    '#include <begin_vertex>',
                    [
                        '#include <begin_vertex>',
                        'float dioramaWobble = sin(uFlowTime * 1.6 + position.x * 3.1 + position.y * 2.3 + position.z * 2.7);',
                        'transformed += normal * dioramaWobble * (0.035 + 0.09 * uBassEnv);',
                    ].join('\n')
                );
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nuniform float uFlowTime;\nuniform float uBassEnv;\nuniform float uTrebleEnv;')
                .replace(
                    '#include <emissivemap_fragment>',
                    [
                        '#include <emissivemap_fragment>',
                        'float dioramaFlow = 0.5 + 0.5 * sin(uFlowTime * 1.4 + vViewPosition.x * 1.6 + vViewPosition.y * 2.3);',
                        'float dioramaFlow2 = 0.5 + 0.5 * sin(uFlowTime * 0.7 - vViewPosition.y * 1.1 + vViewPosition.x * 0.6);',
                        'float dioramaBands = (0.75 * dioramaFlow + 0.35 * dioramaFlow2) * (0.7 + 0.6 * uBassEnv);',
                        'vec3 dioramaViewDir = normalize(vViewPosition);',
                        'float dioramaRim = pow(1.0 - saturate(dot(normalize(normal), dioramaViewDir)), 2.5);',
                        'totalEmissiveRadiance *= 0.4 + dioramaBands;',
                        'totalEmissiveRadiance += totalEmissiveRadiance * dioramaRim * (0.9 + 2.2 * uTrebleEnv);',
                    ].join('\n')
                );
        };
    }, []);

    // The active (newest) segment - the corridor currently playing. During a transition the previous
    // segment is still in the sequencer (the outgoing scene); everything on screen is one of the two.
    const activeSeg = sequencer.segments[sequencer.segments.length - 1] ?? null;
    const total = totalGlobalLines(sequencer);

    // Which GLOBAL indices to mount. Normally a small forward-weighted window around the current line;
    // during a transition ALSO a tighter window around the outgoing line, so the departing corridor stays
    // on screen and recedes into the fog instead of vanishing - two spatially-separated clusters, one
    // scene. The outgoing cluster may be a different segment (song change) or the far end of the SAME
    // segment (loop back to start), so membership is by index proximity, not by segment.
    const mountedIndices = useMemo(() => {
        const indices = new Set<number>();
        const addWindow = (center: number, behind: number, ahead: number) => {
            const start = Math.max(center - behind, 0);
            const end = Math.min(center + ahead, total - 1);
            for (let i = start; i <= end; i += 1) indices.add(i);
        };
        addWindow(globalIndex, LINES_BEHIND, LINES_AHEAD);
        if (transitionOutgoingIndex != null) addWindow(transitionOutgoingIndex, OUTGOING_LINES_BEHIND, OUTGOING_LINES_AHEAD);
        return Array.from(indices).sort((a, b) => a - b);
    }, [globalIndex, transitionOutgoingIndex, total]);

    const visibleLines = useMemo(() => {
        const result: VisibleLineEntry[] = [];
        for (const i of mountedIndices) {
            const resolved = resolveGlobal(sequencer, i);
            if (!resolved || !resolved.line) continue;
            const { frame } = resolved;
            const placement = getDioramaTextPlacement(resolved.localIndex, resolved.segment.seed, motion.weaveScale);
            const position = {
                x: frame.position.x + frame.right.x * placement.offsetR + frame.up.x * placement.offsetU,
                y: frame.position.y + frame.right.y * placement.offsetR + frame.up.y * placement.offsetU,
                z: frame.position.z + frame.right.z * placement.offsetR + frame.up.z * placement.offsetU,
            };
            result.push({
                index: i,
                line: resolved.line,
                placement,
                position: [position.x, position.y, position.z],
                quaternion: frameQuaternion(frame, placement.roll, placement.yaw),
                // A line belongs to the departing cluster if it sits nearer the outgoing centre than the
                // current one (works whether that cluster is a different segment or this corridor's own end).
                isOutgoing: transitionOutgoingIndex != null
                    && Math.abs(i - transitionOutgoingIndex) <= Math.abs(i - globalIndex),
            });
        }
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mountedIndices, sequencer, transitionOutgoingIndex, globalIndex, motion.weaveScale]);

    // Per-line procedural set-pieces matched to each line's camera move, centered on the line's actual
    // text placement, plus one foreground "gate" wipe shape per line. Built from the LOCAL index + segment
    // seed so each song keeps its own deterministic formations; keyed by GLOBAL index so pieces from two
    // segments never collide.
    const shapes = useMemo(() => {
        const result: ShapeInstance[] = [];
        for (const i of mountedIndices) {
            const resolved = resolveGlobal(sequencer, i);
            if (!resolved) continue;
            const { frame, localIndex, segment } = resolved;
            const placement = getDioramaTextPlacement(localIndex, segment.seed, motion.weaveScale);
            const shot = getDioramaShot(localIndex, segment.lines, segment.seed, motion.subMode);
            buildFormation(localIndex, segment.seed, shot, frame, placement).forEach((piece, slot) => {
                result.push({ ...piece, key: `${i}-${slot}` });
            });
            result.push({ ...getDioramaGateShape(localIndex, segment.seed, frame), key: `${i}-gate` });
        }
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mountedIndices, sequencer, motion.weaveScale, motion.subMode]);

    // Foreground dust field for the active segment's corridor - one static Points draw call; the camera's
    // own motion animates it as parallax. Rebuilt only when the active song/round (segment) changes.
    const activeSegKey = activeSeg?.key ?? 'x';
    const particlePositions = useMemo(
        () => buildParticleField(activeSeg?.frames ?? [], activeSeg?.seed),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [activeSegKey]
    );
    const particleKey = `dust-${activeSegKey}`;

    const activeLine = resolveGlobal(sequencer, globalIndex)?.line ?? null;
    const activeEntry = useMemo(
        () => visibleLines.find((entry) => entry.index === globalIndex) ?? null,
        [visibleLines, globalIndex]
    );
    // Per-grapheme timing for the active line - same source every other visualizer reveals against.
    const activeLineTimeline: GraphemeTiming[] = useMemo(
        () => (activeLine ? buildLineGraphemeTimeline(activeLine) : []),
        [activeLine]
    );
    // Split the active line into individually-rendered units: every CJK grapheme is its own unit,
    // consecutive non-CJK graphemes of the same word form one unit. Whitespace separates units and is
    // never a unit itself (its advance still shapes the layout via prefix measurement).
    const activeLineUnits: LyricUnit[] = useMemo(() => {
        if (!activeLine || activeLineTimeline.length === 0) return [];
        const graphemes = splitLyricGraphemes(activeLine.fullText);
        // Prefix code-unit offset of each grapheme, mapping grapheme index -> string index.
        const charOffsets: number[] = [];
        let acc = 0;
        for (const g of graphemes) { charOffsets.push(acc); acc += g.length; }
        const units: LyricUnit[] = [];
        const pushUnit = (from: number, to: number) => {
            const text = graphemes.slice(from, to).join('');
            if (text.trim().length === 0) return;
            units.push({
                text,
                charStart: charOffsets[from] ?? 0,
                charEnd: (charOffsets[to - 1] ?? 0) + (graphemes[to - 1]?.length ?? 1),
                startTime: activeLineTimeline[from].startTime,
                endTime: activeLineTimeline[to - 1].endTime,
            });
        };
        let i = 0;
        while (i < activeLineTimeline.length) {
            const g = graphemes[i] ?? '';
            if (g.trim().length === 0) { i += 1; continue; }
            if (CJK_GRAPHEME_RE.test(g)) {
                pushUnit(i, i + 1);
                i += 1;
                continue;
            }
            // Non-CJK: extend across the same word (same wordIndex), stopping at whitespace or CJK.
            const wordIndex = activeLineTimeline[i].wordIndex;
            let j = i + 1;
            while (
                j < activeLineTimeline.length
                && activeLineTimeline[j].wordIndex === wordIndex
                && (graphemes[j] ?? '').trim().length > 0
                && !CJK_GRAPHEME_RE.test(graphemes[j] ?? '')
            ) {
                j += 1;
            }
            pushUnit(i, j);
            i = j;
        }
        return units;
    }, [activeLine, activeLineTimeline]);

    // Rasterise + lay out the active line's units. Layout measures PREFIX strings of the full line, so
    // every unit lands at its exact kerned slot; each unit's base/glow textures share one canvas
    // geometry, so the glow registers on the strokes exactly. Synchronous - ready the frame it's built.
    const activeUnitsRaster = useMemo(() => {
        if (!activeLine?.fullText || activeLineUnits.length === 0) return null;
        const worldPerPx = LINE_FONT_SIZE / DIORAMA_RASTER_FONT_PX;
        const full = activeLine.fullText;
        const totalPx = measureDioramaText(full, fontSpec);
        const units: PlacedUnitRaster[] = activeLineUnits.map((unit) => {
            const prefixPx = measureDioramaText(full.slice(0, unit.charStart), fontSpec);
            const raster = rasterDioramaUnit(full.slice(unit.charStart, unit.charEnd), fontSpec);
            return {
                raster,
                centerX: (-totalPx / 2 + prefixPx + raster.advancePx / 2) * worldPerPx,
                width: raster.canvasWidthPx * worldPerPx,
                height: raster.canvasHeightPx * worldPerPx,
            };
        });
        return { units, lineWidth: totalPx * worldPerPx };
    }, [activeLine, activeLineUnits, fontSpec]);
    // Dispose the previous line's unit textures once a new set is in place.
    useEffect(() => {
        const current = activeUnitsRaster;
        return () => {
            current?.units.forEach((u) => {
                u.raster.baseTexture.dispose();
                u.raster.glowTexture.dispose();
            });
        };
    }, [activeUnitsRaster]);

    // Neighbour line rasters, cached per line index and built INCREMENTALLY off the render frame. A song
    // change wants several new line textures at once; rasterising them all synchronously during render is
    // a main source of the switch-frame hitch. Instead this effect prunes/flushes synchronously (cheap)
    // but rasterises the MISSING lines only a couple per animation frame - and since incoming lines start
    // fog-hidden, the few-frame delay before a plane can mount is invisible. The tick state re-renders as
    // textures land (so their planes mount); every consumer reads the cache ref live.
    const lineRasterCacheRef = useRef<Map<number, DioramaLineRaster>>(new Map());
    const lineRasterFontRef = useRef('');
    const [, bumpNeighborTick] = useState(0);
    useEffect(() => {
        const cache = lineRasterCacheRef.current;
        if (lineRasterFontRef.current !== fontSpec) {
            cache.forEach((raster) => raster.texture.dispose());
            cache.clear();
            lineRasterFontRef.current = fontSpec;
        }
        const wanted = new Set<number>();
        visibleLines.forEach(({ index, line }) => {
            if (line?.fullText && index !== globalIndex) wanted.add(index);
        });
        let changed = false;
        cache.forEach((raster, index) => {
            if (!wanted.has(index)) {
                raster.texture.dispose();
                cache.delete(index);
                changed = true;
            }
        });
        const missing: number[] = [];
        wanted.forEach((index) => { if (!cache.has(index)) missing.push(index); });
        if (missing.length === 0) {
            if (changed) bumpNeighborTick((v) => v + 1);
            return undefined;
        }
        let cancelled = false;
        let rafId = 0;
        let qi = 0;
        const buildBatch = () => {
            if (cancelled) return;
            for (let n = 0; n < NEIGHBOR_RASTER_BUDGET && qi < missing.length; n += 1, qi += 1) {
                const entry = visibleLines.find((e) => e.index === missing[qi]);
                if (entry?.line?.fullText && !cache.has(missing[qi])) {
                    cache.set(missing[qi], rasterDioramaLine(entry.line.fullText, fontStack));
                }
            }
            bumpNeighborTick((v) => v + 1);
            if (qi < missing.length) rafId = requestAnimationFrame(buildBatch);
        };
        rafId = requestAnimationFrame(buildBatch);
        return () => { cancelled = true; if (rafId) cancelAnimationFrame(rafId); };
    }, [visibleLines, globalIndex, fontSpec, fontStack]);

    // Free the neighbour cache's WebGL textures on UNMOUNT. The incremental effect above only disposes
    // textures it prunes (index no longer wanted) or flushes (font change); its cleanup just cancels the
    // rAF. three.js never frees manually-created textures on its own, so without this every mount/unmount
    // of the diorama (switching visualizer, leaving the player) would leak the still-cached CanvasTextures
    // on the GPU. A dedicated []-deps effect: its cleanup runs ONLY on unmount, so it can't drop textures
    // that are still in use across an ordinary re-render.
    useEffect(() => () => {
        lineRasterCacheRef.current.forEach((raster) => raster.texture.dispose());
        lineRasterCacheRef.current.clear();
    }, []);

    // The line the camera is LEAVING was, until this frame, drawn as per-glyph units (which never build a
    // whole-line neighbour raster). The instant a transition demotes it to a receding plane it needs that
    // raster THIS render, or it blinks out for the frame or two the async builder above would take (a
    // one-frame disappear/reappear of the outgoing lyric). Build just that ONE line synchronously - no
    // spike - so the swap from units to plane is seamless; all the genuinely new lines stay async.
    if (transitionOutgoingIndex != null && !lineRasterCacheRef.current.has(transitionOutgoingIndex)) {
        const leaving = visibleLines.find((entry) => entry.index === transitionOutgoingIndex);
        if (leaving?.line?.fullText) {
            lineRasterCacheRef.current.set(transitionOutgoingIndex, rasterDioramaLine(leaving.line.fullText, fontStack));
        }
    }

    useFrame((frameState, delta) => {
        // Damped theme colours chase the targets, then everything colour-bearing copies from them -
        // fog, lights, shape materials - so a theme/AI/song switch is a glide, not a jump.
        if (!dampedColorsRef.current) {
            dampedColorsRef.current = {
                primary: colorTargets.primary.clone(),
                accent: colorTargets.accent.clone(),
                secondary: colorTargets.secondary.clone(),
                bg: colorTargets.bg.clone(),
            };
        }
        const damped = dampedColorsRef.current;
        const colorK = 1 - Math.exp(-COLOR_DAMP_RATE * delta);
        damped.primary.lerp(colorTargets.primary, colorK);
        damped.accent.lerp(colorTargets.accent, colorK);
        damped.secondary.lerp(colorTargets.secondary, colorK);
        damped.bg.lerp(colorTargets.bg, colorK);
        const sceneFog = frameState.scene.fog;
        if (sceneFog) sceneFog.color.copy(damped.bg);
        if (ambientRef.current) ambientRef.current.color.copy(damped.secondary);
        if (accentLightRef.current) accentLightRef.current.color.copy(damped.accent);
        if (primaryLightRef.current) primaryLightRef.current.color.copy(damped.primary);

        // Liquid-flow clock: wall time (not playback time) so the energy keeps flowing during pauses.
        flowTimeRef.current.value = frameState.clock.elapsedTime;

        // Audio levels arrive 0..255; scaled by the tuning's audioLevel (0 disables entirely). The
        // GEOMETRY carries the music - the camera never does. Raw values are folded into fast-attack /
        // slow-release ENVELOPES (uniform refs shared with the shape shader): beats land on time, decays
        // breathe out - so every music-reactive element pulses together without frame flicker.
        const audioK = motion.audioLevel;
        const bass01 = Math.min(1, audioBands.bass.get() / 255) * audioK;
        const treble01 = Math.min(1, audioBands.treble.get() / 255) * audioK;
        const power01 = Math.min(1, audioPower.get() / 255) * audioK;
        const bassEnv = bassEnvUniformRef.current.value = stepEnvelope(bassEnvUniformRef.current.value, bass01, 14, 3.2, delta);
        const trebleEnv = trebleEnvUniformRef.current.value = stepEnvelope(trebleEnvUniformRef.current.value, treble01, 14, 3.2, delta);
        const powerEnv = stepEnvelope(powerEnvRef.current, power01, 18, 3.5, delta);
        powerEnvRef.current = powerEnv;
        const camPos = frameState.camera.position;

        // Smoke-life for the dust: the whole field drifts slowly like a carried haze, and the motes
        // swell/brighten with the music's energy - the camera's parallax does the rest.
        if (pointsRef.current) {
            const t = frameState.clock.elapsedTime;
            pointsRef.current.position.set(Math.sin(t * 0.21) * 0.35, Math.sin(t * 0.13 + 1.7) * 0.28, Math.cos(t * 0.17) * 0.35);
        }
        if (pointsMatRef.current) {
            pointsMatRef.current.size = 0.05 * (1 + 0.9 * trebleEnv);
            pointsMatRef.current.opacity = 0.32 + 0.35 * powerEnv;
            pointsMatRef.current.color.copy(damped.accent);
        }

        shapeRefs.current.forEach((mesh, i) => {
            if (!mesh) return;
            const shape = shapes[i];
            if (!shape) return;
            // Distance lifecycle: born from the far haze, dissolved before the lens can clip through.
            const dist = mesh.position.distanceTo(camPos);
            const life = resolveShapeLifeOpacity(dist);
            if (life <= 0.001) {
                mesh.visible = false;
                return;
            }
            mesh.visible = true;
            // Upright architecture only yaws slowly; loose pieces tumble slowly. Treble quickens both.
            const spin = shape.spinSpeed * (1 + trebleEnv * 2);
            if (shape.upright) {
                mesh.rotation.y += delta * spin * 0.6;
            } else {
                mesh.rotation.x += delta * spin;
                mesh.rotation.y += delta * spin * 0.7;
            }
            // Bass pulse + proximity swell, with a gentle shrink while dissolving so a near pass reads
            // as the shape melting away rather than popping off.
            const closeness = Math.max(0, 1 - dist / SHAPE_PROXIMITY_RADIUS);
            const pulse = shape.scale * (1 + bassEnv * 0.18 + closeness * 0.12) * (0.75 + 0.25 * life);
            mesh.scale.set(pulse, pulse * shape.stretchY, pulse);
            const material = mesh.material as THREE.MeshStandardMaterial;
            if (material) {
                const tone = shape.colorSlot === 0 ? damped.primary : damped.accent;
                material.color.copy(tone);
                material.emissive.copy(tone);
                material.opacity = (shape.layer === 'far' ? 0.45 : 0.9) * life;
                material.emissiveIntensity = (0.14 + bassEnv * 0.6 + powerEnv * 0.25 + closeness * 1.0) * life;
            }
        });

        // Fit each lyric line to read well at the HERO distance (times its per-line staging scale and
        // the global 字号 scale), then leave it alone - no billboarding, no live-distance rescale, so
        // camera motion is real. Widths are known synchronously from the raster layout.
        const { camera } = frameState;
        const aspect = camera instanceof THREE.PerspectiveCamera ? camera.aspect : 1;
        const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 55;
        visibleLines.forEach(({ index, placement, isOutgoing }) => {
            if (index === globalIndex) return;
            const mesh = lineMeshRefs.current.get(index);
            const mat = lineMatRefs.current.get(index);
            const raster = lineRasterCacheRef.current.get(index);
            if (!mesh || !mat || !raster) return;
            const worldWidth = raster.advancePx * (LINE_FONT_SIZE / raster.fontPx);
            const fit = resolveFrameFitScale(worldWidth, DIORAMA_HERO_DISTANCE, fov, aspect) * placement.scale * lyricsFontScale;
            mesh.scale.setScalar(fit);
            const life = resolveTextLife(mesh.position.distanceTo(camPos));
            if (isOutgoing) {
                // Departing corridor: a soft primary-toned cluster the camera is flying away from; the
                // distance fog handles the fade-out as it recedes (see resolveOutgoingLineOpacity).
                mat.opacity = resolveOutgoingLineOpacity(index - (transitionOutgoingIndex ?? index)) * life;
                mat.color.copy(damped.primary);
            } else {
                const offset = index - globalIndex;
                mat.opacity = resolveNeighborLineOpacity(offset) * life;
                // Past (already-sung) lines glow in the primary/bright tone as a lit trail; upcoming lines
                // sit in the dim secondary tone, waiting in the dark.
                mat.color.copy(offset < 0 ? damped.primary : damped.secondary);
            }
        });

        // Per-unit reveal + the three INDEPENDENT follow-sing effects. The base reveal (dim -> bright
        // sweep) always runs; on top of it each effect has its own render path and its own effective
        // strength (0 = its toggle is off): 普通辉光 lights the additive cadenza-glow plane, 灵魂出窍
        // drives the additive ghost plane, 渐变 tints the base fill with the line's sung progress.
        // Disabling one never changes what the others draw. All per-frame writes are material
        // colour/opacity + mesh transforms - nothing ever re-rasterises during a line.
        const unitsGroup = unitsGroupRef.current;
        if (globalIndex !== prevActiveGlobalRef.current) {
            // New active line (or new segment/round): fresh per-unit state (the keyed group already
            // remounted fresh planes).
            prevActiveGlobalRef.current = globalIndex;
            unitLightValsRef.current = new Float32Array(activeLineUnits.length);
            unitSoulValsRef.current = new Float32Array(activeLineUnits.length);
            gradientEnvRef.current = 0;
            unitBaseMatRefs.current.length = activeLineUnits.length;
            unitGlowMatRefs.current.length = activeLineUnits.length;
            unitGlowMeshRefs.current.length = activeLineUnits.length;
            unitSoulMatRefs.current.length = activeLineUnits.length;
            unitSoulMeshRefs.current.length = activeLineUnits.length;
        }
        if (unitsGroup && activeUnitsRaster && activeEntry && activeLine) {
            const fit = resolveFrameFitScale(activeUnitsRaster.lineWidth, DIORAMA_HERO_DISTANCE, fov, aspect)
                * activeEntry.placement.scale * lyricsFontScale;
            unitsGroup.scale.setScalar(fit);
            // Publish the active line's world width so CameraRig sizes its word-following truck.
            activeLineWidthRef.current = activeUnitsRaster.lineWidth * fit;
            const life = resolveTextLife(unitsGroup.position.distanceTo(camPos));
            const now = currentTime.get();
            const breath = 0.9 + 0.1 * Math.sin(frameState.clock.elapsedTime * 1.9);
            const lightVals = unitLightValsRef.current;
            const soulVals = unitSoulValsRef.current;

            // 渐变跟唱 line gate: eases in when the line starts being sung and releases slowly after
            // it finishes, so the whole tint fades out naturally and hands over smoothly to the next
            // line (which starts its own gate from zero). lineProgress feeds the per-unit sustain.
            const renderEnd = getLineRenderEndTime(activeLine);
            const lineSpan = Math.max(renderEnd - activeLine.startTime, 0.001);
            const lineProgress = clamp01((now - activeLine.startTime) / lineSpan);
            const gradientGateTarget = gradientIntensity > 0 && now >= activeLine.startTime && now <= renderEnd ? 1 : 0;
            gradientEnvRef.current = stepEnvelope(gradientEnvRef.current, gradientGateTarget, 6, 1.6, delta);
            const gradientNow = gradientEnvRef.current * Math.min(1.5, gradientIntensity);
            // Sung-tint axis for this frame, from the theme's damped colours: normally the accent as
            // is. When the palette is DEGENERATE (accent ~= primary - e.g. the built-in 墨染/素白
            // themes ship the SAME colour for both, so any accent<->primary blend is mathematically
            // invisible), the accent is blended toward a NEUTRAL grey offset in VALUE from the primary
            // (darker on light-text themes, brighter on dark-text). Neutral, never a hue: amplifying
            // the accent's sub-perceptual channel noise would tint a greyscale theme.
            const tintSeparation = Math.abs(damped.accent.r - damped.primary.r)
                + Math.abs(damped.accent.g - damped.primary.g)
                + Math.abs(damped.accent.b - damped.primary.b);
            _sungTint.copy(damped.accent);
            if (tintSeparation < 0.4) {
                const deficit = 1 - tintSeparation / 0.4;
                const primaryLum = (damped.primary.r + damped.primary.g + damped.primary.b) / 3;
                const accentLum = (damped.accent.r + damped.accent.g + damped.accent.b) / 3;
                const targetLum = primaryLum > 0.5 ? accentLum * (1 - 0.5 * deficit) : accentLum + (1 - accentLum) * 0.55 * deficit;
                _neutral.setRGB(targetLum, targetLum, targetLum);
                _sungTint.lerp(_neutral, deficit);
            }
            // The gradient's DEEP anchor: a darker, hue-PRESERVING (multiply, not HSL - HSL would
            // amplify channel noise into a fake hue) version of the sung-tint. The sung glyphs are
            // dyed from the plain primary toward this, so the wave carries a deep, saturated,
            // same-family colour that no palette washes out. The 强 tier makes the anchor deeper.
            const gradHot01 = Math.min(1, Math.max(0, (Math.min(1.5, gradientIntensity) - 0.1) / 1.4));
            _gradDeep.copy(_sungTint).multiplyScalar(0.8 - 0.18 * gradHot01);

            activeLineUnits.forEach((unit, i) => {
                const baseMat = unitBaseMatRefs.current[i];
                if (!baseMat || !lightVals || !soulVals) return;
                const isCurrent = now >= unit.startTime && now < unit.endTime;
                const sung = now >= unit.endTime;
                const span = Math.max(unit.endTime - unit.startTime, 0.001);
                const sungMix = sung ? 1 : isCurrent ? clamp01((now - unit.startTime) / span) : 0;

                // Shared sung-state envelope: swells fast while this unit is sung, trails off after.
                // It TIMES all three effects, but colour is written exactly once below.
                lightVals[i] = stepEnvelope(lightVals[i], isCurrent ? 1 : 0, 14, 4.5, delta);

                // 渐变跟唱 energy for this unit (its OWN follow-sing computation, alive with the other
                // two effects off). A HOT-TRAIL that peaks right as the unit is sung and relaxes over
                // ~1.8s behind the singing (a wave travelling through the line), on top of a floor that
                // deepens with the line's progress - so freshly sung glyphs are deepest, earlier ones
                // settle to a mid tone that grows richer as the line advances, and unsung glyphs are
                // untouched (energy 0). Scaled by gradientNow (the gate x strength tier).
                const sinceSung = sung ? now - unit.endTime : 0;
                const hotTrail = isCurrent ? sungMix : sung ? Math.max(0, 1 - sinceSung / 1.8) : 0;
                const gradientEnergy = sungMix * (0.35 + 0.25 * lineProgress + 0.7 * hotTrail) * gradientNow;

                // BASE REVEAL (always on): dim while unsung, sweeping to full as the unit is sung.
                // The gradient effect adds a small opacity lift on top.
                baseMat.opacity = Math.min(
                    1,
                    (UNSUNG_UNIT_OPACITY + (ACTIVE_LINE_OPACITY - UNSUNG_UNIT_OPACITY) * sungMix + 0.08 * Math.min(1, gradientEnergy)) * life
                );

                // ---- UNIFIED sung-colour state: the fill colour is computed exactly ONCE ----
                // Glow and soul only READ this colour below (never re-dye), so stacking never double-
                // deepens or over-saturates.
                if (gradientIntensity > 0) {
                    // 渐变跟唱 OWNS the fill: dye from the plain primary toward the deep sung-tint by
                    // this unit's energy. Energy 0 = exactly primary (unsung stays plain, the colour is
                    // never blanked), rising smoothly to the deep tint at the sung peak - a continuous,
                    // same-family deepening bound to the lyric progress, no jumps, no wash-out.
                    baseMat.color.copy(damped.primary).lerp(_gradDeep, Math.min(1, gradientEnergy));
                } else {
                    // Standard highlight when the gradient is off: the shared baseline every config
                    // gets - sung unit flashes toward the accent tint, decays after via lightVals.
                    baseMat.color.copy(damped.primary).lerp(_sungTint, Math.min(1, lightVals[i] * 1.15));
                }

                // 普通辉光 (visual layer only - reads the unified colour, never writes it): brightness
                // rides the shared envelope, breath and the music-power envelope AFTER smoothing.
                // CRITICAL: the glow plane NEVER scales or moves - a scaled/offset additive glyph
                // copy reads as a displaced ghost (that displacement IS the soul-drift mechanism,
                // owned by the soul plane below). The glow stays registered on the strokes.
                const glowStrength = Math.min(1.5, glowIntensity);
                const glowLevel = lightVals[i] * life * breath * (0.6 + 0.4 * powerEnv) * glowStrength;
                const glowMat = unitGlowMatRefs.current[i];
                const glowMesh = unitGlowMeshRefs.current[i];
                if (glowMat) {
                    glowMat.opacity = Math.min(1, UNIT_GLOW_MAX_OPACITY * glowLevel);
                    glowMat.color.copy(baseMat.color);
                }
                if (glowMesh) {
                    glowMesh.visible = glowLevel > 0.012;
                }

                // 灵魂出窍 (visual layer only - reads the unified colour as its energy tint): its own
                // slow-release envelope - the ghost hugs the glyph while it is sung (soulVals ~1,
                // detach ~0), then DETACHES as the envelope releases: rising, swelling and fading
                // like the glyph's energy layer leaving the body.
                soulVals[i] = stepEnvelope(soulVals[i], isCurrent ? 1 : 0, 12, 2.2, delta);
                const soulStrength = Math.min(1.5, soulIntensity);
                const soulLevel = soulVals[i] * life * soulStrength;
                const soulMat = unitSoulMatRefs.current[i];
                const soulMesh = unitSoulMeshRefs.current[i];
                if (soulMat && soulMesh) {
                    const detach = 1 - soulVals[i];
                    soulMat.opacity = Math.min(1, SOUL_MAX_OPACITY * soulLevel);
                    soulMat.color.copy(baseMat.color);
                    soulMesh.position.y = LINE_FONT_SIZE * (SOUL_ACTIVE_LIFT_EM + SOUL_DETACH_LIFT_EM * detach) * soulStrength;
                    const soulSwell = 1 + (SOUL_ACTIVE_SWELL * soulVals[i] + SOUL_DETACH_SWELL * detach) * soulStrength;
                    soulMesh.scale.set(soulSwell, soulSwell, 1);
                    soulMesh.visible = soulLevel > 0.015;
                }
            });
        } else {
            activeLineWidthRef.current = 0;
        }
    });

    return (
        <group>
            {/* Fog toward the shell's background colour (damped per-frame in useFrame): distant lines
                and set-pieces melt into the same haze the lifecycle fade births them from. */}
            <fog attach="fog" args={['#000000', FOG_NEAR, FOG_FAR]} />
            {/* Light colours are driven imperatively from the damped theme colours each frame. */}
            <ambientLight ref={ambientRef} intensity={0.6} />
            <pointLight ref={accentLightRef} position={[6, 8, 6]} intensity={1.1} />
            <pointLight ref={primaryLightRef} position={[-6, -4, -6]} intensity={0.5} />

            {showParticles && (
                <points key={particleKey} ref={pointsRef} frustumCulled={false}>
                    <bufferGeometry>
                        <bufferAttribute attach="attributes-position" args={[particlePositions, 3]} />
                    </bufferGeometry>
                    {/* Size/opacity/colour are driven per-frame from the music envelopes in useFrame -
                        the dust breathes like carried smoke instead of sitting static. */}
                    <pointsMaterial
                        ref={pointsMatRef}
                        size={0.05}
                        sizeAttenuation
                        transparent
                        opacity={0.4}
                        depthWrite={false}
                        color={colors.accent}
                        blending={THREE.AdditiveBlending}
                    />
                </points>
            )}

            {showLyrics && visibleLines.map(({ index, line, position, quaternion, isOutgoing }) => {
                if (!line?.fullText) return null;
                if (index === globalIndex) return null;
                // Outgoing (departing) lines use their own soft opacity so a huge index gap never gates
                // them out; incoming neighbours use the offset-from-current bell. Both are refreshed per
                // frame in useFrame - these are just the initial values.
                const offset = index - globalIndex;
                const initialOpacity = isOutgoing
                    ? resolveOutgoingLineOpacity(index - (transitionOutgoingIndex ?? index))
                    : resolveNeighborLineOpacity(offset);
                if (initialOpacity <= 0) return null;
                const raster = lineRasterCacheRef.current.get(index);
                if (!raster) return null;
                const worldPerPx = LINE_FONT_SIZE / raster.fontPx;
                const initialColor = isOutgoing || offset < 0 ? colors.primary : colors.secondary;
                return (
                    // One rasterised plane per neighbour line (colour/opacity refreshed per-frame). Refs are
                    // keyed by GLOBAL index in a Map: added on mount, removed on unmount as the window moves.
                    <mesh
                        key={index}
                        ref={el => { if (el) lineMeshRefs.current.set(index, el); else lineMeshRefs.current.delete(index); }}
                        position={position}
                        quaternion={quaternion}
                        renderOrder={0}
                    >
                        <planeGeometry args={[raster.canvasWidthPx * worldPerPx, raster.canvasHeightPx * worldPerPx]} />
                        <meshBasicMaterial
                            ref={el => { if (el) lineMatRefs.current.set(index, el); else lineMatRefs.current.delete(index); }}
                            map={raster.texture}
                            transparent
                            opacity={initialOpacity}
                            depthWrite={false}
                            color={initialColor}
                        />
                    </mesh>
                );
            })}

            {showLyrics && activeLine?.fullText && activeEntry && activeUnitsRaster && (
                // The active line as INDIVIDUAL units (every CJK char / latin word its own plane), laid
                // out at their exact kerned slots in the full-line layout. Keyed by line index: fresh
                // planes/textures every line. Behind each unit sits an additive plane with the cadenza
                // glow raster of the SAME glyph - registration is exact by construction; its opacity/
                // scale breathe per-frame. The active line never depth-tests, so geometry can frame it
                // from any angle without covering the words.
                <group key={globalIndex} ref={unitsGroupRef} position={activeEntry.position} quaternion={activeEntry.quaternion}>
                    {activeUnitsRaster.units.map((placed, unitIndex) => (
                        <React.Fragment key={unitIndex}>
                            <mesh
                                ref={el => { unitGlowMeshRefs.current[unitIndex] = el; }}
                                visible={false}
                                position={[placed.centerX, 0, -0.01]}
                                renderOrder={17}
                            >
                                <planeGeometry args={[placed.width, placed.height]} />
                                <meshBasicMaterial
                                    ref={el => { unitGlowMatRefs.current[unitIndex] = el; }}
                                    map={placed.raster.glowTexture}
                                    transparent
                                    opacity={0}
                                    depthTest={false}
                                    depthWrite={false}
                                    blending={THREE.AdditiveBlending}
                                    color={colors.accent}
                                />
                            </mesh>
                            {/* 灵魂出窍 ghost: the CRISP base raster (not the blurred glow) drawn
                                additively; useFrame lifts/swells/fades it as its envelope releases. */}
                            <mesh
                                ref={el => { unitSoulMeshRefs.current[unitIndex] = el; }}
                                visible={false}
                                position={[placed.centerX, 0, -0.005]}
                                renderOrder={18}
                            >
                                <planeGeometry args={[placed.width, placed.height]} />
                                <meshBasicMaterial
                                    ref={el => { unitSoulMatRefs.current[unitIndex] = el; }}
                                    map={placed.raster.baseTexture}
                                    transparent
                                    opacity={0}
                                    depthTest={false}
                                    depthWrite={false}
                                    blending={THREE.AdditiveBlending}
                                    color={colors.accent}
                                />
                            </mesh>
                            <mesh position={[placed.centerX, 0, 0]} renderOrder={19}>
                                <planeGeometry args={[placed.width, placed.height]} />
                                <meshBasicMaterial
                                    ref={el => { unitBaseMatRefs.current[unitIndex] = el; }}
                                    map={placed.raster.baseTexture}
                                    transparent
                                    opacity={UNSUNG_UNIT_OPACITY}
                                    depthTest={false}
                                    depthWrite={false}
                                    color={colors.primary}
                                />
                            </mesh>
                        </React.Fragment>
                    ))}
                </group>
            )}

            {shapes.map((shape, i) => (
                <mesh
                    key={shape.key}
                    ref={el => { shapeRefs.current[i] = el; }}
                    position={[shape.position.x, shape.position.y, shape.position.z]}
                    scale={[shape.scale, shape.scale * shape.stretchY, shape.scale]}
                >
                    {/* The formation archetypes map onto SMOOTH, organic primitives only. Hard-edged
                        primitives (boxes/cones) have split per-face normals, so the fluid vertex wobble
                        tears their faces apart at the seams - and their silhouettes read as plastic, not
                        fluid. Smooth geometry shares vertex normals: the wobble undulates the surface
                        continuously, so the set-pieces read as liquid blobs, pillars and ribbons.
                        'box' (pillar archetype) -> capsule, 'cone' (spire) -> flowing torus knot. */}
                    {shape.kind === 'box' && <capsuleGeometry args={[0.42, 0.72, 12, 24]} />}
                    {shape.kind === 'sphere' && <sphereGeometry args={[0.7, 48, 32]} />}
                    {shape.kind === 'cone' && <torusKnotGeometry args={[0.45, 0.16, 96, 16]} />}
                    {shape.kind === 'torus' && <torusGeometry args={[0.7, 0.25, 24, 48]} />}
                    {/* Colour/emissive are copied from the DAMPED theme colours per-frame in useFrame
                        (smooth theme transitions); opacity/emissiveIntensity are the audio pulse,
                        proximity flare and lifecycle fade; onBeforeCompile injects the living-material
                        behaviour (liquid wobble, flowing emissive bands, fresnel glass rim). */}
                    <meshStandardMaterial
                        emissiveIntensity={0.12}
                        roughness={shape.layer === 'far' ? 0.6 : 0.32}
                        metalness={0.15}
                        transparent
                        opacity={shape.layer === 'far' ? 0.45 : 0.9}
                        onBeforeCompile={handleShapeBeforeCompile}
                    />
                </mesh>
            ))}
        </group>
    );
};

export default DioramaScene;
