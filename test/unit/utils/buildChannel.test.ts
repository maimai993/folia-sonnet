import { describe, expect, it } from 'vitest';
import { OFFICIAL_BRANCH, OFFICIAL_BRANCH_PREFIX, isOfficialBuildBranch } from '@/utils/buildChannel';

// test/unit/utils/buildChannel.test.ts
// 什么算正式版：只有 main 与 release/x.y.z。判错一边的代价不对称 —— 把测试版认成正式版，用户拿它当日常用；
// 把正式版认成测试版，只是多弹一个窗。所以分不清的取值（空串、'HEAD'、'unknown'）一律按测试版算。

describe('isOfficialBuildBranch', () => {
    it('takes main and the release branches as official', () => {
        expect(isOfficialBuildBranch(OFFICIAL_BRANCH)).toBe(true);
        expect(isOfficialBuildBranch(`${OFFICIAL_BRANCH_PREFIX}0.7.24`)).toBe(true);
        expect(isOfficialBuildBranch(`${OFFICIAL_BRANCH_PREFIX}0.7.24-rc1`)).toBe(true);
    });

    it('takes every other branch as a test build', () => {
        for (const branch of ['dev', 'feat/113-bravais-seam-auto-reverse', 'fix/112-lockscreen-overlay-lingering', 'release', 'releases/1.0.0', 'mainline']) {
            expect(isOfficialBuildBranch(branch)).toBe(false);
        }
    });

    it('treats what it cannot recognise as a test build', () => {
        for (const branch of ['', 'HEAD', 'unknown', ' ']) {
            expect(isOfficialBuildBranch(branch)).toBe(false);
        }
    });
});
