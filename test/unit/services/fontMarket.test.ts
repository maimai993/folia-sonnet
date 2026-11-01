import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveToCache } from '@/services/db';
import { fetchFontMarket, installMarketFont, type FontMarketFont } from '@/services/fontMarket';

// 当前文件：字体市场目录的分页契约与字体文件下载。
//
// 分页和过滤都放在服务端 —— 前端手上只有一页，在前端筛等于只在这一页里筛，
// 翻页还会漏掉后面几页的。所以这里盯的是「请求长什么样」，以及老服务端
// 还不带分页字段时客户端能不能体面地退一步。
//
// 字体本体是二进制：下载必须走通用原生桥（bodyBase64），不能走 AI 那条
// 只回字符串的 aiRequest，否则非 UTF-8 字节会被当文本转坏。

vi.mock('@/services/db', () => ({ saveToCache: vi.fn() }));

const fontRecord = (id: string) => ({
  id,
  name: `字体 ${id}`,
  family: `FoliaMarket_${id}`,
  category: 'sans',
  categoryLabel: '黑体 / 无衬线',
  previewAspect: 3,
});

const marketFont = (overrides: Partial<FontMarketFont> = {}): FontMarketFont => ({
  id: 'font-a',
  name: '字体 A',
  family: 'FoliaMarket_font-a',
  category: 'sans',
  categoryLabel: '黑体 / 无衬线',
  license: 'OFL',
  fileName: 'font-a.ttf',
  mimeType: 'font/ttf',
  fileSize: 7,
  fileUrl: 'https://fonts.example.com/font-a.ttf',
  previewUrl: '/fonts/font-a.png',
  previewAspect: 3,
  enabled: true,
  sort: 0,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const stubFetch = (payload: unknown, ok = true, bytes?: Uint8Array): { calls: string[] } => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
      arrayBuffer: async () => (bytes ? bytes.slice().buffer : new ArrayBuffer(0)),
    } as Response;
  }));
  return { calls };
};

describe('fetchFontMarket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for one page and keeps the filters in the query', async () => {
    const { calls } = stubFetch({
      fonts: [fontRecord('a')],
      total: 57,
      page: 2,
      pageSize: 24,
      hasMore: true,
    });
    const result = await fetchFontMarket({ page: 2, pageSize: 24, category: 'sans', q: '黑体' });
    expect(result.error).toBeNull();
    expect(result.fonts).toHaveLength(1);
    expect(result.total).toBe(57);
    expect(result.page).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(calls[0]).toContain('page=2');
    expect(calls[0]).toContain('pageSize=24');
    expect(calls[0]).toContain('category=sans');
    expect(calls[0]).toContain('q=');
  });

  it('drops the defaults so the first page stays cacheable', async () => {
    const { calls } = stubFetch({ fonts: [], total: 0, page: 1, pageSize: 24, hasMore: false });
    await fetchFontMarket({ page: 1, category: 'all', q: '   ' });
    expect(calls[0]).not.toContain('page=');
    expect(calls[0]).not.toContain('category=');
    expect(calls[0]).not.toContain('q=');
  });

  it('falls back to the page length when an older server sends no totals', async () => {
    const { calls } = stubFetch({ fonts: [fontRecord('a'), fontRecord('b')] });
    const result = await fetchFontMarket();
    expect(result.error).toBeNull();
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(calls[0]).not.toContain('?');
  });

  it('turns a failed request into an empty page instead of throwing', async () => {
    stubFetch({}, false);
    const result = await fetchFontMarket({ page: 3 });
    expect(result.error).toBe('server');
    expect(result.fonts).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('ignores malformed entries instead of rendering broken cards', async () => {
    stubFetch({ fonts: [fontRecord('a'), null, { name: '没有 id' }], total: 3, hasMore: false });
    const result = await fetchFontMarket();
    expect(result.fonts.map((font) => font.id)).toEqual(['a']);
  });
});

describe('installMarketFont', () => {
  beforeEach(() => {
    vi.mocked(saveToCache).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads binary font bytes through the generic native bridge, not the AI text path', async () => {
    // 这些字节不是合法 UTF-8：走 aiRequest 的 string body 会被替换成 U+FFFD。
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x81, 0x7f, 0x25]);
    const httpRequest = vi.fn(async (_options: { url: string; method: string; bodyBase64: string }) => ({
      status: 200,
      headers: [{ name: 'content-type', value: 'font/ttf' }],
      bodyBase64: 'AP/+gIF/Jw==',
    }));
    const aiRequest = vi.fn();
    vi.stubGlobal('window', {
      setTimeout: () => 1,
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => true,
        Plugins: { FoliaNative: { httpRequest, aiRequest } },
      },
    });

    const result = await installMarketFont(marketFont());

    expect(result.base64).toBe('AP/+gIF/Jw==');
    expect(aiRequest).not.toHaveBeenCalled();
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(httpRequest.mock.calls[0][0]).toMatchObject({
      url: 'https://fonts.example.com/font-a.ttf',
      method: 'GET',
    });
    expect(saveToCache).toHaveBeenCalledWith('lyrics_uploaded_font', expect.objectContaining({
      id: 'font-a',
      name: 'font-a.ttf',
      mimeType: 'font/ttf',
      family: 'FoliaMarket_font-a',
      label: '字体 A',
    }));
    const stored = vi.mocked(saveToCache).mock.calls.at(-1)?.[1] as { blob: Blob };
    expect(stored.blob.type).toBe('font/ttf');
    expect(stored.blob.size).toBe(bytes.byteLength);
  });

  it('falls back to the page fetch on desktop and still caches the font', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const { calls } = stubFetch({}, true, bytes);

    const result = await installMarketFont(marketFont({ fileUrl: '/fonts/font-a.ttf' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/fonts/font-a.ttf');
    expect(result.base64).toBe('3q2+7w==');
    expect(result.previewUrl).toContain('/fonts/font-a.png');
    expect(saveToCache).toHaveBeenCalledWith('lyrics_uploaded_font', expect.objectContaining({
      id: 'font-a',
      name: 'font-a.ttf',
    }));
  });

  it('rejects a failed download without caching it', async () => {
    stubFetch({}, false);

    await expect(installMarketFont(marketFont())).rejects.toThrow('字体下载失败（HTTP 500）');
    expect(saveToCache).not.toHaveBeenCalled();
  });
});
