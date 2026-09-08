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

test('a cache hit lands without waiting out the debounce, and a settling layout flushes a pending one', async ({ mount, page }) => {
    const component = await mount('latticeTitle');
    await expect(component.locator('.lattice-poster-copy strong[data-title-settled]')).not.toHaveCount(0);
    await page.waitForTimeout(400);

    // Timed in-page rather than by polling from the test, so the numbers are the browser's own.
    const timings = await component.locator('.lattice-root').evaluate(async (root: HTMLElement) => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const expandedTitle = (generation: number) =>
            root.querySelector<HTMLElement>(`[data-generation="${generation}"] .lattice-poster.is-expanded .lattice-poster-copy strong`);
        const waitFor = async (predicate: () => boolean) => {
            for (let i = 0; i < 600 && !predicate(); i++) await frame();
            return predicate();
        };
        const fitted = (generation: number) => Boolean(expandedTitle(generation)?.hasAttribute('data-title-settled'));
        const remount = root.querySelector<HTMLElement>('button')!;
        const layoutSettled = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

        // A width never measured before: nothing to reuse, so the debounce runs in full.
        let start = performance.now();
        expandedTitle(0)!.parentElement!.style.width = '361px';
        await waitFor(() => !fitted(0));
        await waitFor(() => fitted(0));
        const coldFit = Math.round(performance.now() - start);

        // Remounted at widths already measured once: the answer is cached, no measurement is owed.
        start = performance.now();
        remount.click();
        await waitFor(() => fitted(1));
        const warmFit = Math.round(performance.now() - start);

        // A fresh width arms the debounce; the box then reports that it has stopped growing.
        start = performance.now();
        expandedTitle(1)!.parentElement!.style.width = '347px';
        await waitFor(() => !fitted(1));
        layoutSettled.click();
        await waitFor(() => fitted(1));
        const flushedFit = Math.round(performance.now() - start);
        return { coldFit, warmFit, flushedFit };
    });

    // The debounce still governs a genuine measurement...
    expect(timings.coldFit).toBeGreaterThan(150);
    // ...but neither a cached answer nor a box that has finished moving has to sit through it.
    expect(timings.warmFit).toBeLessThan(120);
    expect(timings.flushedFit).toBeLessThan(120);
});

test('an expanding poster shows its fitted title the moment it stops growing', async ({ mount, page }) => {
    const component = await mount('latticeTitleExpansion');
    await page.waitForTimeout(1500);
    // Clicked from inside the page: the wall is virtualized and the first card sits off-screen.
    const report = await component.locator('.lattice-poster').first().evaluate(async (poster: HTMLElement) => {
        const title = () => poster.querySelector('strong')!;
        const start = performance.now();
        poster.click();
        let lastWidth = -1;
        let widthStoppedAt = 0;
        let settledAt: number | null = null;
        for (let i = 0; i < 600; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const node = title();
            const width = Math.round(node.getBoundingClientRect().width);
            if (width !== lastWidth) { widthStoppedAt = performance.now() - start; lastWidth = width; }
            if (settledAt === null && node.hasAttribute('data-title-settled')) settledAt = performance.now() - start;
            if (settledAt !== null && performance.now() - start > widthStoppedAt + 300) break;
        }
        const node = title();
        const style = getComputedStyle(node);
        return {
            gap: settledAt === null ? null : settledAt - widthStoppedAt,
            full: node.getAttribute('aria-label'),
            shown: node.textContent,
            // The settled rule drops the CSS clamp, so an early fit that overflowed would show here.
            lines: (node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
                / parseFloat(style.lineHeight),
        };
    });

    // Measured against the target width while the spring was still running, so nothing is owed once
    // it stops. Without that head start this lands roughly a debounce late and the card visibly
    // re-lays-out after it has come to rest.
    expect(report.gap).not.toBeNull();
    expect(report.gap!).toBeLessThan(60);
    expect(report.shown).not.toBe(report.full);
    expect(report.shown).toMatch(/…$/);
    expect(report.lines).toBeLessThanOrEqual(3.02);
});
