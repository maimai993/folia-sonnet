import { OnlineProviderError } from '../../types/onlineMusic';
import type { OnlineFailureDetail, OnlineFailureOperation } from '../../types/onlineMusic';

// src/services/onlineMusic/qishuiFailure.ts
// 汽水要播放地址、读歌单和专辑的歌曲没有成功时交出的事实（services/onlineMusic/failure/）。
// 上游那份未注册的 `qishui/` 整份删除（issue M19）以后，注册的这份一直缺 `describeFailure`，
// 于是汽水的失败到页面侧只剩一句泛化的「请求失败」。这里按注册的那份 transport 实际交出来的错来分。

// 这个运行环境没有那座桥（网页版）：汽水在这里根本用不了。
const NEEDS_RUNTIME = 'Qishui Music is not available on this runtime';
// 桥自己坏了（主进程 / 原生那边抛的）：本地这一侧的问题，不是断网。
const BRIDGE_FAILED = 'Qishui desktop request failed';

export const describeQishuiFailure = (_operation: OnlineFailureOperation, error: unknown): OnlineFailureDetail | null => {
    if (!(error instanceof OnlineProviderError) || error.providerId !== 'qishui') return null;
    // 网页版没有那座桥：重试也不会出现，说「这里不支持」。
    if (error.message === NEEDS_RUNTIME) return { case: 'not-configured' };
    // 桥自己抛的：本地这一侧坏了，别当成断网自动重试。
    if (error.message === BRIDGE_FAILED && error.code === 'network') return { case: 'local-service-stopped' };
    // 平台的错误号（`upstreamCode` 留在 `cause` 上）：菜单那边要引它的号。
    if (typeof error.cause === 'string' && error.cause) return { code: error.cause };
    // 「只拿到试听 / 没有地址」由调用方自己点名；其余的按共用规则看 code 与 HTTP 状态。
    return null;
};
