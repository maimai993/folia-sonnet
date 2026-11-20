import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// test/unit/mod-system/androidTrustRoot.test.ts
// 安卓的信任根（启用状态 + 内容摘要）不能和模组目录放在同一棵树里。
//
// 为什么值得单独钉：模组在 Node 宿主里拿到的是真的 `fs`，而 userData（`mods/` 所在的那棵树）
// 落在外部存储上，模组自己能读写。把授权记录放回去，摘要绑定就形同虚设——改一行
// `enabled: true`、配上刚算好的摘要，重启即生效。这里读 host.js 的源码结构来守住这三条：
//   1. 信任文件在 FOLIA_TRUST_DIR（Java 传进来的应用私有目录）下，不在 userData 下；
//   2. 读信任文件是 fail closed：坏 JSON、版本不认识、记录形状不对，都按「未授权」；
//   3. 启用必须带摘要，且和目录当前摘要一致（宿主自己会再算一遍）。

const hostPath = path.resolve('android/app/src/main/assets/folia-node/host.js');
const source = fs.readFileSync(hostPath, 'utf8');
const require = createRequire(import.meta.url);

/** 抽出 host.js 里一个 `const NAME = ...;` 起的顶层声明（到下一个空行为止的近似）。 */
const sliceDeclaration = (startMarker: string, length = 4000): string => {
    const index = source.indexOf(startMarker);
    expect(index, `host.js 里找不到 ${startMarker}`).toBeGreaterThan(-1);
    return source.slice(index, index + length);
};

describe('the Android trust root', () => {
    it('keeps the trust file under FOLIA_TRUST_DIR, not under userData', () => {
        const trustDir = sliceDeclaration('const trustDir = (() => {', 500);
        // 先读 Java 传进来的应用私有目录，拿不到才退回 userData（浏览器预览、老原生层）。
        expect(trustDir).toContain('process.env.FOLIA_TRUST_DIR');
        expect(trustDir.indexOf('process.env.FOLIA_TRUST_DIR')).toBeLessThan(trustDir.indexOf('path.join(userDataDir'));
        // 信任文件名在这棵树下，而不是 userData 根目录下的 mod-system.json。
        expect(source).toContain("const trustPath = path.join(trustDir, 'mod-trust.json');");
        expect(source).not.toMatch(/const trustPath = path\.join\(userDataDir/);
    });

    it('says out loud in the settings file path that settings are not the trust root', () => {
        // 设置里只留模组系统总开关这类不构成授权的状态；启用记录一律在信任文件里。
        const settings = sliceDeclaration('const settingsPath =', 200);
        expect(settings).toContain("path.join(userDataDir, 'mod-system.json')");
        expect(source).toContain('settings.mods = {};');
    });

    it('reads the trust file fail closed', () => {
        const reader = sliceDeclaration('const readTrustFile = () => {', 2400);
        // 坏 JSON / 版本不认识 / 缺 mods 表 / 单条记录形状不对：都记 error 日志并当没有授权。
        expect(reader).toContain('损坏或不可读');
        expect(reader).toContain('不认识');
        expect(reader).toContain('缺少 mods 表');
        expect(reader).toContain('形状不对');
        // 解析失败时返回的是一张空表，不是解析出来的半个对象。
        expect(reader).toMatch(/if \(parsed === null\)/);
    });

    it('only accepts a sha256 digest as a trust binding', () => {
        const isTrustDigest = sliceDeclaration('const isTrustDigest =', 200);
        expect(isTrustDigest).toContain('^sha256:[0-9a-f]{64}$');
        // 一条「启用」记录必须带合规摘要；关掉的记录摘要只能是 null。
        const isTrustRecord = sliceDeclaration('const isTrustRecord =', 400);
        expect(isTrustRecord).toContain('isTrustDigest(record.digest)');
    });

    it('refuses to enable a mod without a digest, and refuses one that changed since confirmation', () => {
        const writeEnabled = sliceDeclaration('const writeEnabled =', 700);
        expect(writeEnabled).toContain('if (enabled === true && !isTrustDigest(digest))');
        expect(writeEnabled).toContain('return false;');

        const setEnabled = sliceDeclaration("'set-enabled':", 2200);
        // 宿主自己重新算一遍摘要，而不是相信调用方送来的值。
        expect(setEnabled).toContain('const current = computeModDigest(item.dirPath);');
        expect(setEnabled).toContain('enable-digest-mismatch');
        expect(setEnabled).toContain("'mod-content-unverifiable'");
    });

    it('revokes the approval when the files no longer match the digest', () => {
        const trustState = sliceDeclaration('const trustStateOf =', 2000);
        expect(trustState).toContain('record.digest === digest');
        // 对不上就把记录改成未启用并写回：下次启动仍然是「需要重新确认」。
        expect(trustState).toContain('trust.mods[modId] = { enabled: false, digest: null, confirmedAt: null };');
        expect(trustState).toContain('writeTrust();');
        // 内置模组第一次跑时把自己这一份内容记成已确认（随包发布，没有第三方代码）。
        expect(trustState).toContain('BUILTIN_MOD_IDS.has(modId)');
    });

    it('migrates the old userData records without trusting a third-party "enabled"', () => {
        const migrate = sliceDeclaration('const migrateLegacyTrust = () => {', 2400);
        // 只迁移「用户明确关掉」和内置模组；第三方模组的启用记录不搬，要求重新确认。
        expect(migrate).toContain('record.enabled === false');
        expect(migrate).toContain('BUILTIN_MOD_IDS.has(modId)');
        expect(migrate).not.toMatch(/if \(record\.enabled === true\) \{\s*trust\.mods\[modId\] = \{ enabled: true/);
        // 迁移只做一次。
        expect(migrate).toContain('MIGRATION_MARKER');
    });

    it('installs a zip without enabling it', () => {
        const install = sliceDeclaration("'install-zip': async", 900);
        expect(install).not.toContain('writeEnabled');
        expect(install).toContain('needsConfirmation: true');
    });
});

describe('host.js parses', () => {
    it('is syntactically valid CommonJS', () => {
        const vm = require('vm') as typeof import('vm');
        expect(() => new vm.Script(source, { filename: hostPath })).not.toThrow();
    });
});
