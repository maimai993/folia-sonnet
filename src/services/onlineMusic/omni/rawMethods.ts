import type { JsonValue, OmniProviderId, ProviderRawEndpoint } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { getOnlineMusicProvider, listOnlineMusicProviders } from '../providerRegistry';
import { withoutCredentials } from '../rawResponse';
import { unsupported } from './providerCalls';

// src/services/onlineMusic/omni/rawMethods.ts
// The platform back end's raw endpoints, for Folium's platform.raw only.

export const rawMethods = {
    /*
     * 把「原生兜底切歌要用的凭据」推一遍给原生网关。
     *
     * 原生那条兜底（WebView 冻结后仍能切歌 / 取流）得自己拼取流地址和 Cookie，
     * 而这些凭据只有各平台自己的 transport 知道怎么读。调用方是 hooks
     * （useCapacitorPlaybackBridge），按依赖方向不该直连 `<id>Transport.ts` ——
     * 所以这里开一个入口，由各平台 provider 自己实现（见 `nativeGateway`）。
     *
     * 没有这个能力的平台安静跳过：它不是取数据，缺了只是那条平台没有原生兜底。
     */
    syncNativeGatewayCredentials(): void {
        for (const provider of listOnlineMusicProviders()) {
            provider.nativeGateway?.syncCredentials();
        }
    },
    // ---- 平台后端的原始接口（OnlineRawRequestProvider）：调用平台专有能力的后备通道，只给 Folium 的
    // 实验接口 platform.raw 用。omni 已有对应能力的接口，调用方应改用 omni（分类表的 `omni` 一列）。

    // 这个平台能否直通：后端库的名字和版本，和宿主自己设置的参数名。不能直通回 null。
    getRawRequestInfo(providerId: OmniProviderId): { backend: { name: string; version: string }; reservedParams: readonly string[] } | null {
        const raw = getOnlineMusicProvider(providerId)?.raw;
        return raw ? { backend: { name: raw.backend.name, version: raw.backend.version }, reservedParams: raw.reservedParams } : null;
    },

    // 一个接口在平台分类表里的那一行；不能直通的平台、表外的接口回 null。
    describeRawEndpoint(providerId: OmniProviderId, endpoint: string): ProviderRawEndpoint | null {
        return getOnlineMusicProvider(providerId)?.raw?.describeEndpoint(endpoint) ?? null;
    },

    // 参数的取值有没有问题（平台的 checkParams，比如会拼进上游路径的参数只收数字）：有回一句说明，没有回 null。
    // 调用方在发请求之前问，把问题当作参数错误报给它的调用方；requestProviderRaw 自己也会再挡一次。
    checkRawParams(providerId: OmniProviderId, endpoint: string, params: Record<string, JsonValue>): string | null {
        return getOnlineMusicProvider(providerId)?.raw?.checkParams?.(endpoint, params) ?? null;
    },

    // 以当前登录的会话调用一个平台接口，回平台原始的 JSON，凭据字段（rawResponse.ts）已经剥掉。
    // 权限由调用方查；这里再挡一次表外和永远拒绝的接口、宿主自己设置的参数、取值不合平台格式的参数（unsupported）。
    // 分类表说接口要「当前用户」而调用方没给时，填上当前账号的用户 id；没有登录就是 auth-required。
    async requestProviderRaw(
        providerId: OmniProviderId,
        endpoint: string,
        params: Record<string, JsonValue>,
        signal: AbortSignal,
    ): Promise<JsonValue> {
        const raw = getOnlineMusicProvider(providerId)?.raw;
        if (!raw) return unsupported(providerId, 'raw-requests');
        const rule = raw.describeEndpoint(endpoint);
        if (!rule || rule.access === 'denied') {
            throw new OnlineProviderError('unsupported', `${endpoint} is not open to raw requests`, providerId);
        }
        const reserved = Object.keys(params).find(name => raw.reservedParams.includes(name));
        if (reserved !== undefined) {
            throw new OnlineProviderError('unsupported', `The parameter ${reserved} is set by the host`, providerId);
        }
        const problem = raw.checkParams?.(endpoint, params) ?? null;
        if (problem !== null) {
            throw new OnlineProviderError('unsupported', `Refused parameters for ${endpoint}: ${problem}`, providerId);
        }
        let sent = params;
        if (rule.selfParam && params[rule.selfParam] === undefined) {
            const userId = useOnlineProviderAccountStore.getState().accounts[providerId]?.user?.id;
            if (userId === undefined || userId === null) {
                throw new OnlineProviderError('auth-required', `${endpoint} is about the signed-in account, and nobody is signed in`, providerId);
            }
            sent = { ...params, [rule.selfParam]: userId };
        }
        return withoutCredentials(await raw.request(endpoint, sent, signal), raw.credentialFields);
    },
};
