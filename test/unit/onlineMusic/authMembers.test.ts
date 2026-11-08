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
    // Two ways to play, picked at the sign-in; after it, whether the account gets audio keys is
    // checked, and the Soloist setup is a checklist of its own. 安卓诊断报告的 getLoginDiagnostics
    // 是本 fork 自己的（Spotify 在安卓没有桌面端那座桥，报告需要说出「卡在哪」）。
    spotify: [
        'cancelLogin', 'checkAfterLogin', 'checkLogin', 'describeLoginFailure', 'getLoginDiagnostics', 'getLoginStatus', 'getLoginTexts', 'getLoginTtlMs', 'getSetup',
        'logout', 'openLoginPage', 'resolveLoginMethods', 'runSetupAction', 'startLogin',
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
    // Signs in inside the companion window: no code to show, and the window is gone when the
    // attempt is cancelled, so there is no TTL of its own. The sign-in lives in the companion's
    // profile on this machine, so the kept account shows at app start.
    appleMusic: [
        'cancelLogin', 'checkLogin', 'describeLoginFailure', 'getLoginStatus', 'getLoginTexts', 'logout', 'openLoginPage',
        'opensLoginPageItself', 'showsKeptAccountAtStart', 'signInRanOut', 'startLogin',
    ],
    // 表单式登录：不扫码不开浏览器，登录窗口按 getLoginForm 声明渲染账号密码表单。
    // 这份是**本 fork** 的飞牛（feiniuProvider.ts），靠 foliaNative 的原生 HTTP 发请求，
    // 安卓与桌面都能用；上游那份 fnmusic（Electron 主进程桥）文件保留但未注册 —— 两份都注册
    // 会让平台列里出现两个「飞牛」。第一栏由 feiniuServerUrlForLoginInput 自己认短码 / 地址。
    feiniu: [
        'getLoginForm', 'getLoginMethods', 'getLoginStatus', 'getLoginTexts', 'getPasswordLoginDefaults',
        'loginWithPassword', 'logout', 'submitLoginForm',
    ],
};

describe('the sign-in members of each built-in platform', () => {
    it.each(Object.entries(AUTH_MEMBERS))('%s has exactly these', (providerId, members) => {
        expect(Object.keys(getOnlineMusicProvider(providerId)!.auth!).sort()).toEqual(members);
    });

    it('has a row for every built-in platform that signs in', () => {
        expect(listOnlineMusicProviders()
            .filter(provider => provider.capabilities.auth)
            .map(provider => provider.id).sort()).toEqual(Object.keys(AUTH_MEMBERS).sort());
    });

    it('an accountless platform declares no sign-in members', () => {
        const accountless = listOnlineMusicProviders().filter(provider => !provider.capabilities.auth);
        expect(accountless.length).toBeGreaterThan(0);
        for (const provider of accountless) expect(provider.auth, provider.id).toBeUndefined();
    });
});
