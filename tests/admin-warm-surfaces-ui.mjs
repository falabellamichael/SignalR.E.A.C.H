import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

export default async function(page) {
    const classes = ['reach-card', 'reach-stat-card', 'reach-tile', 'reach-stat-mini-tile', 'reach-feed-card', 'reach-presence-section', 'reach-presence-card', 'reach-live-hud'];
    await page.setContent('<main class="reach-page">' + classes.map(name => `<section class="${name}">Usage tile</section>`).join('') + '</main>');
    for (const file of ['reach.css', 'reach-components.css', 'reach-telemetry.css', 'reach-tools.css', 'reach-theme.css', 'reach-responsive.css', 'reach-browser.css']) {
        await page.addStyleTag({ content: await fs.readFile(new URL('../src/' + file, import.meta.url), 'utf8') });
    }
    for (const theme of ['warm-light', 'light']) {
        await page.evaluate(theme => {
            document.documentElement.dataset.workspaceTheme = theme;
            document.documentElement.dataset.workspaceColorScheme = 'light';
        }, theme);
        const surfaces = await page.locator('main > section').evaluateAll(nodes => nodes.map(node => ({
            background: getComputedStyle(node).backgroundColor, image: getComputedStyle(node).backgroundImage,
        })));
        for (const surface of surfaces) assert.deepEqual(surface, { background: 'rgb(255, 255, 255)', image: 'none' });
    }
    await page.evaluate(() => {
        document.documentElement.dataset.workspaceTheme = 'dark';
        document.documentElement.dataset.workspaceColorScheme = 'dark';
    });
    assert.notEqual(await page.locator('.reach-presence-card').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    return { whiteSurfaces: classes, lightAndWarmPassed: true, darkUnchanged: true };
}
