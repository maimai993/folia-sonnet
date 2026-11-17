// src/stores/storagePrimitives.ts
// The localStorage read/write primitives every settings store shares.
//
// Moved out of useSettingsUiStore so the domain stores split out of it do not have to import
// from each other just to read a boolean. Behaviour is unchanged, including the SSR guard.

/*
 * 有没有 localStorage 可用。
 *
 * 只判 `typeof window === 'undefined'` 不够，而以前这里正是这么判的：`window` 在、存储不在的
 * 环境是有的 —— 无痕/受限的 WebView、被裁掉存储的沙箱，以及测试里只为别的事 stub 了一个
 * window 的情形（`vi.stubGlobal('window', {...})`）。那种时候 `localStorage` 是裸引用，
 * 取它直接抛 ReferenceError，而引用这些原语的 store 多数在**模块求值**时就调一次，
 * 于是整条 import 链一起崩 —— 报出来的错跟真正的原因（某个测试 stub 的 window）毫无关系。
 *
 * 这里统一收口：拿不到就当没有存储，读返回兜底、写什么都不做。
 */
const storageOrNull = (): Storage | null => {
    if (typeof window === 'undefined') {
        return null;
    }
    try {
        // window.localStorage 在真浏览器里就是全局那份；WebView 被裁掉存储时它是 undefined，
        // 这时退回全局 localStorage（测试 stub 的就是这一份），两处都没有才算没有存储。
        return window.localStorage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch {
        // 取 localStorage 本身就可能抛（安全策略禁掉存储时）。
        return null;
    }
};

export const getStoredBoolean = (key: string, fallback: boolean) => {
    const storage = storageOrNull();
    if (!storage) {
        return fallback;
    }

    const saved = storage.getItem(key);
    return saved !== null ? saved === 'true' : fallback;
};

export const setStoredBoolean = (key: string, value: boolean) => {
    storageOrNull()?.setItem(key, String(value));
};

export const setStoredString = (key: string, value: string) => {
    storageOrNull()?.setItem(key, value);
};

export const getStoredString = (key: string, fallback: string) => {
    const storage = storageOrNull();
    if (!storage) {
        return fallback;
    }

    return storage.getItem(key) || fallback;
};

export const removeStoredKey = (key: string) => {
    storageOrNull()?.removeItem(key);
};
