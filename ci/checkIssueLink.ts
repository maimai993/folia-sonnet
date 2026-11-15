// ci/checkIssueLink.ts
// PR 门禁：fix/* 分支和带 bug 标签的 PR，正文里必须有一条 issue 关联（Closes / Fixes / Resolves / Refs + #编号）。
//   node ci/checkIssueLink.ts                   读 GITHUB_EVENT_PATH 里的 PR 判定（CI 里由 Actions 提供）
//   node ci/checkIssueLink.ts --text "Closes #12"   本地检查一段正文
//
// 只认正文，不认标题：标题里的编号 GitHub 也不会用来关闭 issue。动词与 #编号要写在同一行，
// 中间可以有半角或全角空格；只写 #12、或只提到 issue 而没有动词，都算没关联。
// 其余 PR（feat / docs / refactor 等）不要求关联，规则说明与流程见 docs/issue-workflow.md。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type IssueLinkKind = 'closes' | 'fixes' | 'resolves' | 'refs';

export interface IssueLink {
    kind: IssueLinkKind;
    number: number;
}

// 动词与 # 之间也认全角空格 U+3000：中文输入法下很容易打出「Closes　#12」。
// 末尾的 \b 挡住 #12abc 这类写法，避免把版本号或别的数字当成 issue。
const ISSUE_LINK_PATTERN = /\b(closes|fixes|resolves|refs)[ \t\u3000]*#(\d+)\b/gi;

// body 可以为 null（PR 正文没写时 GitHub 给的是 null），一并当空串处理。
export function parseIssueRefs(text: string | null | undefined): IssueLink[] {
    const refs: IssueLink[] = [];
    for (const matched of (text ?? '').matchAll(ISSUE_LINK_PATTERN)) {
        refs.push({ kind: matched[1].toLowerCase() as IssueLinkKind, number: Number(matched[2]) });
    }
    return refs;
}

export function hasIssueLink(text: string | null | undefined): boolean {
    return parseIssueRefs(text).length > 0;
}

export interface IssueLinkGate {
    branch: string;
    labels: string[];
}

/**
 * 只有修复类 PR 强制关联 issue：
 * - 分支名以 fix/ 开头；
 * - 或者 PR 带了 bug 标签（分支名不是 fix/、但确实是修 bug 的情况）。
 * 新功能、重构、文档不要求。
 */
export function requiresIssueLink(gate: IssueLinkGate): boolean {
    return gate.branch.startsWith('fix/') || gate.labels.some((label) => label.toLowerCase() === 'bug');
}

// 门禁失败时给人看的话：先说该做什么，再说去哪读规则。
export function explainMissingLink(): string {
    return [
        'PR 正文没有关联 issue（fix/* 分支和带 bug 标签的 PR 必须关联）。',
        '发现 bug 时先提 issue 再修：用 gh issue create 建 issue，修完在 PR 正文写一行 Closes #<issue 号>（Fixes / Resolves / Refs 也可以）。',
        '动手前先读 AGENTS.md 的「Bug 与 issue」一节，流程见 docs/issue-workflow.md。',
    ].join('\n');
}

interface PullRequestEvent {
    pull_request?: {
        title?: string | null;
        body?: string | null;
        head?: { ref?: string | null } | null;
        labels?: Array<{ name?: string | null }> | null;
    } | null;
}

interface PullRequestContext {
    title: string;
    branch: string;
    body: string;
    labels: string[];
}

function readPullRequest(): PullRequestContext | null {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) return null;
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as PullRequestEvent;
    const pullRequest = event.pull_request;
    if (!pullRequest) return null;
    return {
        title: pullRequest.title ?? '',
        branch: pullRequest.head?.ref ?? '',
        body: pullRequest.body ?? '',
        labels: (pullRequest.labels ?? []).map((label) => label.name ?? '').filter((name) => name.length > 0),
    };
}

function main(): void {
    const args = process.argv.slice(2);
    const textIndex = args.indexOf('--text');
    const pullRequest = readPullRequest();
    const body = textIndex >= 0 ? (args[textIndex + 1] ?? '') : pullRequest?.body;

    if (textIndex < 0 && !pullRequest) {
        console.error('找不到 PR 信息：本地请用 node ci/checkIssueLink.ts --text "Closes #12" 检查一段正文，CI 里由 GITHUB_EVENT_PATH 提供。');
        process.exitCode = 1;
        return;
    }
    // --text 只检查一段正文，不看策略；CI 里按分支和标签决定这次要不要要求关联。
    if (textIndex < 0 && pullRequest && !requiresIssueLink({ branch: pullRequest.branch, labels: pullRequest.labels })) {
        console.log(`issue 关联检查通过：分支 ${pullRequest.branch || '(未知)'} 不是 fix/*，也没有 bug 标签，本次不要求关联。`);
        return;
    }
    if (!hasIssueLink(body)) {
        if (textIndex < 0 && pullRequest) console.error(`PR「${pullRequest.title}」，分支 ${pullRequest.branch}`);
        console.error(explainMissingLink());
        process.exitCode = 1;
        return;
    }
    const refs = parseIssueRefs(body).map((ref) => `${ref.kind} #${ref.number}`).join('、');
    console.log(`issue 关联检查通过：${refs}`);
}

// 只有直接 `node ci/checkIssueLink.ts` 才跑检查；被单测 import 时不产生副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
