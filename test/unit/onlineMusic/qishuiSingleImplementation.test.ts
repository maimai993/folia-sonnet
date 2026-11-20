import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qishuiProvider } from '@/services/onlineMusic/qishuiProvider';
import { qishuiApiImage } from '@/services/onlineMusic/qishuiNormalize';
import { describeQishuiFailure } from '@/services/onlineMusic/qishuiFailure';
import { getOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import { OnlineProviderError } from '@/types/onlineMusic';
import { onlineFailureOf } from '@/services/onlineMusic/failure/onlineFailureCase';

// test/unit/onlineMusic/qishuiSingleImplementation.test.ts
// 汽水音乐只留一套实现（issue M19）。
//
// 场景：`onlineMusic/` 下曾经同时躺着 fork 这份（根目录 6 个文件，注册了）和上游 v0.7.22 那份
// （`qishui/` 目录 11 个文件，没注册）。没注册的那份本该是死代码，却因为洛雪的公开接口借用它的取图
// 函数被整个拖进产物（那份 transport 还从 `qishui-music-api` 取类型）；改一个 bug 很容易只改到其中一份。
//
// 这里钉三件事：源码树里同名的汽水实现只剩一处、产物里没有任何文件再碰上游那份、
// 以及上游那份独有的能力（失败分类）搬到了注册的这份身上。

const ROOT = path.resolve(__dirname, '../../..');
const PLATFORM_FOLDER = path.join(ROOT, 'src/services/onlineMusic');
const UPSTREAM_FOLDER = path.join(PLATFORM_FOLDER, 'qishui');

const listFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(next) : [next];
});

describe('汽水只有一套实现（issue M19）', () => {
    it('`onlineMusic/qishui/` 整个目录不在了', () => {
        expect(() => statSync(UPSTREAM_FOLDER)).toThrow();
    });

    it('根目录那份仍是唯一一份，并且注册着', () => {
        for (const name of ['qishuiProvider.ts', 'qishuiTransport.ts', 'qishuiCatalog.ts', 'qishuiLibrary.ts', 'qishuiMutations.ts', 'qishuiNormalize.ts']) {
            expect(statSync(path.join(PLATFORM_FOLDER, name)).isFile(), name).toBe(true);
        }
        expect(getOnlineMusicProvider('qishui')).toBe(qishuiProvider);
    });

    it('源码树里没有任何文件再引用上游那份', () => {
        const offenders = listFiles(path.join(ROOT, 'src'))
            .filter(file => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
            .filter((file) => {
                const source = readFileSync(file, 'utf8');
                return /(?:\.\.?\/)+qishui\/qishui/.test(source);
            })
            .map(file => path.relative(ROOT, file).replace(/\\/g, '/'));
        expect(offenders).toEqual([]);
    });
});

describe('上游那份独有的能力搬到了注册的这份（issue M19）', () => {
    it('未注册的那份原来的取图函数现在在根目录', () => {
        // 公开接口借的就是这一样：字符串原样，对象取 urls。
        expect(qishuiApiImage('https://p3.douyinpic.com/a.jpg')).toBe('https://p3.douyinpic.com/a.jpg');
        expect(qishuiApiImage({ urls: ['https://p3.douyinpic.com/b.jpg'] })).toBe('https://p3.douyinpic.com/b.jpg');
        expect(qishuiApiImage({})).toBe('');
    });

    it('注册的 provider 现在有 describeFailure，失败按种类分开说', () => {
        expect(qishuiProvider.describeFailure).toBe(describeQishuiFailure);
        // 网页版没有那座桥：这里根本用不了汽水，重试也不会出现。
        const noRuntime = new OnlineProviderError('unavailable', 'Qishui Music is not available on this runtime', 'qishui');
        expect(describeQishuiFailure('audio', noRuntime)).toEqual({ case: 'not-configured' });
        // 桥自己抛的：本地这一侧坏了，不当成断网自动重试。
        const bridgeFailed = new OnlineProviderError('network', 'Qishui desktop request failed', 'qishui');
        expect(describeQishuiFailure('audio', bridgeFailed)).toEqual({ case: 'local-service-stopped' });
        // 平台的错误号在 cause 上：引出来。
        const platformCode = new OnlineProviderError('unavailable', 'Qishui refused the request', 'qishui', 'QISHUI_2001');
        expect(describeQishuiFailure('collection', platformCode)).toEqual({ code: 'QISHUI_2001' });
        // 别的平台的错不归它管。
        expect(describeQishuiFailure('audio', new OnlineProviderError('network', 'x', 'qq'))).toBeNull();
    });

    it('没有登录时说「登录后才能播放」，不是「请求失败」', () => {
        const signedOut = new OnlineProviderError('auth-required', 'sign in to play', 'qishui');
        // 交给共用规则按 code 判，这里不点名，免得绕开它。
        expect(describeQishuiFailure('audio', signedOut)).toBeNull();
        expect(onlineFailureOf({ operation: 'audio', providerId: 'qishui' }, { error: signedOut }).case).toBe('sign-in-needed');
    });
});
