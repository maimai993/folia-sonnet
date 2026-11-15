import type { AcousticMaterial, RoomRequest } from './acousticsTypes';

// src/services/sceneSound/roomEstimate.ts
//
// 安卓上没有 Steam Audio：它是个桌面端的原生库，算的是真几何声学（射线追踪 +
// 卷积 IR），搬不到手机上。但影厅的「声线追踪」在手机上想要的效果其实是
// **听起来像在那个厅里**，不是逐样本还原那条 IR。
//
// 所以这里换一条路：从场景的几何和材质里量出这个房间的几个物理量 —— 体积、
// 表面积、平均吸声率 —— 再用混响的经典公式（Sabine / Eyring）算出 RT60，
// 交给原生 DSP 已有的 ReverbStage（Freeverb 结构）去演奏。
//
// 这不是近似得很勉强的替代：Sabine 公式本来就是「房间多大、多吸声 → 混响多长」
// 的物理关系，厅堂声学设计一直在用它。丢掉的只是「哪面墙把声音反射到耳朵」
// 这种方位信息 —— 耳机下能听出左右，但听不出「左后方那面墙」。
//
// 参数怎么定的：
//   · 体积 V 与总表面积 S 从场景顶点与三角形算（包围盒当房间，三角形面积累加）。
//   · 平均吸声率 ᾱ 按**面积加权**取三个频段的平均 —— 一个厅里大厅绒布、座椅、
//     吸声墙板各占多少面积，决定它有多「干」。
//   · RT60 = 0.161 · V / (S · ᾱ)（Sabine，米制）。ᾱ 大到 0.3 以上时 Sabine 会高估，
//     改用 Eyring：RT60 = 0.161 · V / (-S · ln(1 - ᾱ))。
//   · 预延迟按「听者到最近反射面」估：取包围盒最短边的一半，声速 343 m/s。
//   · 阻尼跟吸声率走：高频吸得多（地毯、绒布）的房间，阻尼高一些。
//   · 干湿比跟「厅有多大」走：更大的厅湿声更多，但不能盖过直达声。

/** 声速（m/s），20 ℃ 的空气。 */
const SPEED_OF_SOUND = 343;
/** Sabine 公式的米制常数。 */
const SABINE_CONSTANT = 0.161;
/** ᾱ 超过这个值就该用 Eyring 了（Sabine 在强吸声房间里会显著高估）。 */
const EYRING_THRESHOLD = 0.3;

/** 原生的 ReverbStage 能接受的范围，超出会被它自己夹住（见 ReverbSettings）。 */
const RT60_MIN = 0.3;
const RT60_MAX = 10;
const MIX_MIN = 0;
const MIX_MAX = 1;
const DAMPING_MIN = 0.02;
const DAMPING_MAX = 0.9;
const PRE_DELAY_MAX_MS = 120;

/** 场景声学换算出来的混响参数，形状和原生 ReverbSettings 对得上。 */
export interface RoomReverbEstimate {
    /** 衰减 60 dB 所需的秒数。 */
    rt60Seconds: number;
    /** 干湿比，0..1。 */
    mix: number;
    /** 高频阻尼，0..1，越大越暗。 */
    damping: number;
    /** 预延迟，毫秒。 */
    preDelayMs: number;
    /** 湿声电平，dB。 */
    roomLevelDb: number;
    /** 量出来的房间，给界面显示用。 */
    room: {
        /** 体积，立方米。 */
        volume: number;
        /** 表面积，平方米。 */
        surface: number;
        /** 面积加权的平均吸声率。 */
        meanAbsorption: number;
        /** 包围盒最短边，米。 */
        shortestSpan: number;
    };
}

const clamp = (value: number, min: number, max: number): number => (
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
);

/**
 * 把 `AcousticMeshes` 里的顶点摊开，算出包围盒与总表面积。
 *
 * 只量三角形面积，不建空间索引：这是每次换场景算一次的东西，一米一米地乘加足够快，
 * 而且不需要为它引入一套 BVH。
 */
/**
 * 估算只要几何与材质，不要听众座位、音箱位置这些东西 —— 所以收 `RoomRequest` 的一部分，
 * 而不是整个请求。这样放干声的那条路上不用为了估算去凑一份假请求。
 */
type RoomGeometry = Pick<RoomRequest, 'meshes' | 'materials'>;

const measure = (world: RoomGeometry): { volume: number; surface: number; shortestSpan: number } | null => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let surface = 0;
    let triangles = 0;

    for (const mesh of world.meshes) {
        const positions = mesh.positions;
        const indices = mesh.indices;
        for (let i = 0; i + 2 < indices.length; i += 3) {
            const a = indices[i] * 3;
            const b = indices[i + 1] * 3;
            const c = indices[i + 2] * 3;
            const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
            const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
            const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
            if (!Number.isFinite(ax) || !Number.isFinite(bx) || !Number.isFinite(cx)) continue;

            minX = Math.min(minX, ax, bx, cx);
            minY = Math.min(minY, ay, by, cy);
            minZ = Math.min(minZ, az, bz, cz);
            maxX = Math.max(maxX, ax, bx, cx);
            maxY = Math.max(maxY, ay, by, cy);
            maxZ = Math.max(maxZ, az, bz, cz);

            // 三角形面积 = 两条边的叉积长度的一半。
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            surface += 0.5 * Math.hypot(nx, ny, nz);
            triangles += 1;
        }
    }

    if (triangles === 0 || !Number.isFinite(minX)) return null;

    const spanX = Math.max(0.01, maxX - minX);
    const spanY = Math.max(0.01, maxY - minY);
    const spanZ = Math.max(0.01, maxZ - minZ);
    return {
        volume: spanX * spanY * spanZ,
        surface: Math.max(0.01, surface),
        shortestSpan: Math.min(spanX, spanY, spanZ),
    };
};

/**
 * 面积加权的平均吸声率。
 *
 * 每个三角形的材质在 `materials` 里，`triangleMaterials` 给的是那张表的索引。
 * 三个频段（约 400 Hz / 2.5 kHz / 15 kHz）各算一个，最后取算术平均 ——
 * 原生那边的 ReverbStage 只有一个阻尼参数，没有分频段，取平均是它能吃下的形状。
 */
const meanAbsorption = (world: RoomGeometry, materials: readonly AcousticMaterial[]): number => {
    if (materials.length === 0) return 0.2;
    let weighted = 0;
    let total = 0;
    for (const mesh of world.meshes) {
        const positions = mesh.positions;
        const indices = mesh.indices;
        const perTriangle = mesh.triangleMaterials;
        for (let i = 0, t = 0; i + 2 < indices.length; i += 3, t += 1) {
            const a = indices[i] * 3;
            const b = indices[i + 1] * 3;
            const c = indices[i + 2] * 3;
            const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
            const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
            const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            const area = 0.5 * Math.hypot(nx, ny, nz);
            if (!(area > 0)) continue;
            const material = materials[perTriangle[t] ?? 0] ?? materials[0];
            const bands = material?.absorption ?? [0.2, 0.2, 0.2];
            const bandMean = (bands[0] + bands[1] + bands[2]) / 3;
            weighted += area * bandMean;
            total += area;
        }
    }
    return total > 0 ? weighted / total : 0.2;
};

/**
 * 把场景换算成混响参数。场景没有可用几何时返回 null，调用方照旧走干声。
 *
 * `output` 影响湿声电平：耳机下房间感可以更明显一点，音箱下要收着，否则
 * 扬声器的直达声和混响声叠在一起会糊。
 */
export const estimateRoomReverb = (
    world: RoomGeometry,
    materials: readonly AcousticMaterial[],
    output: RoomRequest['output'],
): RoomReverbEstimate | null => {
    const size = measure(world);
    if (!size) return null;

    const absorption = clamp(meanAbsorption(world, materials), 0.02, 0.95);

    // Sabine 在强吸声房间里高估混响时间：ᾱ 超过 0.3 换成 Eyring。
    const rt60 = absorption >= EYRING_THRESHOLD
        ? SABINE_CONSTANT * size.volume / (-size.surface * Math.log(1 - absorption))
        : SABINE_CONSTANT * size.volume / (size.surface * absorption);

    // 预延迟：最近的一面反射墙到耳朵的往返时间。包围盒最短边的一半当距离。
    const preDelayMs = clamp((size.shortestSpan * 0.5) / SPEED_OF_SOUND * 1000, 0, PRE_DELAY_MAX_MS);

    // 阻尼跟吸声率走：越吸声的房间高频掉得越快（地毯、绒布正是这样）。
    const damping = clamp(0.12 + absorption * 0.55, DAMPING_MIN, DAMPING_MAX);

    // 干湿比跟厅的大小走。小房间（几个立方米）几乎不该有湿声，大厅可以多一点。
    // 0.18 到 0.52 之间插值，对数尺度：体积翻十倍才多一点点。
    const mix = clamp(0.18 + Math.log10(1 + size.volume / 10) * 0.16, MIX_MIN, MIX_MAX);

    // 湿声电平：耳机下 -3 dB，音箱下 -5 dB（叠在直达声上更明显）。
    const roomLevelDb = output === 'headphones' ? -3 : -5;

    return {
        rt60Seconds: clamp(rt60, RT60_MIN, RT60_MAX),
        mix,
        damping,
        preDelayMs,
        roomLevelDb,
        room: {
            volume: size.volume,
            surface: size.surface,
            meanAbsorption: absorption,
            shortestSpan: size.shortestSpan,
        },
    };
};

/**
 * 把估值写进音频控制台的混响设置 —— 这是安卓上真正让它响的那一步。
 *
 * 原生播放走 ExoPlayer → AudioTrack，Web Audio 那张图根本不在那条路上，
 * 所以这里不接 ConvolverNode，走的是「音频控制台 → nativeEqualizer → 原生
 * ReverbStage」这条已有的同步通道（用户手动调的混响也走它）。
 *
 * 只在**场景声学开着、且用户没自己开混响**时调用：用户手调过的混响设置不该被
 * 场景悄悄改掉。
 */
export const applyRoomReverbToConsole = (estimate: RoomReverbEstimate): void => {
    // 动态 import：这条路径只在场景里有声音时走到，不该让播放内核在启动时就依赖它。
    void import('../../stores/useAudioConsoleStore').then(({ useAudioConsoleStore }) => {
        useAudioConsoleStore.getState().setReverb({
            enabled: true,
            rt60: estimate.rt60Seconds,
            mix: estimate.mix,
            damping: estimate.damping,
            preDelayMs: estimate.preDelayMs,
            roomLevelDb: estimate.roomLevelDb,
        });
    }).catch((error: unknown) => {
        console.warn('[SceneSound] could not hand the room estimate to the native reverb', error);
    });
};

/** 场景声学关掉时把混响还原成关（只动它自己开过的那次）。 */
export const clearRoomReverbFromConsole = (): void => {
    void import('../../stores/useAudioConsoleStore').then(({ useAudioConsoleStore }) => {
        useAudioConsoleStore.getState().setReverb({ enabled: false });
    }).catch(() => {});
};

