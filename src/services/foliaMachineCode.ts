// src/services/foliaMachineCode.ts
// 「机器码」：这台设备在免费渠道里的身份，同时也是它的 API Key。
//
// 为什么要这么设计：让不想注册、不想申请 Key 的人装上就能用。代价是身份只能靠设备
// 自己声称 —— 机器码谁拿到都能用。所以它天然只是「一把有额度的普通 Key」，不是账号：
// 丢了就换一个（旧的自然作废），额度跟着 Key 走而不是跟着人走。
//
// 三条规矩：
//   1. **随机，但与设备绑定**：首次启动生成一次，之后一直用它。每次启动都换新的话，
//      用户签到攒的额度会凭空消失。
//   2. **`sk-` 开头**：群里那个机器人靠这个前缀认出「这是一串机器码」，也是因为它
//      长得和普通 API Key 一样，用户一眼能明白「这是密钥，别到处发」。
//   3. **只生成一次就落盘**：读写都走 localStorage（安卓 WebView 也持久）。
//      安卓另有一份原生存储，但那是给「原生发请求」用的，机器码不需要跟着走 ——
//      网页侧读到的就是它，推配置时一并带给原生。

const STORAGE_KEY = 'foliaMachineCode';

/** 机器码的形状：`sk-` + 32 位十六进制。与服务端的校验正则一致。 */
const MACHINE_CODE_PATTERN = /^sk-[0-9a-f]{32}$/;
const CODE_BYTES = 16;

/** 密码学安全随机：优先 crypto.getRandomValues，没有就退回 Math.random（极老环境）。 */
const randomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);
    const cryptoApi = typeof globalThis !== 'undefined'
        ? (globalThis.crypto as Crypto | undefined)
        : undefined;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        cryptoApi.getRandomValues(buffer);
    } else {
        for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
};

/** 造一个新的机器码（不落盘）。 */
export const createMachineCode = (): string => `sk-${randomHex(CODE_BYTES)}`;

/** 读已经存下的机器码；没有或形状不对就是空串。 */
export const readMachineCode = (): string => {
    if (typeof localStorage === 'undefined') return '';
    try {
        const raw = (localStorage.getItem(STORAGE_KEY) || '').trim();
        return MACHINE_CODE_PATTERN.test(raw) ? raw : '';
    } catch {
        return '';
    }
};

/**
 * 取机器码：有就用，没有就生成一个存下来。
 *
 * 这是这个模块唯一会被正常调用的入口 —— 调用方不需要知道「第一次」和「以后」的区别。
 */
export const ensureMachineCode = (): string => {
    const existing = readMachineCode();
    if (existing) return existing;
    const code = createMachineCode();
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(STORAGE_KEY, code);
        } catch {
            // 配额满 / 隐私模式：这一次先用内存里这个，下次启动会重新生成。
            // 真到这一步，用户会在群里绑一个「上次的」码 —— 但那种环境本来就存不住东西。
        }
    }
    return code;
};

/** 判断一段文本是不是机器码（设置页校验用；服务端还会再校验一遍）。 */
export const isMachineCode = (value: unknown): boolean => (
    typeof value === 'string' && MACHINE_CODE_PATTERN.test(value.trim())
);

/** 只显示头尾，用于日志与「确认一下是这一串」的场景。 */
export const maskMachineCode = (code: string): string => (
    code.length <= 12 ? code : `${code.slice(0, 7)}…${code.slice(-4)}`
);
