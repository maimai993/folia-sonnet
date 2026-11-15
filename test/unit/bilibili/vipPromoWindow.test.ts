import { describe, expect, it } from 'vitest';
import { isBilibiliVipPromoWindow } from '../../../src/components/bilibili/BilibiliVipPromoModal';

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
/*
 * 关掉之后不能自己又冒出来。
 *
 * 这一条是被真机坑出来的：组件每分钟重算一次窗口，只把 isOpen 摆成 false 的话，
 * 下一次 tick 又会算回 true —— 用户点掉弹窗，一分钟后它自己弹回来。
 * 状态机本身在组件里，这里钉的是它的判定条件：关掉了就不再进。
 */
describe('关掉之后不再自动弹回来', () => {
    const shouldOpen = (closedThisMount: boolean, now: Date, dismissed: boolean): boolean => (
        !closedThisMount && isBilibiliVipPromoWindow(now) && !dismissed
    );

    it('窗口里、没勾不再提示 —— 关掉后同一轮挂载里不再进', () => {
        expect(shouldOpen(true, new Date(2026, 10, 15, 13, 0, 0), false)).toBe(false);
    });

    it('窗口里、没关过就该进', () => {
        expect(shouldOpen(false, new Date(2026, 10, 15, 13, 0, 0), false)).toBe(true);
    });

    it('勾了不再提示就不再进', () => {
        expect(shouldOpen(false, new Date(2026, 10, 15, 13, 0, 0), true)).toBe(false);
    });
});
