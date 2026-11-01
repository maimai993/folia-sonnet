import { createAiFetch } from './aiNativeFetch';
import { createNativeFetch } from './nativeHttpFetch';
import { resolveCloudApiUrl, resolveCloudBaseUrl } from './foliaCloud';
import { saveToCache } from './db';

// src/services/fontMarket.ts
// 字体市场的客户端：拉目录、看预览、按需取字体文件。
//
// 流量是这里唯一的设计约束。目录里每条字体只带一张**后台上传时就烤好的预览图**
// （几 KB 的 PNG），播放器**不下载字体文件**就能看到这字体长什么样；只有用户点
// 「使用」才去取那几 MB 的字体本体，取回来顺手落进本地缓存，重启也不用再下一遍。
//
// 目录是公开只读接口。上架 / 下架 / 改名一律走后台那个带登录的面板。

const REQUEST_TIMEOUT_MS = 15_000;

/** 与「本地上传字体」共用同一个落盘槽位，冷启动的恢复流程因此原样可用。 */
const UPLOADED_LYRICS_FONT_KEY = 'lyrics_uploaded_font';

export interface FontMarketFont {
    id: string;
    name: string;
    family: string;
    category: string;
    categoryLabel: string;
    license: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    fileUrl: string;
    previewUrl: string;
    /** 预览图宽高比。图片还没到时先按这个比例撑住位置，免得加载完顶一下。 */
    previewAspect: number;
    enabled: boolean;
    sort: number;
    createdAt: string;
    updatedAt: string;
}

export interface FontMarketSelection {
    id: string;
    family: string;
    label: string;
    previewUrl: string;
}

export type FontMarketInstallResult = FontMarketSelection & {
    /**
     * 字体字节（base64）。
     *
     * 壁纸 / 叠层那两层是自绘的，读不到网页注册的 FontFace —— 谁要把字体
     * 交给原生层，就用这一份。它已经在内存里了，不必再下一遍。
     */
    base64: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
);

const asText = (value: unknown, fallback = ''): string => (
    typeof value === 'string' ? value : (value === undefined || value === null ? fallback : String(value))
);

const absoluteUrl = (value: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${resolveCloudBaseUrl()}${raw.startsWith('/') ? '' : '/'}${raw}`;
};

/** 预览图地址：目录里带的是相对路径，这里补上云服务地址。 */
export const resolveFontPreviewUrl = (font: Pick<FontMarketFont, 'previewUrl'>): string => (
    absoluteUrl(font.previewUrl)
);

const registeredFonts = new Map<string, FontFace>();
const registeredFamilies = new Set<string>();

const getFontFaceConstructor = () => (globalThis as typeof globalThis & {
    FontFace?: new (family: string, source: BufferSource | string) => FontFace;
}).FontFace;

/** 注册字体字节，返回可直接写进 CSS 的 family。重复安装同一款不会再下第二遍。 */
const registerFontBytes = async (font: FontMarketFont, bytes: Uint8Array): Promise<string> => {
    const FontFaceConstructor = getFontFaceConstructor();
    if (!FontFaceConstructor || typeof document === 'undefined' || !document.fonts?.add) {
        return font.family;
    }

    if (registeredFamilies.has(font.family)) return font.family;

    // FontFace keeps a reference to the buffer, so hand it a private copy:
    // the caller's array is also going into IndexedDB.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);

    const face = new FontFaceConstructor(font.family, copy);
    await face.load();
    document.fonts.add(face);
    registeredFonts.set(font.id, face);
    registeredFamilies.add(font.family);
    return font.family;
};

/** 已经在本会话注册过的市场字体。 */
export const isMarketFontRegistered = (font: Pick<FontMarketFont, 'id'>): boolean => (
    registeredFonts.has(font.id)
);

const withTimeout = (timeoutMs: number): AbortSignal => {
    const controller = new AbortController();
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(() => controller.abort(), timeoutMs);
    }
    return controller.signal;
};

export interface FontMarketResult {
    fonts: FontMarketFont[];
    error: 'offline' | 'server' | null;
    /** 服务端过滤后的总条数，不是这一页的条数。 */
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

const emptyResult = (error: FontMarketResult['error']): FontMarketResult => ({
    fonts: [],
    error,
    total: 0,
    page: 1,
    pageSize: 0,
    hasMore: false,
});

/** 老服务端还没有分页字段时，就拿这一页的条数当总数，界面不至于算出「0 款」。 */
const readCount = (value: unknown, fallback: number): number => (
    Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : fallback
);

const mapFont = (value: unknown): FontMarketFont | null => {
    const record = asRecord(value);
    if (!record) return null;
    const id = asText(record.id).trim();
    const family = asText(record.family).trim();
    if (!id || !family) return null;
    return {
        id,
        name: asText(record.name).trim() || family,
        family,
        category: asText(record.category).trim() || 'sans',
        categoryLabel: asText(record.categoryLabel).trim() || asText(record.category).trim() || 'sans',
        license: asText(record.license),
        fileName: asText(record.fileName),
        mimeType: asText(record.mimeType),
        fileSize: Number(record.fileSize ?? 0) || 0,
        fileUrl: asText(record.fileUrl),
        previewUrl: asText(record.previewUrl),
        previewAspect: Number(record.previewAspect ?? 0) || 0,
        enabled: record.enabled !== false,
        sort: Number(record.sort ?? 0) || 0,
        createdAt: asText(record.createdAt),
        updatedAt: asText(record.updatedAt),
    };
};

const fetchFonts = async (url: string): Promise<FontMarketResult> => {
    try {
        const response = await createAiFetch()(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: withTimeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return emptyResult('server');
        const data = await response.json().catch(() => null) as {
            fonts?: unknown;
            total?: unknown;
            page?: unknown;
            pageSize?: unknown;
            hasMore?: unknown;
        } | null;
        const fonts = Array.isArray(data?.fonts)
            ? data.fonts.map(mapFont).filter((font): font is FontMarketFont => font !== null)
            : [];
        const total = readCount(data?.total, fonts.length);
        return {
            fonts,
            error: null,
            total,
            page: Math.max(1, readCount(data?.page, 1)),
            pageSize: readCount(data?.pageSize, fonts.length),
            hasMore: data?.hasMore === true || (fonts.length > 0 && fonts.length < total),
        };
    } catch {
        return emptyResult('offline');
    }
};

export interface FontMarketQuery {
    page?: number;
    pageSize?: number;
    /** 'all' 或空 = 不过滤。 */
    category?: string;
    q?: string;
}

/**
 * 拉一页目录。断网 / 服务端坏了都只是「列表为空」，不弹错。
 *
 * 分类和关键字交给服务端筛：分页之后前端手上只有一页，在前端筛等于只在这一页里筛。
 */
export const fetchFontMarket = async (query: FontMarketQuery = {}): Promise<FontMarketResult> => {
    const params = new URLSearchParams();
    if (query.page && query.page > 1) params.set('page', String(Math.trunc(query.page)));
    if (query.pageSize && query.pageSize > 0) params.set('pageSize', String(Math.trunc(query.pageSize)));
    if (query.category && query.category !== 'all') params.set('category', query.category);
    const needle = query.q?.trim();
    if (needle) params.set('q', needle);
    const suffix = params.toString();
    return fetchFonts(`${resolveCloudApiUrl('fonts')}${suffix ? `?${suffix}` : ''}`);
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    const CHUNK = 0x8000;
    let binary = '';
    for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
    }
    return btoa(binary);
};

/**
 * 安装一款市场字体：下载 → 注册 FontFace → 落盘。
 *
 * 落盘用的就是「上传字体」那一个槽位，于是冷启动时
 * `restoreUploadedLyricsFont(fontId)` 能把它重新注册回来 —— 市场字体和本地上传的
 * 字体在播放器眼里是同一件事，只是来路不同。
 *
 * 字体文件是二进制，必须走 `createNativeFetch`：安卓的 `aiRequest` 只回字符串，
 * 原生那边把字节转成文本再交回来，字体就损坏了。目录 JSON 仍走 `createAiFetch`。
 */
export const installMarketFont = async (font: FontMarketFont): Promise<FontMarketInstallResult> => {
    const response = await createNativeFetch(REQUEST_TIMEOUT_MS)(absoluteUrl(font.fileUrl), {
        method: 'GET',
        signal: withTimeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`字体下载失败（HTTP ${response.status}）`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const family = await registerFontBytes(font, bytes);
    const mimeType = font.mimeType || 'font/ttf';
    const fileName = font.fileName || `${font.name}.ttf`;

    await saveToCache(UPLOADED_LYRICS_FONT_KEY, {
        id: font.id,
        name: fileName,
        mimeType,
        blob: new Blob([bytes], { type: mimeType }),
        family,
        label: font.name,
        createdAt: Date.now(),
    });

    return {
        id: font.id,
        family,
        label: font.name,
        previewUrl: resolveFontPreviewUrl(font),
        base64: bytesToBase64(bytes),
    };
};

/** 面板地址，给「去后台看看」这类入口用。 */
export const resolveFontMarketAdminUrl = (): string => `${resolveCloudBaseUrl()}/admin`;

// ------------------------------------------------------------------ 本机选择

const CHOICE_STORAGE_KEY = 'foliaFontMarketChoice';

/**
 * 本机当前用着的是哪款市场字体。
 *
 * 只存元信息，不存字节 —— 字节在 `lyrics_uploaded_font` 那个缓存槽里，
 * 冷启动时由现有的「恢复上传字体」流程重新注册。
 */
export const readFontMarketChoice = (): FontMarketSelection | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(CHOICE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FontMarketSelection>;
        if (!parsed?.id || !parsed?.family) return null;
        return {
            id: String(parsed.id),
            family: String(parsed.family),
            label: String(parsed.label ?? parsed.family),
            previewUrl: String(parsed.previewUrl ?? ''),
        };
    } catch {
        return null;
    }
};

export const writeFontMarketChoice = (choice: FontMarketSelection | null): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        if (!choice) localStorage.removeItem(CHOICE_STORAGE_KEY);
        else localStorage.setItem(CHOICE_STORAGE_KEY, JSON.stringify(choice));
    } catch {
        // Quota or private mode: the in-memory font still applies this session.
    }
};
