import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianCatalog.test.ts

const require = createRequire(import.meta.url);
const { createCatalogOperations } = require('../../../electron/bodian/catalog.cjs');

describe('Bodian catalog operations', () => {
    it('builds Discover detail requests with a validated index', async () => {
        const client = { call: vi.fn().mockResolvedValue({ data: { title: '潮趣日推', musicList: [] } }) };
        const operations = createCatalogOperations(client);
        await expect(operations.ai_playlist_detail({ index: 3 })).resolves.toEqual({ title: '潮趣日推', musicList: [] });
        expect(client.call).toHaveBeenCalledWith('/api/service/home/aiPlaylistDetail', { params: { index: 3 } });
    });

    it('rejects malformed Discover indexes before networking', async () => {
        const client = { call: vi.fn() };
        const operations = createCatalogOperations(client);
        expect(() => operations.ai_playlist_detail({ index: -1 })).toThrow('Invalid Bodian Discover index');
        expect(() => operations.home_module({ moduleId: 'bad' })).toThrow('Invalid Bodian home module id');
        expect(client.call).not.toHaveBeenCalled();
    });
});
