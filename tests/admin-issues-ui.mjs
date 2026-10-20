import setup from './admin-layout-ui.mjs';

export default async function (page) {
    await setup(page);
    await page.evaluate(() => {
        window.qaCleanup?.();
        const host = document.querySelector('.reach-content');
        host.replaceChildren();
        const original = window.setInterval;
        window.setInterval = callback => { window.qaTick = callback; return 0; };
        window.qaCleanup = window.__reachPages.logs(host);
        window.setInterval = original;
    });
    const input = page.getByPlaceholder('model filter (e.g. gpt-4o*)');
    await input.waitFor();
    await input.fill('unfinished-filter');
    await page.evaluate(() => window.qaTick());
    await page.waitForTimeout(100);
    if (await input.inputValue() !== 'unfinished-filter') throw new Error('Polling erased the draft filter');
    if (!await input.evaluate(node => node === document.activeElement)) throw new Error('Polling stole focus');
    await input.press('Tab');
    await page.waitForTimeout(100);
    await page.locator('.reach-log-row-clickable').first().click();
    await page.locator('.reach-modal-overlay').waitFor();
    await page.evaluate(() => window.qaCleanup());
    if (await page.locator('.reach-modal-overlay').count()) throw new Error('Inspector survived page cleanup');
    return { filterDraftAndFocusPreserved: true, inspectorRemovedOnCleanup: true };
}
