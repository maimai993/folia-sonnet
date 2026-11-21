import { afterEach, describe, expect, it, vi } from 'vitest';

// 桥那一路的入口换成假的：这组用例只测「桥答了什么」怎么变成页面侧的错。
vi.mock('@/services/foliaExtensionBridge', () => ({
    FOLIA_EXTENSION_API_BASE: 'extension',
    isFoliaExtensionBridgeConfigured: () => true,
    isFoliaExtensionBridgeAvailable: async () => true,
    requestFoliaExtension: vi.fn(),
}));

import { BRIDGE_ERROR_CODES, bridgeErrorCodeOf, bridgeFailureError, providerErrorCodeOfBridgeError } from '@/services/onlineMusic/omni/bridgeFailure';
import { OnlineProviderError } from '@/types/onlineMusic';
import { requestFoliaExtension } from '@/services/foliaExtensionBridge';
import { requestNeteaseRoute } from '@/services/onlineMusic/netease/netease';
import { describeNeteaseFailure } from '@/services/onlineMusic/netease/neteaseFailure';
import { onlineFailureOf, noteOnlineFailure } from '@/services/onlineMusic/failure/onlineFailureCase';

// test/unit/onlineMusic/bridgeFailure.test.ts
// 桥层的失败语义只有一份（issue M20）：`__foliaBridgeError` 的取值、它到 `ProviderErrorCode` 的
// 对应、以及「这条应答算不算失败」都在 omni/bridgeFailure.ts 里定。写入端是纯 JS，读不到这里的类型，
// 所以取值表本身也钉一遍：桥新加一种失败、这边没跟上，第一条用例就会红。

describe('桥错误的取值表（issue M20）', () => {
    it('认的是桥真正会写的那五个取值', () => {
        // 写入点：src/nativeBridge/api/folia.js、qq.js、qq/explore.js。
        expect([...BRIDGE_ERROR_CODES]).toEqual([
            'AUTH_REQUIRED',
            'NETWORK',
            'UNSUPPORTED',
            'INVALID_PARAMS',
            'ROUTE_NOT_IMPLEMENTED',
        ]);
    });

    it('只有 AUTH_REQUIRED 读成 auth-required，别的都不会被当成登录问题', () => {
        expect(providerErrorCodeOfBridgeError('AUTH_REQUIRED')).toBe('auth-required');
        expect(providerErrorCodeOfBridgeError('NETWORK')).toBe('network');
        // 桥里没有这条路由、调用方参数不对：都不是断网，界面才不该说「连不上，请稍后重试」。
        expect(providerErrorCodeOfBridgeError('UNSUPPORTED')).toBe('unsupported');
        expect(providerErrorCodeOfBridgeError('ROUTE_NOT_IMPLEMENTED')).toBe('unsupported');
        expect(providerErrorCodeOfBridgeError('INVALID_PARAMS')).toBe('invalid-response');
    });
});

describe('认一条否定应答', () => {
    it('五个取值都认得出来', () => {
        for (const code of BRIDGE_ERROR_CODES) {
            expect(bridgeErrorCodeOf({ __foliaBridgeError: code })).toBe(code);
        }
    });

    it('正常的回答不算失败', () => {
        expect(bridgeErrorCodeOf({ code: 200, songs: [] })).toBeUndefined();
        expect(bridgeErrorCodeOf(null)).toBeUndefined();
        expect(bridgeErrorCodeOf(undefined)).toBeUndefined();
    });

    it('桥给了不认识的取值时不冒充成功', () => {
        expect(bridgeErrorCodeOf({ __foliaBridgeError: 'SOMETHING_NEW' })).toBeUndefined();
    });
});

describe('抛出来的错', () => {
    it('种类留在 code 上，整条应答留在 cause 上', () => {
        const answer = { __foliaBridgeError: 'AUTH_REQUIRED' as const, path: '/song/url/v1' };
        const error = bridgeFailureError(answer, 'netease', 'fallback');
        expect(error).toBeInstanceOf(OnlineProviderError);
        expect(error.code).toBe('auth-required');
        expect(error.providerId).toBe('netease');
        expect(error.cause).toBe(answer);
        // 桥没写话时用错误码兜底，界面上不出现空字符串。
        expect(error.message).toBe('AUTH_REQUIRED');
    });

    it('桥写的话优先', () => {
        const error = bridgeFailureError({ __foliaBridgeError: 'NETWORK', message: 'upstream down' }, 'qq', 'fallback');
        expect(error.code).toBe('network');
        expect(error.message).toBe('upstream down');
    });

    it('不认识的取值退成 network，而不是「读成功」', () => {
        const error = bridgeFailureError({ __foliaBridgeError: 'BRAND_NEW' }, 'kugou', 'fallback');
        expect(error.code).toBe('network');
        expect(error.message).toBe('BRAND_NEW');
    });
});

// 网易云那条链路的现场（issue M20）：桥答「要登录」，页面侧拿到的必须是能认出来的登录失败，
// 不是一句泛化错误。原先 `netease.ts` 在这里抛的是裸 `Error`，种类当场就丢了。
describe('网易云：桥的否定应答走到失败分类', () => {
    const bridge = vi.mocked(requestFoliaExtension);
    const signal = () => new AbortController().signal;
    // 走哪条路由 API base 决定：`extension` 就是本地桥。
    const routeThroughBridge = (answer: Record<string, unknown>) => {
        vi.stubEnv('VITE_NETEASE_API_BASE', 'extension');
        bridge.mockResolvedValue(answer);
        return requestNeteaseRoute('/user/record', 'uid=42', signal());
    };

    afterEach(() => {
        vi.unstubAllEnvs();
        bridge.mockReset();
    });

    it('AUTH_REQUIRED 抛的是 auth-required，页面上是要登录而不是「请求失败」', async () => {
        const answer = { __foliaBridgeError: 'AUTH_REQUIRED', path: '/user/record', message: '请先登录网易云' };
        await expect(routeThroughBridge(answer)).rejects.toMatchObject({
            name: 'OnlineProviderError',
            code: 'auth-required',
            providerId: 'netease',
            cause: answer,
        });

        const caught = await routeThroughBridge(answer).catch((error: unknown) => error);
        // 正面承认这一层现在什么都不说（见上面那条用例）：种类要真的到页面，不能指望它。
        expect(describeNeteaseFailure('collection', caught)).toBeNull();
        // 页面按这个错分情况：要登录就停下并提示登录，不是「连不上，稍后重试」。
        const shown = onlineFailureOf({ operation: 'collection', providerId: 'netease' }, { error: caught });
        expect(shown.case).toBe('sign-in-needed');
    });

    it('NETWORK 仍是连不上，而且原话引得出来', async () => {
        const caught = await routeThroughBridge({ __foliaBridgeError: 'NETWORK', message: 'upstream down' }).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(OnlineProviderError);
        expect((caught as OnlineProviderError).code).toBe('network');
        expect(describeNeteaseFailure('collection', caught)).toMatchObject({ case: 'unreachable', code: 'NETWORK', message: 'upstream down' });
        expect(onlineFailureOf({ operation: 'collection', providerId: 'netease' }, { error: caught }).case).toBe('unreachable');
    });

    it('ROUTE_NOT_IMPLEMENTED 说「这里没有这条」，不是断网', async () => {
        const answer = { __foliaBridgeError: 'ROUTE_NOT_IMPLEMENTED', path: '/user/record' };
        const caught = await routeThroughBridge(answer).catch((error: unknown) => error);
        expect((caught as OnlineProviderError).code).toBe('unsupported');
        expect(describeNeteaseFailure('collection', caught)).toEqual({ case: 'not-configured' });
        // 走 omni 实际那条路：error 先记下 provider 的说法（noteOnlineFailure），再由它分情况。
        noteOnlineFailure(caught, describeNeteaseFailure('collection', caught));
        const shown = onlineFailureOf({ operation: 'collection', providerId: 'netease' }, { error: caught });
        expect(shown.case).toBe('not-configured');
    });

    it('正常的回答照旧原样交回', async () => {
        const answer = { code: 200, allData: [], weekData: [] };
        await expect(routeThroughBridge(answer)).resolves.toBe(answer);
    });
});
