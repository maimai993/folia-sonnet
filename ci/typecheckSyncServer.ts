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

const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
// Windows 不能直接 spawn .cmd；仅将固定命令交给 cmd，路径始终由 cwd 传入，不拼入 shell 字符串。
const args = isWindows ? ['/d', '/s', '/c', 'npm.cmd run build:node'] : ['run', 'build:node'];
const result = spawnSync(command, args, { cwd: serverDir, stdio: 'inherit', shell: false });
if (result.error) {
    console.error('[ci] 无法启动 sync-server build:node。', result.error);
    process.exit(1);
}
if (result.signal) {
    console.error('[ci] sync-server build:node 被信号终止。', result.signal);
    process.exit(1);
}
if (result.status !== 0) {
    console.error(`[ci] sync-server build:node 失败，exit=${result.status ?? 'unknown'}。`);
    process.exit(result.status ?? 1);
}
