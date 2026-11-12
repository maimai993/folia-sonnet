import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWithRetry } from '../../../src/components/visualizer/backgrounds/particles/coverLoader';

// 粒子背景的封面重试（#294）。
// QQ 的封面地址是临时签名 URL，偶尔 403 / 超时，一次拿不到不该就整场没有封面。
// 这几条盯的是重试的**形状**：失败几次、退避多久、最后有没有告诉调用方。

interface FakeLoader {
    load: (
        url: string,
        onLoad: (resource: { dispose: () => void }) => void,
        onProgress: undefined,
        onError: (error: unknown) => void,
    ) => unknown;
}

/** 一个按剧本失败的加载器：`outcomes[i]` 决定第 i 次调用是成功还是失败。 */
const scripted = (outcomes: Array<'ok' | 'fail'>) => {
    const calls: string[] = [];
    const loader: FakeLoader = {
        load: (_url, onLoad, _progress, onError) => {
            const index = calls.length;
            calls.push(_url);
            const outcome = outcomes[index] ?? 'fail';
            // 同步回调就够了：被测代码的分支判断不依赖微任务时序。
            if (outcome === 'ok') onLoad({ dispose: () => {} });
            else onError(new Error(`attempt ${index + 1} failed`));
        },
    };
    return { loader, calls };
};

describe('粒子背景：封面重试', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('第一次就成功时不重试', () => {
        const { loader, calls } = scripted(['ok']);
        const done = vi.fn();
        loadWithRetry(loader, 'https://example.test/cover.jpg', done);
        expect(calls).toHaveLength(1);
        expect(done).toHaveBeenCalledTimes(1);
    });

    it('失败后按 400ms / 800ms / 1.6s 退避重试', () => {
        const { loader, calls } = scripted(['fail', 'fail', 'fail', 'ok']);
        const done = vi.fn();
        loadWithRetry(loader, 'https://example.test/cover.jpg', done, 3);

        // 第 1 次已经发生，接下来三次分别在 400 / 800 / 1600 ms 之后。
        expect(calls).toHaveLength(1);
        vi.advanceTimersByTime(400);
        expect(calls).toHaveLength(2);
        vi.advanceTimersByTime(800);
        expect(calls).toHaveLength(3);
        vi.advanceTimersByTime(1600);
        expect(calls).toHaveLength(4);
        expect(done).toHaveBeenCalledTimes(1);
    });

    it('重试用尽时回调 onFail(exhausted)，不会无限重试', () => {
        const { loader, calls } = scripted(['fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
        const fail = vi.fn();
        loadWithRetry(loader, 'https://example.test/cover.jpg', () => {}, 3, fail);

        vi.advanceTimersByTime(10_000);
        // 1 次首发 + 3 次重试 = 4 次，之后不再发起。
        expect(calls).toHaveLength(4);
        expect(fail).toHaveBeenCalledWith('exhausted');
        expect(fail).toHaveBeenCalledTimes(1);
    });

    it('空地址直接失败，不去打网络', () => {
        const { loader, calls } = scripted(['ok']);
        const fail = vi.fn();
        loadWithRetry(loader, '', () => {}, 3, fail);
        expect(calls).toHaveLength(0);
        expect(fail).toHaveBeenCalledWith('empty-url');
    });

    it('重试途中取消，之后既不再请求也不回调', () => {
        const { loader, calls } = scripted(['fail', 'fail', 'ok']);
        const done = vi.fn();
        const cancel = loadWithRetry(loader, 'https://example.test/cover.jpg', done, 3);
        expect(calls).toHaveLength(1);
        cancel();
        vi.advanceTimersByTime(10_000);
        expect(calls).toHaveLength(1);
        expect(done).not.toHaveBeenCalled();
    });

    it('失败次数记在日志里，事后查得到', () => {
        const { loader } = scripted(['fail', 'fail', 'fail', 'fail']);
        loadWithRetry(loader, 'https://example.test/cover.jpg', () => {}, 3, () => {});
        vi.advanceTimersByTime(10_000);
        const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
            .map(args => String(args[0]))
            .join('\n');
        expect(warned).toContain('4 attempts');
        expect(warned).toContain('https://example.test/cover.jpg');
    });
});
