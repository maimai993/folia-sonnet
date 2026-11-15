import { describe, expect, it } from 'vitest';
import { isBilibiliVipPromoWindow } from '../../../src/components/modal/BilibiliVipPromoModal';

/*
 * 活动的窗口：系统本地时间 11 月 15 日 12:00 到 11 月 16 日 12:00。
 *
 * 这里只钉「什么时候该弹」这一件事 —— 弹窗本身是 UI，窗口算错才是用户真会抱怨的那类
 * 问题（要么活动期间不弹，要么过了两天还在弹）。用本地时间构造，和组件里一致。
 */

describe('bilibili 大会员活动弹窗的时间窗口', () => {
    it('窗口开始前不弹', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 15, 11, 59, 59))).toBe(false);
    });

    it('窗口开始那一刻就弹', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 15, 12, 0, 0))).toBe(true);
    });

    it('窗口中间当然弹', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 16, 3, 0, 0))).toBe(true);
    });

    it('窗口结束前一秒还弹', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 16, 11, 59, 59))).toBe(true);
    });

    it('窗口结束那一刻就不弹了', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 16, 12, 0, 0))).toBe(false);
    });

    it('过了窗口不再弹', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 17, 9, 0, 0))).toBe(false);
    });

    it('11 月 14 日不弹', () => {
        expect(isBilibiliVipPromoWindow(new Date(2026, 10, 14, 12, 0, 0))).toBe(false);
    });
});
