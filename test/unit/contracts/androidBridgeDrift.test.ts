// test/unit/contracts/androidBridgeDrift.test.ts
// 安卓桥的漂移检查（issue M35）：原生有的方法要进文档，文档记的要真在原生，页面侧的类型要能对上。
//
// 为什么要有它：桥方法改名或删掉时，页面侧不会报错 —— 所有桥方法在类型里都是可选的，
// 调用点一律「没有就回落」。于是改了原生、忘了改页面，表现只是「功能看着还在，其实没走原生」，
// 静默且难查。这份用例把三方（原生 Kotlin / 契约文档 / 页面侧类型）的名字对齐一次。

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const PLUGIN_KT = 'android/app/src/main/java/top/izuna/foliamajor/FoliaNativePlugin.kt';
const CONTRACT_DOC = 'docs/contracts/android-bridge.md';

const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

/**
 * 原生侧登记的方法名。
 *
 * 认 `@PluginMethod` 后面紧跟的 `fun <名字>(call: PluginCall)`；注解与方法之间允许有空格和换行
 * （现有代码是紧挨着的，但排版调整不该让检查失效）。
 */
const nativeMethods = (): string[] => {
    const source = read(PLUGIN_KT);
    const found = new Set<string>();
    const pattern = /@PluginMethod\s+fun\s+([a-zA-Z][a-zA-Z0-9]*)\s*\(\s*call\s*:/g;
    for (const match of source.matchAll(pattern)) found.add(match[1]);
    return [...found].sort();
};

/**
 * 契约文档里点名的方法：**表格里**反引号包起来的标识符。
 *
 * 只认表格行（`|` 开头）里的反引号，是因为正文里也会用反引号提到别的概念
 * （`FoliaSettingsStore`、`void`、`JSObject` 这些是类型或类名，不是桥方法）。
 * 表格是「一个方法一行」的登记处，正文不是。
 */
const documentedMethods = (): string[] => {
    const source = read(CONTRACT_DOC);
    const start = source.indexOf('## 方法清单');
    if (start < 0) throw new Error('契约文档里找不到「## 方法清单」一节');
    const end = source.indexOf('\n## ', start + 1);
    const body = source.slice(start, end < 0 ? undefined : end);
    const found = new Set<string>();
    for (const line of body.split('\n')) {
        if (!line.trimStart().startsWith('|')) continue;
        for (const match of line.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g)) found.add(match[1]);
    }
    return [...found].sort();
};

/**
 * 页面侧「`FoliaNative` 插件类型」里声明成方法的方法名 —— 也就是真正要发给它的那些。
 *
 * 三道筛子，缺一个就会混进噪声：
 *   1. **只认 `type NativeXxxPlugin = { ... }` / `type NativeXxx = { ... }`**：这些名字是
 *      「这个插件长什么样」的声明。`src/services/` 里还有大量业务对象的可选方法
 *      （`aiCloudCache.ts` 的 `canGenerate` 之类），跟桥没关系。
 *   2. **只认同样是 `Native*` 名字的类型块**，避免把 `type Foo = {...}` 这类业务类型算进来。
 *   3. **排除指向别的插件的文件**：`nativeQueueBridge.ts` 用的是 `FoliaPlayback`、
 *      `nativePlayerPlugin.ts` 用的是 `FoliaNativePlayer`，它们的类型块名字也以 `Native`
 *      开头，但那是另一份契约（不在这份文档里）。判据是文件里出现的插件名。
 *
 * 块内认 `name?: (...)` 与 `name: (...)` 两种属性签名。
 */
const pageSideDeclaredMethods = (): { file: string; name: string }[] => {
    const dir = path.join(repoRoot, 'src/services');
    const out: { file: string; name: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const source = readFileSync(path.join(dir, entry.name), 'utf8');
        // 这个文件里出现的插件名。只要它提到了 FoliaNative，就把它的 Native* 类型块算进来；
        // 只提到别的插件（FoliaPlayback / FoliaNativePlayer）的文件跳过。
        const namesPlugin = /\bFoliaNative\b/.test(source);
        if (!namesPlugin) continue;
        const blocks = source.matchAll(/type\s+Native[A-Za-z]*\s*=\s*\{([\s\S]*?)\n\};/g);
        for (const block of blocks) {
            for (const match of block[1].matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\??:\s*\(/gm)) {
                out.push({ file: `src/services/${entry.name}`, name: match[1] });
            }
        }
    }
    return out;
};

describe('安卓桥契约漂移', () => {
    const native = nativeMethods();
    const documented = documentedMethods();

    it('原生侧确实扫到了方法（防止正则失效导致这个用例永远绿）', () => {
        // 数量下限：现在是 50 多个，低于 40 说明扫描规则坏了，而不是「原生真的删光了」。
        expect(native.length).toBeGreaterThan(40);
        expect(native).toContain('runAiCompletion');
        expect(native).toContain('getBackgroundThemeResult');
    });

    it('原生有、文档没有 —— 新方法忘了登记契约', () => {
        const missing = native.filter(name => !documented.includes(name));
        expect(missing).toEqual([]);
    });

    it('文档有、原生没有 —— 文档记着已经删掉的方法', () => {
        const phantom = documented.filter(name => !native.includes(name));
        expect(phantom).toEqual([]);
    });

    it('页面侧类型声明的方法，原生侧都有 —— 不会调用一个不存在的桥方法', () => {
        const declared = pageSideDeclaredMethods();
        // 下限：扫不到任何声明说明正则与实际写法脱节了。
        expect(declared.length).toBeGreaterThan(5);
        const phantom = declared.filter(entry => !native.includes(entry.name));
        expect(phantom).toEqual([]);
    });
});
