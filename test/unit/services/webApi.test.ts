import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFoliaApiUrl } from '@/services/webApi';

// 当前文件：验证 Folia API 地址在 Web 与 Capacitor Android 中的解析契约。

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('treats Android WebView shell as Android even before Capacitor bridge initializes (#353)', () => {
    vi.stubGlobal('window', { location: { href: 'https://localhost/' } });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
    });

    expect(() => resolveFoliaApiUrl('/api/generate-theme', {
      apiBase: '',
    })).toThrow(/VITE_FOLIA_API_BASE/);
  });
});
