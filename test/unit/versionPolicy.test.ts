// test/unit/versionPolicy.test.ts
// 版本约束：gradle 的 versionCode 推导、版本号格式、平台依赖钉死。CI 的 version-policy 任务跑同一份实现。

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
    checkVersionPolicy,
    isPinnedSpec,
    parseVersion,
    versionCodeOf,
    versionNumberIssues,
} from '../../ci/checkVersionPolicy.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('versionCode 推导与 android/app/build.gradle 一致', () => {
    it('三段版本号', () => {
        // minor 占 10^6、patch 占 10^4：0.7.22 => 7*1000000 + 22*10000 = 7220000
        expect(versionCodeOf('0.7.22')).toBe(7220000);
    });

    it('第四位也进 versionCode', () => {
        // 0.7.19.1 => 7*1000000 + 19*10000 + 1 = 7190001
        expect(versionCodeOf('0.7.19.1')).toBe(7190001);
    });

    it('patch 到三位数被截断，与上一版同 code', () => {
        expect(versionCodeOf('0.7.100')).toBe(versionCodeOf('0.7.99'));
    });

    /*
     * 位宽漂移是这个文件最容易出错的地方：一旦这里和 gradle 的乘法对不上，
     * 门禁就会「通过」一个系统判成降级安装的号（0.7.26 那次的 702600 就是这么来的）。
     * 所以直接从 gradle 里把公式抠出来，拿同一批版本号两边各算一遍。
     */
    it('与 gradle 的公式逐项一致', async () => {
        const fs = await import('node:fs/promises');
        const gradle = await fs.readFile(`${repoRoot}android/app/build.gradle`, 'utf8');
        const matched = /return minor \* (\d+) \+ patch \* (\d+) \+ build/.exec(gradle);
        expect(matched).not.toBeNull();
        const minorWeight = Number(matched![1]);
        const patchWeight = Number(matched![2]);
        const gradleCodeOf = (minor: number, patch: number, build: number) =>
            minor * minorWeight + Math.min(patch, 99) * patchWeight + Math.min(build, 99);

        const cases: [string, number, number, number][] = [
            ['0.7.22', 7, 22, 0],
            ['0.7.19.1', 7, 19, 1],
            ['0.7.27.2', 7, 27, 2],
            ['0.8.0', 8, 0, 0],
            ['0.7.100', 7, 100, 0],
        ];
        for (const [version, minor, patch, build] of cases) {
            expect(versionCodeOf(version), version).toBe(gradleCodeOf(minor, patch, build));
        }
    });
});

describe('版本号约束', () => {
    it('只接受 A.B.C 与 A.B.C.D', () => {
        expect(parseVersion('0.7.22')).toEqual({ major: 0, minor: 7, patch: 22, build: 0 });
        expect(parseVersion('0.7.22.3')).toEqual({ major: 0, minor: 7, patch: 22, build: 3 });
        expect(parseVersion('v0.7.22')).toBeNull();
    });

    it('patch/build 超过两位要报出来', () => {
        expect(versionNumberIssues('0.7.22')).toEqual([]);
        expect(versionNumberIssues('0.7.100')).toHaveLength(1);
        expect(versionNumberIssues('0.7.22.100')).toHaveLength(1);
    });
});

describe('平台依赖必须钉死', () => {
    it('范围写法不算钉死', () => {
        expect(isPinnedSpec('^4.41.1')).toBe(false);
        expect(isPinnedSpec('~4.41.1')).toBe(false);
        expect(isPinnedSpec('*')).toBe(false);
        expect(isPinnedSpec('latest')).toBe(false);
        expect(isPinnedSpec('file:../x')).toBe(false);
    });

    it('精确版本和带标签的 tarball 算钉死', () => {
        expect(isPinnedSpec('4.41.1')).toBe(true);
        expect(isPinnedSpec('https://github.com/MakcRe/KuGouMusicApi/archive/refs/tags/v1.6.0.tar.gz')).toBe(true);
    });
});

describe('仓库当前状态', () => {
    it('通过全部版本约束', () => {
        expect(checkVersionPolicy(repoRoot)).toEqual([]);
    });
});
