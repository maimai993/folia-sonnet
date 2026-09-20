import { expect, test } from './fixtures';

// test/component/latticeExit.spec.ts
// The leaving wave is resolved when the wall actually leaves, not when it last rendered: the
// posters are inside the exiting subtree and React never re-renders them on the way out. If that
// resolution breaks, the wall either vanishes at once or empties in the wrong order - both of
// which still unmount cleanly, so nothing else in the suite would notice.

/** Every mounted poster's world position and live opacity, in one read. */
const sample = (page: import('@playwright/test').Page) => page.evaluate(() => (
    [...document.querySelectorAll('.lattice-poster')].map(node => {
        const box = node.getBoundingClientRect();
        return { corner: box.x + box.y, opacity: Number(getComputedStyle(node).opacity) };
    })
));

test('the wall empties back toward the corner it entered from', async ({ mount, page }) => {
    const component = await mount('latticeExit');
    // Past the opening wave, so the posters measured below are at rest.
    await page.waitForTimeout(1400);
    const resting = await sample(page);
    expect(resting.length).toBeGreaterThan(8);
    expect(Math.min(...resting.map(poster => poster.opacity))).toBe(1);

    await component.getByRole('button', { name: '离开' }).click();
    // Long enough for the near corner to be well into its fade, short enough that the far corner,
    // held back by the reversed wave, has not started.
    await page.waitForTimeout(200);
    const leaving = await sample(page);
    expect(leaving.length).toBeGreaterThan(8);
    const first = leaving.reduce((a, b) => (a.corner > b.corner ? a : b));
    const last = leaving.reduce((a, b) => (a.corner < b.corner ? a : b));
    expect(first.opacity).toBeLessThan(0.9);
    expect(last.opacity).toBeGreaterThan(first.opacity + 0.2);

    // The wave still has to finish: a delay that never resolves would strand the cards here.
    await expect(component.locator('[data-gone="true"]')).toHaveCount(1, { timeout: 5000 });
    await expect(component.locator('.lattice-poster')).toHaveCount(0);
});

test('the wave follows the camera, not where a card last rendered', async ({ mount, page }) => {
    const component = await mount('latticeExit');
    await page.waitForTimeout(1400);
    // Pan well past the culled region so the corner the wave measures from is nowhere near where
    // these cards were when they last rendered. A delay captured at render time survives the first
    // case above and fails here.
    const field = component.locator('.lattice-field');
    const box = (await field.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 12; step++) await page.mouse.wheel(160, 120);
    // Long enough for the re-cull, the posters revealed by it, and their fade-up to finish.
    await page.waitForTimeout(800);
    const resting = await sample(page);
    expect(Math.min(...resting.map(poster => poster.opacity))).toBe(1);

    await component.getByRole('button', { name: '离开' }).click();
    await page.waitForTimeout(200);
    const leaving = await sample(page);
    const first = leaving.reduce((a, b) => (a.corner > b.corner ? a : b));
    const last = leaving.reduce((a, b) => (a.corner < b.corner ? a : b));
    expect(first.opacity).toBeLessThan(0.9);
    expect(last.opacity).toBeGreaterThan(first.opacity + 0.2);
});
