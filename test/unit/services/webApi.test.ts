import { describe, expect, it } from 'vitest';
import { resolveFoliaApiUrl } from '@/services/webApi';

// 当前文件：验证 Folia API 地址在 Web 与 Capacitor Android 中的解析契约。

describe('resolveFoliaApiUrl', () => {
  it('normalizes the configured remote base and endpoint', () => {
    expect(resolveFoliaApiUrl('/api/lyric-proxy', {
      apiBase: ' https://folia.izuna.top/api/ ',
      capacitorAndroid: true,
    })).toBe('https://folia.izuna.top/api/lyric-proxy');
  });

  it('keeps the same-origin Web fallback when no base is configured', () => {
    expect(resolveFoliaApiUrl('generate-theme', {
      apiBase: '',
      capacitorAndroid: false,
    })).toBe('/api/generate-theme');
  });

  it('requires a remote base for Capacitor Android', () => {
    expect(() => resolveFoliaApiUrl('/api/generate-theme', {
      apiBase: '',
      capacitorAndroid: true,
    })).toThrow(/VITE_FOLIA_API_BASE/);
  });
});
