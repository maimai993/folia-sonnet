// android/app/src/main/assets/folia-node/moduleFence.js
// 模组的模块级围栏：按「谁在 require」决定某个 Node 内置模块能不能被拿到。
//
// 为什么要有它：这个宿主里模组代码和宿主跑在同一个进程、同一个 V8 里，模组 activate 时
// 一 require('child_process') 就能起子进程，一 require('net') 就能绕过 folium.net.fetch 的
// 白名单直连任意主机。以前的拦截只把 'electron' 换成替身，其余原样放行，等于「模组 = 完整
// 本地权限」。这里给出真正会失败的边界：
//
//   · 宿主自己（host.js / electron-shim.cjs / modSystem/*.cjs）不受限 —— 它本来就该有全部能力；
//   · 随包内置的模组（builtinMods 里的 id）也不受限：它们和宿主一起签名发布，用户装到的就是
//     这一份字节，认证的正是「这些代码可以拿全部模块」。而且它们的 mod.json 带着官方签名，
//     改一个字签名就失效（面板会报「签名不匹配」），所以不能靠给它们加 `processes` 来放行；
//   · 其余的模组：路径在模组目录里的代码只能拿 foliumShared.json 的 coreModules，外加 mod.json 的
//     `processes` 里声明过的那几个能力所带的模块；没声明就是 MODULE_NOT_ALLOWED；
//   · 宿主的替身（nvidia-smi 之类）只有宿主能装，模组改不动（见 makeChildProcessFacade 对
//     execFile 的包装）。
//
// 围栏本身也是制止不完全的：它拦的是 `require`，拦不住模组去翻 require.cache 里别的模块、
// 或者用 process.binding 之类更底层的口子。它把「随手写一句 require('child_process')」变成
// 一次可见的失败，并让 mod.json 里那份能力声明必须和实现对上；它不是虚拟机级的沙箱。

'use strict';

const path = require('path');
const Module = require('module');

const NODE_PREFIX = 'node:';

/** `node:fs` / `fs/promises` / `fs` 都归到同一个模块名。 */
const bareName = (request) => {
    let name = String(request);
    if (name.startsWith(NODE_PREFIX)) {
        name = name.slice(NODE_PREFIX.length);
    }
    const slash = name.indexOf('/');
    return slash > 0 ? name.slice(0, slash) : name;
};

/**
 * 建一份判断函数的集合。
 *
 * @param {object} options
 * @param {string[]} options.coreModules        不需要声明的模块（foliumShared.json 的 coreModules）
 * @param {Object<string, {modules: string[]}>} options.capabilities 能力 → 它带的模块
 * @param {string[]} options.hostRoots          宿主自己的目录（里面的代码不受限）
 * @param {string[]} [options.builtinModIds]    随包内置、连同宿主一起发布的模组（不受限）
 * @param {(modId: string, moduleName: string) => void} [options.onDenied] 拒绝时回调（记日志用）
 */
const createModuleFence = ({ coreModules, capabilities, hostRoots, builtinModIds = [], onDenied }) => {
    const core = new Set(coreModules);
    // 内置模组：与宿主同一份发布流程认证过的代码，放行全部模块。
    const builtin = new Set(builtinModIds);
    // 模块名 → 需要的能力。
    const capabilityOfModule = new Map();
    Object.keys(capabilities).forEach((id) => {
        (capabilities[id].modules || []).forEach((name) => {
            if (!capabilityOfModule.has(name)) {
                capabilityOfModule.set(name, id);
            }
        });
    });
    const roots = hostRoots.map((root) => {
        const resolved = path.resolve(root);
        return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    });

    const isHostFile = (filename) => {
        if (typeof filename !== 'string' || filename.length === 0) return false;
        const resolved = path.resolve(filename);
        return roots.some((root) => resolved.startsWith(root));
    };

    /**
     * 某个模块对某个调用者现在能不能用。
     *
     * @param {string | null} modId        调用者所属的模组；null 表示宿主
     * @param {string[]} granted           该模组声明过的能力
     * @param {string} request             原始 require 参数
     */
    const admits = (modId, granted, request) => {
        if (modId === null) return { ok: true, name: bareName(request) };
        const name = bareName(request);
        if (builtin.has(modId)) return { ok: true, name };
        if (core.has(name)) return { ok: true, name };
        const needed = capabilityOfModule.get(name);
        if (needed === undefined) {
            return { ok: false, name, reason: `module "${name}" is not available to mods` };
        }
        if (granted.includes(needed)) return { ok: true, name };
        return { ok: false, name, reason: `module "${name}" needs the "${needed}" capability in mod.json` };
    };

    /**
     * 装到 Module._load 上。`resolveRequester(module)` 给出「这个父模块是谁的代码」，
     * 返回 { modId, capabilities } 或 null（宿主）；`facades` 是给模组看的替身模块
     * （例如宿主装过 nvidia-smi 替身的 child_process 副本），只在放行后替换取到的对象。
     */
    const install = ({ resolveRequester, onElectron, facades = new Map() }) => {
        if (Module.__foliaModuleFence) return;
        const originalLoad = Module._load;
        Module._load = function fencedLoad(request, parent, isMain) {
            if (request === 'electron') return onElectron();
            // 宿主自己的代码（含宿主 require 进来的 modSystem/*.cjs）不受限。
            const parentFile = parent && parent.filename ? parent.filename : null;
            if (isHostFile(parentFile)) {
                return originalLoad.call(this, request, parent, isMain);
            }
            const requester = resolveRequester(parent);
            const decision = requester === null
                ? { ok: true, name: bareName(request) }
                : admits(requester.modId, requester.capabilities || [], request);
            if (!decision.ok) {
                if (requester !== null && typeof onDenied === 'function') {
                    try {
                        onDenied(requester.modId, decision.name, decision.reason);
                    } catch {
                        // 记日志失败不能把拒绝变成放行。
                    }
                }
                const error = new Error(`[folia-mod-fence] ${decision.reason}`);
                error.code = 'MODULE_NOT_ALLOWED';
                throw error;
            }
            const loaded = originalLoad.call(this, request, parent, isMain);
            if (requester !== null && facades.has(decision.name)) {
                return facades.get(decision.name);
            }
            return loaded;
        };
        Module.__foliaModuleFence = true;
    };

    return { install, admits, isHostFile, capabilityOfModule };
};

/**
 * 给模组用的 `child_process` 外观。
 *
 * 宿主在真 child_process 上装过 nvidia-smi 替身（见 host.js）；模组若拿到原对象就能把它
 * 改回去，所以这里交一份只读副本：方法都绑在原生实现上，改副本上的属性和冻结空对象一样
 * 无效。没有声明 process.run 的模组根本走不到这里（围栏先拦了）。
 */
const makeChildProcessFacade = (childProcess) => {
    const facade = {};
    Object.keys(childProcess).forEach((key) => {
        const value = childProcess[key];
        facade[key] = typeof value === 'function' ? value.bind(childProcess) : value;
    });
    // execFile 是宿主装过替身的那一个：直接把当前实现拷过来，拷完再改原对象也不影响这里。
    facade.execFile = childProcess.execFile.bind(childProcess);
    return Object.freeze(facade);
};

/** 把相对请求解析成真实文件（解析不出来就返回 null，交给原生 require 去报错）。 */
const resolveRequested = (request, parent) => {
    try {
        return Module._resolveFilename(request, parent, false);
    } catch {
        return null;
    }
};

module.exports = { createModuleFence, makeChildProcessFacade, bareName, resolveRequested };
