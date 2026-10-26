import { describe, expect, it } from 'vitest';
import { getOnlineMusicProvider, listOnlineMusicProviders } from '@/services/onlineMusic/providerRegistry';

// test/unit/onlineMusic/authMembers.test.ts
// Which members the `auth` object of each built-in platform has. All but two members of
// OnlineAuthProvider are optional, so one that goes missing from an adapter gives no type error:
// Omni then answers as if the platform never had it (no QR picture, no page to open, no timer).
// A member added or removed on purpose changes its row here.

const AUTH_MEMBERS: Record<string, string[]> = {
    netease: [
        'canRunLoginSelfCheck', 'checkLogin', 'createQr', 'describeLoginFailure', 'forgetOldKeptAccount', 'getLoginDiagnostics', 'getLoginStatus', 'getLoginTexts', 'localService',
        'logout', 'oldKeptAccount', 'runLoginSelfCheck', 'showsKeptAccountAtStart', 'signInRanOut', 'startLogin',
    ],
    qq: [
        'canRunLoginSelfCheck', 'cancelLogin', 'checkLogin', 'createQr', 'describeLoginFailure', 'getLoginDiagnostics', 'getLoginMethods', 'getLoginStatus',
        'getLoginTexts', 'getLoginTtlMs', 'logout', 'resolveLoginMethods', 'runLoginSelfCheck', 'showsKeptAccountAtStart', 'signInRanOut', 'startLogin',
    ],
    kugou: [
        'checkLogin', 'createQr', 'describeLoginFailure', 'getLoginStatus', 'getLoginTexts', 'logout', 'showsKeptAccountAtStart', 'signInRanOut',
        'startLogin',
    ],
    // No `describeLoginFailure`: the desktop side answers Bodian's failures in the shared codes already.
    bodian: [
        'cancelLogin', 'checkLogin', 'createQr', 'getLoginStatus', 'getLoginTexts', 'getLoginTtlMs', 'logout', 'startLogin',
    ],
    // 安卓上登录诊断报告要说出「卡在哪」：Spotify 在安卓没有桌面端那座桥，
    // 报告原来那一段是空的（"(none)"），所以补上 getLoginDiagnostics（与汽水 / QQ 同）。
    spotify: [
        'cancelLogin', 'checkLogin', 'describeLoginFailure', 'getLoginDiagnostics', 'getLoginStatus', 'getLoginTexts', 'getLoginTtlMs', 'logout',
        'openLoginPage', 'startLogin',
    ],
    // YTM 在安卓有一份登录诊断（账号没读出来时说清卡在哪）；上游把它去掉过，本分支这个 fork 保留着。
    ytm: [
        'cancelLogin', 'checkLogin', 'describeLoginFailure', 'getLoginDiagnostics', 'getLoginStatus', 'getLoginTexts', 'getLoginTtlMs', 'logout',
        'openLoginPage', 'opensLoginPageItself', 'signInRanOut', 'startLogin',
    ],
    // 汽水（扫码）与飞牛（用户名密码 + 自建服务地址）是我们自己接的两个平台。
    // resolveLoginMethods：桥支持两套协议时由 provider 声明「车机 / 手机」两种扫码方式。
    qishui: [
        'cancelLogin', 'checkLogin', 'createQr', 'getLoginDiagnostics', 'getLoginStatus', 'getLoginTexts', 'getLoginTtlMs', 'logout',
        'resolveLoginMethods', 'startLogin',
    ],
    // 两种登录方式（FN ID 云连接 / 局域网地址）由 provider 声明：要不要先停在「选择方式」那一屏，由 controller 按它决定。
    feiniu: [
        'getLoginMethods', 'getLoginStatus', 'getLoginTexts', 'getPasswordLoginDefaults', 'loginWithPassword', 'logout',
    ],
};

describe('the sign-in members of each built-in platform', () => {
    it.each(Object.entries(AUTH_MEMBERS))('%s has exactly these', (providerId, members) => {
        expect(Object.keys(getOnlineMusicProvider(providerId)!.auth!).sort()).toEqual(members);
    });

    it('has a row for every built-in platform', () => {
        expect(listOnlineMusicProviders().map(provider => provider.id).sort()).toEqual(Object.keys(AUTH_MEMBERS).sort());
    });
});
