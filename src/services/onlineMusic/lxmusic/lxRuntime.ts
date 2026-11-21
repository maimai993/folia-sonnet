// src/services/onlineMusic/lxmusic/lxRuntime.ts
// 洛雪自定义音源的运行环境：复刻 LX 桌面端暴露给脚本的 `globalThis.lx` API，并提供音源取歌用的
// `lxRequest`（拿播放地址 / 歌词 / 封面的那条 HTTP 通路）。
//
// 实测要点（照真实音源脚本踩出来的）：
//   · 很多音源是**异步初始化**的：先 await 探测几个接口，过几百毫秒才 send('inited')。
//     所以不能「脚本函数跑完就立刻取 sources」，必须等 ready。
//   · 混淆过的音源把 lx 写成 globalThis['\x6c\x78']，初始化期间还会再次读 globalThis.lx。
//   · utils.crypto.aesEncrypt / utils.zlib 是真实存在的 API，缺了脚本会直接抛错。
//
// 安全说明（H17/C2）：脚本**不再**在主线程里跑。`loadLxSource` 现在转到 lxSourceSandbox.ts ——
// 脚本在一个专用 Web Worker 里执行，手里只有一张能力清单，请求统统经主线程代发。这个文件留下的
// 是「取歌的那条 HTTP 通路」和沙箱与主线程共用的几个小工具（lxUtils.ts），主线程本身不再执行
// 任何来自脚本的代码。

import type { LxLoadedSource, LxSourceMeta } from './lxTypes';
import { loadLxSourceInSandbox } from './lxSourceSandbox';
import { bufferApi, cryptoApi, md5, zlibApi } from './lxUtils';

export { md5, bufferApi, cryptoApi, zlibApi };
// 请求通路的实现在 lxRequest.ts（见那边的开头），这里保留原来的导出名，调用方不用改。
export { lxRequest, type LxRequestResponse, type LxRequestOptions } from './lxRequest';

const INIT_TIMEOUT_MS = 15000;

/**
 * 加载一个音源脚本。
 *
 * 实现已经搬到沙箱（lxSourceSandbox.ts）：脚本在专用 worker 里执行，请求经主线程代发，并有
 * 「不许打本机 / 内网地址」的守卫。保留这个入口是为了调用方（lxSourceStore 等）不必跟着改，
 * 返回的形状也没变。
 */
export const loadLxSource = (rawScript: string, meta: LxSourceMeta): LxLoadedSource => (
    loadLxSourceInSandbox(rawScript, meta)
);

/** 沙箱与主线程共用的初始化超时（worker 侧的兜底在 lxSourceSandboxBridge.ts）。 */
export const LX_INIT_TIMEOUT_MS = INIT_TIMEOUT_MS;
