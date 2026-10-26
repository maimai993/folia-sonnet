import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAllowlist, maskHit, repoRoot, scanDist, scanSources, scanText, secretEnvEntries } from '../../../ci/checkSecrets.ts';

// test/unit/security/checkSecrets.test.ts
// 密钥门禁自己也要有用例：正则写松了会漏，写紧了会把正常代码判红，这两种只有跑起来才看得出来。
// 最后一条 scanSources(repoRoot) 同时是「仓库现在干净」的断言，CI 的 secret-guard 跑的是同一份实现。

const tempDirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-secrets-'));
    tempDirs.push(dir);
    return dir;
};

afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SK_KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';

describe('VITE_ 凭据变量名', () => {
    it('名字里带 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH 就失败，普通配置名不算', () => {
        const findings = scanText('src/a.ts', [
            'const key = import.meta.env.VITE_OPENAI_API_KEY;',
            'const base = import.meta.env.VITE_FOLIA_API_BASE;',
            'VITE_AI_PROVIDER=google',
            "readSetting('VITE_KUGOU_API_TOKEN')",
            'const note = "VITE_LIBRARY_TUI"',
        ].join('\n'));

        expect(findings.map(finding => finding.line + ':' + finding.hit)).toEqual([
            '1:VITE_OPENAI_API_KEY',
            '4:VITE_KUGOU_API_TOKEN',
        ]);
        expect(findings.every(finding => finding.secret === false)).toBe(true);
    });
});

describe('明文密钥形态', () => {
    it('常见前缀认得出来', () => {
        const findings = scanText('src/leak.ts', [
            "const a = '" + SK_KEY + "';",
            "const b = 'AIzaSyabcdefghijklmnopqrstuvwxyz012345';",
            "const c = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
            "const d = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';",
            "const e = 'xoxb-not-a-real-token-1';",
            "const f = 'Bearer abcdefghijklmnopqrstuvwxyz';",
        ].join('\n'));

        expect(findings.map(finding => finding.line)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(findings.every(finding => finding.secret === true)).toBe(true);
    });

    it('短前缀与普通单词不算', () => {
        expect(scanText('src/ok.ts', [
            "const a = 'sk-learn';",
            "const b = 'Bearer abc';",
            "const c = 'task-scheduler';",
            "const d = 'https://api.example.com/v1';",
        ].join('\n'))).toEqual([]);
    });
});

describe('失败输出', () => {
    it('命中的密钥值只露开头几位，太短的整段隐去', () => {
        expect(maskHit(SK_KEY)).toBe('sk-abc…');
        expect(maskHit('abc')).toBe('…');
        expect(maskHit('12345678')).toBe('…');
    });
});

describe('allowlist', () => {
    it('按文件与命中原文放行，别的文件照旧失败', () => {
        const allow = [{ file: 'src/fixture.ts', match: SK_KEY, reason: '测试夹具里的假值' }];
        expect(scanText('src/fixture.ts', "const k = '" + SK_KEY + "';", allow)).toEqual([]);
        expect(scanText('src/other.ts', "const k = '" + SK_KEY + "';", allow)).toHaveLength(1);
    });

    it('file 以 * 结尾时放行这个目录下的任何文件（产物文件名带内容哈希）', () => {
        const allow = [{ file: 'dist/*', match: SK_KEY, reason: '依赖里的公开值' }];
        expect(scanText('dist/assets/index-abc123.js', "const k = '" + SK_KEY + "';", allow)).toEqual([]);
        expect(scanText('src/a.ts', "const k = '" + SK_KEY + "';", allow)).toHaveLength(1);
    });

    it('条目缺理由就报错，不静默放行', () => {
        const root = tempDir();
        fs.mkdirSync(path.join(root, 'ci'));
        fs.writeFileSync(path.join(root, 'ci/secretsAllowlist.json'), JSON.stringify({ allow: [{ file: 'src/a.ts', match: SK_KEY }] }));

        expect(() => loadAllowlist(root)).toThrow(/reason/);
    });
});

describe('产物扫描', () => {
    it('找得到密钥形态与环境变量的值', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'assets'));
        fs.writeFileSync(path.join(dir, 'assets/app.js'), "const k = '" + SK_KEY + "';\nconst e = 'zzz-env-secret-value';\n");

        const findings = scanDist(dir, { GEMINI_API_KEY: 'zzz-env-secret-value' });

        expect(findings.map(finding => [finding.line, finding.reason])).toEqual([
            [1, 'sk- 开头的 API key（OpenAI 等）'],
            [2, '产物里出现了环境变量 GEMINI_API_KEY 的值'],
        ]);
        expect(findings[0].file.endsWith('assets/app.js')).toBe(true);
    });

    it('干净的产物通过，目录不存在直接报错', () => {
        const clean = tempDir();
        fs.writeFileSync(path.join(clean, 'app.js'), 'const a = 1;');
        expect(scanDist(clean, {})).toEqual([]);

        expect(() => scanDist(path.join(clean, 'missing'))).toThrow(/找不到产物目录/);
    });

    it('环境变量只挑名字像凭据、值又不像示例值的', () => {
        expect(secretEnvEntries({
            GEMINI_API_KEY: 'abcdefgh12345678',
            OPENAI_API_KEY: 'your_openai_api_key_here',
            VITE_KUGOU_API_BASE: 'http://localhost:3000',
            NODE_OPTIONS: '--enable-source-maps',
            ACTIONS_RUNTIME_TOKEN: 'short',
        })).toEqual([{ name: 'GEMINI_API_KEY', value: 'abcdefgh12345678' }]);
    });
});

describe('仓库当前状态', () => {
    // 整个源码树（src / electron / shared / api，约 2800 个文件）都要读一遍：
    // 默认的 5 秒只够快到当时的树，慢了就报「超时」而不是「扫出了什么」。
    it('源码里没有 VITE_ 凭据变量名，也没有明文密钥', () => {
        expect(scanSources(repoRoot)).toEqual([]);
    }, 120_000);
});
