import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccountSummary } from '@/types/onlineMusic';

// test/unit/search/searchSources.test.ts
// 搜索页的来源：「全部」排最前（所有能搜的平台一起搜），当前平台次之，其余配置了的平台都列
// （不看登没登录：游客也能搜到歌），然后本地（有歌才列）、云端缓存（AI 主题）、Navidrome（配好了才列）。

// The hook beside the rule reads the Navidrome switch at import; the rule itself is pure.
vi.mock('@/services/navidromeService', () => ({ getNavidromeConfig: () => null, isNavidromeEnabled: () => false }));

const { resolveSearchSources } = await import('@/components/app/search/searchSources');

const provider = (providerId: string, overrides: Partial<ProviderAccountSummary> = {}): ProviderAccountSummary => ({
    providerId,
    displayName: providerId,
    shortName: providerId,
    availability: { configured: true },
    requiresAccount: true,
    status: 'anonymous',
    user: null,
    collections: [],
    hydration: 'ready',
    freshness: 'fresh',
    ...overrides,
} as ProviderAccountSummary);

const providers = [
    provider('netease', { status: 'authenticated' }),
    provider('qq'),
    provider('kugou', { status: 'authenticated' }),
    provider('spotify', { status: 'authenticated', availability: { configured: false } }),
    provider('folium.mod.source', { requiresAccount: false }),
];

describe('search sources', () => {
    it('lists "all" first, then the current platform, then every configured one, then the library sources', () => {
        expect(resolveSearchSources({ providers, activeProviderId: 'netease', hasLocalSongs: true, navidromeReady: true }))
            .toEqual(['all', 'netease', 'qq', 'kugou', 'folium.mod.source', 'local', 'cloud', 'navidrome']);
    });

    it('lists platforms nobody is signed in to as well: a guest can search them', () => {
        expect(resolveSearchSources({ providers, activeProviderId: 'qq', hasLocalSongs: false, navidromeReady: false }))
            .toEqual(['all', 'qq', 'netease', 'kugou', 'folium.mod.source', 'cloud']);
    });

    it('leaves out the platform that is not configured, the local library without songs and Navidrome that is not set up', () => {
        const sources = resolveSearchSources({ providers, activeProviderId: 'kugou', hasLocalSongs: false, navidromeReady: false });
        expect(sources).not.toContain('local');
        expect(sources).not.toContain('navidrome');
        // Not configured (signed out or otherwise unavailable) is not offered.
        expect(sources).not.toContain('spotify');
    });
});
