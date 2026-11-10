import { describe, expect, it } from 'vitest';
import { onAccentColor } from '../../../src/components/modal/settings/kit/kitTheme';
import { parseNumberText } from '../../../src/components/modal/settings/kit/numberText';
import { placePopover } from '../../../src/components/modal/settings/kit/popoverPlace';
import { landOnMark } from '../../../src/components/modal/settings/kit/Slider';
import { getContrastRatio } from '../../../src/utils/themeColorMath';

// test/unit/settings/settingsKit.test.ts
// The two rules of the settings kit that cannot be seen by using the window: which colour goes on
// the accent, and what number a typed text is. Both were wrong in ways that looked fine: white on a
// mid-light accent at 2.5:1, and "0,7" saved as typed and then used as 0.
// After them: where a layer that opens from a control is put, and where a dragged slider lands.

describe('the colour on the accent', () => {
    const DARK = '#17171a';
    const WHITE = '#ffffff';

    // Accents between the old fixed cut (luminance 0.4) and the point where dark starts to read
    // better (about 0.2) used to get white.
    it.each(['#ea580c', '#ff7f50', '#10b981', '#e879f9', '#a3a3a3'])('is dark on the mid-light accent %s', (accent) => {
        expect(onAccentColor(accent)).toBe(DARK);
    });

    it.each(['#2563eb', '#18181b', '#7c3aed'])('is white on the dark accent %s', (accent) => {
        expect(onAccentColor(accent)).toBe(WHITE);
    });

    it('is dark on the near-white accent of the default dark theme', () => {
        expect(onAccentColor('#f4f4f5')).toBe(DARK);
    });

    it('is never the worse of the two', () => {
        for (const accent of ['#ea580c', '#2563eb', '#10b981', '#808080', '#f4f4f5', '#18181b', '#facc15', '#be123c']) {
            const chosen = getContrastRatio(onAccentColor(accent), accent);
            expect(chosen).toBe(Math.max(getContrastRatio(DARK, accent), getContrastRatio(WHITE, accent)));
        }
    });
});

describe('a typed number', () => {
    it.each([
        ['0.7', 0.7],
        ['0,7', 0.7],
        ['1,5', 1.5],
        ['0，7', 0.7],
        ['0。7', 0.7],
        [' 0.7 ', 0.7],
        ['3', 3],
        ['.5', 0.5],
        ['1.', 1],
        ['-1', -1],
    ])('reads %j as %d', (text, value) => {
        expect(parseNumberText(text)).toBe(value);
    });

    // parseFloat reads the start of each of these as a number.
    it.each(['', '   ', 'abc', '0.7abc', '1e3', '1,234.5', '0.7.1', '.', 'Infinity'])('reads %j as no number', (text) => {
        expect(parseNumberText(text)).toBeNull();
    });
});

describe('where a popover goes', () => {
    // A window that is not at the corner of the screen: every distance is from its own edges.
    const WINDOW = { left: 100, top: 50, width: 400, height: 600 };
    const LAYER = { width: 200, height: 120 };
    const anchorAt = (left: number, top: number) => ({ left, top, width: 80, height: 32 });

    it('hangs under its anchor from the edge asked for', () => {
        expect(placePopover(anchorAt(140, 100), LAYER, WINDOW, { side: 'under', align: 'start' }))
            .toEqual({ side: 'under', left: 40, top: 88, maxHeight: 504 });
        expect(placePopover(anchorAt(340, 100), LAYER, WINDOW, { side: 'under', align: 'end' }))
            .toEqual({ side: 'under', right: 80, top: 88, maxHeight: 504 });
    });

    it('goes over the anchor where the window ends too soon under it, and under it where it was asked over and does not fit there', () => {
        expect(placePopover(anchorAt(140, 560), LAYER, WINDOW, { side: 'under', align: 'start' }))
            .toEqual({ side: 'over', left: 40, bottom: 96, maxHeight: 496 });
        expect(placePopover(anchorAt(140, 100), LAYER, WINDOW, { side: 'over', align: 'start' }))
            .toEqual({ side: 'under', left: 40, top: 88, maxHeight: 504 });
    });

    it('takes the whole window in one shorter than the layer, whatever side was asked for', () => {
        const short = { ...WINDOW, height: 300 };
        const tall = { width: 200, height: 400 };
        /*
         * 窗口比弹层矮时，两侧都不可能装下。
         * 以前是「挑余量更大的那一侧」然后给那个余量 —— 结果是一个很窄的框，
         * 内容要多滑好几屏才到底。现在改成直接吃满窗口高度。
         */
        for (const side of ['over', 'under'] as const) {
            const place = placePopover(anchorAt(140, 180), tall, short, { side, align: 'start' });
            expect(place.top).toBe(8);
            expect(place.maxHeight).toBe(300 - 16);
        }
        // 侧边仍然是原来那套对齐规则。
        expect(placePopover(anchorAt(140, 180), tall, short, { side: 'under', align: 'start' }).left).toBe(40);
    });

    it('counts from the scrolled edges of a window whose content is scrolled, with the same room', () => {
        const scrolled = { ...WINDOW, scrollLeft: 10, scrollTop: 40 };
        expect(placePopover(anchorAt(140, 100), LAYER, scrolled, { side: 'under', align: 'start' }))
            .toEqual({ side: 'under', left: 50, top: 128, maxHeight: 504 });
        expect(placePopover(anchorAt(340, 560), LAYER, scrolled, { side: 'under', align: 'end' }))
            .toEqual({ side: 'over', right: 70, bottom: 56, maxHeight: 496 });
        expect(placePopover(anchorAt(300, 100), LAYER, scrolled, { side: 'under', align: 'end', fill: true }))
            .toMatchObject({ left: 18, right: -2, top: 128 });
    });

    it('stays a gutter inside the window at both sides', () => {
        // The anchor is at the window's right edge: a layer from its start would pass that edge.
        expect(placePopover(anchorAt(400, 100), LAYER, WINDOW, { side: 'under', align: 'start' }).left).toBe(192);
        // The anchor is at the window's left edge: a layer from its end would pass that edge.
        expect(placePopover(anchorAt(104, 100), LAYER, WINDOW, { side: 'under', align: 'end' }).right).toBe(192);
        // A layer wider than the window starts at the gutter.
        expect(placePopover(anchorAt(140, 100), { width: 500, height: 120 }, WINDOW, { side: 'under', align: 'start' }).left).toBe(8);
    });

    /*
     * 横屏手机上的控制面板很矮（三百来像素），而「歌词样式 / 背景类型 / 音频效果器」
     * 这几个下拉的内容有三四百像素。锚点在面板中部：下方只剩一百多像素，
     * 弹层被压成那么高，内容要在一个很小的框里滚很久才见得到底 ——
     * 用户感受就是「怎么滑都滑不到底」。
     *
     * 一侧装不下时，就该把整个窗口的高度给它，滚在最大的框里。
     */
    it('takes the whole window when it does not fit on one side of its anchor', () => {
        const short = { ...WINDOW, height: 300 };
        const medium = { width: 200, height: 260 };
        // 锚点靠下：下方只剩很少，两侧都装不下这份内容。
        const place = placePopover(anchorAt(140, 210), medium, short, { side: 'under', align: 'start' });
        // 铺开之后不再分上下 —— top 从窗口顶端留白算起，高度吃满到窗口底端。
        expect(place.top).toBe(8);
        expect(place.maxHeight).toBe(300 - 16);
        // 铺开时不该再给 bottom（否则高度被定死，失去自适应）。
        expect(place.bottom).toBeUndefined();
    });

    it('takes the whole window even when the layer is taller than the window itself', () => {
        const short = { ...WINDOW, height: 300 };
        const tall = { width: 200, height: 400 };
        const place = placePopover(anchorAt(140, 180), tall, short, { side: 'under', align: 'start' });
        // 内容比窗口还高：更要铺开 —— 单侧只会更矮、要多滑一截。
        expect(place.top).toBe(8);
        expect(place.maxHeight).toBe(300 - 16);
        // 仍然不能比窗口还高：超出部分靠内部滚动。
        expect(place.maxHeight).toBeLessThan(short.height);
    });

    it('is as wide as the window, less the gutters, when asked to fill', () => {
        expect(placePopover(anchorAt(300, 100), LAYER, WINDOW, { side: 'under', align: 'end', fill: true }))
            .toMatchObject({ left: 8, right: 8, top: 88 });
    });

    it('is centred on its anchor, and moved in at the edge of the screen', () => {
        const screen = { left: 0, top: 0, width: 1000, height: 700 };
        const label = { width: 120, height: 24 };
        expect(placePopover(anchorAt(500, 300), label, screen, { side: 'over', align: 'center' }))
            .toEqual({ side: 'over', left: 480, bottom: 406, maxHeight: 286 });
        expect(placePopover(anchorAt(912, 300), label, screen, { side: 'over', align: 'center' }).left).toBe(872);
        // No room over a part at the top of the screen.
        expect(placePopover(anchorAt(500, 10), label, screen, { side: 'over', align: 'center' })).toMatchObject({ side: 'under', top: 48 });
    });
});

describe('where a dragged slider lands', () => {
    // A font size in percent: the reach is what six pixels of the track are worth.
    const MARKS = [90, 100, 110, 125];
    const REACH = 4.9;

    it('lands on a mark that is within reach, on the nearer of two', () => {
        expect(landOnMark(113, MARKS, REACH)).toBe(110);
        expect(landOnMark(96, MARKS, REACH)).toBe(100);
        expect(landOnMark(110, MARKS, REACH)).toBe(110);
        expect(landOnMark(106, MARKS, 8)).toBe(110);
    });

    it('stays where it is out of reach of every mark, so a value between marks can be had', () => {
        expect(landOnMark(117, MARKS, REACH)).toBe(117);
        expect(landOnMark(95, MARKS, REACH)).toBe(95);
        expect(landOnMark(60, MARKS, REACH)).toBe(60);
    });

    it('takes a mark exactly at the end of the reach, and no mark where there is none', () => {
        expect(landOnMark(105, [100], 5)).toBe(100);
        expect(landOnMark(42, [], 100)).toBe(42);
    });
});
