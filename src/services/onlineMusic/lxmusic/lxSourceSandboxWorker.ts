// src/services/onlineMusic/lxmusic/lxSourceSandboxWorker.ts
// 音源沙箱的 worker 入口：只有这几十行 —— 装配沙箱、收消息、回消息。
//
// 这里**故意不 import 应用里的任何东西**（不能碰 store、bridge、i18n、React）：worker 的模块图越小，
// 一段第三方脚本能摸到的宿主代码就越少。唯一引入的是 lxSourceSandboxBridge（它自己只依赖 lxUtils
// 与 fflate）和两个类型。
//
// 打包方式：lxSourceSandbox.ts 用 `new Worker(new URL('./lxSourceSandboxWorker.ts', import.meta.url), { type: 'module' })`
// 起它，Vite 会把这里当独立入口打成一个模块 worker 包，跟着 WebView 一起发布。

import { createLxSandbox, type LxSandboxFromWorker, type LxSandboxToWorker } from './lxSourceSandboxBridge';

// 宿主环境里没有 DOM lib 的 DedicatedWorkerGlobalScope 类型（tsconfig 只装了 DOM），用最小形状代替。
const port = self as unknown as { postMessage: (message: unknown) => void; onmessage: ((event: MessageEvent) => void) | null };

const sandbox = createLxSandbox((message: LxSandboxFromWorker) => {
    port.postMessage(message);
});

port.onmessage = (event: MessageEvent<LxSandboxToWorker>) => {
    const message = event.data;
    switch (message.type) {
        case 'load':
            sandbox.start(message.rawScript, message.meta);
            break;
        case 'request':
            void sandbox.request(message.id, message.payload);
            break;
        case 'http-result':
            sandbox.settleHttp(message);
            break;
        case 'dispose':
            sandbox.dispose();
            break;
        default:
            break;
    }
};
