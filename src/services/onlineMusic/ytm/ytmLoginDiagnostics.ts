import type { LoginDiagnosticLine } from '../../../types/onlineMusic';
import { diagnosticLine, formatDiagnosticClock } from '../login/loginDiagnosticReport';
import { isCapacitorAndroid } from '../../../platform/runtime';

// src/services/onlineMusic/ytm/ytmLoginDiagnostics.ts
// 登录诊断报告里 YouTube Music 那一段。
//
// 为什么单独一份：安卓那一套是移植来的（ytm/android/），它自己没有这一段，而报告要每一家
// 都说得出自己卡在哪（`test/unit/login/loginDiagnosticReport.test.ts` 会数每一家的段数与
// 宣称有这一段的 provider 相对齐）—— 少了这一段，登录确认之后读不出账号（account-refresh-failed）
// 时报告里这一家就是空的，看不出卡在哪。
//
// 为什么只说这两件事：会话存在原生侧，用 Android Keystore 加密落盘（`YtmSessionStore.java`），
// Web 这一侧拿不到 cookie 本身，也不该去拿。能说的只有「走的是哪一侧」和「最近一次问账号
// 问到了什么」，与 Spotify 那一段是同一套写法。

/** 最近一次问账号的结论。 */
let lastLoginStatusCheck: LoginDiagnosticLine | null = null;

export const noteYtmLoginStatusCheck = (summary: LoginDiagnosticLine): void => {
    lastLoginStatusCheck = diagnosticLine`${formatDiagnosticClock(Date.now())} ${summary}`;
};

export const getYtmLoginDiagnostics = (): LoginDiagnosticLine[] => {
    const lines: LoginDiagnosticLine[] = [];
    lines.push(diagnosticLine`side: ${isCapacitorAndroid() ? 'android' : 'desktop'}`);
    if (lastLoginStatusCheck) lines.push(lastLoginStatusCheck);
    return lines;
};
