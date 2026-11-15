// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/coverBytes.test.ts
// 「把封面交给原生」那两处（原生歌词壁纸的模糊底图、通知栏的 Bitmap）只在乎拿到像素。
// 这里钉的是**取字节那三条路的顺序**，不是图片本身：
//
//   1. 页内匿名 fetch —— 封面图床不需要 cookie，而带凭据的请求会被「回通配符」的图床
//      直接判死（带凭据时通配符不作数），那正是壁纸 / 通知栏常年没有封面的来处；
//   2. 原生 OkHttp —— 没有同源这一说，压根不下发 CORS 头的那几个 CDN 只有这条路；
//   3. 带凭据的页内请求 —— 自建服务那类「要 cookie 才给图」的地址，且没有原生桥时。

const { handlers } = vi.hoisted(() => ({
    handlers: {
        nativeAvailable: false,
        nativeFetch: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
        /** #262：原生下载那条路。`null` = 不在原生平台（桌面 / 网页）。 */
        filesystem: null as null | {
            cached: Map<string, number>;
            downloads: string[];
            failDownload?: boolean;
            /** 落盘文件的开头字节；默认给 JPEG 魔数。 */
            header?: number[];
            deleted?: string[];
        },
    },
}));

vi.mock('@/services/nativeHttpFetch', () => ({
    isNativeHttpFetchAvailable: () => handlers.nativeAvailable,
    createNativeFetch: () => (input: RequestInfo | URL, init?: RequestInit) =>
        (handlers.nativeFetch as NonNullable<typeof handlers.nativeFetch>)(String(input), init),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => handlers.filesystem !== null,
        // 测试里只关心「拿到一个可 fetch 的地址」，具体形状由 App 的 scheme 决定。
        convertFileSrc: (path: string) => `https://localhost/_capacitor_file_${path}`,
    },
    registerPlugin: () => ({}),
}));

vi.mock('@capacitor/filesystem', () => ({
    Directory: { Cache: 'CACHE' },
    Filesystem: {
        stat: async ({ path }: { path: string }) => {
            const size = handlers.filesystem?.cached.get(path);
            if (size == null) throw new Error('not found');
            return { size, uri: `file:///data/user/0/app/cache/${path}` };
        },
        mkdir: async () => undefined,
        readdir: async () => ({ files: [] }),
        deleteFile: async ({ path }: { path: string }) => {
            handlers.filesystem?.deleted?.push(path);
            handlers.filesystem?.cached.delete(path);
        },
        // 默认回 JPEG 魔数（FF D8 FF）；测试可以换成 HTML 之类。
        readFile: async () => {
            const header = handlers.filesystem?.header ?? [0xff, 0xd8, 0xff, 0xe0];
            return { data: btoa(String.fromCharCode(...header)) };
        },
        downloadFile: async ({ url, path }: { url: string; path: string }) => {
            const state = handlers.filesystem;
            if (!state) throw new Error('no filesystem');
            if (state.failDownload) throw new Error('404');
            state.downloads.push(url);
            // 一张 640×640 的 JPEG 大概这么大，够区分「有落盘」与「没落盘」。
            state.cached.set(path, 648_936);
            return { path: `/data/user/0/app/cache/${path}` };
        },
    },
}));

const { fetchCoverBytes } = await import('@/services/coverBytes');

const COVER_URL = 'https://picture.example.com/abc.jpg';

/** 一个够用的响应：被测代码只碰 ok 与 blob()。 */
const okResponse = (): Response => ({
    ok: true,
    status: 200,
    blob: async () => new Blob(['bytes'], { type: 'image/jpeg' }),
}) as unknown as Response;

/** 跨域被拦时浏览器给的就是这么一句，没有别的信息。 */
const corsFailure = (): never => {
    throw new TypeError('Failed to fetch');
};

const setFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
};

describe('fetchCoverBytes', () => {
    beforeEach(() => {
        handlers.nativeAvailable = false;
        handlers.nativeFetch = null;
        handlers.filesystem = null;
        setFetch(async () => corsFailure());
    });

    /*
     * #262：封面是几 MB 的二进位，整段过桥要在 Java heap 里再放一份 1.33× 的 base64
     * 副本。改由原生下载到缓存目录，进 WebView 的只有一张图。
     */
    it('downloads the cover natively before asking the bridge', async () => {
        handlers.filesystem = { cached: new Map(), downloads: [] };
        handlers.nativeAvailable = true;
        handlers.nativeFetch = async () => {
            throw new Error('有原生下载这条路时不该再过桥');
        };
        setFetch(async (url) => (
            url.startsWith('https://localhost/_capacitor_file_') ? okResponse() : corsFailure()
        ));

        const blob = await fetchCoverBytes(COVER_URL);

        expect(blob?.type).toBe('image/jpeg');
        expect(handlers.filesystem.downloads).toEqual([COVER_URL]);
    });

    it('reuses the file already downloaded for the same url', async () => {
        handlers.filesystem = { cached: new Map(), downloads: [] };
        setFetch(async (url) => (
            url.startsWith('https://localhost/_capacitor_file_') ? okResponse() : corsFailure()
        ));

        await fetchCoverBytes(COVER_URL);
        await fetchCoverBytes(COVER_URL);

        expect(handlers.filesystem.downloads).toEqual([COVER_URL]);
    });

    /* 自建服务那类「要 cookie 才给图」的地址下不了：Filesystem 的下载不带 WebView 的 cookie。 */
    it('still falls back to the bridge when the native download fails', async () => {
        handlers.filesystem = { cached: new Map(), downloads: [], failDownload: true };
        handlers.nativeAvailable = true;
        handlers.nativeFetch = async () => okResponse();
        setFetch(async () => corsFailure());

        const blob = await fetchCoverBytes(COVER_URL);

        expect(blob?.type).toBe('image/jpeg');
    });

    /*
     * 同一类地址更隐蔽的一种：网关不给 404，而是回一张 200 的登录页。
     * 不校验文件头就会把这张 HTML 当封面落盘、并按 URL 哈希永久复用。
     */
    it('rejects a non-image download and falls back to the bridge', async () => {
        handlers.filesystem = {
            cached: new Map(),
            downloads: [],
            deleted: [],
            // "<html>"
            header: [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e],
        };
        handlers.nativeAvailable = true;
        let bridgeUsed = false;
        handlers.nativeFetch = async () => {
            bridgeUsed = true;
            return okResponse();
        };
        setFetch(async (url) => (
            url.startsWith('https://localhost/_capacitor_file_') ? okResponse() : corsFailure()
        ));

        const blob = await fetchCoverBytes(COVER_URL);

        expect(blob?.type).toBe('image/jpeg');
        expect(bridgeUsed).toBe(true);
        // 坏文件必须删掉，否则下次还会命中它。
        expect(handlers.filesystem.deleted?.length).toBe(1);
        expect(handlers.filesystem.cached.size).toBe(0);
    });

    it('takes the in-page answer without asking the native bridge', async () => {
        handlers.nativeAvailable = true;
        handlers.nativeFetch = async () => {
            throw new Error('原生那条不该被走到');
        };
        setFetch(async () => okResponse());

        const blob = await fetchCoverBytes(COVER_URL);
        expect(blob?.type).toBe('image/jpeg');
    });

    /* 页内那一条被跨域拦掉（图床不给 CORS 头）时的退路。 */
    it('falls back to the native bridge when the page request is blocked', async () => {
        handlers.nativeAvailable = true;
        handlers.nativeFetch = async () => okResponse();
        setFetch(async () => corsFailure());

        const blob = await fetchCoverBytes(COVER_URL);
        expect(blob?.type).toBe('image/jpeg');
    });

    /*
     * 关键在这一条：**第一跳不带凭据**。带凭据的请求撞上 `Access-Control-Allow-Origin: *`
     * 会被浏览器判死（通配符在带凭据的请求里不作数），而那正是一家的图床回的东西。
     */
    it('asks for the cover without credentials on the first attempt', async () => {
        /*
         * 没有原生桥（桌面 / 网页）时页内会试两次，顺序就是这条要钉的东西：
         * 先匿名，拿不到才带凭据 —— 「要 cookie 才给图」的自建服务靠后一跳。
         */
        const seen: Array<RequestInit | undefined> = [];
        handlers.nativeAvailable = false;
        setFetch(async (_url, init) => {
            seen.push(init);
            return corsFailure();
        });

        await fetchCoverBytes(COVER_URL);

        expect(seen).toHaveLength(2);
        expect(seen[0]?.credentials).toBeUndefined();
        expect(seen[1]?.credentials).toBe('include');
    });

    /* blob: 只有页内这条路走得通，别拿它去问原生。 */
    it('reads a blob url in the page only', async () => {
        handlers.nativeAvailable = true;
        handlers.nativeFetch = async () => {
            throw new Error('原生那边不认 blob:');
        };
        setFetch(async () => okResponse());

        const blob = await fetchCoverBytes('blob:https://localhost/9f2c');
        expect(blob?.type).toBe('image/jpeg');
    });

    it('gives up quietly when nothing can fetch it', async () => {
        handlers.nativeAvailable = false;
        setFetch(async () => corsFailure());

        expect(await fetchCoverBytes(COVER_URL)).toBeNull();
    });
});
