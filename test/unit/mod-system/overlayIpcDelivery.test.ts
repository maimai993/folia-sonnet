import { describe, expect, it, vi } from 'vitest';
import path from 'path';

// test/unit/mod-system/overlayIpcDelivery.test.ts
// overlay 页面 → 主进程这条通路（issue H18）。
//
// 背景：`dispatch` 靠 `contents.get(windowId)` 取 sender，而写 contents 的那个方法全仓库没有
// 调用方，于是 `if (sender === null) return;` 把每一条页面消息都静默丢掉 —— 症状是「窗口能收到
// 主进程推送，但页面里点什么都没反应」，且没有任何日志。
//
// Java 侧修好 sender 之后还有第二半：模组的 `ipcMain.on` 注册在 Node 那边，Java 不认通道，
// 所以要把消息交给 host 的 electron-shim 去投。那个投递函数就是这里测的对象。

const shimPath = path.resolve('android/app/src/main/assets/folia-node/electron-shim.cjs');

type Shim = {
    deliverIpcToMain: (raw: unknown, warn?: (message: string) => void) => boolean;
    ipcMain: { on: (channel: string, fn: (...args: unknown[]) => void) => void; removeAllListeners: () => void };
    BrowserWindow: new (options?: Record<string, unknown>) => {
        webContents: { __windowId?: number };
        isDestroyed: () => boolean;
        __id?: number;
    };
    __windows?: Map<number, unknown>;
};

const loadShim = (): Shim => {
    // 每个用例都拿一份干净的替身，避免监听器互相串味。
    const resolved = require.resolve(shimPath);
    delete require.cache[resolved];
    return require(resolved) as Shim;
};

describe('overlay 页面 → 主进程投递（H18）', () => {
    it('投给 ipcMain 时 sender 就是那个窗口的 webContents', () => {
        const shim = loadShim();
        // 直接往 shim 的 windows 表里放一个窗口替身，模拟「窗口已经建好」。
        const windows = (shim as unknown as { __testWindows: Map<number, unknown> }).__testWindows;
        expect(windows).toBeDefined();

        const fakeWindow = {
            destroyed: false,
            isDestroyed: () => false,
            webContents: { __windowId: 42, send: vi.fn() },
        };
        windows!.set(42, fakeWindow);

        const received: { sender: unknown; payload: unknown }[] = [];
        shim.ipcMain.on('ping', (event: unknown, payload: unknown) => {
            received.push({ sender: (event as { sender: unknown }).sender, payload });
        });

        const ok = shim.deliverIpcToMain(JSON.stringify({ id: 42, channel: 'ping', payload: { n: 1 } }));

        expect(ok).toBe(true);
        expect(received).toHaveLength(1);
        // 模组普遍写 `event.sender === win.webContents`，必须是同一个对象。
        expect(received[0].sender).toBe(fakeWindow.webContents);
        expect(received[0].payload).toEqual({ n: 1 });
    });

    it('窗口已经销毁时丢弃并留一条 warn，而不是静默', () => {
        const shim = loadShim();
        const windows = (shim as unknown as { __testWindows: Map<number, unknown> }).__testWindows;
        const warn = vi.fn();

        const ok = shim.deliverIpcToMain(JSON.stringify({ id: 999, channel: 'ping', payload: {} }), warn);

        expect(windows).toBeDefined();
        expect(ok).toBe(false);
        expect(warn).toHaveBeenCalled();
        // 关键：日志里要能看出是哪个窗口、哪个通道。
        expect(String(warn.mock.calls[0][0])).toContain('999');
        expect(String(warn.mock.calls[0][0])).toContain('ping');
    });

    it('载荷解析不了时返回 false，不抛', () => {
        const shim = loadShim();
        const warn = vi.fn();
        expect(shim.deliverIpcToMain('not json', warn)).toBe(false);
        expect(warn).toHaveBeenCalled();
    });
});
