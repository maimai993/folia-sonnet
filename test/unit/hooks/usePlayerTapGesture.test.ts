// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayerTapGesture, type PlayerTapGestureBinding } from '../../../src/hooks/usePlayerTapGesture';
import { DOUBLE_TAP_MS } from '../../../src/utils/doubleTap';

// test/unit/hooks/usePlayerTapGesture.test.ts
// 播放页双击暂停的时序：第一下单击要等双击窗口过去才执行，窗口内的第二下取消它。
//
// 真机上只看得见最后暂停没有，看不出「第一下的控件显隐有没有被压住」；这里用假时钟
// 把几次点击之间的先后钉住。

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let binding: PlayerTapGestureBinding | null = null;
let taps = 0;
let doubles = 0;

const Probe = ({ enabled }: { enabled: boolean }) => {
    binding = usePlayerTapGesture({
        enabled,
        onTap: () => {
            taps += 1;
        },
        onDoubleTap: () => {
            doubles += 1;
        },
    });
    return null;
};

const mount = async (enabled: boolean) => {
    await act(async () => {
        root.render(createElement(Probe, { enabled }));
    });
};

const click = (x = 100, y = 100) => {
    act(() => {
        binding?.onClick({ clientX: x, clientY: y, stopPropagation: () => {} });
    });
};

const advance = async (ms: number) => {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
};

beforeEach(() => {
    vi.useFakeTimers();
    taps = 0;
    doubles = 0;
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
    vi.useRealTimers();
});

describe('usePlayerTapGesture', () => {
    it('第一次点击先压住，窗口过去才执行单击', async () => {
        await mount(true);
        click();

        expect(taps).toBe(0);
        await advance(DOUBLE_TAP_MS);
        expect(taps).toBe(0);
        await advance(1);
        expect(taps).toBe(1);
        expect(doubles).toBe(0);
    });

    it('窗口内的第二下算双击，不再补第一下的单击', async () => {
        await mount(true);
        click();
        click();

        expect(doubles).toBe(1);
        expect(taps).toBe(0);
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(0);
    });

    it('正好卡在窗口边上的第二下也算双击', async () => {
        await mount(true);
        click();
        await advance(DOUBLE_TAP_MS);
        click();

        expect(doubles).toBe(1);
        expect(taps).toBe(0);
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(0);
    });

    it('第二下离得远就是两次单击，各执行一次', async () => {
        await mount(true);
        click(100, 100);
        click(200, 200);

        expect(doubles).toBe(0);
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(2);
    });

    it('第二下来晚了就是两次单击', async () => {
        await mount(true);
        click();
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(1);

        click();
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(2);
        expect(doubles).toBe(0);
    });

    it('滑动重置会丢掉滑动前压着的那一下', async () => {
        await mount(true);
        click();
        act(() => {
            binding?.resetTapSequence();
        });
        click();

        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(1);
        expect(doubles).toBe(0);
    });

    it('关掉时不延迟，单击立即执行', async () => {
        await mount(false);
        click();

        expect(taps).toBe(1);
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(1);
    });

    it('中途关掉会取消还没执行的单击', async () => {
        await mount(true);
        click();
        await mount(false);

        expect(taps).toBe(0);
        await advance(DOUBLE_TAP_MS + 1);
        expect(taps).toBe(0);
    });
});
