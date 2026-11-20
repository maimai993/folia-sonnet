// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// test/unit/visualizer/pixiRuntimeHostOwnership.test.ts
// Pixi 宿主的运行时归属（issue H14）。
//
// 以前的 cleanup 写 `createdRuntime ?? runtimeRef.current`：靠这个 `??` 兜住「运行时创建晚于
// 宿主销毁」的情况。能兜住，但读代码的人无法确认「到底谁负责销毁」——而这条路径被四个
// 渲染器（商籁、凝彩、绘光、花火）共用，一次漏销毁就是一块 WebGL 上下文和它的纹理池。
//
// 这里钉住那条真正重要的契约：create 在 abort 之后仍然 resolve 时，它拿到的那个运行时
// **必须被销毁**，而且只销毁一次。

import { useVisualizerPixiHost } from '@/components/visualizer/pixi/pixiRuntimeHost';

type FakeRuntime = { id: number };

const destroyed: number[] = [];
let nextId = 1;

/** 每次 create 都返回一个受控的 promise，由用例决定什么时候 resolve。 */
const pendingCreates: ((runtime: FakeRuntime) => void)[] = [];

const create = () => new Promise<FakeRuntime>(resolve => {
    pendingCreates.push(resolve);
});

const Harness = ({ label }: { label: string }) => {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    useVisualizerPixiHost<FakeRuntime, string>({
        hostRef,
        label,
        song: 'a',
        create: (host) => {
            // 宿主必须真的挂在 DOM 上，create 才有地方挂 canvas。
            expect(host).toBeTruthy();
            return create();
        },
        swap: async () => undefined,
        destroy: runtime => {
            destroyed.push(runtime.id);
        },
        rebuildKey: [],
    });
    return React.createElement('div', { ref: hostRef });
};

describe('Pixi 宿主的运行时归属（H14）', () => {
    let root: Root | null = null;
    let container: HTMLDivElement | null = null;

    const mount = (label: string) => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root!.render(React.createElement(Harness, { label }));
        });
    };

    afterEach(() => {
        destroyed.length = 0;
        pendingCreates.length = 0;
        if (root) {
            act(() => root!.unmount());
            root = null;
        }
        if (container) {
            container.remove();
            container = null;
        }
    });

    it('create 在宿主销毁之后才 resolve，运行时仍被销毁', async () => {
        mount('h14-late-resolve');
        expect(pendingCreates).toHaveLength(1);

        // 先在 create 还没 resolve 的时候卸载 —— 这正是「创建晚于销毁」的顺序。
        act(() => root!.unmount());
        root = null;
        // 它没有东西可销毁（运行时还不存在），所以此刻销毁列表应当是空的。
        expect(destroyed).toHaveLength(0);

        // 现在 create 才 resolve。
        const runtime: FakeRuntime = { id: nextId++ };
        await act(async () => {
            pendingCreates[0](runtime);
            // 让 then 里的销毁跑完。
            await Promise.resolve();
        });

        expect(destroyed).toEqual([runtime.id]);
    });
});
