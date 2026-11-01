// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/login/loginPasswordForm.test.ts
// 密码登录那一幅（飞牛这类自建服务没有二维码：要的是地址、用户名、密码）。
// 上游重写登录窗口时漏了这一幅的渲染，飞牛于是只剩一个转圈的弧、一个输入框都没有 ——
// 这里钉住「表单真的画出来了、提交真的把三个值交出去」，防它再发生一次。

vi.mock('react-i18next', async importOriginal => ({
    ...(await importOriginal<typeof import('react-i18next')>()),
    // 文案断言用 key 本身，不引真译文：译文改了不该让这个用例挂。
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

import PasswordLoginForm from '@/components/login/window/PasswordLoginForm';
import type { PasswordLoginCredentials } from '@/types/onlineMusic';

// React 听的是 input 事件，而它自己跟踪了 value：绕开它的 setter 才是真的「用户敲了一下」。
const type = (field: HTMLInputElement, text: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('the password form of a sign-in', () => {
    let root: Root;
    let place: HTMLElement;
    let submitted: PasswordLoginCredentials[];

    const draw = (props: Partial<React.ComponentProps<typeof PasswordLoginForm>> = {}): void => act(() => root.render(
        React.createElement(PasswordLoginForm, {
            needsServerUrl: true,
            serverUrl: '',
            error: null,
            busy: false,
            onSubmit: credentials => { submitted.push(credentials); },
            ...props,
        }),
    ));

    const fields = (): { url: HTMLInputElement | null; name: HTMLInputElement | null; secret: HTMLInputElement | null } => {
        // 用户名与服务器地址都是 text 框：要填地址时它是第一个，否则用户名就是第一个。
        const texts = [...place.querySelectorAll<HTMLInputElement>('input[type="text"]')];
        return {
            url: texts.length > 1 ? texts[0] : null,
            name: texts.length > 1 ? texts[1] : texts[0] ?? null,
            secret: place.querySelector<HTMLInputElement>('input[type="password"]'),
        };
    };

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        submitted = [];
        place = document.body.appendChild(document.createElement('div'));
        root = createRoot(place);
    });
    afterEach(() => {
        act(() => root.unmount());
        place.remove();
    });

    it('draws a password field, which a service without a code needs and a code never had', () => {
        draw();
        const { secret } = fields();
        expect(secret).not.toBeNull();
        // 飞牛的地址每一家都不同，写不进构建期配置：那一栏也要有。
        expect(fields().url).not.toBeNull();
    });

    it('leaves the server address out when the service already knows where it is', () => {
        draw({ needsServerUrl: false });
        // 只剩用户名一个 text 框。
        expect(place.querySelectorAll('input[type="text"]').length).toBe(1);
        expect(place.querySelector('input[type="password"]')).not.toBeNull();
    });

    it('hands the three values over, once all of them are there', () => {
        draw({ needsServerUrl: true });
        const { url, name, secret } = fields();
        act(() => {
            type(url!, ' http://nas.lan:5666 ');
            type(name!, ' someone ');
            type(secret!, 'a-secret');
        });
        act(() => place.querySelector('button[type="submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        // 前后空白不是账号的一部分。
        expect(submitted).toEqual([{ serverUrl: 'http://nas.lan:5666', username: 'someone', password: 'a-secret' }]);
    });

    it('holds the submit back until the name and the password are both filled', () => {
        draw({ needsServerUrl: false });
        const { name, secret } = fields();
        const button = () => place.querySelector<HTMLButtonElement>('button[type="submit"]');
        expect(button()?.disabled).toBe(true);
        act(() => type(name!, 'someone'));
        // 只填了账号，仍然按不下去。
        expect(button()?.disabled).toBe(true);
        act(() => type(secret!, 'a-secret'));
        expect(button()?.disabled).toBe(false);
    });

    it('keeps what was typed while a submit is on its way, and says why the last one failed', () => {
        draw({ needsServerUrl: true, error: 'invalid-credentials', busy: true });
        expect(place.textContent).toContain('home.loginPasswordInvalidCredentials');
        // 提交中三个框锁住（不是清空）：失败时用户改过的东西必须还在。
        expect([...place.querySelectorAll('input')].every(field => field.disabled)).toBe(true);
        expect(place.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    });

    it('asks for what the chosen method asks for, without knowing which method it is', () => {
        // 第一栏叫什么、例子写什么，全按传进来的 field 说 —— 表单自己不认识任何平台，
        // 也不替平台拼地址：填进去的是什么就原样交出去。
        draw({ field: { labelKey: 'test.customField', placeholderKey: 'test.customFieldPlaceholder' } });
        const { url } = fields();
        expect(place.textContent).toContain('test.customField');
        expect(url?.getAttribute('placeholder')).toBe('test.customFieldPlaceholder');
        act(() => {
            type(url!, 'abcd1234');
            type(fields().name!, 'someone');
            type(fields().secret!, 'a-secret');
        });
        act(() => place.querySelector('button[type="submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        // 翻译交给平台自己：这里原样交出去，不替它拼域名。
        expect(submitted).toEqual([{ serverUrl: 'abcd1234', username: 'someone', password: 'a-secret' }]);
    });
});
