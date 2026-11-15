import { describe, expect, it } from 'vitest';
import { estimateRoomReverb } from '../../../src/services/sceneSound/roomEstimate';
import type { AcousticMaterial } from '../../../src/services/sceneSound/acousticsTypes';

// 影厅声学的安卓实现：从场景几何算出混响参数。
// 这几条测的是「量出来的房间对不对」和「公式在边界上不炸」。

type RoomGeometry = Parameters<typeof estimateRoomReverb>[0];

const hard: AcousticMaterial = { absorption: [0.05, 0.05, 0.05], scattering: 0.05, transmission: [0.1, 0.1, 0.1] };
const soft: AcousticMaterial = { absorption: [0.8, 0.85, 0.8], scattering: 0.6, transmission: [0.05, 0.02, 0.01] };

/** 一个 width × height × depth 的盒子，六个面各两个三角形，全部用同一种材质。 */
const box = (width: number, height: number, depth: number, materialIndex = 0): RoomGeometry => {
    const x = width / 2;
    const y = height / 2;
    const z = depth / 2;
    const corners: Array<[number, number, number]> = [
        [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
        [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
    ];
    const faces = [
        [0, 1, 2], [0, 2, 3],
        [4, 6, 5], [4, 7, 6],
        [0, 4, 5], [0, 5, 1],
        [3, 2, 6], [3, 6, 7],
        [0, 3, 7], [0, 7, 4],
        [1, 5, 6], [1, 6, 2],
    ];
    const positions = new Float32Array(corners.flat());
    const indices = new Uint32Array(faces.flat());
    return {
        meshes: [{
            positions,
            indices,
            triangleMaterials: new Uint16Array(faces.length).fill(materialIndex),
        }],
        materials: [],
    };
};

describe('影厅声学：场景 → 混响参数', () => {
    it('量得出一间屋子的体积与表面积', () => {
        const estimate = estimateRoomReverb(box(10, 4, 20), [hard], 'headphones');
        expect(estimate).not.toBeNull();
        expect(estimate!.room.volume).toBeCloseTo(800, 5);
        // 10x4x20 的六个面：2*(10*4) + 2*(10*20) + 2*(4*20) = 80 + 400 + 160 = 640
        expect(estimate!.room.surface).toBeCloseTo(640, 5);
        expect(estimate!.room.shortestSpan).toBeCloseTo(4, 5);
    });

    it('越吸声的房间混响越短', () => {
        const hall = box(30, 12, 45);
        const live = estimateRoomReverb(hall, [hard], 'headphones')!;
        const dry = estimateRoomReverb(hall, [soft], 'headphones')!;
        expect(dry.rt60Seconds).toBeLessThan(live.rt60Seconds);
        expect(dry.room.meanAbsorption).toBeGreaterThan(live.room.meanAbsorption);
    });

    it('越大的厅混响越长', () => {
        const small = estimateRoomReverb(box(6, 3, 8), [hard], 'headphones')!;
        const large = estimateRoomReverb(box(30, 12, 45), [hard], 'headphones')!;
        expect(large.rt60Seconds).toBeGreaterThan(small.rt60Seconds);
    });

    it('极小的房间预延迟接近零，极短的厅也不会超上限', () => {
        const tiny = estimateRoomReverb(box(2, 2, 2), [hard], 'headphones')!;
        expect(tiny.preDelayMs).toBeGreaterThanOrEqual(0);
        expect(tiny.preDelayMs).toBeLessThan(120);
        const huge = estimateRoomReverb(box(200, 200, 200), [soft], 'headphones')!;
        expect(huge.preDelayMs).toBeLessThanOrEqual(120);
        expect(huge.rt60Seconds).toBeLessThanOrEqual(10);
    });

    it('强吸声的房间走 Eyring，不会算出离谱的长混响', () => {
        // 吸声率 0.8 的软包房间：Sabine 会给出比实际长的数，Eyring 收敛得更快。
        const estimate = estimateRoomReverb(box(20, 8, 30), [soft], 'headphones')!;
        expect(estimate.room.meanAbsorption).toBeGreaterThan(0.3);
        expect(estimate.rt60Seconds).toBeGreaterThan(0);
        expect(estimate.rt60Seconds).toBeLessThan(10);
    });

    it('耳机比音箱的湿声更明显', () => {
        const hall = box(30, 12, 45);
        const headphones = estimateRoomReverb(hall, [hard], 'headphones')!;
        const speakers = estimateRoomReverb(hall, [hard], 'speakers')!;
        expect(headphones.roomLevelDb).toBeGreaterThan(speakers.roomLevelDb);
    });

    it('没有几何时返回 null，调用方照旧放干声', () => {
        expect(estimateRoomReverb({ meshes: [], materials: [] }, [hard], 'headphones')).toBeNull();
        expect(estimateRoomReverb({ meshes: [{ positions: new Float32Array(), indices: new Uint32Array(), triangleMaterials: new Uint16Array() }], materials: [] }, [hard], 'headphones')).toBeNull();
    });

    it('没有材质表也不会炸，按 0.2 的默认吸声率算', () => {
        const estimate = estimateRoomReverb(box(10, 4, 20), [], 'headphones');
        expect(estimate).not.toBeNull();
        expect(estimate!.room.meanAbsorption).toBeCloseTo(0.2, 5);
    });

    it('参数都夹在原生能接受的范围内', () => {
        for (const size of [[1, 1, 1], [10, 4, 20], [300, 100, 400]]) {
            for (const material of [hard, soft]) {
                const estimate = estimateRoomReverb(box(size[0], size[1], size[2]), [material], 'headphones')!;
                expect(estimate.rt60Seconds).toBeGreaterThanOrEqual(0.3);
                expect(estimate.rt60Seconds).toBeLessThanOrEqual(10);
                expect(estimate.mix).toBeGreaterThanOrEqual(0);
                expect(estimate.mix).toBeLessThanOrEqual(1);
                expect(estimate.damping).toBeGreaterThanOrEqual(0.02);
                expect(estimate.damping).toBeLessThanOrEqual(0.9);
                expect(estimate.preDelayMs).toBeGreaterThanOrEqual(0);
                expect(estimate.preDelayMs).toBeLessThanOrEqual(120);
            }
        }
    });
});
