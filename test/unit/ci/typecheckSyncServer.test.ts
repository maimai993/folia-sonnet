import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// 用真正的 wrapper 和 npm lifecycle 验证 Windows 启动与退出码，不依赖真实服务依赖。
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtures: string[] = [];

const fixture = (exitCode = 0, withDependencies = true) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'folia sync 中文 & '));
    fixtures.push(root);
    const serverDir = path.join(root, 'sync-server');
    mkdirSync(path.join(root, 'ci'), { recursive: true });
    mkdirSync(serverDir);
    copyFileSync(path.join(repoRoot, 'ci/typecheckSyncServer.ts'), path.join(root, 'ci/typecheckSyncServer.ts'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify({
        private: true,
        scripts: {
            'prebuild:node': 'node step.cjs pre',
            'build:node': 'node step.cjs build',
            'postbuild:node': 'node step.cjs post',
        },
    }));
    writeFileSync(path.join(serverDir, 'step.cjs'), `
const fs = require('node:fs');
fs.appendFileSync('steps.txt', process.argv[2] + '\\n');
fs.writeFileSync('cwd.txt', process.cwd());
if (process.argv[2] === 'build') process.exit(${exitCode});
`);
    if (withDependencies) {
        const bin = path.join(serverDir, 'node_modules/.bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(path.join(bin, process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), '');
    }
    return { root, serverDir };
};

const run = (root: string, overrides: NodeJS.ProcessEnv = {}) => {
    const env = { ...process.env };
    // Windows 环境变量名不区分大小写；先移除同名键，避免继承的 COMSPEC 抢先于 ComSpec。
    for (const [name, value] of Object.entries(overrides)) {
        for (const existing of Object.keys(env)) {
            if (existing.toLowerCase() === name.toLowerCase()) delete env[existing];
        }
        env[name] = value;
    }
    // npm 的外层生命周期配置不应污染 fixture 的真实 npm run。
    for (const name of Object.keys(env)) {
        if (['npm_config_ignore_scripts', 'npm_config_script_shell'].includes(name.toLowerCase())) delete env[name];
    }
    return spawnSync(process.execPath, [path.join(root, 'ci/typecheckSyncServer.ts')], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8',
        timeout: 15_000,
    });
};

afterEach(() => {
    for (const root of fixtures.splice(0)) {
        // root 仅来自本测试的 mkdtemp，不删除项目目录或用户数据。
        rmSync(root, { recursive: true, force: true });
    }
});

describe('sync-server typecheck launcher', () => {
    it('runs the real npm script and pre/post lifecycle from the server directory', () => {
        const { root, serverDir } = fixture();
        const result = run(root, { npm_execpath: '/not-an-npm-cli/pnpm.cjs' });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(path.join(serverDir, 'steps.txt'), 'utf8')).toBe('pre\nbuild\npost\n');
        expect(readFileSync(path.join(serverDir, 'cwd.txt'), 'utf8')).toBe(serverDir);
    });

    it('preserves the actual build failure exit code', () => {
        const { root, serverDir } = fixture(7);
        const result = run(root);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(7);
        expect(readFileSync(path.join(serverDir, 'steps.txt'), 'utf8')).toBe('pre\nbuild\n');
        expect(result.stderr).toContain('exit=7');
    });

    it('fails clearly before spawning npm when dependencies are missing', () => {
        const { root, serverDir } = fixture(0, false);
        const result = run(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('npm --prefix sync-server ci');
        expect(result.stdout).not.toContain('step.cjs');
        expect(existsSync(path.join(serverDir, 'steps.txt'))).toBe(false);
    });

    it.skipIf(process.platform !== 'win32')('uses cmd.exe when ComSpec is empty', () => {
        const { root } = fixture();
        const result = run(root, { ComSpec: '' });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
    });

    it.skipIf(process.platform !== 'win32')('reports a launcher error separately from a failed build', () => {
        const { root } = fixture();
        const result = run(root, { ComSpec: path.join(root, 'missing-cmd.exe') });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('无法启动');
        expect(result.stderr).toContain('ENOENT');
    });
});
