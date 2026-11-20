import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/security/androidLogRedaction.test.ts
// issue M24：投送这条路上的日志行不许出现凭据与设备地址。
//  - 令牌（投送的访问凭据）的值不许拼进 Log.* 的文案里（文案里点名这个词不算，拼值才算）；
//  - 含主机与端口的完整地址不许直接拼进 Log.*（要先过 LanCastLogText 的网段化）。
// 这里扫源码文本：真要跑的脱敏逻辑在 test/unit/android/LanCastLogTextTest.kt 里逐条核对。

const ROOT = path.join(__dirname, '..', '..', '..');
const KOTLIN_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'top', 'izuna', 'foliamajor');

/** 投送相关的 Kotlin 源文件：这几个文件里的日志行就是 M24 的范围。 */
const LAN_CAST_FILES = [
    'FoliaLanCastPlugin.kt',
    'LocalAudioServer.kt',
    'LanCastLeaseRegistry.kt',
    'LanCastTargetPolicy.kt',
];

/** 日志调用（可能跨行）：从 `Log.x(` 那个左括号开始，按括号配平取出整段。 */
const logCalls = (source: string): string[] => {
    const calls: string[] = [];
    const opener = /Log\.[wied]\(/g;
    for (let hit = opener.exec(source); hit !== null; hit = opener.exec(source)) {
        let depth = 0;
        let index = source.indexOf('(', hit.index);
        const start = index;
        for (; index < source.length; index += 1) {
            if (source[index] === '(') depth += 1;
            else if (source[index] === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        calls.push(source.slice(start, index + 1));
    }
    return calls;
};

/**
 * 把一段 Kotlin 代码里的**字符串字面量**换成空格，其余原样。
 *
 * 这样 `"unknown token"` 这种文案里点名的词不会误报，而 `+ token`、`"$token"`、`"${token}"`
 * 这些真正把值拼进日志的写法仍然留在文本里（插值的变量名在字面量里面，所以先把插值本身
 * `$x` / `${x}` 单独抠出来留在原地）。
 */
const withoutLiterals = (code: string): string => code.replace(/"(?:[^"\\\n]|\\.)*"/g, literal => {
    const interpolated = literal
        .slice(1, -1)
        .match(/\$\{?[A-Za-z_][A-Za-z0-9_.]*\}?/g) ?? [];
    return ' ' + interpolated.join(' ') + ' ';
});

/**
 * 这一行日志里有没有真的把一个令牌的**值**拼进去。
 *
 * 只看 `token` 这个名字不够：`LanCastLogText.tokenHint(token)` 是先脱敏再进日志的，
 * 参数里出现令牌是对的。所以先把脱敏调用的参数去掉再看。
 */
const appendsTokenValue = (call: string): boolean => (
    /\b\w*token\b/i.test(withoutLiterals(call).replace(/LanCastLogText\.\w+\([^()]*\)/g, ' '))
);

/**
 * 这一行日志里有没有把一个带主机 / 端口的**完整地址**拼进去。
 *
 * 三种写法都要抓到：`+ location`、`"$location"` 这种插值（字面量被抹掉后变量名还留着）、
 * 以及整个地址对象 `target`；`target.name` 这种只是文件 / 资源名，不算。
 * `locates` / `operations` 这类名字里恰好含 location 的标识符不算。
 */
const appendsAddressValue = (call: string): boolean => {
    const code = withoutLiterals(call);
    if (/\b(location|controlUrl|controlPath|remoteHost|hostAddress|deviceUrl)\b/.test(code)) return true;
    return /\btarget\b(?!\s*\.)/.test(code);
};

const readAll = (): { name: string; calls: string[] }[] => LAN_CAST_FILES.map(name => {
    const source = fs.readFileSync(path.join(KOTLIN_DIR, name), 'utf8');
    return { name, calls: logCalls(source) };
});

describe('LanCast 日志行不带凭据与设备地址', () => {
    it('投送令牌的值不拼进日志行', () => {
        const offenders: string[] = [];
        for (const file of readAll()) {
            for (const call of file.calls) {
                if (appendsTokenValue(call)) offenders.push(`${file.name}: ${call.replace(/\s+/g, ' ')}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('含主机与端口的完整地址不直接拼进日志行', () => {
        // LOCATION / controlUrl / 上游音频地址 / 来源 IP：这些值都带主机（还常常带端口）。
        const offenders: string[] = [];
        for (const file of readAll()) {
            for (const call of file.calls) {
                if (!appendsAddressValue(call)) continue;
                // 过了 LanCastLogText 的算是已经网段化，放行。
                if (call.includes('LanCastLogText.')) continue;
                offenders.push(`${file.name}: ${call.replace(/\s+/g, ' ')}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('扫描本身是有效的：能在一份故意违规的样本里抓出每一处', () => {
        const sample = [
            'Log.w(TAG, "remote audio token unknown: " + token)',
            'Log.w(TAG, "read description failed: $location", error)',
            'Log.w(TAG, "via " + lanToken + " and " + remoteHost)',
            'Log.w(TAG, "dropped: " + target.name)',
            'Log.w(TAG, "upstream for " + target)',
            // 先脱敏再进日志：这几行是对的，不该被当成违规。
            'Log.w(TAG, "ok: " + LanCastLogText.tokenHint(token))',
            'Log.w(TAG, "ok: " + LanCastLogText.deviceHint(location))',
            'Log.w(TAG, "lan cast request with a token outside the current lease")',
        ].join('\n');
        const calls = logCalls(sample);
        expect(calls).toHaveLength(8);
        // 两处把令牌的值拼进去了：原文 token、lanToken。先脱敏的 tokenHint 只交出「令牌形态」，不算。
        expect(calls.filter(appendsTokenValue)).toHaveLength(2);
        // 三处把完整地址拼进去了：$location 插值、remoteHost、整个 target。
        // 先脱敏的 deviceHint（只交出资源名）与 `target.name` 不算。
        const leakedAddresses = calls.filter(call => appendsAddressValue(call) && !call.includes('LanCastLogText.'));
        expect(leakedAddresses).toHaveLength(3);
        expect(appendsAddressValue(calls[3])).toBe(false);
        expect(appendsAddressValue(calls[4])).toBe(true);
    });

    it('所有投送相关的 Kotlin 文件都能读到', () => {
        for (const name of LAN_CAST_FILES) {
            expect(fs.existsSync(path.join(KOTLIN_DIR, name)), name).toBe(true);
        }
        expect(readAll().reduce((sum, file) => sum + file.calls.length, 0)).toBeGreaterThan(15);
    });
});
