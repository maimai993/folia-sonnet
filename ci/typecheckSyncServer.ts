// ci/typecheckSyncServer.ts
// 本地跑 sync-server 的 typecheck，和 CI 的 typecheck-sync-server job 用同一条 build:node。
// 依赖没装时只给一次性安装提示，不自动联网安装。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'sync-server');
/*
 * 依赖探测看的是 `node_modules/.bin/tsc`，不是 typescript 包里的入口。
 *
 * `build:node` 就是一条裸的 `tsc`，走的正是 `.bin` 里那个转发脚本；`.bin` 在，
 * 说明依赖是按 package.json 装下来的。用包内路径判断会在只装了部分依赖时误判。
 */
const tscBin = path.join(serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

if (!fs.existsSync(tscBin)) {
    console.error('[ci] sync-server 的依赖还没装。先跑一次：npm --prefix sync-server ci');
    process.exit(1);
}

/*
 * 跑 `npm run build:node`，而不是直接调 tsc。
 *
 * 两者跑出来的 tsc 一样，但 npm 还带 `pre` / `post` 生命周期 —— sync-server 的
 * package.json 里靠它们做生成步骤，绕过 npm 就等于少跑了那几步（test/unit/ci
 * /typecheckSyncServer.test.ts 里 `steps.txt` 期望的正是 pre/build/post 三步）。
 *
 * Windows 上不能直接 spawn 一个 `.cmd`：不带 shell 会 EINVAL，带 shell 又因为参数
 * 拼接触发 DEP0190。所以交给 cmd.exe，但命令是固定的字面量、路径只经 cwd 传入，
 * 没有任何外部输入拼进 shell 字符串。
 */
const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
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
