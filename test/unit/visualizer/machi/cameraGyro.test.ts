import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MACHI_CAMERA_LIMITS, MachiCamera } from '@/components/visualizer/machi/engine/camera';

// test/unit/visualizer/machi/cameraGyro.test.ts
// 町景相机上的陀螺仪偏移：关着时收不到读数、开着时读数这一帧就贴上去（相机不再自己追一遍）、
// 关掉后缓回零而不是瞬跳、俯仰叠加后仍夹在拖拽的范围里。

const DEG = Math.PI / 180;
const HOME = { azimuth: 30 * DEG, elevation: 31 * DEG, zoom: 1.5 };

const create = () => {
    const camera = new MachiCamera();
    camera.setAspect(1600, 900);
    const points = [-6, 6].flatMap(x => [-6, 6].flatMap(z => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 6, z)]));
    camera.setFraming({ points, view: { ...HOME } }, null);
    return camera;
};

/** 跑若干帧，返回每一帧的方位偏移（度）。 */
const run = (camera: MachiCamera, frames: number) => {
    const path: number[] = [];
    for (let frame = 0; frame < frames; frame += 1) {
        camera.update(1 / 30, 1 / 30);
        path.push(camera.offset().azimuth);
    }
    return path;
};

describe('MachiCamera gyro', () => {
    it('ignores readings while the toggle is off', () => {
        const camera = create();
        camera.setGyroOffsets({ azimuth: 10 * DEG, elevation: 5 * DEG });
        run(camera, 5);
        expect(camera.offset().azimuth).toBeCloseTo(0, 6);
        expect(camera.offset().elevation).toBeCloseTo(0, 6);
    });

    it('puts a reading on screen in the very frame it arrives', () => {
        /*
         * ★ 相机这一侧不再有「往里追」的第二段平滑：读数已经过死区与一阶低通
         * （backgrounds/gyroTilt.ts）。再追一遍就是两条指数串起来，倾斜手机时画面
         * 会慢半拍 —— 那是 issue #429 的「迟滞」。
         */
        const camera = create();
        camera.setGyro(true);
        const target = 8 * DEG;
        camera.setGyroOffsets({ azimuth: target, elevation: 0 });
        const [first] = run(camera, 1);
        expect(first!).toBeCloseTo(target / DEG, 3);
        // 之后一直停在那儿，不漂。
        run(camera, 30);
        expect(camera.offset().azimuth).toBeCloseTo(target / DEG, 3);
    });

    it('eases back to the resting view when the toggle goes off', () => {
        const camera = create();
        camera.setGyro(true);
        camera.setGyroOffsets({ azimuth: 9 * DEG, elevation: 0 });
        // 淡入淡出那 0.35 秒按 1/30 秒一帧算约 11 帧，先让它贴到位再关。
        run(camera, 15);
        const settled = camera.offset().azimuth;
        expect(settled).toBeCloseTo(9, 3);
        camera.setGyro(false);
        // 第一帧还在回去的路上，不是一下子归零。
        const [first] = run(camera, 1);
        expect(Math.abs(first!)).toBeGreaterThan(0);
        expect(Math.abs(first!)).toBeLessThan(Math.abs(settled));
        run(camera, 120);
        expect(Math.abs(camera.offset().azimuth)).toBeLessThan(0.02);
    });

    it('keeps the elevation inside the drag range it was clamped to', () => {
        const camera = create();
        camera.setGyro(true);
        // 远超范围的一仰：叠加后必须还夹在 maxElevation 里。
        camera.setGyroOffsets({ azimuth: 0, elevation: 45 * DEG });
        run(camera, 120);
        expect(camera.view().elevation).toBeLessThanOrEqual(MACHI_CAMERA_LIMITS.maxElevation + 1e-9);
        expect(camera.view().elevation).toBeLessThan(HOME.elevation + 45 * DEG);
    });

    it('keeps following the gyro after the view was adjusted by hand', () => {
        const camera = create();
        camera.setGyro(true);
        // 手动调过视角并固定下来（存成自定义视角）。此后镜头不会自己回机位，
        // 以前这条路上陀螺仪的偏移再也摆不上去，画面就不跟着倾斜了。
        camera.setCustom({ azimuth: 12, elevation: 5, zoom: 1.2, panX: 0, panZ: 0 });
        run(camera, 10);
        const before = camera.offset().azimuth;
        camera.setGyroOffsets({ azimuth: 6 * DEG, elevation: 0 });
        run(camera, 2);
        // 自定义视角还在，陀螺仪的 6° 也叠了上去。
        expect(camera.offset().azimuth).toBeCloseTo(before + 6, 2);
        // 偏移归零后回到自定义视角本身。
        camera.setGyroOffsets({ azimuth: 0, elevation: 0 });
        run(camera, 120);
        expect(camera.offset().azimuth).toBeCloseTo(before, 1);
    });
});
