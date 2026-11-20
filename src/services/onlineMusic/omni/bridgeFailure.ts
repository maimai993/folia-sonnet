// src/services/onlineMusic/omni/bridgeFailure.ts
//
// 桥层失败语义的唯一一份类型（issue M20）。
//
// 桥（`src/nativeBridge/api/folia.js` 等）在应答里用 `__foliaBridgeError` 表示「这一条没成功」，
// 取值是一组固定的字符串。写入端在纯 JS 里，读不读得到类型由各平台 transport 决定；这里把
// 取值、判定与到 `ProviderErrorCode` 的映射各写一次，平台侧只调用，不再各写一遍字面量比较。
//
// 为什么要分开：一个失败的「种类」决定了界面说什么 —— 要登录（`auth-required`）与连不上
// （`network`）是两件完全不同的事。把种类丢成裸 `Error`，上层就只能一律说「请求失败」。

import { OnlineProviderError } from '../../../types/onlineMusic';
import type { OnlineProviderId, ProviderErrorCode } from '../../../types/onlineMusic';

// 桥自己那五个取值。写入点见 `src/nativeBridge/api/`（`AUTH_REQUIRED`、`NETWORK`、
// `UNSUPPORTED`、`INVALID_PARAMS`、`ROUTE_NOT_IMPLEMENTED`）。
export const BRIDGE_ERROR_CODES = [
    'AUTH_REQUIRED',
    'NETWORK',
    'UNSUPPORTED',
    'INVALID_PARAMS',
    'ROUTE_NOT_IMPLEMENTED',
] as const;

export type BridgeErrorCode = typeof BRIDGE_ERROR_CODES[number];

/** 桥对一次请求的否定应答：`message` 是桥写的话，`path` / `operation` 只用来诊断。 */
export interface BridgeFailure {
    readonly __foliaBridgeError: BridgeErrorCode;
    readonly message?: string;
    readonly path?: string;
    readonly operation?: string;
    readonly provider?: string;
}

/**
 * 这个桥错误说的是哪一种失败。
 *
 * - `AUTH_REQUIRED` = 这条路由要求登录（会话不在或已失效）：界面要说「登录」，不是「请求失败」。
 * - `NETWORK` = 桥去问平台时没问通（上游 5xx、连接失败）。
 * - `UNSUPPORTED` / `ROUTE_NOT_IMPLEMENTED` = 桥里没有这条路由，重试也不会出现。
 * - `INVALID_PARAMS` = 调用方给的参数不全（缺 id 之类），同样的参数再问一次也一样。
 */
export const providerErrorCodeOfBridgeError = (code: BridgeErrorCode): ProviderErrorCode => {
    switch (code) {
        case 'AUTH_REQUIRED': return 'auth-required';
        case 'NETWORK': return 'network';
        // 「桥里没有这条路由」与「平台的这个后端不支持这项能力」在界面上的处理是一样的：不给重试。
        case 'UNSUPPORTED':
        case 'ROUTE_NOT_IMPLEMENTED': return 'unsupported';
        case 'INVALID_PARAMS': return 'invalid-response';
    }
};

const isBridgeErrorCode = (value: unknown): value is BridgeErrorCode => (
    typeof value === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(value)
);

/**
 * 应答应答是不是桥给出的否定应答。
 *
 * ⚠ 只认上面那五个取值。桥将来新加一种失败时，旧版本页面会把它当成「一次正常的回答」继续往下读
 * —— 那不如把未知取值也算成失败：宁可是一句「桥说这条路没通」，也不要把一个失败的回答当成歌单读。
 */
export const isBridgeFailure = (answer: unknown): answer is BridgeFailure => (
    typeof answer === 'object' && answer !== null && '__foliaBridgeError' in answer
);

/** 这条否定应答的种类；不是否定应答（或桥给了不认识的取值）时是 `undefined`。 */
export const bridgeErrorCodeOf = (answer: unknown): BridgeErrorCode | undefined => {
    const raw = (answer as { __foliaBridgeError?: unknown } | null | undefined)?.__foliaBridgeError;
    return isBridgeErrorCode(raw) ? raw : undefined;
};

/** 桥在应答里写的话：没写就退回它的错误码，别让界面上出现空字符串。 */
export const bridgeFailureMessage = (failure: BridgeFailure): string => (
    typeof failure.message === 'string' && failure.message.trim() ? failure.message : failure.__foliaBridgeError
);

/**
 * 这条否定应答要抛的错：种类在 `code` 上（`OnlineProviderError` 的码），整条应答在 `cause` 上
 * 供诊断与原话取用。`cause` 上一定带着 `__foliaBridgeError`，认它比按 `code` 反推种类可靠：
 * `auth-required` 也可能是桥以外的地方给的。
 */
export const bridgeFailureError = (
    answer: unknown,
    providerId: OnlineProviderId,
    fallbackMessage: string,
): OnlineProviderError => {
    const code = bridgeErrorCodeOf(answer);
    if (!code) {
        // 桥给了不认识的取值：当作「这次请求连不上」，至少不会把失败读成成功。
        const said = (answer as { __foliaBridgeError?: unknown } | null | undefined)?.__foliaBridgeError;
        return new OnlineProviderError(
            'network',
            typeof said === 'string' && said ? said : fallbackMessage,
            providerId,
            answer,
        );
    }
    const failure: BridgeFailure = { ...(answer as BridgeFailure), __foliaBridgeError: code };
    return new OnlineProviderError(providerErrorCodeOfBridgeError(code), bridgeFailureMessage(failure), providerId, answer);
};
