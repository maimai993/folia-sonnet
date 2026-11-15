// main.cjs — 模组市场的 Node 端。
//
// 为什么下载和解压在 Node 侧：渲染端拿不到任意磁盘路径，而「下载 → 装进 mods 目录」
// 需要落盘。于是这里负责三件渲染端做不了的事：
//   1. 拉官方市场的 catalog.json（带 ETag 与本地缓存，断网时退回缓存）；
//   2. 把 .zip 下到本模组的缓存目录，并且**先核对 SHA-256**（catalog 里写的是文件哈希）
//      再交给宿主安装器——哈希不对的包不会被写进 mods；
//   3. 扫 userData/mods 下每个模组的 mod.json，把已装版本报给界面，用来算「可更新」。
//
// 真正的解压 / 暂存 / 原子替换交给宿主自己的 installModFromZip（folia-mods:install-zip）：
// 它已经做了 zip-slip 防护、体积上限、暂存目录校验和失败回滚，重写一遍只会更差。
// 本文件不写 mods 目录、不删任何模组、不碰 mod-system.json。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG_ORIGIN = 'https://folium-compound.cielaniska.top';
const CATALOG_URL = `${CATALOG_ORIGIN}/catalog.json`;
const CATALOG_FORMAT = 'folium-market-catalog';

// 与宿主的安装上限一致：超过 64MB 的包宿主也不会收，提前拒掉省一次下载。
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 120000;
// catalog 的 Cache-Control 是 300 秒，本地缓存比它稍长一点，避免每次开面板都打一次网。
const LOCAL_TTL_MS = 10 * 60 * 1000;
const MOD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readJson = (file) => {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
        return null;
    }
};

const writeJson = (file, value) => {
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
    fs.renameSync(temp, file);
};

// 只认 /downloads/ 下的包，且必须是本站域名：catalog 被篡改也换不成别的上游。
const resolveDownloadUrl = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) {
        return null;
    }
    let url;
    try {
        url = new URL(raw, CATALOG_ORIGIN);
    } catch {
        return null;
    }
    if (url.origin !== CATALOG_ORIGIN || !url.pathname.startsWith('/downloads/')) {
        return null;
    }
    return url.toString();
};

const normalizeEntry = (entry) => {
    if (!isObject(entry) || !MOD_ID_PATTERN.test(String(entry.id ?? ''))) {
        return null;
    }
    const download = isObject(entry.download) ? entry.download : null;
    const url = resolveDownloadUrl(download?.url);
    if (!download || !url) {
        return null;
    }
    const preview = isObject(entry.preview) ? entry.preview : null;
    return {
        id: String(entry.id),
        name: String(entry.name ?? entry.id).slice(0, 120),
        version: String(entry.version ?? '0.0.0'),
        author: entry.author ? String(entry.author).slice(0, 120) : '',
        description: String(entry.description ?? ''),
        origin: entry.origin === 'official' ? 'official' : 'community',
        channel: entry.channel === 'beta' ? 'beta' : 'release',
        keyLabel: entry.keyLabel ? String(entry.keyLabel) : '',
        keyId: entry.keyId ? String(entry.keyId) : '',
        signedAt: entry.signedAt ? String(entry.signedAt) : '',
        permissions: Array.isArray(entry.permissions) ? entry.permissions.filter((id) => typeof id === 'string') : [],
        experimental: Array.isArray(entry.experimental) ? entry.experimental.filter((id) => typeof id === 'string') : [],
        depends: Array.isArray(entry.depends) ? entry.depends.filter((id) => typeof id === 'string') : [],
        embedOrigins: Array.isArray(entry.embedOrigins) ? entry.embedOrigins.filter((id) => typeof id === 'string') : [],
        folia: entry.folia ? String(entry.folia) : null,
        hasMain: entry.hasMain === true,
        network: entry.hasMain === true,
        owners: Array.isArray(entry.owners) ? entry.owners.filter((name) => typeof name === 'string') : [],
        source: entry.source ? String(entry.source) : '',
        path: entry.path ? String(entry.path) : '',
        download: {
            url,
            fileName: download.fileName ? String(download.fileName) : `${entry.id}-${entry.version}.zip`,
            size: Number(download.size) || 0,
            sha256: String(download.sha256 ?? '').toLowerCase(),
        },
        preview: preview?.url
            ? { url: new URL(preview.url, CATALOG_ORIGIN).toString(), width: Number(preview.width) || 0, height: Number(preview.height) || 0 }
            : null,
        page: `${CATALOG_ORIGIN}/#mod-${entry.id}`,
    };
};

module.exports = function activate(api) {
    // 用来算 userData：mods-cache/<id> 的上两级就是 userData（api.storage.paths 的布局）。
    let userDataDir = null;
    let cacheDir = null;
    // 进行中的请求，模组停用时一起 abort，免得关掉面板后还在写盘。
    const inflight = new Set();

    const ensureDirs = () => {
        if (!cacheDir) {
            cacheDir = api.storage.paths.cache;
            userDataDir = path.dirname(path.dirname(cacheDir));
        }
        return cacheDir;
    };

    const userModsDir = () => {
        ensureDirs();
        return path.join(userDataDir, 'mods');
    };

    const catalogCacheFile = () => path.join(ensureDirs(), 'catalog.json');

    const track = (controller) => {
        inflight.add(controller);
        return () => inflight.delete(controller);
    };

    /* ---------------------------------------------------------------- catalog */

    const readCachedCatalog = () => {
        const cached = readJson(catalogCacheFile());
        if (!isObject(cached) || !isObject(cached.catalog) || !Array.isArray(cached.catalog.mods)) {
            return null;
        }
        return {
            catalog: cached.catalog,
            etag: typeof cached.etag === 'string' ? cached.etag : '',
            fetchedAt: Number(cached.fetchedAt) || 0,
        };
    };

    const shapeCatalog = (catalog, extra) => ({
        ok: true,
        format: String(catalog.format ?? ''),
        version: Number(catalog.version) || 0,
        commit: catalog.commit ? String(catalog.commit) : '',
        repository: catalog.repository ? String(catalog.repository) : '',
        mods: catalog.mods.map(normalizeEntry).filter(Boolean),
        ...extra,
    });

    const fetchCatalog = async ({ force } = {}) => {
        const cached = readCachedCatalog();
        const fresh = cached && !force && Date.now() - cached.fetchedAt < LOCAL_TTL_MS;
        if (fresh) {
            return shapeCatalog(cached.catalog, {
                source: 'cache',
                stale: false,
                fetchedAt: cached.fetchedAt,
                etag: cached.etag,
            });
        }

        const controller = new AbortController();
        const untrack = track(controller);
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const headers = { accept: 'application/json' };
            // 有 ETag 就问一句 304，命中时连响应体都不必读。
            if (cached?.etag) {
                headers['if-none-match'] = cached.etag;
            }
            const response = await fetch(CATALOG_URL, { headers, signal: controller.signal, cache: 'no-store' });

            if (response.status === 304 && cached) {
                writeJson(catalogCacheFile(), { ...cached, fetchedAt: Date.now() });
                return shapeCatalog(cached.catalog, {
                    source: 'cache',
                    stale: false,
                    fetchedAt: Date.now(),
                    etag: cached.etag,
                });
            }
            if (!response.ok) {
                throw new Error(`catalog-http-${response.status}`);
            }

            const text = await response.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                throw new Error('catalog-not-json');
            }
            if (!isObject(parsed) || parsed.format !== CATALOG_FORMAT || !Array.isArray(parsed.mods)) {
                throw new Error('catalog-unexpected-format');
            }

            const etag = response.headers.get('etag') || '';
            const fetchedAt = Date.now();
            writeJson(catalogCacheFile(), { catalog: parsed, etag, fetchedAt });
            return shapeCatalog(parsed, { source: 'network', stale: false, fetchedAt, etag });
        } catch (error) {
            const code = controller.signal.aborted ? 'catalog-timeout' : String(error?.message || error);
            api.log.warn(`拉取 catalog 失败：${code}`);
            // 有新有旧都先给旧的：断网时市场不该整页空白。
            if (cached) {
                return shapeCatalog(cached.catalog, {
                    source: 'cache',
                    stale: true,
                    fetchedAt: cached.fetchedAt,
                    etag: cached.etag,
                    error: code,
                });
            }
            return { ok: false, error: code, mods: [] };
        } finally {
            clearTimeout(timer);
            untrack();
        }
    };

    /* -------------------------------------------------------------- installed */

    // 一个目录里可能多套一层（下载后手动解压的常见形态），和宿主的发现规则一致。
    const resolveModRoot = (dir) => {
        if (fs.existsSync(path.join(dir, 'mod.json'))) {
            return dir;
        }
        let children = [];
        try {
            children = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return dir;
        }
        const candidates = children
            .filter((child) => child.isDirectory() && !child.name.startsWith('.'))
            .map((child) => path.join(dir, child.name))
            .filter((child) => fs.existsSync(path.join(child, 'mod.json')));
        return candidates.length === 1 ? candidates[0] : dir;
    };

    const readInstalled = () => {
        const dir = userModsDir();
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return { ok: true, directory: dir, mods: [] };
        }
        const mods = [];
        entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .forEach((entry) => {
                const root = resolveModRoot(path.join(dir, entry.name));
                const manifest = readJson(path.join(root, 'mod.json'));
                if (!isObject(manifest) || !MOD_ID_PATTERN.test(String(manifest.id ?? ''))) {
                    return;
                }
                mods.push({
                    id: String(manifest.id),
                    version: String(manifest.version ?? ''),
                    name: String(manifest.name ?? manifest.id),
                    author: manifest.author ? String(manifest.author) : '',
                    preview: manifest.preview ? String(manifest.preview) : null,
                    folder: entry.name,
                    directory: root,
                });
            });
        return { ok: true, directory: dir, mods };
    };

    /* --------------------------------------------------------------- download */

    const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

    const packagePath = (id, version) => {
        const safeVersion = String(version).replace(/[^0-9A-Za-z.+_-]/g, '_').slice(0, 32) || '0';
        return path.join(ensureDirs(), 'packages', `${id}-${safeVersion}.zip`);
    };

    /*
     * 下载一个模组包到本模组缓存目录，校验 catalog 里声明的 SHA-256。
     * 返回绝对路径，界面再把这个路径交给宿主的安装器。校验不过就删掉，绝不落到 mods。
     */
    const downloadPackage = async ({ id, url, sha256, version } = {}) => {
        if (!MOD_ID_PATTERN.test(String(id ?? ''))) {
            return { ok: false, error: 'market-bad-id' };
        }
        const target = resolveDownloadUrl(url);
        if (!target) {
            return { ok: false, error: 'market-bad-url' };
        }
        const expected = String(sha256 ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expected)) {
            return { ok: false, error: 'market-no-checksum' };
        }

        const file = packagePath(id, version);
        // 同一个包重复点「安装」时不必再下一次。
        try {
            const existing = fs.readFileSync(file);
            if (existing.length <= MAX_ARCHIVE_BYTES && sha256Of(existing) === expected) {
                return { ok: true, path: file, size: existing.length, cached: true };
            }
        } catch {
            // 没有就当没命中
        }

        const controller = new AbortController();
        const untrack = track(controller);
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        try {
            const response = await fetch(target, {
                headers: { accept: 'application/zip,application/octet-stream' },
                signal: controller.signal,
                redirect: 'follow',
            });
            if (!response.ok) {
                return { ok: false, error: `download-http-${response.status}` };
            }
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
                return { ok: false, error: 'install-too-large' };
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length === 0) {
                return { ok: false, error: 'download-empty' };
            }
            if (buffer.length > MAX_ARCHIVE_BYTES) {
                return { ok: false, error: 'install-too-large' };
            }
            const actual = sha256Of(buffer);
            if (actual !== expected) {
                api.log.warn(`下载的包哈希不符：${id}，期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
                return { ok: false, error: 'download-checksum-mismatch' };
            }

            fs.mkdirSync(path.dirname(file), { recursive: true });
            // 先写 .part 再改名：中途失败不会留一个看起来完整的 zip。
            const temp = `${file}.part`;
            fs.writeFileSync(temp, buffer);
            fs.renameSync(temp, file);
            api.log.info(`已下载 ${id} v${version}（${buffer.length} 字节，哈希已核对）`);
            return { ok: true, path: file, size: buffer.length, cached: false };
        } catch (error) {
            return { ok: false, error: controller.signal.aborted ? 'download-timeout' : String(error?.message || error) };
        } finally {
            clearTimeout(timer);
            untrack();
        }
    };

    /*
     * 安装成功后顺手清掉缓存里的包：zip 已经解到 mods 里，留着只是占地方。
     * 装失败时保留，方便重试时命中缓存（哈希对得上就直接复用）。
     */
    const dropPackage = ({ path: file } = {}) => {
        if (typeof file !== 'string' || !file.toLowerCase().endsWith('.zip')) {
            return { ok: false, error: 'market-bad-path' };
        }
        const root = path.join(ensureDirs(), 'packages');
        if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) {
            return { ok: false, error: 'market-outside-cache' };
        }
        try {
            fs.rmSync(file, { force: true });
            return { ok: true };
        } catch {
            return { ok: false, error: 'market-drop-failed' };
        }
    };

    const prunePackages = () => {
        const root = path.join(ensureDirs(), 'packages');
        let entries = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return { ok: true, removed: 0 };
        }
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let removed = 0;
        entries.forEach((entry) => {
            if (!entry.isFile()) {
                return;
            }
            const full = path.join(root, entry.name);
            try {
                if (fs.statSync(full).mtimeMs < cutoff) {
                    fs.rmSync(full, { force: true });
                    removed += 1;
                }
            } catch {
                // 清缓存是顺手的，失败就算了
            }
        });
        return { ok: true, removed };
    };

    /* ------------------------------------------------------------------- rpc */

    api.rpc.handle('market.catalog', (options) => fetchCatalog({ force: options?.force === true }));
    api.rpc.handle('market.installed', () => readInstalled());
    api.rpc.handle('market.download', (request) => downloadPackage(request ?? {}));
    api.rpc.handle('market.dropPackage', (request) => dropPackage(request ?? {}));
    api.rpc.handle('market.prune', () => prunePackages());

    // 进面板时把过期包清一次，别让缓存无限长。
    api.onDispose(() => {
        inflight.forEach((controller) => {
            try {
                controller.abort();
            } catch {
                // 已经结束了
            }
        });
        inflight.clear();
    });

    api.log.info(`模组市场已就绪，缓存目录 ${ensureDirs()}`);
    prunePackages();
};
