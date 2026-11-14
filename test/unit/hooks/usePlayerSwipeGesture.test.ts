// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
    usePlayerSwipeGesture,
    type PlayerSwipeGestureBinding,
} from '../../../src/hooks/usePlayerSwipeGesture';
import { PLAYER_SWIPE_TRIGGER_PX } from '../../../src/utils/playerSwipeGesture';

// test/unit/hooks/usePlayerSwipeGesture.test.ts
// 播放页左右滑动切歌的多指簿记。判定几何本身在 test/unit/utils/playerSwipeGesture，
// 这里钉的是 hook 层：多指同时触屏时，第一根落下的手指持有手势，别的手指不抢起点、
// 不重置触发标记、抬起不打断 —— 这些恰恰是安卓真机上「多指乱切歌」的来源，
// 且与 usePlayerTapGesture.test.ts 同一套路，不引 testing-library。

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let binding: PlayerSwipeGestureBinding | null = null;
let nexts = 0;
let prevs = 0;

const Probe = ({ enabled }: { enabled: boolean }) => {
    binding = usePlayerSwipeGesture({
        enabled,
        onNext: () => {
            nexts += 1;
        },
        onPrev: () => {
            prevs += 1;
        },
    });
    return null;
};

const mount = async (enabled: boolean) => {
    await act(async () => {
        root.render(createElement(Probe, { enabled }));
    });
};

const pointer = (id: number, x: number, y: number) =>
    ({ pointerId: id, clientX: x, clientY: y }) as unknown as ReactPointerEvent<HTMLElement>;

const down = (id: number, x: number, y: number) => {
    act(() => {
        binding?.onPointerDown(pointer(id, x, y));
    });
};

const move = (id: number, x: number, y: number) => {
    act(() => {
        binding?.onPointerMove(pointer(id, x, y));
    });
};

const up = (id: number) => {
    act(() => {
        binding?.onPointerUp(pointer(id, 0, 0));
    });
};

const cancel = (id: number) => {
    act(() => {
        binding?.onPointerCancel(pointer(id, 0, 0));
    });
};

/** 从 x 出发往左划过阈值的一整段 move（含正好压线的最后一步）。 */
const swipeLeft = (id: number, fromX: number, y: number) => {
    move(id, fromX - PLAYER_SWIPE_TRIGGER_PX / 2, y);
    move(id, fromX - PLAYER_SWIPE_TRIGGER_PX, y);
};

beforeEach(() => {
    nexts = 0;
    prevs = 0;
    binding = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
});

describe('usePlayerSwipeGesture', () => {
    it('单指左滑切下一首、右滑切上一首', async () => {
        await mount(true);
        down(1, 300, 400);
        swipeLeft(1, 300, 400);
        expect(nexts).toBe(1);
        expect(prevs).toBe(0);
        up(1);

        down(2, 300, 400);
        move(2, 300 + PLAYER_SWIPE_TRIGGER_PX, 400);
        expect(prevs).toBe(1);
        up(2);
    });

    it('第二根手指落下不抢起点：判定仍以第一根手指为准', async () => {
        // 旧实现的 bug：B 一落就把起点换成 B 的位置，A 的移动从 B 的起点算，
        // 左滑会被误判成右滑（prev）。这里 A 在 300 起手、B 在 100 落下，
        // A 划过阈值必须还是 next。
        await mount(true);
        down(1, 300, 400);
        down(2, 100, 400);
        swipeLeft(1, 300, 400);
        expect(nexts).toBe(1);
        expect(prevs).toBe(0);
    });

    it('静止手指的抖动不触发切歌', async () => {
        await mount(true);
        down(1, 300, 400);
        down(2, 80, 900);
        move(2, 84, 904);
        move(2, 76, 897);
        move(2, 82, 902);
        expect(nexts).toBe(0);
        expect(prevs).toBe(0);
    });

    it('触发后另一根手指落下并大幅移动不连切', async () => {
        // 旧实现里 B 的 down 会把 triggeredRef 抹掉，B 再一动就是第二次切歌。
        await mount(true);
        down(1, 300, 400);
        swipeLeft(1, 300, 400);
        expect(nexts).toBe(1);
        down(2, 100, 900);
        swipeLeft(2, 100, 900);
        expect(nexts).toBe(1);
        expect(prevs).toBe(0);
    });

    it('别的手指抬起不打断进行中的手势', async () => {
        // 旧实现里 B 的 up 会直接 finish，A 继续滑就断了。
        await mount(true);
        down(1, 300, 400);
        down(2, 100, 900);
        up(2);
        swipeLeft(1, 300, 400);
        expect(nexts).toBe(1);
    });

    it('别的手指的 cancel 不打断进行中的手势，tracked 手指抬起才收尾', async () => {
        await mount(true);
        down(1, 300, 400);
        down(2, 100, 900);
        cancel(2);
        swipeLeft(1, 300, 400);
        expect(nexts).toBe(1);
        up(1);
    });

    it('触发那下滑压住的 click，不会被另一根手指的落下放出来', async () => {
        await mount(true);
        down(1, 300, 400);
        swipeLeft(1, 300, 400);
        down(2, 100, 900);
        expect(binding?.consumeSuppressedClick()).toBe(true);
        expect(binding?.consumeSuppressedClick()).toBe(false);
    });

    it('新一轮手势的 down 才重置 click 压制', async () => {
        await mount(true);
        down(1, 300, 400);
        swipeLeft(1, 300, 400);
        up(1);
        expect(binding?.consumeSuppressedClick()).toBe(true);

        down(2, 300, 400);
        expect(binding?.consumeSuppressedClick()).toBe(false);
    });

    it('tracked 手指抬起后手势结束，新一轮滑动照常工作', async () => {
        // 防「卡死」：别的手指还搭在屏幕上时 tracked 手指收尾，之后不得残留旧状态。
        await mount(true);
        down(1, 300, 400);
        down(2, 100, 900);
        up(1);
        swipeLeft(2, 100, 900);
        expect(nexts).toBe(0);

        down(3, 300, 400);
        swipeLeft(3, 300, 400);
        expect(nexts).toBe(1);
    });

    it('没有手势时收到零散的 move / up / cancel 不出错也不触发', async () => {
        await mount(true);
        move(9, 300, 400);
        up(9);
        cancel(9);
        expect(nexts).toBe(0);
        expect(prevs).toBe(0);
    });

    it('关掉时整条手势失效', async () => {
        await mount(false);
        down(1, 300, 400);
        swipeLeft(1, 300, 400);
        expect(nexts).toBe(0);
        expect(prevs).toBe(0);
    });
});
