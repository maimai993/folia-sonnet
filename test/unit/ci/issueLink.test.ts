// test/unit/ci/issueLink.test.ts
// PR 关联 issue 的判定规则：认哪些写法、什么不算，以及失败时给人看的话。
// CI 的 issue-link job 跑的是同一份实现（ci/checkIssueLink.ts）。

import { describe, expect, it } from 'vitest';
import { explainMissingLink, hasIssueLink, parseIssueRefs, requiresIssueLink } from '../../../ci/checkIssueLink.ts';

describe('parseIssueRefs', () => {
    it('四种动词都认，大小写不敏感，编号取数字', () => {
        expect(parseIssueRefs('Closes #12')).toEqual([{ kind: 'closes', number: 12 }]);
        expect(parseIssueRefs('fixes #3')).toEqual([{ kind: 'fixes', number: 3 }]);
        expect(parseIssueRefs('Resolves #99')).toEqual([{ kind: 'resolves', number: 99 }]);
        expect(parseIssueRefs('REFS #7')).toEqual([{ kind: 'refs', number: 7 }]);
    });

    it('多行正文里逐行找，一行可以有多条', () => {
        const body = ['## 改了什么', '', '修了播放卡住的问题。', 'Fixes #3', 'Refs #99'].join('\n');
        expect(parseIssueRefs(body)).toEqual([
            { kind: 'fixes', number: 3 },
            { kind: 'refs', number: 99 },
        ]);
    });

    it('动词与 # 之间可以有全角空格', () => {
        expect(parseIssueRefs('Closes\u3000#12')).toEqual([{ kind: 'closes', number: 12 }]);
    });

    it('只有 #编号、或只提到 issue，没有动词就不算', () => {
        expect(parseIssueRefs('相关讨论见 #12。')).toEqual([]);
        expect(parseIssueRefs('这个 PR 和 issue 里的现象一样。')).toEqual([]);
        expect(parseIssueRefs('Closes the issue')).toEqual([]);
    });

    it('动词与编号不在同一行不算', () => {
        expect(parseIssueRefs('Closes\n#12')).toEqual([]);
    });

    it('别的单词里的 fixes、编号后面的字母都不算', () => {
        expect(parseIssueRefs('prefixes #3')).toEqual([]);
        expect(parseIssueRefs('Closes #12abc')).toEqual([]);
        expect(parseIssueRefs('Closes #')).toEqual([]);
    });

    it('正文为空、null、undefined 时返回空数组', () => {
        expect(parseIssueRefs('')).toEqual([]);
        expect(parseIssueRefs(null)).toEqual([]);
        expect(parseIssueRefs(undefined)).toEqual([]);
    });
});

describe('hasIssueLink', () => {
    it('动词加编号就通过', () => {
        expect(hasIssueLink('Closes #12')).toBe(true);
        expect(hasIssueLink('## 说明\n\n这个 bug 已修，refs #5')).toBe(true);
    });

    it('只写编号、或只提到 issue 不算关联', () => {
        expect(hasIssueLink('#12')).toBe(false);
        expect(hasIssueLink('见 issue #12 的讨论')).toBe(false);
        expect(hasIssueLink('')).toBe(false);
        expect(hasIssueLink(null)).toBe(false);
    });
});

describe('requiresIssueLink', () => {
    it('fix/* 分支强制关联，不看标签', () => {
        expect(requiresIssueLink({ branch: 'fix/login-timeout', labels: [] })).toBe(true);
        expect(requiresIssueLink({ branch: 'fix/login-timeout', labels: ['bug'] })).toBe(true);
    });

    it('其他分支只在带 bug 标签时强制，标签大小写不敏感', () => {
        expect(requiresIssueLink({ branch: 'feat/export-playlist', labels: ['bug'] })).toBe(true);
        expect(requiresIssueLink({ branch: 'feat/export-playlist', labels: ['BUG'] })).toBe(true);
        expect(requiresIssueLink({ branch: 'feat/export-playlist', labels: ['enhancement'] })).toBe(false);
        expect(requiresIssueLink({ branch: 'feat/export-playlist', labels: [] })).toBe(false);
    });

    it('只认 fix/ 前缀，fixes/ 这样的分支名不算', () => {
        expect(requiresIssueLink({ branch: 'fixes/login-timeout', labels: [] })).toBe(false);
        expect(requiresIssueLink({ branch: '', labels: [] })).toBe(false);
    });
});

describe('explainMissingLink', () => {
    it('说清该怎么做、去哪读规则', () => {
        const message = explainMissingLink();
        expect(message).toContain('没有关联 issue');
        expect(message).toContain('Closes #');
        expect(message).toContain('AGENTS.md');
        expect(message).toContain('Bug 与 issue');
    });
});
