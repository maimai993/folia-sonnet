import { flattenAcoustics, type AcousticMeshes } from './acousticMaterials';
import { getSceneAcousticsApi, type RoomRequest, type RoomResult, type SceneAcousticsApi, type Vec3 } from './acousticsTypes';
import { applyRoomReverbToConsole, clearRoomReverbFromConsole, estimateRoomReverb } from './roomEstimate';
import { loudnessGain, roomRequestKey } from './roomIr';
import { createRoomStage, getRoomSlot, onRoomSlot, type RoomIr, type RoomSlot, type RoomStage } from './roomStage';

// src/services/sceneSound/sceneSound.ts
// The scene's ctx.sound on the main window's player page: the room's shape and the listener's seat go to the
// acoustics process (window.electron.sceneAcoustics), the IR that comes back plays through roomStage.ts.
// The gain comes from the default seat's IR (roomIr.ts loudnessGain), so another seat asks for two IRs the
// first time. Without the acoustics process (web build, a machine where Steam Audio does not load), with the
// room sound switched off, or before the playback graph exists, the music plays dry and tier is 'off'.

export type RoomOutput = RoomRequest['output'];
/**
 * 'realtime' / 'cached'：桌面端由 Steam Audio 算出来的真 IR（现算 / 读缓存）。
 * 'estimated'：安卓上没有 Steam Audio，从场景几何估出混响参数，交给原生 DSP 的
 * ReverbStage 演奏（见 roomEstimate.ts）。听感是「在那个厅里」，但没有方位信息。
 * 'off'：干声。
 */
export type RoomTier = 'realtime' | 'cached' | 'estimated' | 'off';

type Point = readonly [number, number, number];
interface ViewpointPoint { id: string; ear: Point; lookAt: Point; preferred?: boolean }
interface SpeakerPoint { id: string; position: Point }

export interface RoomSoundAnchors {
    viewpoints: () => readonly ViewpointPoint[];
    speakers: () => readonly SpeakerPoint[];
}

export interface RoomSoundOptions {
    enabled: boolean;
    output: RoomOutput;
}

type Listener = { position: Point; lookAt?: Point } | { viewpoint: string };

export interface RoomSound {
    setAcoustics(world: AcousticMeshes): void;
    moveObject(id: string, matrix: ArrayLike<number>): void;
    setListener(pose: Listener): void;
    play(): { stop(): void };
    readonly tier: RoomTier;
    /** From the host: the user's switch and headphones-or-speakers. */
    setOptions(options: RoomSoundOptions): void;
    dispose(): void;
}

interface Deps {
    anchors: RoomSoundAnchors;
    api?: SceneAcousticsApi | null;
    getSlot?: () => RoomSlot | null;
    onSlot?: (listener: () => void) => () => void;
    createStage?: (slot: RoomSlot) => RoomStage;
}

/** How many IRs this scene keeps at hand (about 1.5 MB each): enough for going back and forth between seats. */
const KEPT_IRS = 6;

const vec = (point: Point): Vec3 => [point[0], point[1], point[2]];
const normalize = (x: number, y: number, z: number): Vec3 => {
    const length = Math.hypot(x, y, z);
    return length > 0 ? [x / length, y / length, z / length] : [0, 0, -1];
};

/**
 * A seat or a pose as the listener: a seat's ear, facing its look-at point level (the way a seated
 * listener faces the screen); a pose facing its look-at point, or -z.
 */
export const resolveListener = (listener: Listener | null, seats: readonly ViewpointPoint[]): RoomRequest['listener'] | null => {
    const up: Vec3 = [0, 1, 0];
    if (listener && 'position' in listener) {
        const [x, y, z] = listener.position;
        const look = listener.lookAt;
        return { position: vec(listener.position), forward: look ? normalize(look[0] - x, look[1] - y, look[2] - z) : [0, 0, -1], up };
    }
    const seat = (listener && seats.find(entry => entry.id === listener.viewpoint)) ?? seats.find(entry => entry.preferred) ?? seats[0];
    if (!seat) return null;
    return { position: vec(seat.ear), forward: normalize(seat.lookAt[0] - seat.ear[0], 0, seat.lookAt[2] - seat.ear[2]), up };
};

export const createRoomSound = ({
    anchors,
    api = getSceneAcousticsApi(),
    getSlot = getRoomSlot,
    onSlot = onRoomSlot,
    createStage = createRoomStage,
}: Deps): RoomSound => {
    let room: Pick<RoomRequest, 'meshes' | 'materials'> | null = null;
    let listener: Listener | null = null;
    let options: RoomSoundOptions = { enabled: true, output: 'headphones' };
    let tier: RoomTier = 'off';
    let stage: { slot: RoomSlot; stage: RoomStage } | null = null;
    let generation = 0;
    let scheduled = false;
    let disposed = false;
    let available: Promise<boolean> | null = null;
    // IRs by request key, in-flight ones included, so two updates never ask twice.
    const irs = new Map<string, Promise<RoomResult>>();
    // The default seat's gain, by the default seat's request key.
    const gains = new Map<string, number>();

    const isAvailable = () => {
        available ??= (api ? api.available() : Promise.resolve({ ok: false, reason: 'no acoustics process' }))
            .catch((error: unknown) => {
                console.warn('[SceneSound] could not ask whether room sound is available', error);
                return { ok: false, reason: String(error) };
            })
            .then(({ ok, reason }) => {
                if (!ok) console.info('[SceneSound] room sound unavailable, music plays dry:', reason);
                return ok;
            });
        return available;
    };

    const fetchIr = (request: RoomRequest) => {
        let entry = irs.get(request.key);
        if (!entry) {
            if (!api) return Promise.reject(new Error('no acoustics process'));
            entry = api.computeRoom(request);
            entry.catch(() => irs.delete(request.key));
            irs.set(request.key, entry);
            const oldest = irs.keys().next();
            if (irs.size > KEPT_IRS && !oldest.done) irs.delete(oldest.value);
        }
        return entry;
    };

    const goDry = () => {
        stage?.stage.stop();
        // 安卓上的房间里那次是写进音频控制台的混响，关掉时要一起还回去，别留着一层湿声。
        if (tier === 'estimated') clearRoomReverbFromConsole();
        tier = 'off';
    };

    const update = async () => {
        scheduled = false;
        const token = ++generation;
        const stale = () => disposed || token !== generation;
        const slot = getSlot();
        if (!room || !options.enabled || !slot) {
            goDry();
            return;
        }
        if (!(await isAvailable()) || stale()) {
            if (stale()) return;
            /*
             * 没有 Steam Audio（安卓就是这样：那是桌面端的原生库，手机上装不了）。
             *
             * 从场景几何估一组混响参数交给原生 DSP，而不是直接放干声 —— 影厅的
             * 「声线追踪」在手机上要的是「听起来在那个厅里」，不是逐样本还原那条
             * IR。估出来的参数走音频控制台 → nativeEqualizer → 原生 ReverbStage，
             * 这条路本来就有，用户手动调混响也走它。
             */
            const estimate = estimateRoomReverb(room, room.materials, options.output);
            if (estimate) {
                applyRoomReverbToConsole(estimate);
                tier = 'estimated';
                console.log(
                    `[SceneSound] no acoustics process, estimated the room instead: `
                    + `RT60 ${estimate.rt60Seconds.toFixed(2)} s, mix ${estimate.mix.toFixed(2)}, `
                    + `damping ${estimate.damping.toFixed(2)}, pre-delay ${Math.round(estimate.preDelayMs)} ms `
                    + `(volume ${estimate.room.volume.toFixed(0)} m³, surface ${estimate.room.surface.toFixed(0)} m², `
                    + `mean absorption ${estimate.room.meanAbsorption.toFixed(2)})`,
                );
                return;
            }
            goDry();
            return;
        }
        const speakerAt = (id: string) => anchors.speakers().find(speaker => speaker.id === id)?.position;
        const left = speakerAt('L');
        const right = speakerAt('R');
        const seats = anchors.viewpoints();
        const pose = resolveListener(listener, seats);
        const defaultPose = resolveListener(null, seats);
        if (!left || !right || !pose || !defaultPose) {
            console.warn('[SceneSound] the scene has no speaker.L / speaker.R or no seat; music plays dry');
            goDry();
            return;
        }
        const base = { ...room, speakers: [vec(left), vec(right)] as [Vec3, Vec3], output: options.output, sampleRate: slot.context.sampleRate };
        const withKey = async (at: RoomRequest['listener']): Promise<RoomRequest> => {
            const request = { ...base, listener: at };
            return { key: await roomRequestKey(request), ...request };
        };
        try {
            const [request, defaultRequest] = await Promise.all([withKey(pose), withKey(defaultPose)]);
            if (stale()) return;
            const started = performance.now();
            let gain = gains.get(defaultRequest.key);
            if (gain === undefined) {
                const reference = await fetchIr(defaultRequest);
                if (stale()) return;
                gain = loudnessGain(reference.channels, reference.sampleRate);
                gains.set(defaultRequest.key, gain);
                console.log(`[SceneSound] loudness gain from the default seat: ${(20 * Math.log10(gain)).toFixed(1)} dB`);
            }
            const result = await fetchIr(request);
            if (stale()) return;
            if (result.sampleRate !== slot.context.sampleRate) {
                console.warn('[SceneSound] IR sample rate does not match the audio context; music plays dry', result.sampleRate, slot.context.sampleRate);
                goDry();
                return;
            }
            if (stage && stage.slot !== slot) {
                stage.stage.dispose();
                stage = null;
            }
            stage ??= { slot, stage: createStage(slot) };
            stage.stage.play(playable(request.key, result.channels, result.sampleRate, gain));
            tier = result.source === 'computed' ? 'realtime' : 'cached';
            console.log(`[SceneSound] room ${tier}: ${options.output}, IR ${result.source} in ${Math.round(result.ms)} ms, ready after ${Math.round(performance.now() - started)} ms`);
        } catch (error) {
            if (stale()) return;
            // Keep what is playing; the next change asks again.
            console.warn('[SceneSound] room IR failed; keeping the current sound', error);
        }
    };

    // The same key and gain give the same object, so the stage sees "already playing" and loads nothing.
    let last: { key: string; ir: RoomIr } | null = null;
    const playable = (key: string, channels: readonly Float32Array[], sampleRate: number, gain: number): RoomIr => {
        if (last?.key === key && last.ir.gain === gain) return last.ir;
        last = { key, ir: { channels, sampleRate, gain } };
        return last.ir;
    };

    // Changes in one go (the host's options and seat, the scene's room) make one update.
    const schedule = () => {
        if (scheduled || disposed) return;
        scheduled = true;
        queueMicrotask(() => { void update(); });
    };
    const stopSlot = onSlot(schedule);

    return {
        setAcoustics: (world) => {
            const flat = flattenAcoustics(world);
            if (flat.unknown.length) console.warn('[SceneSound] unknown acoustic materials, using generic:', flat.unknown.join(', '));
            room = { meshes: flat.meshes, materials: flat.materials };
            schedule();
        },
        // ponytail: the room is one static mesh for now; doors and curtains that move come with a scene that has them.
        moveObject: () => {},
        setListener: (next) => {
            listener = next;
            schedule();
        },
        play: () => ({ stop: () => {} }),
        get tier() {
            return tier;
        },
        setOptions: (next) => {
            if (next.enabled === options.enabled && next.output === options.output) return;
            options = next;
            schedule();
        },
        dispose: () => {
            disposed = true;
            stopSlot();
            stage?.stage.stop();
            if (tier === 'estimated') clearRoomReverbFromConsole();
            tier = 'off';
        },
    };
};
