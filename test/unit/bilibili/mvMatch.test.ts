import { describe, expect, it } from 'vitest';
import {
    buildSearchKeyword,
    pickBestMvHit,
    scoreMvHit,
    type MvMatchInput,
} from '@/services/bilibili/mvMatch';
import type { BilibiliSearchHit } from '@/types/bilibili';

const hit = (over: Partial<BilibiliSearchHit> = {}): BilibiliSearchHit => ({
    bvid: 'BV1xx411c7mD',
    title: '稻香',
    author: '周杰伦',
    durationSec: 223,
    coverUrl: '',
    playCount: 1000,
    ...over,
});

const input: MvMatchInput = { title: '稻香', artist: '周杰伦', durationSec: 223 };

describe('scoreMvHit', () => {
    it('标题命中歌名会显著加分', () => {
        const matched = scoreMvHit(hit(), input);
        const unmatched = scoreMvHit(hit({ title: '完全无关的视频' }), input);
        expect(matched.titleHit).toBe(true);
        expect(unmatched.titleHit).toBe(false);
        expect(matched.score).toBeGreaterThan(unmatched.score + 50);
    });

    it('作者是歌手本人时加分', () => {
        const official = scoreMvHit(hit({ author: '周杰伦' }), input);
        const other = scoreMvHit(hit({ author: '随便一个up' }), input);
        expect(official.artistHit).toBe(true);
        expect(official.score).toBeGreaterThan(other.score);
    });

    it('翻唱 / 伴奏这类标题会被扣分', () => {
        const clean = scoreMvHit(hit(), input);
        const cover = scoreMvHit(hit({ title: '稻香（翻唱 cover）' }), input);
        expect(cover.score).toBeLessThan(clean.score);
    });

    it('时长差太远的会被扣分（合集）', () => {
        const normal = scoreMvHit(hit(), input);
        const hourLong = scoreMvHit(hit({ title: '稻香 合集', durationSec: 3600 }), input);
        expect(hourLong.score).toBeLessThan(normal.score);
    });

    it('全角括号也能匹配', () => {
        const scored = scoreMvHit(hit({ title: '稻香（Official MV）' }), input);
        expect(scored.titleHit).toBe(true);
    });
});

describe('pickBestMvHit', () => {
    it('挑出最像的那一条', () => {
        const hits = [
            hit({ bvid: 'BVCover', title: '稻香（翻唱）', author: '路人', playCount: 9_999_999 }),
            hit({ bvid: 'BVReal', title: '周杰伦 稻香 官方MV', author: '周杰伦' }),
        ];
        expect(pickBestMvHit(hits, input)?.bvid).toBe('BVReal');
    });

    it('标题没命中歌名的一律不选', () => {
        const hits = [hit({ title: '随便一条' }), hit({ title: '另一条' })];
        expect(pickBestMvHit(hits, input)).toBeNull();
    });

    it('空结果回 null', () => {
        expect(pickBestMvHit([], input)).toBeNull();
    });

    it('高播放量的合集不会压过正经 MV', () => {
        const hits = [
            hit({ bvid: 'BVMix', title: '稻香 合集 歌单', author: '音乐站', playCount: 50_000_000 }),
            hit({ bvid: 'BVSingle', title: '稻香', author: '周杰伦', playCount: 100 }),
        ];
        expect(pickBestMvHit(hits, input)?.bvid).toBe('BVSingle');
    });
});

describe('buildSearchKeyword', () => {
    it('把歌名和歌手拼起来', () => {
        expect(buildSearchKeyword('稻香', '周杰伦')).toBe('稻香 周杰伦');
    });

    it('去掉《》这类符号', () => {
        expect(buildSearchKeyword('《稻香》', '周杰伦')).toBe('稻香 周杰伦');
    });

    it('缺歌手时只留歌名', () => {
        expect(buildSearchKeyword('稻香', '')).toBe('稻香');
    });
});
