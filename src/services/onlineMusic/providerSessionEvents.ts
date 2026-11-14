// 平台会话失效的通知通道。
//
// 为什么需要单独一个中立模块：会话是在 provider 的 transport 层被清掉的（那里拿到
// 401 / 拿不到播放链接之后才发现），而要说给用户听的是 hooks 那层。两者直接互相
// import 会破坏 omni 架构的边界（UI 层不许碰 provider 内部），所以中间放这一条事件，
// 两边都只依赖它。
//
// 事件 detail 是 `OnlineProviderId`，监听方据此决定提示哪一家的登录过期了。

export const PROVIDER_SESSION_EXPIRED_EVENT = 'folia-provider-session-expired';

export const announceProviderSessionExpired = (providerId: string): void => {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent(PROVIDER_SESSION_EXPIRED_EVENT, { detail: providerId }));
    } catch {
        // 发不出去只是少一条提示，不影响清会话本身。
    }
};
