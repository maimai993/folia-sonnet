import { expect, test } from './fixtures';

// test/component/latticeTitle.spec.ts — settled fitting and resize/transform regressions.
test('fits after settling, restores full titles on widening, and ignores transforms', async ({ mount, page }) => {
    const component = await mount('latticeTitle');
    const title = component.locator('.lattice-poster-copy strong').first();
    const original = await title.getAttribute('aria-label');
    await expect(title).toHaveAttribute('data-title-settled', 'true');
    expect(await title.textContent()).not.toBe(original);
    expect(await title.textContent()).toMatch(/…$/);
    expect(await title.evaluate(node => {
        const style = getComputedStyle(node);
        return (node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
    })).toBeLessThanOrEqual(3.02);
    await title.evaluate(node => {
        (window as unknown as { titleMutations: number }).titleMutations = 0;
        new MutationObserver(() => { (window as unknown as { titleMutations: number }).titleMutations++; })
            .observe(node, { childList: true, attributes: true, characterData: true, subtree: true });
        (node.closest('.lattice-poster') as HTMLElement).style.transform = 'scale(1.15)';
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { titleMutations: number }).titleMutations)).toBe(0);
    await title.evaluate(node => {
        (node.parentElement as HTMLElement).style.width = '1200px';
    });
    await expect(title).toHaveText(original!);
    await expect(title).toHaveAttribute('data-title-settled', 'true');
    await title.evaluate(node => { node.parentElement!.style.width = '300px'; });
    await expect(title).toHaveAttribute('data-title-settled', 'true');
    await expect(title).not.toHaveText(original!);
    await component.screenshot({ path: 'test-results/lattice-title-settled.png' });
});

test('waits through continuous reflow before fitting again', async ({ mount, page }) => {
    const component = await mount('latticeTitle');
    const title = component.locator('.lattice-poster-copy strong').first();
    await expect(title).toHaveAttribute('data-title-settled', 'true');
    await title.evaluate(async node => {
        for (let step = 0; step < 8; step++) {
            node.parentElement!.style.width = `${300 + step * 10}px`;
            await new Promise(resolve => setTimeout(resolve, 50));
            if (node.hasAttribute('data-title-settled')) throw new Error('Fitted during continuous resize');
        }
    });
    await expect(title).toHaveAttribute('data-title-settled', 'true');
    await page.waitForTimeout(250);
    await expect(title).toHaveAttribute('data-title-settled', 'true');
});
