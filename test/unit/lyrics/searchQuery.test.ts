import { describe, expect, it } from 'vitest';
import { buildKugouLyricSearchQuery, buildLyricSearchQuery } from '@/utils/lyrics/searchQuery';

// test/unit/lyrics/searchQuery.test.ts
// Covers lyric search query construction edge cases.

describe('buildLyricSearchQuery', () => {
    it('trims noisy tail content from very long album names', () => {
        const query = buildLyricSearchQuery(
            'SAKURAスキップ',
            '高田憂希/山口愛/戸田めぐみ/竹尾歩美',
            'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」 歌：fourfolium（高田憂希／山口愛／戸田めぐみ／竹尾歩美） ※読み：fourfolium＝フォーフォリウム'
        );

        expect(query).toBe('SAKURAスキップ - 高田憂希/山口愛/戸田めぐみ/竹尾歩美 - TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」');
    });

    it('keeps normal album names unchanged', () => {
        expect(buildLyricSearchQuery('Night of Bloom', 'Kirara Magic/Xomu/nayuta', 'Night of Bloom'))
            .toBe('Night of Bloom - Kirara Magic/Xomu/nayuta - Night of Bloom');
    });
});

describe('buildKugouLyricSearchQuery', () => {
    it('uses only the title segment from structured metadata queries', () => {
        expect(buildKugouLyricSearchQuery(
            'SAKURAスキップ - 高田憂希/山口愛/戸田めぐみ/竹尾歩美 - TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」'
        )).toBe('SAKURAスキップ');
    });

    it('keeps unstructured manual keywords unchanged', () => {
        expect(buildKugouLyricSearchQuery('SAKURAスキップ fourfolium')).toBe('SAKURAスキップ fourfolium');
    });
});
