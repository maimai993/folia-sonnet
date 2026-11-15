// android/app/src/main/assets/folia-node/host.js
// 安卓端 Node 宿主：把桌面端 electron/modSystem 的模组系统搬到 nodejs-mobile 里。
//
// 它只做「胶水」：清单校验、API 组装、数据存储、守卫、签名、解压安装这些逻辑全部直接
// require 同目录 modSystem/ 下那份与桌面端逐字节相同的 .cjs，所以安卓与桌面行为一致，
// 不会出现「两套实现慢慢漂移」。这里补的是桌面端由 Electron 提供、安卓上没有的东西：
//   · app.getPath(...)      → userDataDir，由 Java 经 nativeStart 传进来
//   · safeStorage           → 没有等价物，退回「本次运行内有效」的内存态
//   · ipcRenderer           → 原生消息通道（folia_node_bridge 这个 linked binding）
//
// 与 Java 的契约（见 FoliaNodeRuntime.java）：
//   收到  channel = 'host'   payload = { id, op, args }          —— 请求
//   发出  channel = 'host'   payload = { id, ok, result | error } —— 应答
//   发出  channel = 'event'  payload = { type, ... }             —— 推送

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 原生桥。nodejs-mobile 用 NODE_MODULE_LINKED 注册，只能经 process._linkedBinding 取到；
// 拿不到时（例如在桌面上单跑本文件检查语法）退化成只打 stdout 的空壳，require 不炸。
const foliaNode = (() => {
    try {
        return process._linkedBinding('folia_node_bridge');
    } catch {
        return {
            registerChannel: () => undefined,
            emit: (channel, payload) => {
                process.stdout.write(`[folia-node] ${channel} ${payload}\n`);
            },
            ready: () => undefined,
            failure: () => undefined,
            getDataDir: () => '',
        };
    }
})();

// Node 的未捕获异常默认会调用 process.exit；在 Android 中 Node 与 WebView
// 共用一个进程，退出会触发 libhoudini/WebView 的析构竞态。把启动和异步异常
// 送回 Java 侧作为可见的降级状态，保持宿主事件循环存活。
const serializeError = (error) => (
    error && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error)
);

let startupFailure = false;
const reportUncaughtFailure = (error) => {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    if (startupFailure) return;
    startupFailure = true;
    try {
        foliaNode.failure(message);
    } catch (reportError) {
        process.stderr.write(`[folia-node] 上报未捕获异常失败：${serializeError(reportError)}\n`);
    }
};
process.on('uncaughtException', reportUncaughtFailure);
process.on('unhandledRejection', reportUncaughtFailure);

const MODS = path.join(__dirname, 'modSystem');

const {
    validateManifest,
    resolveLoadPlan,
} = require(path.join(MODS, 'manifest.cjs'));
const { createModApi, createModDataStore } = require(path.join(MODS, 'modApi.cjs'));
const {
    resolveModStorageDirs,
    measureDirectoryBytes,
    clearDirectoryContents,
} = require(path.join(MODS, 'modFiles.cjs'));
const { createModGuard } = require(path.join(MODS, 'guard.cjs'));
const { computeModDigest, shortDigest } = require(path.join(MODS, 'modDigest.cjs'));
const { verifyModSignature } = require(path.join(MODS, 'modSignature.cjs'));
const { createModSecrets } = require(path.join(MODS, 'modSecrets.cjs'));
const { createNetFetch } = require(path.join(MODS, 'netFetch.cjs'));
const { createZipInstall } = require(path.join(MODS, 'zipInstall.cjs'));
const shared = require(path.join(MODS, 'foliumShared.json'));

const FOLIUM_VERSION = shared.version;
const MANIFEST_NAME = 'mod.json';

// --------------------------------------------------------------------- 路径布局

/*
 * 必须与桌面端一致，因为模组市场靠 dirname(dirname(api.storage.paths.cache))
 * 反推 userData，再拼 mods/ 去数已装模组：
 *   filesDir/folia-userdata/          ← userDataDir（Java 传进来）
 *     mods/<id>/                      ← 已装模组
 *     mods-data/<id>/files/           ← api.storage.paths.data
 *     mods-cache/<id>/                ← api.storage.paths.cache
 *     mod-system.json                 ← 启用状态与信任摘要
 */
const userDataDir = (() => {
    const fromNative = foliaNode.getDataDir();
    if (typeof fromNative === 'string' && fromNative.length > 0) {
        return fromNative;
    }
    return path.join(os.homedir(), 'folia-userdata');
})();

const modsRoot = path.join(userDataDir, 'mods');
const settingsPath = path.join(userDataDir, 'mod-system.json');

fs.mkdirSync(modsRoot, { recursive: true });

// --------------------------------------------------------------------- 日志 / 应答

const safeJson = (value) => {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
};

const send = (channel, payload) => {
    try {
        foliaNode.emit(channel, JSON.stringify(payload));
    } catch (error) {
        process.stderr.write(`[folia-node] emit 失败：${serializeError(error)}\n`);
    }
};

const emitLog = (level, message, details) => {
    let detailText = '';
    if (details !== undefined) {
        try {
            detailText = ` ${JSON.stringify(details)}`;
        } catch {
            detailText = ` ${String(details)}`;
        }
    }
    const line = `[ModSystem] ${message}${detailText}`;
    if (level === 'error') {
        process.stderr.write(`${line}\n`);
    } else {
        process.stdout.write(`${line}\n`);
    }
    send('event', { type: 'log', level, message: String(message), details: details ?? null, at: Date.now() });
};

// --------------------------------------------------------------------- 设置

const readSettings = () => {
    try {
        const text = fs.readFileSync(settingsPath, 'utf8');
        // 别的工具写出来的 JSON 可能带 BOM，先剥掉再解析。
        const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        // 首次启动或文件损坏：都当空设置，不影响启动。
    }
    return { mods: {} };
};

const settings = readSettings();
if (!settings.mods || typeof settings.mods !== 'object') {
    settings.mods = {};
}
// 模组系统总开关。桌面端由主进程持有（settings 里的 MOD_SYSTEM_ENABLED），
// 这里跟着存一份，好让宿主自己知道「该不该跑模组」——UI 关掉总开关时下面那个
// isEnabled 会连带把每个模组都判成未启用，loadAll() 于是真的把运行时卸掉。
if (typeof settings.systemEnabled !== 'boolean') {
    settings.systemEnabled = true;
}

const writeSettings = () => {
    try {
        const temp = `${settingsPath}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8');
        fs.renameSync(temp, settingsPath);
    } catch (error) {
        emitLog('warn', `写入模组设置失败：${serializeError(error)}`);
    }
};

/*
 * 内置模组默认就是开着的：随包发出去的那几个，本来就是应用的一部分，
 * 让用户装完先去列表里一个个点开没有意义。
 *
 * 只影响「用户从没表过态」的情况 —— settings 里一旦有记录（无论开着还是关着），
 * 一律以记录为准，所以用户手动关掉之后不会被下一次启动又打开。
 */
const BUILTIN_MOD_IDS = new Set(['mod-market', 'vinyl-disc', 'visualizer-jump', 'listening-archive']);

const isEnabled = (modId) => {
    // 总开关关着的时候，单个模组的开关是「关是关，开也是关」—— 桌面端同理：
    // 总开关决定「要不要加载模组系统」，单个开关只在系统开着时才有意义。
    if (settings.systemEnabled !== true) return false;
    const record = settings.mods[modId];
    if (record) return record.enabled === true;
    return BUILTIN_MOD_IDS.has(modId);
};

const writeEnabled = (modId, enabled, digest) => {
    settings.mods[modId] = { enabled: enabled === true, digest: digest ?? null };
    writeSettings();
};

// --------------------------------------------------------------------- 桌面端 app 替身

/*
 * 被复用的 cjs 只用到 getPath / getAppPath / isPackaged；getAppPath 指向一个不存在的
 * 目录，让 discovery/approval 里「开发源目录」的判断自然为假。
 */
/*
 * 设备指标（CPU / 内存 / 温度）由原生侧采样后推到 `device-metrics` 通道，这里存最新一份。
 * 桌面端的 `app.getAppMetrics()` 是同步取的，所以只能靠这份缓存回话：拿不到（还没推第一份）
 * 时给空数组，调用方本来就按「没有数据」处理。
 */
let deviceMetrics = null;

const readDeviceMetrics = () => deviceMetrics;

/** 诊断入口：让渲染端能直接看到原生推来的原始指标（见 host.js 的 debug-metrics 请求）。 */
const getDeviceMetricsSnapshot = () => deviceMetrics;

/*
 * GPU 数据：模组（如 clock-perf-widget）用 `execFile('nvidia-smi', [...])` 取
 * GPU 占用/温度/显存/功耗，桌面端靠 NVIDIA 驱动。安卓没有 nvidia-smi，但 SoC 的
 * `gpuss` 温度是真的，GPU 占用按约定用整机 CPU 占用近似 —— 所以这里拦下这个调用，
 * 直接把它要的 CSV 拼出来（格式见 `--query-gpu=name,utilization.gpu,temperature.gpu,
 * memory.used,memory.total,power.draw --format=csv,noheader,nounits`）。
 *
 * 只替换 `nvidia-smi` 这一条命令，别的 execFile 原样放行。拿不到指标时照常回 ENOENT，
 * 模组会退到「只显示 —」，和桌面无 N 卡时的表现一致。
 */
const installNvidiaShim = () => {
    try {
        const childProcess = require('child_process');
        const originalExecFile = childProcess.execFile;
        if (typeof originalExecFile !== 'function' || originalExecFile.__foliaShim) return;
        const patched = function execFile(file, ...rest) {
            const name = String(file || '').toLowerCase();
            if (!name.includes('nvidia-smi')) return originalExecFile.call(this, file, ...rest);
            // 参数形如 (args, options, callback) 或 (args, callback)。
            const args = Array.isArray(rest[0]) ? rest[0] : [];
            const callback = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
            const snapshot = readDeviceMetrics();
            if (!callback) return originalExecFile.call(this, file, ...rest);
            if (!snapshot) {
                // 还没采到：按「命令不存在」回，模组会把它当成没有 GPU 数据。
                const error = new Error('nvidia-smi: not available on this device');
                error.code = 'ENOENT';
                setTimeout(() => callback(error, ''), 0);
                return undefined;
            }
            // 六列依次是：名字、占用%、温度、显存已用、显存总量、功耗。
            // 安卓给不出显存和功耗，留空（模组解析成 null，界面显示 —）。
            const util = typeof snapshot.gpuUtilPct === 'number' ? snapshot.gpuUtilPct : 0;
            const temp = typeof snapshot.gpuTempC === 'number' ? snapshot.gpuTempC : null;
            const line = [snapshot.gpuName || 'Android SoC', util, temp === null ? '' : temp, '', '', ''].join(', ');            setTimeout(() => callback(null, `${line}\n`), 0);
            return undefined;
        };
        patched.__foliaShim = true;
        childProcess.execFile = patched;
    } catch (error) {
        emitLog('warn', `nvidia-smi 替身安装失败：${serializeError(error)}`);
    }
};

/*
 * `require('electron')` 的替身。
 *
 * 模组的 main 入口基本都是给 Electron 主进程写的，一上来就 `require('electron')` 拿 app。
 * 安卓没有这个模块，不拦的话 `require` 直接 MODULE_NOT_FOUND，模组的 activate 立刻失败
 * （表现为 `rpc-not-found:<方法>`：handler 根本没注册上）。
 *
 * 这里给一个和桌面端同形的对象。目前只实现了 `app`；窗口相关的成员
 * （BrowserWindow / ipcMain / screen …）留给用到它们的模组再补，缺的成员给 undefined
 * 而不是抛错，这样「只需要 app」的模组（比如性能卡片）能先跑起来。
 */
const installElectronShim = (shim) => {
    try {
        const Module = require('module');
        if (Module.__foliaElectronShim) return;
        const originalLoad = Module._load;
        Module._load = function load(request, parent, isMain) {
            if (request === 'electron') return shim;
            return originalLoad.call(this, request, parent, isMain);
        };
        Module.__foliaElectronShim = true;
    } catch (error) {
        emitLog('warn', `electron 替身安装失败：${serializeError(error)}`);
    }
};

/*
 * overlay 请求：Node → Java（`overlay` 通道），Java 回 `overlay-result`。
 *
 * 窗口的创建 / 几何 / 显隐 / 穿透要求「发出去就生效」，所以走独立通道，
 * 不和渲染端那条 host 请求-应答混在一起。
 */
const pendingOverlay = new Map();
let overlaySeq = 0;

const callOverlay = (op, args = {}) => new Promise((resolve, reject) => {
    const id = `ov-${++overlaySeq}`;
    const timer = setTimeout(() => {
        pendingOverlay.delete(id);
        reject(new Error(`overlay request timed out: ${op}`));
    }, 8000);
    pendingOverlay.set(id, { resolve, reject, timer });
    try {
        // 用 emit 而不是 send：send 会再包一层 JSON。
        foliaNode.emit('overlay', JSON.stringify({ id, op, args }));
    } catch (error) {
        clearTimeout(timer);
        pendingOverlay.delete(id);
        reject(error);
    }
});

const settleOverlayResult = (payload) => {
    let message;
    try {
        message = JSON.parse(payload);
    } catch {
        return;
    }
    const pending = pendingOverlay.get(message && message.id);
    if (!pending) return;
    pendingOverlay.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false) {
        pending.reject(new Error(String(message.error || 'overlay-failed')));
    } else {
        pending.resolve(message.result || {});
    }
};

/** 把 `app` 与窗口替身合成 `require('electron')` 要的那份模块对象。 */
const buildElectronModule = () => {
    const shim = require('./electron-shim.cjs');
    shim.installOverlayBridge(callOverlay, (message) => emitLog('warn', message));
    // 工作区要真实值：模组按它算初始位置与尺寸上限。
    void shim.screen.refresh();
    // `app` 用宿主这份（它带 getPath / getAppMetrics），窗口相关用替身那份。
    return {
        app: Object.assign({}, shim.app, app),
        BrowserWindow: shim.BrowserWindow,
        ipcMain: shim.ipcMain,
        screen: shim.screen,
        shell: { openExternal: async () => undefined },
        clipboard: { writeText: () => undefined, readText: () => '' },
    };
};

const app = {
    getPath: (name) => {        switch (name) {
            case 'userData':
                return userDataDir;
            case 'temp':
            case 'cache':
                return path.join(userDataDir, 'temp');
            case 'documents':
            case 'downloads':
            case 'music':
            case 'videos':
                return path.join(userDataDir, 'files', name);
            default:
                return userDataDir;
        }
    },
    getAppPath: () => path.join(__dirname, '__no_such_app__'),
    isPackaged: true,
    /*
     * Electron 的主进程指标：每个进程一条 { type, cpu: { percentCPUUsage }, memory: { workingSetSize } }。
     * 安卓是一个进程跑所有东西，所以只有一条，type 用 'Browser'（桌面端主进程那类），
     * 额度里再把渲染进程和 GPU 那两组补上 —— 模组按 type 分组显示，缺一组会显示成 0。
     */
    getAppMetrics: () => {
        const snapshot = readDeviceMetrics();
        if (!snapshot) return [];
        // 给「整机占用」：模组问 CPU 时指望的是这一项，别的进程吃掉的部分也看得见。
        // 拿不到整机才退回本应用读数（`cpuSelfPercent`，与桌面端 percentCPUUsage 同口径）。
        // 只给一条 —— 模组按 type 分组把各条加起来当总量，多给一条就是翻倍。
        const system = typeof snapshot.cpuSystemPercent === 'number'
            ? snapshot.cpuSystemPercent
            : null;
        const self = typeof snapshot.cpuSelfPercent === 'number'
            ? snapshot.cpuSelfPercent
            : (typeof snapshot.cpuPercent === 'number' ? snapshot.cpuPercent : 0);
        const cpu = system == null ? self : system;
        const memoryKb = typeof snapshot.memoryKb === 'number' ? snapshot.memoryKb : 0;
        return [
            { pid: 0, type: 'Browser', cpu: { percentCPUUsage: cpu }, memory: { workingSetSize: memoryKb } },
        ];
    },
};

const hostInfo = {
    folium: { major: FOLIUM_VERSION.major, minor: FOLIUM_VERSION.minor },
    folia: null,
    platform: 'android',
};

// --------------------------------------------------------------------- 发现

/*
 * 桌面端 resolveModRoot 的等价物：目录自己有 mod.json 就用它；否则要求恰好一个非点号
 * 子目录含 mod.json（发布包里多套一层目录的常见形态）。其余情况算无法定位。
 */
const resolveModDirectory = (dirPath) => {
    if (fs.existsSync(path.join(dirPath, MANIFEST_NAME))) {
        return dirPath;
    }
    let names;
    try {
        names = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return null;
    }
    const candidates = names
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(dirPath, entry.name))
        .filter((candidate) => fs.existsSync(path.join(candidate, MANIFEST_NAME)));
    return candidates.length === 1 ? candidates[0] : null;
};

/*
 * 扫 mods/ 得到 { entries: Map<id, {id, dirPath, manifest}>, broken: [...] }。
 * 清单不合法的进 broken，界面照常显示成错误行，而不是静默消失。
 */
const discoverMods = () => {
    const entries = new Map();
    const broken = [];
    let dirents;
    try {
        dirents = fs.readdirSync(modsRoot, { withFileTypes: true });
    } catch {
        return { entries, broken };
    }
    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
            continue;
        }
        const dirPath = resolveModDirectory(path.join(modsRoot, dirent.name));
        if (dirPath === null) {
            broken.push({ id: dirent.name, dirPath: path.join(modsRoot, dirent.name), error: 'manifest-missing' });
            continue;
        }
        let raw;
        try {
            const text = fs.readFileSync(path.join(dirPath, MANIFEST_NAME), 'utf8');
            raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        } catch {
            broken.push({ id: dirent.name, dirPath, error: 'manifest-unreadable' });
            continue;
        }
        const validated = validateManifest(raw);
        if (!validated.ok) {
            broken.push({ id: dirent.name, dirPath, error: validated.errors.join('; ') });
            continue;
        }
        const manifest = validated.value;
        if (entries.has(manifest.id)) {
            // 同 id 两份：保留先扫到的那份，后来的报重复。
            broken.push({ id: manifest.id, dirPath, error: 'duplicate-mod-id' });
            continue;
        }
        entries.set(manifest.id, { id: manifest.id, dirPath, manifest });
    }
    return { entries, broken };
};

// --------------------------------------------------------------------- 密钥

/*
 * 桌面端用 safeStorage（系统钥匙串）加密后落盘。安卓没有等价物，把明文写进私有目录
 * 反而更差，所以这里不落盘：值只活在本次运行的内存里，进程重启后读回 null。
 * 对外形状与桌面端一致，将来接 Android Keystore 只需换这一层。
 */
const secrets = createModSecrets({
    userDataDir,
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
            throw new Error('safeStorage-unavailable');
        },
        decryptString: () => {
            throw new Error('safeStorage-unavailable');
        },
    },
    platform: 'android',
    warn: (message) => emitLog('warn', message),
    log: (message) => emitLog('info', message),
    onChange: (modId, key) => send('event', { type: 'secret-changed', modId, key }),
});

// --------------------------------------------------------------------- 守卫 / 转发

const guard = createModGuard((report) => {
    emitLog('warn', `[${report.modId}] ${report.where} 用时 ${Math.round(report.ms)}ms`);
});

let runtimeSnapshot = null;

const netFetch = createNetFetch({
    requireLoadedMod: (modId) => {
        const runtime = runtimes.get(modId);
        if (!runtime) {
            throw new Error('mod-not-loaded');
        }
        return runtime;
    },
    serializeError,
});

const sendToRenderer = (event, payload) => send('event', { type: 'ipc', event, payload });

const getUserFolder = (name) => {
    const folder = path.join(userDataDir, 'files', name);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
};

// require 缓存里整个模组子树都要丢掉，否则重新加载拿到的是旧对象。
const purgeModuleCache = (dirPath) => {
    const prefix = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep;
    Object.keys(require.cache).forEach((key) => {
        if (key.startsWith(prefix)) {
            delete require.cache[key];
        }
    });
};

// --------------------------------------------------------------------- 运行实例

const runtimes = new Map();
let discoveredCache = { entries: new Map(), broken: [] };

const buildModRuntime = ({ id, dirPath, manifest }) => {
    const dirs = resolveModStorageDirs(userDataDir, id);
    const disposers = [];
    const rpcHandlers = new Map();
    let unloaded = false;

    const context = {
        modId: id,
        manifest,
        dataStore: createModDataStore(dirs.dataDir),
        dataDir: dirs.dataDir,
        filesDir: dirs.filesDir,
        cacheDir: dirs.cacheDir,
        hostInfo,
        getUserFolder,
        emitLog: (level, message, details) => emitLog(level, `[${id}] ${message}`, details),
        getPlaybackSnapshot: () => runtimeSnapshot,
        registerDisposer: (disposer) => {
            if (unloaded || typeof disposer !== 'function') {
                return;
            }
            disposers.push(disposer);
        },
        registerRpc: (name, handler) => {
            if (rpcHandlers.has(name)) {
                throw new Error(`duplicate rpc handler "${name}"`);
            }
            rpcHandlers.set(name, handler);
        },
        sendToClient: (name, json) => {
            if (!unloaded) {
                send('event', { type: 'rpc-message', modId: id, name, json });
            }
        },
        secrets: {
            get: (key) => secrets.get(id, key),
            has: (key) => secrets.has(id, key),
            set: (key, value) => secrets.set(id, key, value),
            subscribe: (listener) => {
                if (typeof listener !== 'function') {
                    throw new TypeError('secrets.subscribe requires a listener function');
                }
                if (unloaded) {
                    return () => undefined;
                }
                return secrets.subscribe(id, (key) => guard.call(
                    id,
                    'secrets.subscribe listener',
                    () => listener(key),
                ));
            },
        },
        /*
         * 透明视频导出：**安卓端没有这条管线**，如实拒绝。
         *
         * 桌面端的实现（electron/modSystem/exportService.cjs）依赖 Electron 独有能力：
         * 用一个隐藏 BrowserWindow 载入模组舞台，逐帧 executeJavaScript 调
         * `window.__foliaModExport.renderFrame(t)`，把 `webContents` 的 BGRA 原始像素
         * 通过管道喂给 ffmpeg（ProRes 4444 / VP9 带 alpha）。
         * 安卓的 WebView 既不能离屏渲染逐帧位图，也没有那条像素管道，所以这不是
         * 「配置没打开」，而是能力确实不存在 —— 与其假装能跑再半路失败，不如直接回绝。
         *
         * 错误码保持 `render-export-unavailable:android` 不变（模组会把它显示给用户），
         * 但带上人话，免得看起来像 bug。
         */
        requestExport: () => Promise.reject(new Error(
            'render-export-unavailable:android —— 安卓端没有逐帧离屏渲染管线，'
            + '透明视频导出只能在桌面版（Windows / macOS / Linux）上运行。',
        )),
    };

    const api = createModApi(context);

    const runDisposer = (disposer) => guard.call(id, 'deactivate handler', disposer);

    const keepDisposer = (returned) => {
        if (typeof returned !== 'function') {
            return;
        }
        if (unloaded) {
            runDisposer(returned);
            return;
        }
        disposers.push(returned);
    };

    const load = (onActivationRejected) => {
        if (!manifest.main) {
            return;
        }
        const entryPath = path.join(dirPath, manifest.main);
        purgeModuleCache(dirPath);
        const factory = require(entryPath);
        if (typeof factory !== 'function') {
            throw new Error(`mod main must export a function, got ${typeof factory}`);
        }
        const activation = guard.call(id, 'activate', () => factory(api), true);
        if (activation && typeof activation.then === 'function') {
            // 激活是异步的：照旧跟随，不等它，桌面端也是这么做的。
            activation.then(keepDisposer, onActivationRejected);
            return;
        }
        keepDisposer(activation);
    };

    const unload = () => {
        unloaded = true;
        while (disposers.length > 0) {
            runDisposer(disposers.pop());
        }
        rpcHandlers.clear();
    };

    return {
        manifest,
        dirPath,
        load,
        unload,
        rpcHandler: (name) => rpcHandlers.get(name),
    };
};

// --------------------------------------------------------------------- 列表

const publicState = (item, status, error, digest) => {
    const manifest = item.manifest ?? null;
    return {
        id: item.id,
        name: manifest ? manifest.name : item.id,
        version: manifest ? manifest.version : '0.0.0',
        author: manifest ? manifest.author ?? '' : '',
        description: manifest ? manifest.description ?? '' : '',
        permissions: manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [],
        status,
        error: error ?? null,
        enabled: isEnabled(item.id),
        trustStale: false,
        signature: manifest
            ? verifyModSignature(item.dirPath, manifest)
            : { status: 'unsigned', keyId: '', keyLabel: '', reason: null },
        devSource: false,
        experimental: manifest && Array.isArray(manifest.experimental) ? manifest.experimental : [],
        embedOrigins: manifest && Array.isArray(manifest.embedOrigins) ? manifest.embedOrigins : [],
        folia: manifest ? manifest.folia ?? null : null,
        hasMain: Boolean(manifest && manifest.main),
        // 客户端入口走同源虚拟路径，由原生 ModRouteProcessor 映射到私有目录里的真实文件。
        // 路径里带摘要前 12 位，改完代码不会命中 WebView 的 ES 模块表。
        clientUrl: status === 'loaded' && manifest && manifest.client
            ? `/mods/${encodeURIComponent(manifest.id)}/${digest ? shortDigest(digest) : 'unknown'}/${manifest.client}`
            : null,
        loadOrder: 0,
        warnings: [],
    };
};

const buildList = () => {
    discoveredCache = discoverMods();
    const mods = [];
    discoveredCache.entries.forEach((item) => {
        if (item.manifest && item.manifest.client && !item.manifest.main && !isEnabled(item.id)) {
            // 纯客户端模组：没有 Node 入口，桌面端也把它当「已安装、待启用」。
            mods.push(publicState(item, 'disabled', null, null));
            return;
        }
        if (!isEnabled(item.id)) {
            mods.push(publicState(item, 'disabled', null, null));
            return;
        }
        const digest = computeModDigest(item.dirPath);
        const runtime = runtimes.get(item.id);
        if (!runtime) {
            mods.push(publicState(item, 'error', 'mod-not-loaded', digest));
            return;
        }
        mods.push(publicState(item, 'loaded', null, digest));
    });
    discoveredCache.broken.forEach((item) => {
        mods.push(publicState({ id: item.id, dirPath: item.dirPath, manifest: null }, 'error', item.error, null));
    });
    return {
        mods,
        ffmpeg: ffmpegStatus(),
        directories: [modsRoot],
        startSkipped: false,
    };
};

// --------------------------------------------------------------------- ffmpeg

/*
 * 安卓上 ffmpeg 在原生层（ffmpeg-kit-full，随 APK 一起装），没有可 spawn 的可执行文件。
 *
 * 这里报的是「这个构建带不带 ffmpeg 能力」，不是「PATH 里有没有 ffmpeg」：
 * app/build.gradle 里那一条 implementation 决定了它，原生侧把结论通过
 * FOLIA_FFMPEG_AVAILABLE 传进来（FoliaNodeRuntime 启动时注入）。
 * 早期版本只看环境变量、而且什么都不注入，于是模组面板永远显示「未找到 ffmpeg」。
 */
const ffmpegStatus = () => ({
    available: process.env.FOLIA_FFMPEG_AVAILABLE === '1',
    // 没有可执行文件路径；真正调用走 Java 侧的 FFmpegKit。
    path: process.env.FOLIA_FFMPEG_PATH ?? null,
    version: process.env.FOLIA_FFMPEG_VERSION ?? null,
    candidates: [],
});

// --------------------------------------------------------------------- 载入

// --------------------------------------------------------------------- 状态文件修正

/**
 * 把个别模组的状态文件改回「安卓上真的能用」的那一份。
 *
 * 目前只有 lyric-float 一家：
 *
 * 它有「桌面歌词」与「悬浮窗歌词」两个形态，后者在安卓上跑不起来 —— 窗口能建出来、
 * 却收不到歌词、整页也不响应拖动，而它又按桌面端的行为一直留在屏上；用户关掉它
 * 之后下次启动又会被 persisted.surface 拉回来（切换是按存档恢复的）。
 *
 * 宿主这边不去动模组的页面或逻辑，只在它读档之前把 `surface` 拨回 `desktop`：
 * 悬浮窗那一路于是永远不会被创建，配置项与字号也就全部只作用在桌面歌词上。
 * 写回失败不算错误（文件不存在、只读目录都正常），静默跳过。
 */
const STATE_FILE_FIXES = {
    'lyric-float': { file: 'lyric-float-state.json', overrides: { surface: 'desktop' } },
};

const normalizeModStateFile = (modId) => {
    const fix = STATE_FILE_FIXES[modId];
    if (!fix) {
        return;
    }
    try {
        const target = path.join(userDataDir, fix.file);
        if (!fs.existsSync(target)) {
            return;
        }
        const raw = fs.readFileSync(target, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            // 存档坏了就交给模组自己的兜底逻辑，不在这里猜。
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return;
        }
        let changed = false;
        Object.keys(fix.overrides).forEach((key) => {
            const want = fix.overrides[key];
            if (parsed[key] !== want) {
                parsed[key] = want;
                changed = true;
            }
        });
        if (changed) {
            fs.writeFileSync(target, JSON.stringify(parsed));
            emitLog('info', `[${modId}] 已把状态文件的形态改回桌面歌词`);
        }
    } catch (error) {
        emitLog('warn', `[${modId}] 状态文件修正失败：${serializeError(error)}`);
    }
};

const loadAll = () => {
    runtimes.forEach((runtime) => runtime.unload());
    runtimes.clear();
    discoveredCache = discoverMods();
    const { entries } = discoveredCache;

    // 依赖顺序、循环依赖、未启用依赖都由桌面端同一份 manifest.cjs 判定。
    const enabledManifests = new Map();
    entries.forEach((item, id) => {
        if (isEnabled(id)) {
            enabledManifests.set(id, item.manifest);
        }
    });
    const plan = resolveLoadPlan(enabledManifests, {
        source: 'android',
        isEnabled: (id) => isEnabled(id),
    });

    plan.order.forEach((id) => {
        const item = entries.get(id);
        if (!item) {
            return;
        }
        try {
            // 必须在 runtime.load() 之前跑完：模组在激活时就会读自己的状态文件。
            normalizeModStateFile(id);
            const runtime = buildModRuntime(item);
            runtimes.set(id, runtime);
            runtime.load((error) => {
                emitLog('error', `[${id}] 异步激活失败：${serializeError(error)}`);
            });
            emitLog('info', `已载入 ${id}@${item.manifest.version}`);
        } catch (error) {
            runtimes.delete(id);
            emitLog('error', `载入 ${id} 失败：${serializeError(error)}`);
        }
    });
    plan.failures.forEach((messages, id) => {
        emitLog('warn', `[${id}] 不载入：${messages.join('; ')}`);
    });

    zipInstall.pruneStagingDirectory();
    return buildList();
};

// --------------------------------------------------------------------- 安装器

const zipInstall = createZipInstall({
    app,
    isModSystemEnabled: () => true,
    loadAll,
    // 桌面端的签名是 (modId, level, message)；安卓这边统一成 (level, message, details)。
    emitLog: (modId, level, message) => {
        if (message === undefined) {
            emitLog(typeof modId === 'string' ? modId : 'info', String(level ?? ''));
            return;
        }
        emitLog(level, `[${modId}] ${message}`);
    },
    serializeError,
});

// --------------------------------------------------------------------- 操作表

const requireRuntime = (modId) => {
    const runtime = runtimes.get(modId);
    if (runtime) {
        return { runtime };
    }
    return {
        error: { ok: false, error: discoveredCache.entries.has(modId) ? 'mod-not-loaded' : 'mod-not-found' },
    };
};

const operations = {
    list: () => buildList(),

    /**
     * 模组系统总开关。关掉要**真的把已激活的模组卸掉**（走 loadAll → runtime.unload），
     * 不能只把 UI 藏起来 —— 用户看到的是「关掉了模组还在跑」。
     * 桌面端在 electron/main.cjs 存设置时做同一件事。
     */
    'set-system-enabled': ({ enabled }) => {
        settings.systemEnabled = enabled === true;
        writeSettings();
        const list = loadAll();
        send('event', { type: 'state-changed', list });
        return { ok: true, list };
    },

    reload: () => loadAll(),

    'set-enabled': ({ id, enabled }) => {
        const item = discoveredCache.entries.get(id);
        if (!item) {
            return { ok: false, error: `mod-not-found:${id}` };
        }
        writeEnabled(id, enabled === true, computeModDigest(item.dirPath));
        const list = loadAll();
        send('event', { type: 'state-changed', list });
        return { ok: true, list };
    },

    'install-zip': async ({ zipPath }) => {
        const result = await zipInstall.installModFromZip(zipPath);
        if (result && result.ok) {
            // 安卓上没有桌面端那套原生确认框；用户主动装包即为明确意图，直接启用。
            const item = discoverMods().entries.get(result.id);
            if (item) {
                writeEnabled(result.id, true, computeModDigest(item.dirPath));
            }
            loadAll();
            send('event', { type: 'state-changed', list: buildList() });
        }
        return result;
    },

    rpc: async ({ modId, name, args }) => {
        const { runtime, error } = requireRuntime(modId);
        if (error) {
            return error;
        }
        /*
         * lyric-float 的「切到悬浮窗歌词」在安卓上跑不通：窗口建得出来，但收不到歌词、
         * 显示不出内容、整页也不响应拖动 —— 用户只能看到一个空壳挂在屏上，而且它的
         * 显隐状态会跟着存档被带回来。宿主这边直接把这一路关掉，返回一个正常结果
         * （不是报错），命令面板与「窗」按钮都不会再抛出 rpc-failed。
         */
        if (modId === 'lyric-float' && name === 'set-surface'
            && Array.isArray(args) && String(args[0] || '') === 'window') {
            return { ok: true, result: { ok: false, code: 'unsupported-on-android', surface: 'desktop' } };
        }
        /*
         * 「固定 / 解锁位置」在安卓上点不动 —— 它靠的是桌面端窗口的置顶与拖动语义，
         * 这里既没有置顶、拖动也由原生接管，按下去了看不到任何变化，像是坏的。
         *
         * 现在这颗键改成模组自己声明的「桌面歌词：显示 / 隐藏」（`toggle-widget`，
         * 和播放控制条上的「词」按钮同一个开关）：同一个位置、同一颗按钮，按一下
         * 就把歌词窗收起来 / 叫回来，行为是清楚可见的。
         */
        if (modId === 'lyric-float' && name === 'toggle-pin') {
            const widgetHandler = runtime.rpcHandler('toggle-widget');
            if (typeof widgetHandler === 'function') {
                try {
                    const result = await guard.call(modId, 'rpc toggle-widget',
                        () => widgetHandler(), true);
                    return { ok: true, result: result === undefined ? null : safeJson(result) };
                } catch (caught) {
                    return { ok: false, error: serializeError(caught) };
                }
            }
        }
        /*
         * 窗口里那颗 × 走的是 page → main 的 IPC（`toggle-visibility`），宿主这边
         * 收不到；它发出的 close/hide 又会被原生当成「关掉窗口」。于是让 × 之后
         * 的隐藏退回模组自己声明的显隐开关：窗口不销毁，还能被「词」按钮叫回来。
         */
        if (modId === 'lyric-float' && name === 'toggle-visibility') {
            const widgetHandler = runtime.rpcHandler('toggle-widget');
            if (typeof widgetHandler === 'function') {
                try {
                    const result = await guard.call(modId, 'rpc toggle-widget',
                        () => widgetHandler(), true);
                    return { ok: true, result: result === undefined ? null : safeJson(result) };
                } catch (caught) {
                    return { ok: false, error: serializeError(caught) };
                }
            }
        }
        const handler = runtime.rpcHandler(name);
        if (typeof handler !== 'function') {
            return { ok: false, error: `rpc-not-found:${name}` };
        }
        try {
            const result = await guard.call(modId, `rpc ${name}`, () => handler(...(Array.isArray(args) ? args : [])), true);
            return { ok: true, result: result === undefined ? null : safeJson(result) };
        } catch (caught) {
            return { ok: false, error: serializeError(caught) };
        }
    },

    storage: async ({ modId, op, key, value }) => {
        const { error } = requireRuntime(modId);
        if (error) {
            return error;
        }
        const dirs = resolveModStorageDirs(userDataDir, modId);
        const store = createModDataStore(dirs.dataDir);
        try {
            switch (op) {
                case 'get':
                    return { ok: true, result: (await store.get(key)) ?? null };
                case 'set':
                    await store.set(key, value);
                    return { ok: true, result: null };
                case 'has':
                    return { ok: true, result: await store.has(key) };
                case 'delete':
                    await store.delete(key);
                    return { ok: true, result: null };
                case 'keys':
                    return { ok: true, result: await store.keys() };
                default:
                    return { ok: false, error: `storage-unknown-operation:${op}` };
            }
        } catch (caught) {
            return { ok: false, error: serializeError(caught) };
        }
    },

    secrets: async ({ modId, op, key, value }) => {
        try {
            switch (op) {
                case 'get':
                    return { ok: true, result: await secrets.get(modId, key) };
                case 'has':
                    return { ok: true, result: await secrets.has(modId, key) };
                case 'set':
                    await secrets.set(modId, key, value ?? null);
                    return { ok: true, result: null };
                case 'declare':
                    secrets.declare(modId, Array.isArray(value) ? value : []);
                    return { ok: true, result: null };
                default:
                    return { ok: false, error: `secrets-unknown-operation:${op}` };
            }
        } catch (caught) {
            return { ok: false, error: serializeError(caught) };
        }
    },

    'net-fetch': ({ modId, url, init }) => netFetch.invokeModNetFetch(modId, url, init),

    /* 诊断用：把原生最近一次推来的设备指标原样交出去，便于在渲染端核对 CPU / 温度。 */
    'device-metrics': () => ({ metrics: getDeviceMetricsSnapshot() }),

    /*
     * 这两个都必须 await：modFiles.cjs 里的 measureDirectoryBytes / clearDirectoryContents
     * 都是异步的。之前没 await，`data + cache` 把两个 Promise 拼成了字符串
     * （" [object Promise][object Promise]"），界面于是显示「无法统计占用空间」；
     * 清理同理——没等删完就回了 ok，缓存其实还在。
     */
    'storage-usage': async ({ modId }) => {
        const dirs = resolveModStorageDirs(userDataDir, modId);
        const data = await measureDirectoryBytes(dirs.filesDir);
        const cache = await measureDirectoryBytes(dirs.cacheDir);
        return { ok: true, result: { data, cache, total: data + cache } };
    },

    'clear-cache': async ({ modId }) => {
        await clearDirectoryContents(resolveModStorageDirs(userDataDir, modId).cacheDir);
        return { ok: true, result: null };
    },

    'call-stats': ({ modId }) => ({ ok: true, result: guard.getStats(modId) }),

    'ffmpeg-status': () => ({ ok: true, result: ffmpegStatus() }),

    // 安卓上把「打开到某个目录」暴露给 WebView 没有安全入口，如实报不支持。
    'open-directory': () => ({ ok: false, error: 'open-directory-unsupported' }),

    // 桌面端用原生文件选择框；安卓端由渲染层的 <input type=file> 完成。
    'pick-file': () => ({ ok: false, error: 'pick-file-unsupported' }),

    'restore-file': ({ filePath }) => ({ ok: true, result: filePath ?? null }),

    'release-file': () => ({ ok: true, result: null }),

    'push-runtime-snapshot': ({ snapshot }) => {
        runtimeSnapshot = snapshot ?? null;
        return { ok: true, result: null };
    },

    'start-settled': () => ({ ok: true, result: null }),

    'export-cancel': () => ({ ok: false, error: 'export-unavailable:android' }),
};

// --------------------------------------------------------------------- 与 Java 对接

const handleRequest = async (raw) => {
    let message;
    try {
        message = JSON.parse(raw);
    } catch {
        emitLog('warn', `收到无法解析的宿主请求：${String(raw).slice(0, 400)}`);
        return;
    }
    const requestId = message && message.id;
    const op = message && message.op;
    const args = message && typeof message.args === 'object' && message.args !== null ? message.args : {};
    const operation = typeof op === 'string' ? operations[op] : undefined;
    if (typeof operation !== 'function') {
        send('host', { id: requestId, ok: false, error: `host-unknown-operation:${op}` });
        return;
    }
    try {
        const value = await operation(args);
        // 操作表两种风格混用：已带 ok 的包装结果原样透传，裸值补上 ok。
        const payload = value && typeof value === 'object' && Object.hasOwn(value, 'ok')
            ? value
            : { ok: true, result: value === undefined ? null : value };
        // 注意展开顺序：结果里可能自带 id（安装结果就是 { ok, id, mods }），必须让它
        // 在后面，否则会把请求号盖掉，调用方永远等不到应答。
        send('host', { ...safeJson(payload), id: requestId });
    } catch (error) {
        send('host', { id: requestId, ok: false, error: serializeError(error) });
    }
};

const main = () => {
    emitLog('info', `Node 宿主启动：node ${process.version}，数据目录 ${userDataDir}`);
    // 回调必须立刻返回；重活丢进微任务，别堵住 uv 循环。
    foliaNode.registerChannel('host', (payload) => {
        Promise.resolve().then(() => handleRequest(payload));
    });
    /*
     * 原生每采一份设备指标就推到这条通道（安卓没有 Electron 的 getAppMetrics，
     * 也没有 nvidia-smi，数字只能从内核读，见 DeviceMetrics.java）。
     */
    foliaNode.registerChannel('device-metrics', (payload) => {
        try {
            deviceMetrics = JSON.parse(payload);
        } catch (error) {
            emitLog('warn', `设备指标解析失败：${serializeError(error)}`);
        }
    });
    // 模组可能在任何时候 require child_process，装上替身要赶在它们加载之前。
    installNvidiaShim();
    foliaNode.registerChannel('overlay-result', (payload) => {
        settleOverlayResult(payload);
    });
    // 同理：模组的 main 一 require('electron') 就得拿到替身。
    installElectronShim(buildElectronModule());
    const list = loadAll();
    foliaNode.ready();
    send('event', { type: 'ready', list });
};

try {
    main();
} catch (error) {
    emitLog('error', `Node 宿主启动失败：${serializeError(error)}`);
    foliaNode.failure(serializeError(error));
}
