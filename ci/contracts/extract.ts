// ci/contracts/extract.ts
// 把仓库里三份隐式契约抽成可比较的 manifest，改了实现却没跟上 manifest 时 CI 直接红：
//   node ci/contracts/extract.ts            校验 docs/contracts/manifest/*.json 与当前实现一致
//   node ci/contracts/extract.ts --update   按当前实现重写 manifest
//
// 三份契约都没有显式的单一来源（preload 的 contextBridge、Hono 的路由表、注册表里的 provider），
// 所以这里静态解析源码。改完实现跑一次 --update，把 manifest 的 diff 一起提交，review 时能看到
// 契约本身变了多少。
//
// 解析方式的限制，改这些文件的内容时也要一起看：
// - preload 用 node:vm 只读加载，require('electron') 换成记录用的桩；暴露的函数会被调用一次，
//   记下 ipcRenderer.invoke/send 的通道，但桩不会真的走 IPC。preload 里 require 别的模块会报错。
// - 路由只认单行的 recv.method('/path', ...) 与 app.route('/前缀', 标识符)：路径必须是单引号字面量，
//   跨模块只跟一层 app.route 挂载；IIFE 与同文件工厂函数靠顶层的 `})();` / `};` 收尾识别
//   （仓库现有排版）。Hono 的 .on()/多方法路由不支持，真用到再在这里加。
// - provider 只认 registerOnlineMusicProvider(标识符)，再顺着 import 取导出对象的顶层 id 字面量；
//   导出是工厂吐出来的（`export const xProvider = createXProvider(...)`）时，回到本文件里找那个
//   工厂的返回对象（取缩进最浅的那个 `return {`）。注册处写成表达式（不是标识符）会明确报错，
//   而不是默默漏掉。
// 解析是基于源码文本的：字符串、注释、模板字面量里的同形文本不会命中（正则锚在行首），正则字面量
// 会整体跳过（里面的引号与花括号不算数）；新增这类写法时先跑一遍 --update 看结果对不对。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type PreloadManifest = {
    namespaces: Record<string, {
        members: string[];
        invokeChannels: string[];
        sendChannels: string[];
    }>;
};

export type SyncServerRoutesManifest = {
    routes: Array<{ method: string; path: string; handlerFile: string }>;
};

export type OmniProvidersManifest = {
    providers: string[];
};

type ManifestName = 'preload' | 'sync-server-routes' | 'omni-providers';

const MANIFEST_DIR = 'docs/contracts/manifest';
const PRELOAD_FILE = 'electron/preload.cjs';
const APP_FILE = 'sync-server/src/app.ts';
const PROVIDER_REGISTRY_FILE = 'src/services/onlineMusic/providerRegistry.ts';

const readSource = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const toRepoPath = (root: string, absolute: string): string => path.relative(root, absolute).split(path.sep).join('/');

// ---------------------------------------------------------------------------
// preload 暴露面

/** 用 vm 跑一遍 preload，把 contextBridge 暴露的对象和 ipcRenderer 的 invoke/send 通道记下来。 */
export function buildPreloadManifest(root: string = repoRoot): PreloadManifest {
    const exposed: Array<{ namespace: string; surface: Record<string, unknown> }> = [];
    const members = new Map<string, Set<string>>();
    const invokeChannels = new Map<string, Set<string>>();
    const sendChannels = new Map<string, Set<string>>();
    let currentNamespace = '';
    let currentMember = '';

    const bucket = <T>(map: Map<string, Set<T>>, namespace: string): Set<T> => {
        let set = map.get(namespace);
        if (!set) {
            set = new Set<T>();
            map.set(namespace, set);
        }
        return set;
    };

    const record = (kind: 'invoke' | 'send', channel: unknown): void => {
        if (!currentNamespace || !currentMember || typeof channel !== 'string') return;
        bucket(kind === 'invoke' ? invokeChannels : sendChannels, currentNamespace).add(channel);
    };

    const contextBridge = {
        exposeInMainWorld: (namespace: string, surface: unknown): void => {
            exposed.push({ namespace, surface: surface as Record<string, unknown> });
            bucket(members, namespace);
        },
    };
    const ipcRenderer = {
        invoke: (channel: unknown): Promise<null> => {
            record('invoke', channel);
            return Promise.resolve(null);
        },
        send: (channel: unknown): void => {
            record('send', channel);
        },
        on: (): void => undefined,
        removeListener: (): void => undefined,
    };
    const electron = {
        contextBridge,
        ipcRenderer,
        webUtils: { getPathForFile: (): null => null },
    };
    const sandbox = {
        require: (id: string): unknown => {
            if (id === 'electron') return electron;
            throw new Error(`[contracts] preload 只允许 require('electron')，解析器不认：${id}`);
        },
        process: {
            platform: 'linux',
            env: {},
            pid: 0,
            getProcessMemoryInfo: () => Promise.resolve({ private: 0, shared: 0 }),
            getBlinkMemoryInfo: () => ({ allocated: 0 }),
        },
    };
    vm.runInNewContext(readSource(root, PRELOAD_FILE), sandbox, { filename: PRELOAD_FILE });

    if (exposed.length === 0) {
        throw new Error('[contracts] preload 没有调用 contextBridge.exposeInMainWorld');
    }

    const walk = (namespace: string, prefix: string, surface: Record<string, unknown>): void => {
        for (const key of Object.keys(surface).sort()) {
            const memberPath = prefix ? prefix + '.' + key : key;
            const value = surface[key];
            if (typeof value === 'function') {
                bucket(members, namespace).add(memberPath);
                currentNamespace = namespace;
                currentMember = memberPath;
                try {
                    const result = (value as (...args: string[]) => unknown)('contract-probe', 'contract-probe', 'contract-probe');
                    if (result instanceof Promise) result.catch(() => undefined);
                } catch {
                    // 探针参数不是真实调用方给的，调用失败不影响「这个成员存在」这件事。
                } finally {
                    currentNamespace = '';
                    currentMember = '';
                }
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                walk(namespace, memberPath, value as Record<string, unknown>);
            } else {
                bucket(members, namespace).add(memberPath);
            }
        }
    };

    const namespaces: PreloadManifest['namespaces'] = {};
    for (const entry of [...exposed].sort((left, right) => (left.namespace < right.namespace ? -1 : 1))) {
        walk(entry.namespace, '', entry.surface);
        namespaces[entry.namespace] = {
            members: [...bucket(members, entry.namespace)].sort(),
            invokeChannels: [...bucket(invokeChannels, entry.namespace)].sort(),
            sendChannels: [...bucket(sendChannels, entry.namespace)].sort(),
        };
    }
    return { namespaces };
}

// ---------------------------------------------------------------------------
// sync-server 路由

type ImportedName = { local: string; file: string; exportName: string };

type RouteDeclaration = { receiver: string; method: string; path: string; line: number };

/** 解析 import，返回「本地标识符 -> 源文件 + 导出名」；只跟相对路径。 */
function parseLocalImports(source: string, file: string, root: string): ImportedName[] {
    const imports: ImportedName[] = [];
    // 锚在行首，避免从 "import ... from 'hono'" 一路吞到下一个相对 import。
    const importPattern = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(source))) {
        const clause = match[1];
        if (!match[2].startsWith('.')) continue;
        const resolved = resolveLocalModule(file, match[2], root);
        const defaultName = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
        if (defaultName) imports.push({ local: defaultName[1], file: resolved, exportName: 'default' });
        const named = clause.match(/\{([\s\S]*?)\}/);
        if (named) {
            for (const part of named[1].split(',')) {
                const piece = part.trim();
                if (!piece) continue;
                const [imported, local] = piece.split(/\s+as\s+/);
                imports.push({ local: (local ?? imported).trim(), file: resolved, exportName: imported.trim() });
            }
        }
    }
    return imports;
}

function resolveLocalModule(fromFile: string, specifier: string, root: string): string {
    const base = path.resolve(path.dirname(path.join(root, fromFile)), specifier);
    for (const candidate of [base.replace(/\.js$/, '.ts'), base + '.ts', base]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return toRepoPath(root, candidate);
    }
    throw new Error(`[contracts] 解析不到 import：${fromFile} -> ${specifier}`);
}

const ROUTE_METHOD = 'get|post|put|delete|patch|all';

/** 行首的 recv.method('/path', ...)。注释行以 * 或 // 开头，不会命中。 */
function routeDeclarations(lines: string[]): RouteDeclaration[] {
    const out: RouteDeclaration[] = [];
    const pattern = new RegExp('^\\s*([A-Za-z_$][\\w$]*)\\.(' + ROUTE_METHOD + ')\\(\\s*\'([^\']*)\'');
    for (let line = 0; line < lines.length; line += 1) {
        const match = lines[line].match(pattern);
        if (match) out.push({ receiver: match[1], method: match[2].toUpperCase(), path: match[3], line });
    }
    return out;
}

/** 同文件里用 const/function 定义、可能返回 Hono 实例的工厂函数名。 */
function localFunctionNames(lines: string[]): Set<string> {
    const names = new Set<string>();
    for (const line of lines) {
        const arrow = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
        if (arrow) names.add(arrow[1]);
        const declared = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
        if (declared) names.add(declared[1]);
    }
    return names;
}

/** 从 start 行往后找块结束；仓库里顶层 IIFE 收在 `})();`，函数收在 `};` 或 `}`。 */
function findBlockEnd(lines: string[], start: number, closing: RegExp): number {
    for (let line = start + 1; line < lines.length; line += 1) {
        // 只认顶格收尾：函数体里缩进的 } 不结束外层块。
        if (closing.test(lines[line])) return line;
    }
    throw new Error(`[contracts] 找不到块结束（从第 ${start + 1} 行开始）`);
}

function factoryBodyRange(lines: string[], factory: string): [number, number] {
    const start = lines.findIndex((line) => new RegExp('^(?:export\\s+)?(?:(?:const|let)\\s+' + factory + '\\b|(?:async\\s+)?function\\s+' + factory + '\\b)').test(line));
    if (start < 0) throw new Error(`[contracts] 找不到路由工厂函数：${factory}`);
    return [start, findBlockEnd(lines, start, /^(?:};|\})$/)];
}

/** 找出某个导出背后的 Hono 实例；同一个文件里多份路由靠作用域 + 接收者名区分。 */
function routesForExport(root: string, file: string, exportName: string): RouteDeclaration[] {
    const lines = readSource(root, file).split('\n');
    const declarations = routeDeclarations(lines);
    const localFunctions = localFunctionNames(lines);
    const receivers = new Set<string>();
    const scopes: Array<[number, number]> = [];
    const pendingScopes: Array<[number, number]> = [];
    const pendingFactories: string[] = [];
    const visitedRanges = new Set<string>();

    const addScope = (start: number, end: number): void => {
        const key = start + ':' + end;
        if (visitedRanges.has(key)) return;
        visitedRanges.add(key);
        scopes.push([start, end]);
        pendingScopes.push([start, end]);
    };

    if (exportName === 'default') {
        const start = lines.findIndex((line) => /^export\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$/.test(line));
        if (start < 0) throw new Error(`[contracts] ${file} 里没有 export default`);
        receivers.add(lines[start].match(/^export\s+default\s+([A-Za-z_$][\w$]*)/)![1]);
    } else {
        const start = lines.findIndex((line) => new RegExp('^export\\s+const\\s+' + exportName + '\\b').test(line));
        if (start < 0) throw new Error(`[contracts] ${file} 里没有导出：${exportName}`);
        const equality = lines[start].indexOf('=');
        const rightHandSide = equality < 0 ? '' : lines[start].slice(equality + 1).trim();
        if (/^new\s+Hono\b/.test(rightHandSide)) {
            receivers.add(exportName);
        } else if (/^\(\s*(?:async\s*)?\(\s*\)\s*=>|^\(function\b/.test(rightHandSide)) {
            addScope(start, findBlockEnd(lines, start, /^\}\)\(\);?$/));
        } else {
            const call = rightHandSide.match(/^([A-Za-z_$][\w$]*)\s*\(/);
            if (!call) throw new Error(`[contracts] ${file} 的导出 ${exportName} 不是可识别的 Hono 定义`);
            pendingFactories.push(call[1]);
        }
    }

    while (pendingScopes.length || pendingFactories.length) {
        const scope = pendingScopes.shift();
        if (scope) {
            for (let line = scope[0]; line <= scope[1]; line += 1) {
                const declared = lines[line].match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(new\s+Hono\b|([A-Za-z_$][\w$]*)\s*\()/);
                if (!declared) continue;
                receivers.add(declared[1]);
                if (!declared[2].startsWith('new') && declared[3] && localFunctions.has(declared[3])) {
                    pendingFactories.push(declared[3]);
                }
            }
        }
        const factory = pendingFactories.shift();
        if (factory) addScope(...factoryBodyRange(lines, factory));
    }

    const inScope = (line: number): boolean => scopes.length === 0 || scopes.some(([start, end]) => line >= start && line <= end);
    return declarations.filter((declaration) => receivers.has(declaration.receiver) && inScope(declaration.line));
}

function joinMountPath(prefix: string, routePath: string): string {
    const left = prefix === '/' ? '' : prefix.replace(/\/$/, '');
    if (!routePath || routePath === '/') return left || '/';
    return left + (routePath.startsWith('/') ? routePath : '/' + routePath);
}

export function buildSyncServerRoutesManifest(root: string = repoRoot): SyncServerRoutesManifest {
    const source = readSource(root, APP_FILE);
    const lines = source.split('\n');
    const imports = parseLocalImports(source, APP_FILE, root);
    const routes: SyncServerRoutesManifest['routes'] = [];
    const seen = new Set<string>();
    const push = (method: string, routePath: string, handlerFile: string): void => {
        const key = method + ' ' + routePath + ' ' + handlerFile;
        if (seen.has(key)) return;
        seen.add(key);
        routes.push({ method, path: routePath, handlerFile });
    };

    for (const declaration of routeDeclarations(lines)) {
        if (declaration.receiver === 'app') push(declaration.method, declaration.path, APP_FILE);
    }

    for (const line of lines) {
        const mount = line.match(/^\s*app\.route\(\s*'([^']*)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/);
        if (!mount) continue;
        const prefix = mount[1];
        const local = mount[2];
        const imported = imports.find((entry) => entry.local === local);
        const mounted: RouteDeclaration[] = imported
            ? routesForExport(root, imported.file, imported.exportName)
            : routeDeclarations(lines).filter((declaration) => declaration.receiver === local);
        const handlerFile = imported ? imported.file : APP_FILE;
        if (mounted.length === 0) {
            throw new Error(`[contracts] ${APP_FILE} 挂载的 ${local} 一条路由都没解析到；解析器可能已落后于写法`);
        }
        for (const declaration of mounted) push(declaration.method, joinMountPath(prefix, declaration.path), handlerFile);
    }

    routes.sort((left, right) => (left.path === right.path
        ? (left.method < right.method ? -1 : 1)
        : (left.path < right.path ? -1 : 1)));
    return { routes };
}

// ---------------------------------------------------------------------------
// omni provider

/**
 * 跳过字符串、模板字面量、正则字面量与注释，找到与 openIndex 的 { 配对的 }。
 *
 * 正则字面量要单独认：`/itunes:timing="([^"]+)"/` 里有一个引号，当成字符串开头就会一路吃到行尾，
 * 后面的花括号就再也配不平（Apple Music 的 provider 工厂第一版就是这么挂的）。
 */
function matchingBrace(source: string, openIndex: number): number {
    let depth = 0;
    let quote = '';
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (char === '\\') index += 1;
            else if (char === quote) quote = '';
            continue;
        }
        const next = source[index + 1];
        if (char === '/' && next === '/') {
            index = source.indexOf('\n', index);
            if (index < 0) break;
            continue;
        }
        if (char === '/' && next === '*') {
            index = source.indexOf('*/', index + 2);
            if (index < 0) break;
            index += 1;
            continue;
        }
        if (char === '/' && startsRegexLiteral(source, index)) {
            index = skipRegexLiteral(source, index);
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error('[contracts] 找不到对象字面量的结尾');
}

/**
 * 这个 `/` 是不是正则字面量的开头：看前一个非空白字符。
 * 前面是标识符、数字、`)`、`]` 或 `}` 时是除号；其余（`=`、`(`、`,`、`return`、行首……）当正则。
 */
function startsRegexLiteral(source: string, index: number): boolean {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const char = source[cursor];
        if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue;
        return !(/[A-Za-z0-9_$)\]}]/.test(char));
    }
    return true;
}

/** 跳过正则字面量（含末尾的 flags）与字符类里的转义，返回收尾的 `/` 之后一格。 */
function skipRegexLiteral(source: string, index: number): number {
    let inClass = false;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (char === '\\') {
            cursor += 1;
        } else if (char === '\n') {
            return cursor;
        } else if (inClass) {
            if (char === ']') inClass = false;
        } else if (char === '[') {
            inClass = true;
        } else if (char === '/') {
            return cursor;
        }
    }
    return source.length - 1;
}

/** 对象顶层某个字符串属性；只看 depth 1，避免把方法体里的同名键当成 provider id。 */
function topLevelStringProperty(objectSource: string, key: string): string | null {
    let depth = 0;
    let quote = '';
    for (let index = 0; index < objectSource.length; index += 1) {
        const char = objectSource[index];
        if (quote) {
            if (char === '\\') index += 1;
            else if (char === quote) quote = '';
            continue;
        }
        const next = objectSource[index + 1];
        if (char === '/' && next === '/') {
            index = objectSource.indexOf('\n', index);
            if (index < 0) break;
            continue;
        }
        if (char === '/' && next === '*') {
            index = objectSource.indexOf('*/', index + 2);
            if (index < 0) break;
            index += 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
        } else if (char === '{' || char === '[' || char === '(') {
            depth += 1;
        } else if (char === '}' || char === ']' || char === ')') {
            depth -= 1;
        } else if (depth === 1 && objectSource.startsWith(key, index)
            && !/[\w$]/.test(objectSource[index - 1] ?? '')
            && !/[\w$]/.test(objectSource[index + key.length] ?? '')) {
            const literal = objectSource.slice(index + key.length).match(/^\s*:\s*'([^']*)'/);
            if (literal) return literal[1];
        }
    }
    return null;
}

function providerIdFromModule(root: string, file: string, exportName: string): string {
    const source = readSource(root, file);
    // 导出可能就是对象字面量（`export const xProvider = { ... }`），也可能是工厂吐出来的
    // （`export const xProvider = createXProvider(...)`，Apple Music 那种）：两种都要认。
    const declaration = new RegExp('export\\s+const\\s+' + exportName + '\\b[^=]*=\\s*').exec(source);
    if (!declaration) throw new Error(`[contracts] ${file} 里没有导出：${exportName}`);
    const valueStart = declaration.index + declaration[0].length;
    if (source[valueStart] === '{') {
        const id = topLevelStringProperty(source.slice(valueStart, matchingBrace(source, valueStart) + 1), 'id');
        if (!id) throw new Error(`[contracts] ${file} 的 ${exportName} 没有顶层 id`);
        return id;
    }
    // 工厂调用：顺着它调的那个工厂函数名回到本文件里找它的返回对象。
    const factory = /^([A-Za-z_$][\w$]*)\s*\(/.exec(source.slice(valueStart));
    if (!factory) throw new Error(`[contracts] ${file} 的 ${exportName} 既不是对象字面量也不是工厂调用`);
    const body = factoryReturnObject(source, factory[1]);
    const id = body === null ? null : topLevelStringProperty(body, 'id');
    if (!id) throw new Error(`[contracts] ${file} 的 ${exportName}（${factory[1]}）里没有顶层的 id 字面量`);
    return id;
}

/**
 * 本文件里某个工厂函数的返回对象字面量；找不到返回 null。
 *
 * 工厂体里还有别的小函数也在 `return {`（先把入参整理成对象那种），所以这里先找到函数体的
 * 收尾，再取**缩进最浅**的那个 `return {` —— 工厂自己的那个写在顶层缩进上。
 */
function factoryReturnObject(source: string, functionName: string): string | null {
    const declared = new RegExp(
        '(?:export\\s+)?function\\s+' + functionName + '\\s*[\\(<]|(?:export\\s+)?const\\s+' + functionName + '\\s*=\\s*[\\(<]',
    ).exec(source);
    if (!declared) return null;
    const openIndex = source.indexOf('{', declared.index + declared[0].length);
    if (openIndex < 0) return null;
    const endIndex = matchingBrace(source, openIndex);
    const body = source.slice(openIndex, endIndex + 1);
    const returns = [...body.matchAll(/^([ \t]*)return\s*\{/gm)];
    if (returns.length === 0) return null;
    const shallowest = returns.reduce((best, entry) => (entry[1].length < best[1].length ? entry : best));
    const literalStart = openIndex + shallowest.index + shallowest[0].length - 1;
    return source.slice(literalStart, matchingBrace(source, literalStart) + 1);
}

export function buildOmniProvidersManifest(root: string = repoRoot): OmniProvidersManifest {
    const source = readSource(root, PROVIDER_REGISTRY_FILE);
    const imports = parseLocalImports(source, PROVIDER_REGISTRY_FILE, root);
    const providers: string[] = [];
    // 锚在行首：注释掉或缩进示例里的注册不应该进 manifest。
    const pattern = /^registerOnlineMusicProvider\(\s*([A-Za-z_$][\w$]*)\s*\)/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        const imported = imports.find((entry) => entry.local === match![1]);
        if (!imported) throw new Error(`[contracts] 无法解析 provider 注册：${match[1]}（注册参数要是 import 进来的标识符）`);
        providers.push(providerIdFromModule(root, imported.file, imported.exportName));
    }
    if (providers.length === 0) throw new Error(`[contracts] ${PROVIDER_REGISTRY_FILE} 里没有 registerOnlineMusicProvider 调用`);
    return { providers: [...new Set(providers)].sort() };
}

// ---------------------------------------------------------------------------
// manifest 读写与 CLI

const MANIFESTS: Record<ManifestName, (root?: string) => unknown> = {
    preload: buildPreloadManifest,
    'sync-server-routes': buildSyncServerRoutesManifest,
    'omni-providers': buildOmniProvidersManifest,
};

export function manifestFile(name: ManifestName): string {
    return MANIFEST_DIR + '/' + name + '.json';
}

export function serializeManifest(manifest: unknown): string {
    return JSON.stringify(manifest, null, 2) + '\n';
}

export function readManifest(name: ManifestName, root: string = repoRoot): unknown {
    const file = path.join(root, manifestFile(name));
    if (!fs.existsSync(file)) {
        throw new Error(`[contracts] 缺少 ${manifestFile(name)}：先跑 node ci/contracts/extract.ts --update`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 按当前实现生成全部 manifest；--update 重写，校验模式拿来逐份比较。 */
export function buildManifests(root: string = repoRoot): Record<ManifestName, unknown> {
    const built = {} as Record<ManifestName, unknown>;
    for (const name of Object.keys(MANIFESTS) as ManifestName[]) built[name] = MANIFESTS[name](root);
    return built;
}

export function writeManifests(root: string = repoRoot): string[] {
    const built = buildManifests(root);
    const written: string[] = [];
    for (const name of Object.keys(MANIFESTS) as ManifestName[]) {
        const file = path.join(root, manifestFile(name));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializeManifest(built[name]));
        written.push(manifestFile(name));
    }
    return written;
}

/** 与仓库里已提交的 manifest 比，返回不一致的文件列表；比较的是序列化文本，格式漂移也算。 */
export function manifestDrift(root: string = repoRoot): string[] {
    const built = buildManifests(root);
    const drift: string[] = [];
    for (const name of Object.keys(MANIFESTS) as ManifestName[]) {
        const file = path.join(root, manifestFile(name));
        const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (serializeManifest(built[name]) !== committed) drift.push(manifestFile(name));
    }
    return drift;
}

function main(): void {
    const update = process.argv.slice(2).includes('--update');
    if (update) {
        const written = writeManifests();
        console.log('[contracts] 已按当前实现重写 manifest：' + written.join('、'));
        return;
    }
    const drift = manifestDrift();
    if (drift.length === 0) {
        console.log('[contracts] manifest 与当前实现一致：' + (Object.keys(MANIFESTS) as ManifestName[]).map(manifestFile).join('、'));
        return;
    }
    console.error('[contracts] manifest 与当前实现不一致：');
    for (const file of drift) console.error('  ' + file);
    console.error('[contracts] 确认实现改动后跑 node ci/contracts/extract.ts --update，并把 manifest 的 diff 一起提交。');
    process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();