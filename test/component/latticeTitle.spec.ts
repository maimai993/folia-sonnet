import { expect, test } from './fixtures';

// Verify actual truncation and unclipped glyph painting with the reported mixed-font titles.
test('compact titles keep visible glyphs and omit text beyond three lines', async ({ mount }) => {
    const component = await mount('latticeTitle');
    const titles = component.locator('strong');
    for (const title of await titles.all()) {
        await expect(title).toHaveCSS('overflow', 'hidden');
        await expect.poll(() => title.evaluate(node => (node as HTMLElement).offsetHeight / parseFloat(getComputedStyle(node).lineHeight))).toBeLessThan(3.05);
    }
    await expect(titles.nth(1)).toHaveCSS('-webkit-line-clamp', '3');
    await component.screenshot({ path: 'test-results/lattice-title-unclipped.png' });
    // Growing the available width must restore the original text, not re-truncate the preview.
    await component.locator('.lattice-poster-copy').evaluateAll(nodes => nodes.forEach(node => (node as HTMLElement).style.width = '1200px'));
    await expect(titles.nth(0)).toHaveText('壤土下的安居 Cozy Home Underground');
    await expect(titles.nth(1)).toHaveText('锤砧间的音符 Notes From Striking the Anvil');
});
