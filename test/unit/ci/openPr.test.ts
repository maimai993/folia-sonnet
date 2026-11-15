// test/unit/ci/openPr.test.ts
// 提 PR 脚本里的纯逻辑：认出 remote 里的 GitHub 仓库（HTTPS / SSH 都认）、决定 PR 建到哪、
// 解析命令行、生成正文和 compare 链接。main() 里的 git / gh 调用不在这里测。

import { describe, expect, it } from 'vitest';
import { buildPrBody, compareUrl, githubRepoFromRemote, parseArgs, parseRepoName, selectPrTarget } from '../../../ci/openPr.ts';

describe('从 origin URL 解析 GitHub 仓库', () => {
    it('HTTPS 写法', () => {
        expect(githubRepoFromRemote('https://github.com/maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
        expect(githubRepoFromRemote('https://github.com/maimai993/folia-sonnet')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
    });

    it('SSH 写法（git@ 与 ssh:// 都认）', () => {
        expect(githubRepoFromRemote('git@github.com:maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
        expect(githubRepoFromRemote('ssh://git@github.com/maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
    });

    it('不是 GitHub 就返回 null', () => {
        expect(githubRepoFromRemote('https://gitlab.com/o/r.git')).toBeNull();
        expect(githubRepoFromRemote('/local/path/repo')).toBeNull();
    });
});

describe('parseRepoName（--repo 的值）', () => {
    it('认 owner/repo，允许带 .git 后缀', () => {
        expect(parseRepoName('maimai993/folia-sonnet')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
        expect(parseRepoName('maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
    });

    it('完整 URL、带斜杠或空格的写法都不认', () => {
        expect(parseRepoName('https://github.com/o/r')).toBeNull();
        expect(parseRepoName('o/r extra')).toBeNull();
        expect(parseRepoName('just-a-name')).toBeNull();
    });
});

describe('selectPrTarget（PR 建到哪个仓库）', () => {
    const forkOrigin = 'git@github.com:qlzhj03/folia-sonnet.git';
    const upstream = 'https://github.com/maimai993/folia-sonnet.git';

    it('fork 场景：有 upstream 且与 origin 不同时建到 upstream，head 前缀是 fork 的 owner', () => {
        expect(selectPrTarget(forkOrigin, upstream)).toEqual({
            repo: { owner: 'maimai993', repo: 'folia-sonnet' },
            headOwner: 'qlzhj03',
        });
    });

    it('没有 upstream 时建到 origin 本身，head 不加前缀', () => {
        expect(selectPrTarget(forkOrigin, null)).toEqual({
            repo: { owner: 'qlzhj03', repo: 'folia-sonnet' },
            headOwner: null,
        });
    });

    it('origin 和 upstream 是同一个仓库时不算 fork', () => {
        expect(selectPrTarget(forkOrigin, 'git@github.com:qlzhj03/folia-sonnet.git')).toEqual({
            repo: { owner: 'qlzhj03', repo: 'folia-sonnet' },
            headOwner: null,
        });
    });

    it('--repo 覆盖目标仓库，head 仍按 origin 是否同仓库判断', () => {
        expect(selectPrTarget(forkOrigin, null, 'maimai993/folia-sonnet')).toEqual({
            repo: { owner: 'maimai993', repo: 'folia-sonnet' },
            headOwner: 'qlzhj03',
        });
        expect(selectPrTarget(forkOrigin, null, 'qlzhj03/folia-sonnet.git')).toEqual({
            repo: { owner: 'qlzhj03', repo: 'folia-sonnet' },
            headOwner: null,
        });
    });

    it('origin 不是 GitHub、没有 upstream 也没有 --repo 时返回 null', () => {
        expect(selectPrTarget('https://gitlab.com/o/r.git', null)).toBeNull();
    });
});

describe('parseArgs', () => {
    it('默认值：base 是 dev，其余关掉', () => {
        expect(parseArgs([])).toEqual({ title: null, base: 'dev', issue: null, repo: null, watch: false, skipCi: false, help: false });
    });

    it('全部选项一起给，标题位置不限', () => {
        expect(parseArgs(['--issue', '42', '--base', 'main', '--repo', 'o/r', '--watch', '--skip-ci', 'fix: 修好了'])).toEqual({
            title: 'fix: 修好了',
            base: 'main',
            issue: 42,
            repo: 'o/r',
            watch: true,
            skipCi: true,
            help: false,
        });
    });

    it('--help / -h 单独识别', () => {
        expect(parseArgs(['--help']).help).toBe(true);
        expect(parseArgs(['-h']).help).toBe(true);
    });

    it('未知参数、重复标题直接报错，避免把编号当成标题', () => {
        expect(() => parseArgs(['标题', '--wat'])).toThrow('不认识的参数');
        expect(() => parseArgs(['一个标题', '另一个标题'])).toThrow('标题只能给一个');
    });

    it('值选项缺值、--issue 不是正整数、--repo 不是 owner/repo 都报错', () => {
        expect(() => parseArgs(['--base'])).toThrow('--base 需要一个值');
        expect(() => parseArgs(['--issue', '--watch'])).toThrow('--issue 需要一个值');
        expect(() => parseArgs(['--issue', 'abc'])).toThrow('--issue 需要 issue 编号');
        expect(() => parseArgs(['--issue', '0'])).toThrow('--issue 需要 issue 编号');
        expect(() => parseArgs(['--repo', '没有斜杠'])).toThrow('--repo 需要 owner/repo 形式');
    });
});

describe('buildPrBody', () => {
    it('带 --issue 时正文写 Closes，本地门禁勾上', () => {
        const body = buildPrBody({ issue: 42, skipCi: false });
        expect(body).toContain('Closes #42');
        expect(body).toContain('- [x] `npm run ci:local`');
        expect(body).not.toContain('（非 fix/*');
    });

    it('没带 --issue 时不写 Closes，留一句提示', () => {
        const body = buildPrBody({ issue: null, skipCi: false });
        expect(body).not.toContain('Closes #');
        expect(body).toContain('Refs #编号');
        expect(body).toContain('- [x] `npm run ci:local`');
    });

    it('--skip-ci 时勾选框留空', () => {
        expect(buildPrBody({ issue: null, skipCi: true })).toContain('- [ ] `npm run ci:local`');
    });
});

describe('compareUrl（没有 gh 时的浏览器链接）', () => {
    it('fork 的 head 写成 owner:branch，指向目标仓库', () => {
        const target = selectPrTarget('git@github.com:qlzhj03/folia-sonnet.git', 'https://github.com/maimai993/folia-sonnet.git');
        expect(target).not.toBeNull();
        expect(compareUrl(target!, 'dev', 'fix/login-timeout')).toBe('https://github.com/maimai993/folia-sonnet/compare/dev...qlzhj03:fix/login-timeout?expand=1');
    });

    it('同仓库的 head 不加前缀', () => {
        const target = selectPrTarget('https://github.com/maimai993/folia-sonnet.git', null);
        expect(target).not.toBeNull();
        expect(compareUrl(target!, 'dev', 'fix/login-timeout')).toBe('https://github.com/maimai993/folia-sonnet/compare/dev...fix/login-timeout?expand=1');
    });
});
