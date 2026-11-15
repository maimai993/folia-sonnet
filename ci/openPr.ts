// ci/openPr.ts
// 一键提 PR：本地门禁 → 推当前分支 → 建发往 dev 的 PR → 打印接下来要盯什么。
// 用法：npm run pr -- "fix: 一句话标题" [--issue 42] [--base dev] [--repo owner/repo] [--watch] [--skip-ci]
//
// 目标仓库：有 upstream remote 且与 origin 不同时，PR 建到 upstream，head 写 <fork 的 owner>:<分支>；
// 否则建到 origin。--repo 可以手动覆盖。fix/* 的 PR 必须用 --issue 关联一个 issue。
//
// gh（GitHub CLI）是便利工具，不是硬依赖：
//   - 装了 gh 且已登录：直接建 PR，--watch 会盯 CI。
//   - 没装 / 没登录 / 用 SSH 认证：照常 push（SSH 走你自己的 key），然后打印一个 compare 链接，
//     浏览器里点 Create pull request 即可；CI 在 PR 的 Checks 页看，review 在 Files changed 里写。
//
// 所有 CLI 解析都在 main() 里：这个文件会被单测 import，模块顶层不能碰 process.exit。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `用法：npm run pr -- "标题" [选项]

  --issue <编号>  关联 issue，正文自动写 Closes #<编号>；fix/* 分支必填
  --base <分支>   目标分支，默认 dev
  --repo <仓库>   目标仓库，owner/repo；有 upstream remote 时默认用它，否则用 origin
  --watch         建完 PR 直接盯 CI 到出结果（需要 gh；没有 gh 时打印链接）
  --skip-ci       跳过本地门禁（不建议，CI 会照样拦）

完整例子：
  git switch -c fix/login-timeout origin/dev
  git add -A && git commit -m "fix: 登录超时后不再卡住"
  npm run pr -- "fix: 登录超时后不再卡住" --issue 42

没装 gh、或用 SSH 认证：同样跑这一条，最后会用浏览器链接代替 gh 建 PR。
`;

export interface GithubRepo {
    owner: string;
    repo: string;
}

export interface PrTarget {
    repo: GithubRepo;
    /** 跨仓库 PR 的 head 前缀（fork 的 owner）；同仓库 PR 为 null。 */
    headOwner: string | null;
}

export interface PrArgs {
    title: string | null;
    base: string;
    issue: number | null;
    repo: string | null;
    watch: boolean;
    skipCi: boolean;
    help: boolean;
}

/** 从 remote 的 URL 里取出 GitHub 的 owner/repo；HTTPS、ssh://、git@ 三种写法都认。 */
export function githubRepoFromRemote(url: string): GithubRepo | null {
    const matched = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url.trim());
    return matched ? { owner: matched[1], repo: matched[2] } : null;
}

/** 解析 --repo 的 owner/repo；允许带 .git 后缀。 */
export function parseRepoName(value: string): GithubRepo | null {
    const matched = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(value.trim());
    return matched ? { owner: matched[1], repo: matched[2] } : null;
}

/**
 * 决定 PR 建到哪个仓库：
 * - 有 upstream 且与 origin 不同：建到 upstream，head 用 origin 的 owner（fork → upstream）；
 * - 否则建到 origin；
 * - --repo 覆盖目标仓库，head 仍按 origin 是否同仓库判断。
 */
export function selectPrTarget(originUrl: string, upstreamUrl: string | null | undefined, repoOverride?: string | null): PrTarget | null {
    const origin = githubRepoFromRemote(originUrl);
    const upstream = upstreamUrl ? githubRepoFromRemote(upstreamUrl) : null;
    const override = repoOverride ? parseRepoName(repoOverride) : null;
    const repo = override ?? (upstream && (!origin || upstream.owner !== origin.owner || upstream.repo !== origin.repo) ? upstream : origin);
    if (!repo) return null;
    const isSameRepo = origin !== null && origin.owner === repo.owner && origin.repo === repo.repo;
    return { repo, headOwner: origin && !isSameRepo ? origin.owner : null };
}

const VALUE_FLAGS = new Set(['--base', '--issue', '--repo']);

/** 解析命令行；标题只能有一个，未知参数直接报错，避免把 --issue 的编号当成标题。 */
export function parseArgs(argv: string[]): PrArgs {
    const args: PrArgs = { title: null, base: 'dev', issue: null, repo: null, watch: false, skipCi: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
            continue;
        }
        if (arg === '--watch') {
            args.watch = true;
            continue;
        }
        if (arg === '--skip-ci') {
            args.skipCi = true;
            continue;
        }
        if (VALUE_FLAGS.has(arg)) {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
            index += 1;
            if (arg === '--base') args.base = value;
            else if (arg === '--repo') args.repo = value;
            else {
                if (!/^[1-9]\d*$/.test(value)) throw new Error('--issue 需要 issue 编号（正整数）');
                args.issue = Number(value);
            }
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`不认识的参数：${arg}`);
        if (args.title !== null) throw new Error(`标题只能给一个：${args.title} / ${arg}`);
        args.title = arg;
    }
    if (args.repo && !parseRepoName(args.repo)) throw new Error('--repo 需要 owner/repo 形式');
    return args;
}

/** 生成的 PR 正文：fix/* 有 --issue 时写 Closes，其他情况留一句可选的说明。 */
export function buildPrBody(options: { issue: number | null; skipCi: boolean }): string {
    return [
        '## 改了什么',
        '（一句话说明改了什么、为什么）',
        '',
        '## 关联 issue',
        options.issue === null ? '（非 fix/* 且没有 bug 标签时可以不关联；有相关任务就写 `Refs #编号`）' : `Closes #${options.issue}`,
        '',
        '## 本地门禁已跑',
        `- [${options.skipCi ? ' ' : 'x'}] \`npm run ci:local\``,
        '',
        '## 备注',
        '（遗留项、已知风险、需要 review 重点看的地方）',
    ].join('\n');
}

/** 没有 gh 时给人的 compare 链接；fork 的 head 要写成 owner:branch。 */
export function compareUrl(target: PrTarget, base: string, branch: string): string {
    const head = target.headOwner ? `${target.headOwner}:${branch}` : branch;
    return `https://github.com/${target.repo.owner}/${target.repo.repo}/compare/${base}...${head}?expand=1`;
}

function run(command: string, args: string[], capture = false): string {
    const result = spawnSync(command, args, {
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
        console.error(`\n[pr] 这一步失败了：${command} ${args.join(' ')}`);
        process.exit(result.status ?? 1);
    }
    return (result.stdout ?? '').trim();
}

function tryRun(command: string, args: string[]): boolean {
    const result = spawnSync(command, args, { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

function main(): void {
    const argv = process.argv.slice(2);
    let args: PrArgs;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.error(`[pr] ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        process.exit(1);
    }

    if (args.help || argv.length === 0) {
        console.log(USAGE);
        process.exit(argv.length === 0 ? 1 : 0);
    }
    if (!args.title) {
        console.error('缺少标题。\n\n' + USAGE);
        process.exit(1);
    }
    const prTitle: string = args.title;
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const ghAvailable = tryRun('gh', ['--version']);
    const ghAuthed = ghAvailable && tryRun('gh', ['auth', 'status']);

    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], true);
    if (branch === 'main' || branch === 'dev') {
        console.error(`[pr] 不能直接往 ${branch} 提 PR。先切分支：git switch -c fix/你的改动 origin/dev`);
        process.exit(1);
    }
    if (branch.startsWith('fix/') && args.issue === null) {
        console.error('[pr] fix/* 的 PR 必须关联 issue。先 gh issue create 建 issue，然后在命令末尾加 --issue <编号>。');
        process.exit(1);
    }
    if (run('git', ['status', '--porcelain'], true)) {
        console.error('[pr] 还有没提交的改动。先 git add -A && git commit -m "..."，再跑一次。');
        process.exit(1);
    }

    const originUrl = run('git', ['remote', 'get-url', 'origin'], true);
    const upstreamUrl = tryRun('git', ['remote', 'get-url', 'upstream']) ? run('git', ['remote', 'get-url', 'upstream'], true) : null;
    const target = selectPrTarget(originUrl, upstreamUrl, args.repo);
    if (!target) {
        console.error('[pr] origin / upstream 都不是 GitHub 仓库，请用 --repo owner/repo 指定目标。');
        process.exit(1);
    }
    const forkNote = target.headOwner ? `（从 fork ${target.headOwner} 提交）` : '';
    console.log(`\n[pr] 分支 ${branch} → ${target.repo.owner}/${target.repo.repo}:${args.base}${forkNote}\n`);

    if (args.skipCi) {
        console.warn('[pr] 已跳过本地门禁。规则要求 PR 前必须本地跑通，CI 会照样检查。\n');
    } else {
        console.log('[pr] 1/3 本地门禁（与 CI 同一套）');
        run(npm, ['run', 'ci:local']);
    }

    console.log('\n[pr] 2/3 推分支');
    run('git', ['push', '-u', 'origin', 'HEAD']);

    const body = buildPrBody({ issue: args.issue, skipCi: args.skipCi });

    if (ghAuthed) {
        console.log('\n[pr] 3/3 建 PR（gh）');
        const createArgs = ['pr', 'create', '--repo', `${target.repo.owner}/${target.repo.repo}`, '--base', args.base, '--title', prTitle, '--body', body];
        if (target.headOwner) createArgs.push('--head', `${target.headOwner}:${branch}`);
        const url = run('gh', createArgs, true);
        console.log(url);
        console.log('\n[pr] 接下来必须做：\n  gh pr checks <编号> --watch     # 等到全绿\n  gh pr review <编号> --comment  # 至少一条 AI review，然后才能合');
        if (args.watch) run('gh', ['pr', 'checks', url, '--watch', '--interval', '30']);
        return;
    }

    // 没有可用的 gh（或仓库不是 GitHub 托管）：交给浏览器，git push 已经走你自己的 SSH/HTTPS 凭据。
    console.log('\n[pr] 3/3 建 PR（浏览器）');
    if (!ghAvailable) console.log('[pr] 没检测到 gh：用下面的链接建 PR 即可，不需要安装。');
    else if (!ghAuthed) console.log('[pr] gh 已安装但没登录：要么 gh auth login，要么直接用下面的链接。');
    console.log(`\n[pr] 打开这个链接，点 “Create pull request”：\n  ${compareUrl(target, args.base, branch)}\n`);
    console.log('[pr] 之后：CI 在 PR 页的 Checks 标签看；review 在 Files changed → Review changes → Comment 里写。');
    if (args.watch) console.log('[pr] --watch 需要 gh；这里只打印链接，盯 CI 请开 Checks 页。');
}

// 只有直接运行才走 CLI；单测 import 时没有副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
