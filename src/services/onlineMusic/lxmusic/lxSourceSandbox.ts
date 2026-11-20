// src/services/onlineMusic/lxmusic/lxSourceSandbox.ts
// 主线程这一侧的沙箱宿主：起 worker、转发 HTTP、把脚本的回话翻译成 LxLoadedSource。
//
// `loadLxSource` 原来是「在主线程 new Function 跑脚本」，现在是「起一个 worker，把脚本交给它跑」。
// 对外形状没有变（仍然是 LxLoadedSource），调用方（lxSourceStore / 播放竞速）不用知道底下换了实现。
//
// 这套安排换来三件事：
//   1. **凭据面收窄**：脚本再也摸不到 localStorage / indexedDB / Capacitor / window.electron /
//      DOM —— 它只有 postMessage 出去的一份能力清单（见 lxSourceSandboxBridge.ts 开头）。
//   2. **界面不再被脚本拖住**：死循环或重活的脚本卡的是 worker，主线程照常跑。
//   3. **请求过一道闸**：脚本的每个请求都要经主线程的 lxRequest 发出，这里再加一条「不许打本机 /
//      内网地址」的判断（规则在 lxRequestGuard.ts）—— 沙箱里的脚本不该有机会去碰用户路由器、NAS、
//      开发机上的调试端口，也不该能读云端元数据服务。

import type { LxLoadedSource, LxRequestHandler, LxSourceMeta } from './lxTypes';
import { lxRequest } from './lxRequest';
import { isAllowedLxRequestUrl } from './lxRequestGuard';
import { validateLxScript } from './lxSourceParser';
import type { LxSandboxFromWorker, LxSandboxToWorker } from './lxSourceSandboxBridge';

/** 脚本初始化（收到 inited）的最长等待；worker 里还有一层 15 秒的兜底。 */
const INIT_TIMEOUT_MS = 18000;

/** 单个请求的最长等待：歌词 20 秒、封面 8 秒、取地址 12 秒，再加 5 秒余量。 */
const REQUEST_GRACE_MS = 5000;

/** 沙箱里的一次 `lx.request`，由主线程替它发。 */
const forwardHttp = (url: string, options: Record<string, unknown>, callback: (
    err: unknown,
    resp?: { status?: number; statusText?: string; headers?: Record<string, string>; text?: string },
) => void) => {
    try {
        const proxy = ((options.proxy as string | undefined) ?? '').trim();
        const target = proxy && /^https?:\/\//i.test(proxy) ? proxy : url;
        if (!isAllowedLxRequestUrl(target)) {
            callback(new Error(`blocked: ${target.slice(0, 64)} 指向本机或内网地址，音源脚本不允许访问`));
            return;
        }
        lxRequest(target, {
            method: typeof options.method === 'string' ? options.method : 'GET',
            headers: (options.headers as Record<string, string> | undefined) ?? {},
            body: options.body as string | Record<string, unknown> | FormData | undefined,
            form: options.form as Record<string, string> | undefined,
            formData: options.formData as Record<string, string | Blob> | undefined,
            timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
        }, (err, resp) => {
            if (err) {
                callback(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            callback(null, {
                status: resp?.statusCode,
                statusText: resp?.statusMessage,
                headers: resp?.headers,
                text: typeof resp?.raw === 'string' ? resp.raw : JSON.stringify(resp?.body ?? ''),
            });
        });
    } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
    }
};

type PendingRequest = { resolve: (value: unknown) => void };

/**
 * 起一个 worker 跑一段音源脚本，返回与主线程版本同形的 LxLoadedSource。
 *
 * worker 的生命周期跟着这份 loaded 走：`dispose()` 或者整份音源被卸载时 terminate 它。
 */
export const loadLxSourceInSandbox = (rawScript: string, meta: LxSourceMeta): LxLoadedSource => {
    validateLxScript(rawScript);

    // 注意：这个对象必须自始至终是同一个引用 —— 脚本可能几百毫秒后才 send('inited')。
    const sources: LxLoadedSource['sources'] = {};
    let failed: string | undefined;
    let inited = false;
    let disposed = false;
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const pending = new Map<number, PendingRequest>();
    let requestSeq = 0;

    const worker = new Worker(new URL('./lxSourceSandboxWorker.ts', import.meta.url), {
        type: 'module',
        // 名字只出现在 DevTools 里，方便认出「这是音源的 worker」。
        name: `lx-source:${meta.name}`,
    });

    const terminate = () => {
        if (disposed) return;
        disposed = true;
        try {
            worker.postMessage({ type: 'dispose' } satisfies LxSandboxToWorker);
        } catch {
            // worker 已经死了就算了。
        }
        worker.terminate();
        pending.forEach((entry) => entry.resolve(undefined));
        pending.clear();
    };

    const settleReady = () => {
        if (inited) return;
        inited = true;
        resolveReady();
    };

    worker.onmessage = (event: MessageEvent<LxSandboxFromWorker>) => {
        const message = event.data;
        switch (message.type) {
            case 'inited': {
                Object.keys(sources).forEach((key) => { delete sources[key as keyof typeof sources]; });
                Object.assign(sources, message.sources ?? {});
                if (!inited && Object.keys(sources).length === 0 && !failed) {
                    failed = '脚本没有声明任何平台（没有收到 inited 事件），可能不是有效的洛雪音源。';
                }
                settleReady();
                break;
            }
            case 'init-error':
                failed = failed ?? message.error;
                console.warn('[lx] 音源初始化失败：', message.error);
                settleReady();
                break;
            case 'http':
                forwardHttp(message.url, message.options, (err, resp) => {
                    if (disposed) return;
                    worker.postMessage(err
                        ? { type: 'http-result', id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies LxSandboxToWorker
                        : {
                            type: 'http-result',
                            id: message.id,
                            ok: true,
                            status: resp?.status ?? 0,
                            statusText: resp?.statusText ?? '',
                            headers: resp?.headers ?? {},
                            text: resp?.text ?? '',
                        } satisfies LxSandboxToWorker);
                });
                break;
            case 'result':
                pending.get(message.id)?.resolve(message.value);
                pending.delete(message.id);
                break;
            case 'request-error':
                console.warn('[lx] request 失败：', message.error);
                pending.get(message.id)?.resolve(undefined);
                pending.delete(message.id);
                break;
            case 'log':
                if (message.level === 'error') console.error('[lx]', message.text);
                else if (message.level === 'warn') console.warn('[lx]', message.text);
                else console.info('[lx]', message.text);
                break;
            default:
                break;
        }
    };

    worker.onerror = (event) => {
        // worker 自己崩了（语法错误、内存爆掉）：当作这个音源初始化失败。
        failed = failed ?? (event.message || '音源沙箱异常退出');
        console.warn('[lx] 音源沙箱异常：', event.message);
        settleReady();
    };

    const requestHandler: LxRequestHandler = (payload) => new Promise((resolve) => {
        if (disposed) {
            resolve(undefined);
            return;
        }
        const id = (requestSeq += 1);
        pending.set(id, { resolve });
        const action = (payload as { action?: string }).action;
        const timeoutMs = (action === 'lyric' ? 20000 : action === 'pic' ? 8000 : 12000) + REQUEST_GRACE_MS;
        window.setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            resolve(undefined);
        }, timeoutMs);
        worker.postMessage({ type: 'request', id, payload } satisfies LxSandboxToWorker);
    });

    worker.postMessage({ type: 'load', rawScript, meta } satisfies LxSandboxToWorker);

    // 超时兜底：worker 里也有，但 worker 卡死时它自己也发不出消息，这里必须另有一层。
    window.setTimeout(() => {
        if (!inited && !disposed) {
            if (!failed) failed = '音源初始化超时（脚本没有在 15 秒内 send(inited)）。';
            settleReady();
        }
    }, INIT_TIMEOUT_MS);

    const loaded: LxLoadedSource = {
        id: '',
        meta,
        sources,
        requestHandler,
        error: failed,
        ready: ready.then(() => {
            if (!failed && Object.keys(sources).length === 0) {
                failed = '脚本没有声明任何平台（没有收到 inited 事件），可能不是有效的洛雪音源。';
            }
            loaded.error = failed;
        }),
        dispose: terminate,
    };

    return loaded;
};
