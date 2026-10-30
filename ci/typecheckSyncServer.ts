// ci/typecheckSyncServer.ts
// 本地跑 sync-server 的 typecheck，和 CI 的 typecheck-sync-server job 用同一条 build:node。
// 依赖没装时只给一次性安装提示，不自动联网安装。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'sync-server');
const tsc = path.join(serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

if (!fs.existsSync(tsc)) {
    console.error('[ci] sync-server 的依赖还没装。先跑一次：npm --prefix sync-server ci');
    process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
/*
 * Windows 上不能直接 spawn `npm.cmd`：Node 22.12+ 起在没有 shell 的情况下
 * spawn `.cmd` / `.bat` 会回 EINVAL（CVE-2024-27980 的缓解），本地门禁会
 * 在完全无关的地方红掉。Windows 走 `cmd /c`，其余平台照旧直连 npm。
 */
const spawnCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : npm;
const spawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm', 'run', 'build:node']
    : ['run', 'build:node'];
const result = spawnSync(spawnCommand, spawnArgs, { cwd: serverDir, stdio: 'inherit' });
if (result.error || result.status !== 0) {
    console.error('[ci] sync-server 的 typecheck 失败了。');
    process.exit(result.status ?? 1);
}
