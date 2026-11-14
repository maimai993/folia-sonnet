import { describe, expect, it } from 'vitest';
import { FONTS_CN_CATEGORIES, categoryPreviewText } from '@/services/fontMarket/fontsNetCn';

// 当前文件：字体市场的分类与预览样文。
//
// 用户报过一个很具体的现象：「英文分类点进去完全不显示内容」。
// 真正的原因不是列表抓不到（列表没问题），而是预览样文写死成中文 ——
// 英文字体里没有汉字字形，canvas.php 就返回一张 1520 字节的空白图。
//
// 所以这里把「英文分类必须用英文样文」钉住，防止以后再改回去。

describe('字体分类', () => {
    it('分类照抄源站，含中英文与图形三个大类', () => {
        const slugs = FONTS_CN_CATEGORIES.map((entry) => entry.slug);
        expect(slugs).toContain('zh');
        expect(slugs).toContain('en');
        expect(slugs).toContain('pic');
    });

    it('英文分类的预览样文是英文', () => {
        const text = categoryPreviewText('en');
        // 不能含汉字，否则预览必空白
        expect(/[\u4e00-\u9fa5]/.test(text)).toBe(false);
        expect(text.length).toBeGreaterThan(0);
    });

    it('中文分类的预览样文是中文', () => {
        expect(/[\u4e00-\u9fa5]/.test(categoryPreviewText('zh'))).toBe(true);
    });

    it('未知分类回落到中文样文（不会给出空串）', () => {
        expect(categoryPreviewText('不存在的分类').length).toBeGreaterThan(0);
    });

    it('每个分类都带自己的预览样文', () => {
        for (const entry of FONTS_CN_CATEGORIES) {
            expect(entry.preview, `${entry.slug} 缺 preview`).toBeTruthy();
        }
    });

    it('三类分组齐全，界面分排显示', () => {
        const groups = new Set(FONTS_CN_CATEGORIES.map((entry) => entry.group));
        expect(groups).toEqual(new Set(['type', 'style', 'foundry']));
    });
});
