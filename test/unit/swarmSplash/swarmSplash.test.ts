import { describe, expect, it } from 'vitest';
import { buildBlueprint } from '@/components/swarmSplash/swarmBlueprint';
import { createSwarm, releaseSwarm, stepSwarm } from '@/components/swarmSplash/swarmPhysics';

// test/unit/swarmSplash/swarmSplash.test.ts
// 启动动画的两个纯逻辑层：物理（群体不能发散、不能越界失控）与蓝图（块都落在视口里）。
// 绘制与 canvas 循环要真浏览器，见 test/render 的手动预览。

describe('群体光标物理', () => {
    it('推进几秒后整群都还在目标附近，不会发散', () => {
        const field = createSwarm({ count: 20, radius: 120, spawn: { width: 800, height: 600 } }, { x: 400, y: 300 });
        for (let step = 0; step < 240; step += 1) stepSwarm(field, 1 / 60, 120);

        for (const cursor of field.cursors) {
            const distance = Math.hypot(cursor.x - 400, cursor.y - 300);
            // 轨道半径最大约 120×1.18×1.3 + 120×0.55 ≈ 250，留一倍余量。
            expect(distance).toBeLessThan(600);
            expect(Number.isFinite(cursor.x)).toBe(true);
            expect(Number.isFinite(cursor.y)).toBe(true);
        }
    });

    it('目标点移动时整群跟着走', () => {
        const field = createSwarm({ count: 12, radius: 100, spawn: { width: 800, height: 600 } }, { x: 100, y: 100 });
        for (let step = 0; step < 120; step += 1) stepSwarm(field, 1 / 60, 100);

        // 目标搬到远处，再跑足够久。
        field.target = { x: 700, y: 500 };
        for (let step = 0; step < 300; step += 1) stepSwarm(field, 1 / 60, 100);

        const centers = field.cursors.map(cursor => Math.hypot(cursor.x - 700, cursor.y - 500));
        const average = centers.reduce((sum, value) => sum + value, 0) / centers.length;
        expect(average).toBeLessThan(600);
    });

    it('撤离最终把所有光标送出屏幕', () => {
        const field = createSwarm({ count: 10, radius: 80, spawn: { width: 400, height: 400 } }, { x: 200, y: 200 });
        let remaining = field.cursors.length;
        for (let step = 0; step < 600 && remaining > 0; step += 1) {
            remaining = releaseSwarm(field, 1 / 60, 400, 400);
        }
        expect(remaining).toBe(0);
    });

    it('钳住 dt 上限之外的大跳不会把坐标算成 NaN', () => {
        const field = createSwarm({ count: 6, radius: 100, spawn: { width: 800, height: 600 } }, { x: 400, y: 300 });
        stepSwarm(field, 0.05, 100);
        for (const cursor of field.cursors) {
            expect(Number.isFinite(cursor.x)).toBe(true);
            expect(Number.isFinite(cursor.y)).toBe(true);
        }
    });
});

describe('建造蓝图', () => {
    it('每一块都落在视口里', () => {
        for (const size of [{ width: 360, height: 720 }, { width: 800, height: 1280 }, { width: 1440, height: 900 }]) {
            for (const block of buildBlueprint(size)) {
                expect(block.x).toBeGreaterThanOrEqual(0);
                expect(block.y).toBeGreaterThanOrEqual(0);
                expect(block.x + block.width).toBeLessThanOrEqual(size.width + 1);
                expect(block.y + block.height).toBeLessThanOrEqual(size.height + 1);
                expect(block.width).toBeGreaterThan(0);
                expect(block.height).toBeGreaterThan(0);
            }
        }
    });

    it('窄屏上中央块不会大到盖住整个屏幕', () => {
        const narrow = buildBlueprint({ width: 320, height: 640 });
        const main = narrow[0];
        expect(main.width).toBeLessThan(320);
    });
});
