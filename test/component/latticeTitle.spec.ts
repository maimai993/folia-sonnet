import { expect, test } from './fixtures';

// Every line box the browser paints, plus the clip box that has to contain their glyphs.
// Lines past the cap are fragmented into an overflow column to the right of the clip box, so
// horizontal position is what separates "dropped" from "painted". A single line can report
// several rects (one per font run), hence the de-duplication by block position.
const measure = (node: Element) => {
    const box = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    const painted = rects.filter(rect => rect.left < box.right);
    const style = getComputedStyle(node);
    return {
        lines: new Set(painted.map(rect => Math.round(rect.top))).size,
        overflowed: rects.length > painted.length,
        cap: Number(style.getPropertyValue('--lattice-title-lines')),
        inkTop: Math.min(...painted.map(rect => rect.top)),
        inkBottom: Math.max(...painted.map(rect => rect.bottom)),
        clipTop: box.top,
        clipBottom: box.bottom,
        leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
    };
};

test('compact titles keep visible glyphs and omit text beyond three lines', async ({ mount }) => {
    const component = await mount('latticeTitle');
    const titles = component.locator('.lattice-poster-copy strong');
    await expect(titles).toHaveCount(7);
    for (const title of await titles.all()) {
        await expect(title).toHaveCSS('overflow', 'clip');
        const box = await title.evaluate(measure);
        expect(box.lines).toBeGreaterThan(0);
        expect(box.lines).toBeLessThanOrEqual(box.cap);
        // A truncated title has to spend its whole allowance. Balanced columns are the trap:
        // they would hand a four-line title two visible lines and an empty half.
        if (box.overflowed) expect(box.lines).toBe(box.cap);
        // And no glyph may be clipped at either block edge.
        expect(box.inkBottom).toBeLessThanOrEqual(box.clipBottom);
        expect(box.inkTop).toBeGreaterThanOrEqual(box.clipTop);
    }
    // At least one title has to exercise the fragmented path for the assertions above to mean anything.
    expect((await titles.nth(2).evaluate(measure)).overflowed).toBe(true);
    // The display leading itself is the fix; loosening it back out is the regression.
    expect((await titles.nth(0).evaluate(measure)).leading).toBeCloseTo(0.88, 2);
    expect((await titles.nth(3).evaluate(measure)).leading).toBeCloseTo(0.96, 2);
    // Lyric mode keeps its own one-line label, which truncates the ordinary way.
    const metadata = titles.nth(6);
    await expect(metadata).toHaveCSS('text-overflow', 'ellipsis');
    expect((await metadata.evaluate(measure)).lines).toBe(1);
    expect(await metadata.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await component.screenshot({ path: 'test-results/lattice-title-unclipped.png' });
    // Growing the available width must restore the original text, not re-truncate the preview.
    await component.locator('.lattice-poster-copy').evaluateAll(nodes => nodes.forEach(node => (node as HTMLElement).style.width = '1200px'));
    await expect(titles.nth(0)).toHaveText('壤土下的安居 Cozy Home Underground');
    await expect(titles.nth(1)).toHaveText('锤砧间的音符 Notes From Striking the Anvil');
    expect((await titles.nth(2).evaluate(measure)).overflowed).toBe(false);
});
