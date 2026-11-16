// src/services/videoSources/config.ts
// TVBox 配置的解析。TVBox 的配置地址不一定是纯 JSON：常见三种形态——
// 1) 标准 JSON；
// 2) 带 `//` 注释行、尾随逗号、或单引号的"宽松 JSON"（TVBox 自己也是按字符串清洗后 parse 的，
//    所以真实配置经常不是合法 JSON，直接用 JSON.parse 会在注释行上失败）；
// 3) 一张图片（jpg/png/bmp/gif），真正的配置是图片里的一段超长 base64（"图片藏配置"）。
// 这里按 magic 判断形态，图片形态找到最长的 base64 串解码后再按前两种处理。
// 只做解析，不判断站点是否可运行——type 3（内置 spider）的站点由上层标成不可用。

import { fetchVideoBytesWithTimeout, fetchVideoText } from './net';

/** 配置里一个站点（TVBox 的 sites[] 项，只保留我们真正会用的字段）。 */
export type VideoSite = {
    key: string;
    name: string;
    /** TVBox 站点类型：0 xml cms、1 json cms、3 内置 spider、4 远程 spider 服务。 */
    type: number;
    api: string;
    searchable?: number;
    quickSearch?: number;
    hide?: number;
    ext?: unknown;
};

/** 解析后的配置：sites 一定有，其余字段按配置里有没有给。 */
export type VideoConfig = {
    sites: VideoSite[];
    /** 配置指向的 spider 包地址（`url;md5;md5value` 形态），多数配置有。 */
    spider?: string;
    /** 配置里给的直播源与解析器，保留原样，供以后接入。 */
    lives?: unknown;
    parses?: unknown;
};

const B64_RUN = /[A-Za-z0-9+/]{500,}={0,2}/g;

/** 去掉注释行与尾随逗号，把单引号键名换成双引号。只清洗不改语义。 */
const loosenJson = (raw: string): string => raw
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');

/** 试着解析成 JSON；宽松清洗后再试一次；都不行返回 null。 */
const tryParseJson = (text: string): unknown => {
    const attempts = [text, loosenJson(text)];
    for (const candidate of attempts) {
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        try {
            return JSON.parse(trimmed);
        } catch {
            // 继续下一次尝试。
        }
    }
    return null;
};

const decodeBase64 = (text: string): string | null => {
    try {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return null;
    }
};

/** 从图片字节里取配置文本：找最长的一段 base64，解出来是 JSON 就用它。 */
const configTextFromImage = async (blob: Blob): Promise<string | null> => {
    // 配置文本总是在图片尾部（藏在扫描不到的像素里），转成 latin-1 字符串后按 base64 特征找。
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let latin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        latin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const runs = latin.match(B64_RUN);
    if (!runs) return null;
    // 最长的那一段才是配置，短的可能是图片自身的块数据。
    const longest = runs.reduce((a, b) => (a.length >= b.length ? a : b));
    const text = decodeBase64(longest);
    return text && /^\s*[{[]/.test(text) ? text : null;
};

/** 把未知对象收敛成站点数组：字段类型不对就丢弃，避免脏配置把界面弄垮。 */
const readSites = (value: unknown): VideoSite[] => {
    if (!Array.isArray(value)) return [];
    const sites: VideoSite[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const key = typeof row.key === 'string' ? row.key : '';
        const name = typeof row.name === 'string' ? row.name : '';
        const api = typeof row.api === 'string' ? row.api : '';
        const type = typeof row.type === 'number' ? row.type : Number(row.type);
        if (!key || !name || !Number.isFinite(type)) continue;
        sites.push({
            key,
            name,
            type,
            api,
            searchable: typeof row.searchable === 'number' ? row.searchable : Number(row.searchable) || 0,
            quickSearch: typeof row.quickSearch === 'number' ? row.quickSearch : Number(row.quickSearch) || 0,
            hide: typeof row.hide === 'number' ? row.hide : Number(row.hide) || 0,
            ext: row.ext,
        });
    }
    return sites;
};

/** 配置对象 -> 我们的配置。sites 为空时视为解析失败，由调用方报错。 */
const fromObject = (value: unknown): VideoConfig | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const sites = readSites(row.sites);
    if (sites.length === 0) return null;
    return {
        sites,
        spider: typeof row.spider === 'string' ? row.spider : undefined,
        lives: row.lives,
        parses: row.parses,
    };
};

/**
 * 一段配置文本 -> 配置对象。
 * 先按明文 JSON（含宽松清洗），再按整段 base64——TVBox 圈里所谓的「密文配置」大多就是
 * 把整份 JSON 做了 base64（有的还带 url-safe 的 -_ 与缺省补位），解出来还是同一份结构。
 */
const decodeConfigObject = (text: string): Record<string, unknown> | null => {
    const direct = tryParseJson(text);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
    const compact = text.trim().replace(/\s+/g, '');
    if (compact.length < 24 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
    const normalised = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const decoded = decodeBase64(padded);
    if (!decoded) return null;
    const parsed = tryParseJson(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
};

/** 多仓入口：`{"urls":[{"url":"…","name":"仓库名"}]}`，配置本身不含站点表。 */
const readWarehouse = (row: Record<string, unknown>): Array<{ url: string; name: string }> => {
    if (!Array.isArray(row.urls)) return [];
    return row.urls
        .filter(item => item && typeof item === 'object')
        .map((item, at) => {
            const repo = item as Record<string, unknown>;
            const url = typeof repo.url === 'string' ? repo.url.trim() : '';
            const name = typeof repo.name === 'string' && repo.name.trim() ? repo.name.trim() : `仓库 ${at + 1}`;
            return { url, name };
        })
        .filter(repo => repo.url);
};

/** 多仓最多拉这么几个，再多就只是等超时。 */
const WAREHOUSE_LIMIT = 6;

/** 多仓入口 -> 把各仓库的站点合成一份；键重名时带上仓库名区分。 */
const loadWarehouse = async (
    repos: Array<{ url: string; name: string }>,
    signal?: AbortSignal,
): Promise<VideoConfig> => {
    const loads = repos.map(async repo => {
        try {
            const response = await fetchVideoText(repo.url, signal);
            if (!response.ok || !response.bodyText) return null;
            const object = decodeConfigObject(response.bodyText);
            if (!object) return null;
            const config = fromObject(object);
            if (!config || config.sites.length === 0) return null;
            return { repo, config };
        } catch {
            return null;
        }
    });
    const results = await Promise.all(loads);
    const sites: VideoSite[] = [];
    const used = new Set<string>();
    let spider: string | undefined;
    let lives: unknown;
    let parses: unknown;
    for (const row of results) {
        if (!row) continue;
        spider = spider ?? row.config.spider;
        lives = lives ?? row.config.lives;
        parses = parses ?? row.config.parses;
        for (const site of row.config.sites) {
            let key = site.key;
            if (used.has(key)) key = `${key}@${row.repo.name}`;
            if (used.has(key)) continue;
            used.add(key);
            sites.push({ ...site, key, name: `${row.repo.name}·${site.name}` });
        }
    }
    if (sites.length === 0) throw new Error('多仓入口里的仓库都没读到站点');
    return { sites, spider, lives, parses };
};

/**
 * 拉取并解析一份 TVBox 配置。
 * 两条路径，按结果决定用哪条：
 *   1) 先按文本取（桌面版走主进程 IPC，会跟随 302 —— 配置地址大多是导航页 302 过去的）；
 *      拿到文本先按明文 JSON、再按整段 base64 解，能解析出 sites 就直接用；
 *      解析出来是 `urls` 多仓入口，就把各仓库读回来合成一份。
 *   2) 文本这条拿不到（图片藏配置时文本是乱码，或地址只给二进制），再取原始字节按图片形态解。
 * 成功返回配置；地址不可达、内容不是配置、或 sites 解析为空时抛错，错误文本直接给界面显示。
 */
export const loadVideoConfig = async (address: string, signal?: AbortSignal): Promise<VideoConfig> => {
    const url = address.trim();
    if (!url) throw new Error('配置地址为空');

    let text: string | null = null;
    let textError = '';
    try {
        const response = await fetchVideoText(url, signal);
        if (response.ok && response.bodyText) text = response.bodyText;
        else textError = `配置地址返回 HTTP ${response.status}`;
    } catch (error) {
        textError = error instanceof Error ? error.message : String(error);
    }
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');

    if (text) {
        const object = decodeConfigObject(text);
        if (object) {
            const direct = fromObject(object);
            if (direct) return direct;
            const repos = readWarehouse(object).slice(0, WAREHOUSE_LIMIT);
            if (repos.length > 0) return loadWarehouse(repos, signal);
        }
    }

    // 文本路径不成立，按图片藏配置再试一次。
    const blob = await fetchVideoBytesWithTimeout(url);
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const magic = String.fromCharCode(...head.subarray(0, 4));
    const isImage = magic.startsWith('\xFF\xD8') || magic === '\x89PNG' || magic === 'GIF8'
        || magic === 'BM' || magic === 'RIFF';
    if (!isImage) {
        throw new Error(textError || '内容不是可识别的 TVBox 配置（sites 为空）');
    }
    const imageText = await configTextFromImage(blob);
    if (!imageText) throw new Error('这份图片里没有找到配置文本');
    const parsed = fromObject(tryParseJson(imageText));
    if (!parsed) throw new Error('内容不是可识别的 TVBox 配置（sites 为空）');
    return parsed;
};
