// ci/typecheckSyncServer.ts
// 本地跑 sync-server 的 typecheck，和 CI 的 typecheck-sync-server job 用同一条 build:node。
// 依赖没装时只给一次性安装提示，不自动联网安装。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'sync-server');
// 用 typescript 包里的 tsc 入口（.js，跨平台都能直接交给 node 跑），不用 .bin 里那个 .cmd：
// Windows 上 spawnSync 不带 shell 跑 .cmd 会回 EINVAL，带 shell 又会因为参数拼接触发 DEP0190。
const tsc = path.join(serverDir, 'node_modules', 'typescript', 'bin', 'tsc');

if (!fs.existsSync(tsc)) {
    console.error('[ci] sync-server 的依赖还没装。先跑一次：npm --prefix sync-server ci');
    process.exit(1);
}

// 和 sync-server 的 `build:node`（就是一条 tsc）等价：
// 直接把 tsc 入口交给 node 跑，不经 npm —— Windows 上 spawn 一个 .cmd 会回 EINVAL，
// 带 shell 又因为参数拼接触发 DEP0190。这样也没有 npm 依赖。
const result = spawnSync(process.execPath, [tsc], { cwd: serverDir, stdio: 'inherit' });
if (result.error || result.status !== 0) {
    console.error('[ci] sync-server 的 typecheck 失败了。');
    process.exit(result.status ?? 1);
}
