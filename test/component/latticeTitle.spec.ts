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

test('a remounted title reuses the earlier measurement instead of fitting again', async ({ mount, page }) => {
    const component = await mount('latticeTitle');
    const settled = component.locator('.lattice-poster-copy strong[data-title-settled]');
    const root = component.locator('.lattice-root');
    // Only the posters the observer sees ever fit, so the baseline is measured, not assumed.
    await expect(settled).not.toHaveCount(0);
    await page.waitForTimeout(400);
    const before = await settled.count();
    const fits = await root.getAttribute('data-fits');
    expect(Number(fits)).toBeGreaterThan(0);

    // Standing in for a poster that panned off screen and came back: the component, its observers
    // and its state are gone, so only a cache outliving them can spare the second measurement.
    await component.getByRole('button', { name: 'Remount titles' }).click();
    await expect(component.locator('[data-generation]')).toHaveAttribute('data-generation', '1');
    await expect(settled).toHaveCount(before);
    // Past the 200 ms settle timer, so a late fit cannot slip in behind the assertion.
    await page.waitForTimeout(400);
    await expect(root).toHaveAttribute('data-fits', fits!);
});
