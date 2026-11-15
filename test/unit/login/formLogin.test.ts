import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginScene } from '@/components/login/window/loginView';
import { omni } from '@/services/onlineMusic/omni';

// test/unit/login/formLogin.test.ts
// 通用表单式登录（review 行为 11/14 与「loginScene 'form'、omni.submitLoginForm」）：
// provider 声明了 getLoginForm 就进表单，否则走扫码/浏览器流程；提交走 provider 自己。
//
// 这里钉的平台是飞牛。本 fork 注册的是自己那份 `feiniu`（feiniuProvider.ts），不是上游的
// `fnmusic` —— 上游那份走 Electron 主进程桥、字段叫 `base`，在安卓上发不出请求，所以没注册
// （见 providerRegistry.ts 末尾的说明）。飞牛的表单第一栏因此叫 `serverUrl`，值可以是 FN ID
// 短码（abcd1234）、局域网地址（nas.lan:5666）或整条 URL，由 feiniuServerUrlForLoginInput 认。

const passwordLogin = vi.fn();

// feiniu 的传输层走 foliaNative 的原生 HTTP / fetch，登录这一步被整个替掉，
// 这样测试只验「表单怎么把值交出去」，不碰网络。
vi.mock('@/services/onlineMusic/feiniuTransport', async () => {
    const actual = await vi.importActual<typeof import('@/services/onlineMusic/feiniuTransport')>(
        '@/services/onlineMusic/feiniuTransport',
    );
    return { ...actual, feiniuPasswordLogin: (...args: unknown[]) => passwordLogin(...args) };
});

beforeEach(() => {
    passwordLogin.mockReset().mockResolvedValue({ user: { guid: 'u1', name: 'Tester' } });
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('loginScene form branch', () => {
    it('shows the form for a platform that declares getLoginForm, instead of auto-starting a sign-in', () => {
        // 飞牛没有二维码：没有 getLoginForm 就会落到扫码那一幕，扫的框里永远等不来东西。
        const scene = loginScene({ lead: 'sign-in', phase: null, inBrowser: false, failed: false, providerId: 'feiniu' });
        expect(scene).toBe('form');
    });

    it('does not show the form for a platform without getLoginForm; it follows the normal sign-in flow', () => {
        const scene = loginScene({ lead: 'sign-in', phase: null, inBrowser: false, failed: false, providerId: 'netease' });
        expect(scene).not.toBe('form');
        expect(scene).toBe('preparing');
    });

    it('shows a failure scene when the form sign-in failed (the window shows the failure, not the form)', () => {
        const scene = loginScene({ lead: 'sign-in', phase: null, inBrowser: false, failed: true, providerId: 'feiniu' });
        expect(scene).toBe('failed');
    });
});

describe('omni.getLoginForm', () => {
    it('returns the declared fields for 飞牛', () => {
        const form = omni.getLoginForm('feiniu');
        expect(form).not.toBeNull();
        // 一栏里写 NAS 在哪（短码 / IP:端口 / 整条 URL），再加账号密码。
        expect(form?.fields.map(field => field.key)).toEqual(['serverUrl', 'username', 'password']);
    });

    it('returns null for platforms without a form', () => {
        expect(omni.getLoginForm('netease')).toBeNull();
    });
});

describe('omni.submitLoginForm', () => {
    it('submits the form through the provider itself', async () => {
        await omni.submitLoginForm('feiniu', {
            serverUrl: 'http://192.168.1.10:5666',
            username: 'alice',
            password: 'secret',
        });
        expect(passwordLogin).toHaveBeenCalledWith('alice', 'secret', 'http://192.168.1.10:5666');
    });

    it('turns a bare FN ID into that machine on the relay domain', async () => {
        await omni.submitLoginForm('feiniu', {
            serverUrl: ' ABCD1234 ',
            username: 'alice',
            password: 'secret',
        });
        // 手抄的短码带空格、大小写不一：归一化后补上 fnos.net 后缀、走 https。
        expect(passwordLogin).toHaveBeenCalledWith('alice', 'secret', 'https://abcd1234.fnos.net');
    });

    it('fails with unsupported for a platform without submitLoginForm', async () => {
        await expect(omni.submitLoginForm('netease', {})).rejects.toMatchObject({ code: 'unsupported' });
    });
});
