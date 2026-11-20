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
const { createModuleFence, makeChildProcessFacade, resolveRequested } = require('./moduleFence.js');
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

/*
 * 信任根：启用状态与内容摘要记在这里。
 *
 * 为什么不在 userDataDir 下：模组目录（mods/）和它是同一棵树，而且整棵树落在外部存储
 * （Java 的 getExternalFilesDir）。模组的 fs 能直接写这份文件 —— 那样「授权绑定到内容摘要」
 * 就完全可以由被授权的一方自己伪造：改一行 enabled:true 配上刚算好的 digest，重启即生效。
 * 所以 Java 把应用数据目录（/data/user/0/<包名>/mod-trust）单独传进来（环境变量
 * FOLIA_TRUST_DIR），模组写不到那里。设置里只放模组系统总开关这类不构成授权的状态。
 */
const trustDir = (() => {
    const fromEnv = process.env.FOLIA_TRUST_DIR;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
    return path.join(userDataDir, 'mod-trust');
})();
const trustPath = path.join(trustDir, 'mod-trust.json');

/** 记录格式：每个模组一条 { enabled, digest }。别的形状一律当没有记录（见 readTrustFile）。 */
const TRUST_SCHEMA_VERSION = 1;

const readJsonFile = (file) => {
    try {
        const text = fs.readFileSync(file, 'utf8');
        // 别的工具写出来的 JSON 可能带 BOM，先剥掉再解析。
        const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const writeJsonFile = (file, value) => {
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
};

const readSettings = () => {
    const parsed = readJsonFile(settingsPath) ?? {};
    if (!parsed.mods || typeof parsed.mods !== 'object' || Array.isArray(parsed.mods)) {
        parsed.mods = {};
    }
    return parsed;
};

const settings = readSettings();
// 模组系统总开关。桌面端由主进程持有（settings 里的 MOD_SYSTEM_ENABLED），
// 这里跟着存一份，好让宿主自己知道「该不该跑模组」——UI 关掉总开关时下面那个
// isEnabled 会连带把每个模组都判成未启用，loadAll() 于是真的把运行时卸掉。
if (typeof settings.systemEnabled !== 'boolean') {
    settings.systemEnabled = true;
}

const writeSettings = () => {
    try {
        writeJsonFile(settingsPath, settings);
    } catch (error) {
        emitLog('warn', `写入模组设置失败：${serializeError(error)}`);
    }
};

/*
 * 一条信任记录合不合规。摘要必须是 `sha256:<64 位十六进制>`，少一位都算坏记录 ——
 * 「摘要写错」和「摘要对不上」是两回事：前者说明文件被谁动过，按未启用处理并记日志。
 */
const isTrustDigest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

const isTrustRecord = (record) => (
    record !== null
    && typeof record === 'object'
    && !Array.isArray(record)
    && typeof record.enabled === 'boolean'
    // enabled 为真必须带摘要；为假时 digest 只能是 null。
    && (record.enabled ? isTrustDigest(record.digest) : record.digest === null || record.digest === undefined)
);

/*
 * 读信任文件。文件损坏、版本不认识、某条记录形状不对：都按「没有这条授权」处理并记一行日志，
 * 绝不让一段读不懂的 JSON 变成授权（fail closed）。
 */
const readTrustFile = () => {
    const trust = { version: TRUST_SCHEMA_VERSION, mods: {} };
    if (!fs.existsSync(trustPath)) {
        return trust;
    }
    const parsed = readJsonFile(trustPath);
    if (parsed === null) {
        emitLog('error', `信任记录 ${trustPath} 损坏或不可读，全部模组按未启用处理`);
        return trust;
    }
    if (parsed.version !== TRUST_SCHEMA_VERSION) {
        emitLog('error', `信任记录版本 ${String(parsed.version)} 不认识（期望 ${TRUST_SCHEMA_VERSION}），全部模组按未启用处理`);
        return trust;
    }
    const records = parsed.mods;
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
        emitLog('error', '信任记录缺少 mods 表，全部模组按未启用处理');
        return trust;
    }
    Object.entries(records).forEach(([modId, record]) => {
        if (isTrustRecord(record)) {
            trust.mods[modId] = {
                enabled: record.enabled,
                digest: record.enabled ? record.digest : null,
                confirmedAt: typeof record.confirmedAt === 'string' ? record.confirmedAt : null,
            };
            return;
        }
        emitLog('error', `信任记录里的模组 ${modId} 形状不对，按未启用处理`);
    });
    return trust;
};

const trust = readTrustFile();

/*
 * 从旧位置迁移：0.7.30 之前的版本把启用状态写在 userDataDir/mod-system.json 的 mods 表里，
 * 和模组目录同一棵树。那份记录本身不可信（模组能改），所以不搬「授权」，只搬两样东西：
 *   · 用户明确关掉的模组（enabled:false）—— 这是「拒绝」，搬过去不让模组借迁移复活；
 *   · 内置模组的启用记录 —— 它们随包发布，没有第三方代码可伪造。
 * 第三方模组的「启用」一律不搬，升级后按未确认处理，由用户在确认框里看一遍内容再开。
 * 迁移只做一次：写一个标记文件，旧字段随后从 mod-system.json 里删掉。
 */
const MIGRATION_MARKER = path.join(trustDir, 'migrated-from-userdata');

const migrateLegacyTrust = () => {
    if (fs.existsSync(MIGRATION_MARKER)) return;
    const legacy = settings.mods;
    let moved = 0;
    Object.entries(legacy).forEach(([modId, record]) => {
        if (!record || typeof record !== 'object') return;
        if (trust.mods[modId] !== undefined) return;
        if (record.enabled === false) {
            trust.mods[modId] = { enabled: false, digest: null, confirmedAt: null };
            moved += 1;
            return;
        }
        if (record.enabled === true && BUILTIN_MOD_IDS.has(modId)) {
            // 没有旧摘要就用空摘要占位：内置模组按「随包内容」重新算（见 ensureBuiltinTrust）。
            trust.mods[modId] = { enabled: true, digest: isTrustDigest(record.digest) ? record.digest : null, confirmedAt: null };
            moved += 1;
        }
    });
    try {
        if (moved > 0) writeJsonFile(trustPath, trust);
        fs.mkdirSync(trustDir, { recursive: true });
        fs.writeFileSync(MIGRATION_MARKER, new Date().toISOString(), 'utf8');
    } catch (error) {
        emitLog('warn', `迁移旧启用记录失败：${serializeError(error)}`);
        return;
    }
    if (Object.keys(legacy).length > 0) {
        // 旧字段留在 mod-system.json 里只会让人以为它还算数，迁移完就删掉。
        settings.mods = {};
        writeSettings();
    }
    if (moved > 0) {
        emitLog('info', `已从 userData 迁移 ${moved} 条模组启用记录到 ${trustPath}`);
    }
};

const writeTrust = () => {
    try {
        writeJsonFile(trustPath, trust);
    } catch (error) {
        emitLog('error', `写入信任记录失败（模组启用状态可能不生效）：${serializeError(error)}`);
    }
};

/*
 * 内置模组默认就是开着的：随包发出去的那几个，本来就是应用的一部分，
 * 让用户装完先去列表里一个个点开没有意义。
 *
 * 只影响「用户从没表过态」的情况 —— settings 里一旦有记录（无论开着还是关着），
 * 一律以记录为准，所以用户手动关掉之后不会被下一次启动又打开。
 */
const BUILTIN_MOD_IDS = new Set(['mod-market', 'vinyl-disc', 'visualizer-jump', 'listening-archive', 'lizi-stages']);

/*
 * 随包内置、且管理面板里对用户隐藏的「资源型」模组（LIZI 68 个歌词舞台）。
 * 用户没有关闭入口，历史上又可能因为没有默认启用而被记过一次 enabled:false ——
 * 那种记录是 bug 的产物，不是用户的选择，必须无条件恢复，否则 68 款样式永远出不来。
 * 模组系统总开关仍然尊重（见下面 isEnabled 里 systemEnabled 那条）。
 */
const FORCED_BUILTIN_IDS = new Set(['lizi-stages']);

/*
 * 信任判定，与桌面端 electron/modSystem/approval.cjs 的 resolveTrust 同一套语义：
 *
 *   · 授权是一条记录（enabled + digest），digest 是用户确认那一刻模组目录的内容摘要；
 *   · 每次启动重新算摘要，和记录里的对不上（文件被改过 / 被换过）就是撤销授权：
 *     enabled 置为 false、trustStale 置真，界面提示「文件已变化，需要重新确认」；
 *   · 内置模组随包发布、没有第三方代码可伪造，默认启用；但用户手动关掉之后照样尊重。
 *
 * 返回 { enabled, stale }。stale 只说明「曾经授权过、现在对不上了」。
 */
const trustStateOf = (modId, digest) => {
    if (settings.systemEnabled !== true) {
        return { enabled: false, stale: false };
    }
    const record = trust.mods[modId];
    if (record === undefined) {
        if (FORCED_BUILTIN_IDS.has(modId)) return { enabled: true, stale: false };
        if (BUILTIN_MOD_IDS.has(modId)) {
            // 内置模组第一次跑：把这一份内容本身记成用户已确认的内容（它随包来，没有第三方代码）。
            trust.mods[modId] = { enabled: true, digest, confirmedAt: null };
            writeTrust();
            return { enabled: true, stale: false };
        }
        return { enabled: false, stale: false };
    }
    if (record.enabled !== true) {
        return { enabled: false, stale: false };
    }
    if (digest !== null && record.digest === digest) {
        return { enabled: true, stale: false };
    }
    // 摘要对不上（或者算不出摘要）：撤销授权，下次要用户再看一遍内容。
    trust.mods[modId] = { enabled: false, digest: null, confirmedAt: null };
    writeTrust();
    return { enabled: false, stale: true };
};

/** 用户确认或关掉一个模组：只有带摘要才能记成启用。 */
const writeEnabled = (modId, enabled, digest) => {
    if (enabled === true && !isTrustDigest(digest)) {
        // 没有可信摘要就没有可授权的对象：拒绝对它写入「启用」。
        return false;
    }
    trust.mods[modId] = {
        enabled: enabled === true,
        digest: enabled === true ? digest : null,
        confirmedAt: enabled === true ? new Date().toISOString() : null,
    };
    writeTrust();
    return true;
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
// 宿主装好的替身副本：围栏把这个交给声明了 process.run 的模组，见 installNvidiaShim。
const childProcessFacades = new Map();
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
        /*
         * 声明了 process.run 的模组拿到的是一份只读外观（moduleFence.makeChildProcessFacade）：
         * 交给它的是绑在原生实现上的副本，所以它没法
         *   · 把 execFile 改回原生实现，绕过上面那条 nvidia-smi 替身；
         *   · 在自己的模块作用域里把 require('child_process') 的结果当成可写通道。
         * 真正的限制仍是围栏（没声明 process.run 直接 require 失败）。
         */
        const facade = makeChildProcessFacade(childProcess);
        childProcessFacades.set('child_process', facade);
    } catch (error) {
        emitLog('warn', `nvidia-smi 替身安装失败：${serializeError(error)}`);
    }
};

/*
 * 模块级围栏（见 moduleFence.js）。
 *
 * 以前这里只特判 `'electron'`，别的一律转给原始 `Module._load` —— 模组随手一句
 * `require('child_process')` 就能起子进程、`require('net')` 就能绕过 folium.net.fetch 的
 * 白名单直连任意主机，权限等于宿主自己。现在按调用者是「宿主还是某个模组」决定：
 * 模组只能拿 foliumShared.json 的 coreModules（fs / path / crypto / zlib …，内置模组就用到这几个），
 * 其余要 mod.json 的 `processes` 里声明过对应能力。
 *
 * `resolveRequester` 只认模组目录（mods/<id>/）与随包解的宿主目录以外的文件：
 * 之前 require 进来的、或者模组自己目录里的文件，都算那个模组的代码。
 */
const modRootsByPrefix = new Map();

const rememberModRoot = (modId, dirPath) => {
    const resolved = path.resolve(dirPath);
    modRootsByPrefix.set(resolved.endsWith(path.sep) ? resolved : resolved + path.sep, modId);
};

/** 一个文件属于哪个模组；不属于任何模组时返回 null（= 宿主，不受限）。 */
const modIdForFile = (filename) => {
    if (typeof filename !== 'string' || filename.length === 0) return null;
    const resolved = path.resolve(filename);
    // 最长前缀优先：模组目录不会互相嵌套，但按前缀长度取最稳。
    let best = null;
    let bestLength = -1;
    modRootsByPrefix.forEach((modId, root) => {
        if (resolved.startsWith(root) && root.length > bestLength) {
            best = modId;
            bestLength = root.length;
        }
    });
    return best;
};

const moduleFence = createModuleFence({
    coreModules: Array.isArray(shared.coreModules) ? shared.coreModules : [],
    capabilities: shared.capabilities || {},
    // 内置模组与宿主一起签名发布，放行全部模块：它们的 mod.json 一改官方签名就失效
    // （面板会显示「签名不匹配」），因此不能靠给它们加 processes 来放行 worker_threads。
    builtinModIds: [...BUILTIN_MOD_IDS],
    hostRoots: [__dirname],
    onDenied: (modId, moduleName, reason) => {
        emitLog('warn', `[${modId}] require('${moduleName}') 被拒绝：${reason}`);
    },
});

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
        moduleFence.install({
            onElectron: () => shim,
            facades: childProcessFacades,
            resolveRequester: (parent) => {
                const modId = modIdForFile(parent && parent.filename);
                if (modId === null) return null;
                const runtime = runtimes.get(modId);
                return { modId, capabilities: runtime ? runtime.capabilities : [] };
            },
        });
    } catch (error) {
        emitLog('warn', `electron 替身 / 模块围栏安装失败：${serializeError(error)}`);
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

/**
 * 发起这次 overlay 调用的是哪个模组（issue H19）。宿主自己调的返回空串。
 *
 * 逐帧问 [modIdForFile]：栈帧里第一个落在某个模组目录下的文件就是答案。栈里的文件名有
 * 的是 `file:///...` 形式（ESM），有的带括号，所以统一取括号后的那段。
 */
const callerModId = () => {
    const holder = {};
    Error.captureStackTrace(holder, callerModId);
    const frames = String(holder.stack || '').split('\n');
    for (const line of frames) {
        const matched = /\(?((?:file:\/\/)?[^()\s]+):\d+:\d+\)?\s*$/.exec(line.trim());
        if (!matched) continue;
        const filename = matched[1].startsWith('file://')
            ? matched[1].slice('file://'.length)
            : matched[1];
        const modId = modIdForFile(filename);
        if (modId !== null) return modId;
    }
    return '';
};

const callOverlay = (op, args = {}) => new Promise((resolve, reject) => {
    const id = `ov-${++overlaySeq}`;
    const timer = setTimeout(() => {
        pendingOverlay.delete(id);
        reject(new Error(`overlay request timed out: ${op}`));
    }, 8000);
    pendingOverlay.set(id, { resolve, reject, timer });
    try {
        /*
         * 开窗时捎上「这是谁开的」（issue H19）。
         *
         * 用户禁用某个模组时，原生要能只关掉它名下的窗口 —— 没有归属信息就只剩「全关」
         * 一个选择，会误伤别的模组。归属靠调用栈反查：`new BrowserWindow()` 那一行一定
         * 在模组自己的文件里，`modIdForFile` 能把那段路径映射回模组 id。
         *
         * 只在 create 时算：别的 op 都带着已有的窗口 id，窗口建好时归属就定了。
         */
        const payload = op === 'create'
            ? { ...args, ownerModId: callerModId() }
            : args;
        // 用 emit 而不是 send：send 会再包一层 JSON。
        foliaNode.emit('overlay', JSON.stringify({ id, op, args: payload }));
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
    getPath: (name) => {
        // trust：信任根（见文件开头 trustDir）。桌面端把启用记录放在 userData 下的 settings 里，
        // 安卓必须分开，所以这里单独给一个名字，任何要求「模组写不到」的代码都从这里取。
        if (name === 'trust') {
            return trustDir;
        }
        switch (name) {
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
    // 围栏按目录认人：先登记，模组 activate 时 require 才知道自己是哪个模组。
    rememberModRoot(id, dirPath);

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
        // 模组声明过的进程能力：围栏据此放行 child_process / net 这些模块。
        capabilities: Array.isArray(manifest.processes) ? manifest.processes.slice() : [],
        load,
        unload,
        rpcHandler: (name) => rpcHandlers.get(name),
    };
};

// --------------------------------------------------------------------- 列表

const publicState = (item, status, error, digest, trustState = { enabled: false, stale: false }) => {
    const manifest = item.manifest ?? null;
    return {
        id: item.id,
        name: manifest ? manifest.name : item.id,
        version: manifest ? manifest.version : '0.0.0',
        author: manifest ? manifest.author ?? '' : '',
        description: manifest ? manifest.description ?? '' : '',
        permissions: manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [],
        // 声明过的进程能力（mod.json 的 processes）：界面据此在确认框里说明「这个模组能起子进程 / 直连网络」。
        processes: manifest && Array.isArray(manifest.processes) ? manifest.processes : [],
        status,
        error: error ?? null,
        enabled: trustState.enabled,
        // 曾经确认过、但文件已经变了：界面据此提示要重新确认（桌面端同名语义）。
        trustStale: trustState.stale,
        signature: manifest
            ? verifyModSignature(item.dirPath, manifest)
            : { status: 'unsigned', keyId: '', keyLabel: '', reason: null },
        devSource: false,
        experimental: manifest && Array.isArray(manifest.experimental) ? manifest.experimental : [],
        embedOrigins: manifest && Array.isArray(manifest.embedOrigins) ? manifest.embedOrigins : [],
        folia: manifest ? manifest.folia ?? null : null,
        hasMain: Boolean(manifest && manifest.main),
        // 内容摘要：确认框把它写给用户看，用户确认后又原样交回来复核（set-enabled 的 digest）。
        digest: digest ?? null,
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
        // 授权是「这个 id + 这一份内容」：先算摘要，再拿摘要去比对信任记录
        // （摘要对不上就当场撤销授权，见 trustStateOf）。算不出摘要的目录永远按未授权处理。
        const digest = computeModDigest(item.dirPath);
        const trustState = trustStateOf(item.id, digest);
        if (item.manifest && item.manifest.client && !item.manifest.main && !trustState.enabled) {
            // 纯客户端模组：没有 Node 入口，桌面端也把它当「已安装、待启用」。
            mods.push(publicState(item, 'disabled', null, null, trustState));
            return;
        }
        if (!trustState.enabled) {
            mods.push(publicState(item, 'disabled', null, null, trustState));
            return;
        }
        const runtime = runtimes.get(item.id);
        if (!runtime) {
            mods.push(publicState(item, 'error', 'mod-not-loaded', digest, trustState));
            return;
        }
        mods.push(publicState(item, 'loaded', null, digest, trustState));
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

    /*
     * 每个模组先按「id + 这一份内容」判一次授权，再把结果交给依赖规划。
     *
     * 这里必须重新算摘要：进程起来之后模组文件仍可能被换掉（模组的 fs、外部存储里的
     * 文件管理器、备份恢复），拿上次列表里的结论会放过一次「确认之后被替换」。
     */
    const trustById = new Map();
    entries.forEach((item, id) => {
        trustById.set(id, trustStateOf(id, computeModDigest(item.dirPath)));
    });
    const isTrusted = (id) => trustById.get(id)?.enabled === true;

    // 依赖顺序、循环依赖、未启用依赖都由桌面端同一份 manifest.cjs 判定。
    const enabledManifests = new Map();
    entries.forEach((item, id) => {
        if (isTrusted(id)) {
            enabledManifests.set(id, item.manifest);
        }
    });
    const plan = resolveLoadPlan(enabledManifests, {
        source: 'android',
        isEnabled: isTrusted,
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
        /*
         * 总开关关掉 = 所有模组都停了，它们开的悬浮窗必须跟着消失（issue H19）。
         *
         * loadAll 只卸载运行时（跑 disposers），碰不到已经建好的系统窗口 —— 那些窗口
         * 连同 WebView 还挂在 WindowManager 上，歌词泵还在往里注入内容。用户关掉总开关
         * 看到的却是「窗口还在、歌词还在动」，正是文件里那句注释警告的现象。
         */
        if (settings.systemEnabled !== true) {
            void callOverlay('destroy-all', {}).catch((error) => {
                emitLog('warn', `关闭全部悬浮窗失败：${error && error.message ? error.message : error}`);
            });
        }
        send('event', { type: 'state-changed', list });
        return { ok: true, list };
    },

    reload: () => loadAll(),

    /*
     * 用户确认启用 / 关掉一个模组。
     *
     * 安卓没有桌面端那种原生确认框，确认在渲染端做（模组面板的确认框，见
     * src/mods/android/androidModApproval.ts）：界面先算好这一份内容的摘要给用户看，
     * 用户点了「仍要启用」之后才调这里，并把同一个 digest 带回来。宿主再算一遍当前摘要，
     * 和界面确认的那一份对不上就拒掉（ENABLE_DIGEST_MISMATCH）—— 确认框里写的和实际要
     * 跑的必须是同一份字节，否则「看一眼再启用」就没有意义。
     *
     * 不带 digest 就启用一律拒绝：授权必须绑定到具体内容。
     */
    'set-enabled': ({ id, enabled, digest }) => {
        const item = discoveredCache.entries.get(id);
        if (!item) {
            return { ok: false, error: `mod-not-found:${id}` };
        }
        if (enabled === true) {
            const current = computeModDigest(item.dirPath);
            if (current === null) {
                return { ok: false, error: 'mod-content-unverifiable', list: buildList() };
            }
            if (digest !== undefined && digest !== null && digest !== current) {
                return { ok: false, error: 'enable-digest-mismatch', list: buildList() };
            }
            if (!writeEnabled(id, true, current)) {
                return { ok: false, error: 'mod-content-unverifiable', list: buildList() };
            }
        } else {
            writeEnabled(id, false, null);
        }
        const list = loadAll();
        send('event', { type: 'state-changed', list });
        return { ok: true, list };
    },

    /*
     * 装一个 zip。**只装不启用**：装包只是把文件放到模组目录，用户真正同意「跑这份代码」
     * 要经过和手动放进目录的模组同一条确认流程（刷新列表 → 点启用 → 确认框 → set-enabled
     * 带摘要）。以前这里装完直接 writeEnabled(id, true)，等于把「下载了一个包」当成
     * 「确认过这份代码」，装上就能以完整 Node 权限跑。
     */
    'install-zip': async ({ zipPath }) => {
        const result = await zipInstall.installModFromZip(zipPath);
        if (result && result.ok) {
            loadAll();
            const list = buildList();
            send('event', { type: 'state-changed', list });
            return { ...result, enabled: false, needsConfirmation: true };
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
    emitLog('info', `Node 宿主启动：node ${process.version}，数据目录 ${userDataDir}，信任根 ${trustDir}`);
    // 旧版本把启用状态写在 userData 里，先搬一次（只搬「拒绝」与内置模组，理由见 migrateLegacyTrust）。
    migrateLegacyTrust();
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
    /*
     * overlay 页面 → 主进程（issue H18）。
     *
     * 桌面端这一段由 Electron 自己搬，安卓上要手动接：原生 OverlayBridge 收到页面里
     * `ipcRenderer.send(channel, payload)` 之后，把 { id, channel, payload } 从这个通道送回来，
     * 这里交给替身去找到那个窗口、用它的 webContents 当 sender 触发 ipcMain 的监听。
     */
    foliaNode.registerChannel('overlay-ipc', (payload) => {
        require('./electron-shim.cjs').deliverIpcToMain(
            payload,
            (message) => emitLog('warn', message),
        );
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
