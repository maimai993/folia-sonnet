// src/services/onlineMusic/lxmusic/lxSourceSandboxBridge.ts
// 沙箱里跑脚本的那一半：只给脚本「洛雪音源 API + 纯计算工具」，别的一概没有。
//
// 洛雪音源原先用 `new Function` 在主线程跑，脚本手里就是整个页面：`localStorage`（含登录态与
// 平台 cookie）、`indexedDB`、`Capacitor`（能调原生插件）、`window.electron`（桌面端主进程桥），
// 以及界面上的一切。现在脚本跑在专用 Web Worker 里（见 lxSourceSandboxWorker.ts / lxSourceSandbox.ts），
// 手里只剩下面这份清单：
//
//   · `lx.version / env / currentScriptInfo / EVENT_NAMES / request / on / send / utils` —— 与 LX 一致；
//   · 请求统一经 `postMessage` 交给主线程的 lxRequest 发出。worker 本来就拿不到页面的 cookie，
//     也不会带上它；主线程那边还会拒绝指向本机 / 内网的地址（见 lxSourceSandbox.ts 的守卫）；
//   · 纯计算工具（buffer / crypto / zlib）来自 lxUtils.ts，与主线程给的是同一份实现；
//   · 没有 `require`、没有 `process`、没有 DOM、没有 storage、没有 Capacitor / electron。
//
// 老实说清楚它挡住了什么、挡不住什么：Worker 不是权限沙箱。脚本仍然能发网络请求、仍然能占
// CPU / 内存（主线程的超时到点会把 worker 整个终止）。它做的是把「能碰到应用数据的面」收窄到
// 一张白名单，并把脚本从界面线程挪走 —— 脚本卡死不再冻结界面，脚本也读不到任何本地凭据。

import type { LxPlatformKey, LxRequestHandler, LxSourceMeta, LxSourcePlatformInfo } from './lxTypes';
import { lxUtils } from './lxUtils';

/** 主线程 → 沙箱。 */
export type LxSandboxToWorker =
    /** 装脚本：只在沙箱环境里执行这一段文本。 */
    | { type: 'load'; rawScript: string; meta: LxSourceMeta }
    /** 音源就绪后的一次取地址 / 歌词 / 封面。 */
    | { type: 'request'; id: number; payload: Parameters<LxRequestHandler>[0] }
    /** 某个 HTTP 请求的回包（或失败）。 */
    | { type: 'http-result'; id: number; ok: boolean; status?: number; statusText?: string; headers?: Record<string, string>; text?: string; error?: string }
    /** 卸载：把脚本留下的定时器与监听清掉。 */
    | { type: 'dispose' };

/** 沙箱 → 主线程。 */
export type LxSandboxFromWorker =
    /** 脚本调用了 `lx.send('inited', ...)`；脚本跑完也没发就是空表。 */
    | { type: 'inited'; sources: Partial<Record<LxPlatformKey, LxSourcePlatformInfo>> }
    /** 脚本要发一个 HTTP 请求（由主线程代发）。 */
    | { type: 'http'; id: number; url: string; options: Record<string, unknown> }
    /** 一次 request 的结果。 */
    | { type: 'result'; id: number; value: unknown }
    /** 一次 request 失败。 */
    | { type: 'request-error'; id: number; error: string }
    /** 脚本自己打的日志。 */
    | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
    /** 脚本初始化抛错。 */
    | { type: 'init-error'; error: string };

type HttpResult = Extract<LxSandboxToWorker, { type: 'http-result' }>;

const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' } as const;

/** 脚本既没 send(inited) 也没报错时的兜底：到点按「没有声明平台」处理。 */
const INIT_TIMEOUT_MS = 15000;

const errorText = (error: unknown): string => {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    try {
        return typeof error === 'string' ? error : JSON.stringify(error);
    } catch {
        return String(error);
    }
};

/** 只放行 http(s)：file: / content: / data: 在沙箱里就挡掉，主线程那层再挡内网地址。 */
const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url.trim());

/**
 * 在沙箱里装配 `globalThis.lx` 并执行脚本。
 *
 * 为什么这里仍然用 `new Function`：音源脚本就是脚本，不是模块 —— LX 生态都按「顶层
 * `const { request } = globalThis.lx`」写。worker 里没有 document，套 iframe/Realm 那条路不通；
 * 能做的隔离是「给它一个干净的全局环境」，而这份环境里没有任何应用凭据。所以关键不在执行它的
 * 那个函数，而在于它伸手能摸到什么。
 */
export const createLxSandbox = (send: (message: LxSandboxFromWorker) => void) => {
    const handlers = new Map<string, Array<(payload: unknown) => unknown>>();
    /** 脚本发出去、还没回包的请求：id → 回包回调。 */
    const pendingHttp = new Map<number, (message: HttpResult) => void>();
    let httpSeq = 0;
    let disposed = false;
    /** 脚本自己 setTimeout / setInterval 的返回，卸载时统一清掉。 */
    const timers = new Set<number>();

    /** 记下脚本排的定时器；卸载时清干净，别让它在 worker 里继续跑。 */
    const track = <T>(id: T): T => {
        timers.add(id as unknown as number);
        return id;
    };

    const lxRequest = (
        url: string,
        options: Record<string, unknown> = {},
        callback?: (err: unknown, resp?: unknown, body?: unknown) => void,
    ) => {
        const id = (httpSeq += 1);
        let cancelled = false;
        const finish = (message: HttpResult) => {
            if (cancelled) return;
            cancelled = true;
            pendingHttp.delete(id);
            if (typeof callback !== 'function') return;
            if (!message.ok) {
                callback(new Error(message.error ?? 'request failed'));
                return;
            }
            const text = message.text ?? '';
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = text;
            }
            // 与 LX 一致：响应体能 JSON.parse 就给对象，第三个参数也给它（脚本大量用 resp.body.code）。
            callback(null, {
                statusCode: message.status ?? 0,
                statusMessage: message.statusText ?? '',
                headers: message.headers ?? {},
                bytes: text.length,
                raw: text,
                body: parsed,
            }, parsed);
        };
        if (!isHttpUrl(url)) {
            // 异步回调，与真正的请求失败保持同一时序（脚本常在 Promise 里等它）。
            queueMicrotask(() => finish({ type: 'http-result', id, ok: false, error: `blocked protocol: ${url.slice(0, 32)}` }));
            return () => undefined;
        }
        pendingHttp.set(id, finish);
        send({ type: 'http', id, url, options });
        return () => {
            cancelled = true;
            pendingHttp.delete(id);
        };
    };

    const register = (event: string, handler: (payload: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
    };

    /*
     * 请求处理：与主线程版本同一套语义 —— 回调式 on('request', (p, cb) => cb(null, res)) 与
     * 返回式 on('request', async (p) => res) 都支持；多个 handler 里第一个给出结果的算数。
     * 超时按 action 给（歌词最慢），到点返回 undefined 给调用方，不让死源无限挂着。
     */
    const resolveCall = (payload: unknown): Promise<unknown> => new Promise((resolve, reject) => {
        const list = handlers.get(EVENT_NAMES.request) ?? [];
        if (list.length === 0) {
            reject(new Error('脚本没有注册 request 事件（无法取播放地址 / 歌词）。'));
            return;
        }
        const action = (payload as { action?: string } | null)?.action;
        const timeoutMs = action === 'lyric' ? 20000 : action === 'pic' ? 8000 : 12000;
        let settled = false;
        const finish = (value: unknown, failed?: string) => {
            if (settled) return;
            settled = true;
            if (failed !== undefined) reject(new Error(failed));
            else resolve(value);
        };
        track(setTimeout(() => finish(undefined), timeoutMs));
        const callback = (err: unknown, resp?: unknown) => {
            if (err) {
                send({ type: 'log', level: 'warn', text: `request handler 回调报错：${errorText(err)}` });
                finish(undefined);
                return;
            }
            finish(resp);
        };
        const runHandler = async (index: number): Promise<void> => {
            if (settled) return;
            const handler = list[index];
            if (!handler) {
                finish(undefined);
                return;
            }
            const before = list.length;
            try {
                const returned = (handler as (p: unknown, cb: unknown) => unknown)(payload, callback);
                if (returned !== undefined) {
                    const value = returned && typeof (returned as { then?: unknown }).then === 'function'
                        ? await (returned as Promise<unknown>)
                        : returned;
                    // async 包装的回调式 handler 可能先 resolve 成 undefined，别当结果。
                    if (value !== undefined && value !== null) {
                        finish(value);
                        return;
                    }
                }
            } catch (err) {
                send({ type: 'log', level: 'warn', text: `request handler 抛错：${errorText(err)}` });
                finish(undefined);
                return;
            }
            // 这个 handler 没给结果（也没回调）：交给下一个，最后一个都没有就按没有结果收场。
            if (!settled) void runHandler(Math.min(index + 1, before));
        };
        void runHandler(0);
    });

    const lx = {
        version: '1.2.0',
        // 与桌面端一致：不少音源按 env 决定走哪条加密 / 请求路径。
        env: 'desktop',
        currentScriptInfo: { name: '未命名音源' },
        EVENT_NAMES,
        request: lxRequest,
        on: (event: string, handler: (payload: unknown) => unknown) => {
            register(event, handler);
            return Promise.resolve();
        },
        send: async (event: string, data: unknown) => {
            if (event === EVENT_NAMES.inited) {
                const payload = data as { sources?: Partial<Record<LxPlatformKey, LxSourcePlatformInfo>> };
                send({ type: 'inited', sources: payload?.sources ?? {} });
            } else if (event === EVENT_NAMES.updateAlert) {
                send({ type: 'log', level: 'info', text: `source updateAlert: ${errorText(data)}` });
            }
            return undefined;
        },
        utils: lxUtils,
    };

    /** 把脚本自己的 console 转给主线程：面板的播放诊断要能看到音源吐了什么。 */
    const forwardConsole = () => {
        const forward = (level: 'info' | 'warn' | 'error') => (...args: unknown[]) => {
            send({
                type: 'log',
                level,
                text: args.map((arg) => {
                    if (typeof arg === 'string') return arg;
                    try {
                        return JSON.stringify(arg);
                    } catch {
                        return String(arg);
                    }
                }).join(' '),
            });
        };
        (globalThis as unknown as { console: unknown }).console = {
            log: forward('info'),
            info: forward('info'),
            debug: forward('info'),
            warn: forward('warn'),
            error: forward('error'),
            trace: forward('info'),
        };
    };

    return {
        /** 执行脚本。`meta` 只给脚本看（currentScriptInfo），不影响执行。 */
        start(rawScript: string, meta: LxSourceMeta) {
            lx.currentScriptInfo = { name: meta.name };
            forwardConsole();
            (globalThis as unknown as { lx?: unknown }).lx = lx;
            try {
                const runner = new Function(`"use strict";\n${rawScript}`) as () => unknown;
                const returned = runner();
                // 顶层 await 的脚本返回 Promise：初始化失败要留痕，别静默。
                if (returned && typeof (returned as { then?: unknown }).then === 'function') {
                    void (returned as Promise<unknown>).catch((err) => {
                        send({ type: 'init-error', error: errorText(err) });
                    });
                }
            } catch (err) {
                send({ type: 'init-error', error: errorText(err) });
            }
            // 脚本既没 send(inited) 也没报错：到点给个结论，调用方不能永远等着。
            track(setTimeout(() => {
                if (!disposed) send({ type: 'inited', sources: {} });
            }, INIT_TIMEOUT_MS));
        },

        async request(id: number, payload: Parameters<LxRequestHandler>[0]) {
            try {
                const value = await resolveCall(payload);
                // 音源给回来的应当是纯数据；结构化克隆不接受函数和循环引用，先过一遍 JSON。
                send({
                    type: 'result',
                    id,
                    value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
                });
            } catch (err) {
                send({ type: 'request-error', id, error: errorText(err) });
            }
        },

        settleHttp(message: HttpResult) {
            pendingHttp.get(message.id)?.(message);
        },

        dispose() {
            disposed = true;
            timers.forEach((id) => {
                try {
                    globalThis.clearTimeout(id);
                    globalThis.clearInterval(id);
                } catch {
                    // 清不掉也无所谓：整个 worker 很快就会被终止。
                }
            });
            timers.clear();
            handlers.clear();
            pendingHttp.clear();
        },
    };
};
