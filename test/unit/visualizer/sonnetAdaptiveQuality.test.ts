// test/unit/visualizer/sonnetAdaptiveQuality.test.ts
// Sonnet 的帧时采样与降级判定（issue H12）。
//
// 这一层要回答的是「什么时候该降」，接在 renderFrame 上，所以必须在接线之前就把行为钉住：
// 卡顿要降、偶发掉帧不降、降到底不再降、换歌之后重新学。
//
// 判定本身复用 machi 的 stepMachiDegrade（门槛 = max(11.1ms, 刷新间隔 × 1.33)，最多 21ms；
// 连续 2 次超门槛才降一格），这里测的是 Sonnet 这一侧的封装有没有用错它。

import { describe, expect, it } from 'vitest';

import { SonnetAdaptiveQuality } from '@/components/visualizer/sonnet/adaptiveRenderScale';

/** 喂一段固定帧间隔，返回降了几格。 */
const feed = (quality: SonnetAdaptiveQuality, fastMs: number, slowMs: number, frames: number, startAt = 1000): number => {
    let now = startAt;
    // 第一帧只用来记时间锚点，不产生间隔。
    quality.sample(now, 10);
    for (let index = 0; index < frames; index += 1) {
        now += index % 2 === 0 ? fastMs : slowMs;
        quality.sample(now, 10);
    }
    return quality.steps;
};

describe('Sonnet 帧时降级判定（H12）', () => {
    it('顺滑的帧（16.7ms / 60fps）不降级', () => {
        const quality = new SonnetAdaptiveQuality();
        expect(feed(quality, 1000 / 60, 1000 / 60, 240)).toBe(0);
    });

    /*
     * 又快又卡：较快那一成是 16.7ms（门槛约 22ms），但平均被 80ms 的帧拉到 48ms。
     * 这正是低端机跑 2 倍分辨率时的样子。
     */
    it('又快又卡（一半 16.7ms、一半 80ms）会降级', () => {
        const quality = new SonnetAdaptiveQuality();
        expect(feed(quality, 1000 / 60, 80, 240)).toBeGreaterThan(0);
    });

    /*
     * 匀速的 30fps 也会降级。
     *
     * 这一点试出来才确认：`stepMachiDegrade` 的门槛是「这一帧应有的间隔 × 1.33」，
     * 但**上限写死 21ms** —— 所以哪怕机器稳定跑 30fps，30ms 也超过 21ms 那道闸，
     * 照样降。这是有意的：对 Sonnet 这种重渲染器，30fps 就是卡，不该因为「它一直这么慢」
     * 就当成正常。
     */
    it('匀速 30fps 也算卡，会降级', () => {
        const quality = new SonnetAdaptiveQuality();
        expect(feed(quality, 1000 / 30, 1000 / 30, 240)).toBeGreaterThan(0);
    });

    /*
     * 节流：检查之间至少隔 2.5 秒、且要攒够 60 个帧间隔。
     *
     * 少了这道口子，每帧都拿最近一小段去判，短促的一次抖动就会被当成卡顿。
     * 这条直接盯住节流本身：攒不够样本时，哪怕帧间隔远超门槛也不降。
     */
    it('攒不够 60 个样本时不做判定', () => {
        const quality = new SonnetAdaptiveQuality();
        let now = 1000;
        quality.sample(now, 10);
        // 40 个 50ms 的帧（远超门槛），但不到 60 个样本。
        for (let index = 0; index < 40; index += 1) {
            now += 50;
            quality.sample(now, 10);
        }
        expect(quality.steps).toBe(0);
    });

    it('攒够样本之后才看第二条件：距上次检查不足 2.5 秒也不判', () => {
        const quality = new SonnetAdaptiveQuality();
        let now = 1000;
        quality.sample(now, 10);
        /*
         * 80 个 30ms 的帧：样本够了（80 > 60），但总时长 2.4 秒 < 2.5 秒，
         * 节流的时间条件没过，仍旧不判定。
         */
        for (let index = 0; index < 80; index += 1) {
            now += 30;
            quality.sample(now, 10);
        }
        expect(quality.steps).toBe(0);
    });

    it('两个条件都过了就降', () => {
        const quality = new SonnetAdaptiveQuality();
        /*
         * 要喂够时间：判定要求「连续两次检查都超门槛」，而检查之间至少隔 2.5 秒，
         * 所以至少要 5 秒的帧才见得着第一次降级。240 帧 × 30ms = 7.2 秒。
         */
        expect(feed(quality, 1000 / 30, 1000 / 30, 240)).toBeGreaterThan(0);
    });

    it('降到底就不再降，不会变成负数档', () => {
        const quality = new SonnetAdaptiveQuality();
        let now = 1000;
        quality.sample(now, 10);
        for (let index = 0; index < 2000; index += 1) {
            now += 40;
            quality.sample(now, 2);
        }
        expect(quality.steps).toBe(2);
    });

    /*
     * 页面切走 / JS 长时间阻塞会让某两帧之间隔很久，那不是「渲染跟不上」。
     * 拿它当证据会一路降到底 —— 用户切回来发现画面糊了，却不知道为什么。
     */
    it('异常长的一帧（≥100ms）被丢掉，不算卡顿证据', () => {
        const quality = new SonnetAdaptiveQuality();
        let now = 1000;
        quality.sample(now, 10);
        for (let index = 0; index < 240; index += 1) {
            now += index % 30 === 0 ? 500 : 1000 / 60;
            quality.sample(now, 10);
        }
        expect(quality.steps).toBe(0);
    });

    it('首帧没有前一个时间点，不会误判', () => {
        const quality = new SonnetAdaptiveQuality();
        expect(quality.sample(5000, 10)).toBe(false);
        expect(quality.steps).toBe(0);
    });

    it('reset 之后重新从 0 开始学', () => {
        const quality = new SonnetAdaptiveQuality();
        expect(feed(quality, 1000 / 30, 1000 / 30, 240)).toBeGreaterThan(0);
        quality.reset();
        expect(quality.steps).toBe(0);
        /* 换歌之后画面顺滑，不该再降。 */
        expect(feed(quality, 1000 / 60, 1000 / 60, 240)).toBe(0);
    });
});
