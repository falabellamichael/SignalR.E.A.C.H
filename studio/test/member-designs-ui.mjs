import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const renderer = new URL('../renderer/', import.meta.url);
export default async function (page) {
  await page.setContent('<html><head><title>Team bot workshop QA</title></head><body><div id="team-members"><div><button class="member-design-pick">Design</button></div></div><section id="team-design-board"></section></body></html>');
  await page.addStyleTag({ content: await fs.readFile(new URL('styles.css', renderer), 'utf8') });
  await page.addScriptTag({ content: await fs.readFile(new URL('member-designs.js', renderer), 'utf8') });
  const source = await fs.readFile(new URL('app-create.js', renderer), 'utf8');
  const picker = source.slice(source.indexOf('function openDesignPicker('), source.indexOf('\nfunction renderTeamBuilder('));
  await page.addScriptTag({ content: `const $ = s => document.querySelector(s); const personas = [{id:'qa',name:'Builder'}]; const teamBuilderMembers = [{personaId:'qa',designId:'bot-01'}]; ${picker}; openDesignPicker(0);` });
  await page.getByLabel('Eyes', { exact: true }).selectOption('wink');
  await page.getByLabel('Mouth', { exact: true }).selectOption('grille');
  await page.getByLabel('Top piece', { exact: true }).selectOption('crown');
  await page.getByLabel('Head shape', { exact: true }).selectOption('hex');
  await page.addScriptTag({ content: `document.body.dataset.config = JSON.stringify(ReachMemberDesigns.config(teamBuilderMembers[0].designId));` });
  const config = JSON.parse(await page.locator('body').getAttribute('data-config'));
  assert.equal(config.eyes, 'wink'); assert.equal(config.mouth, 'grille'); assert.equal(config.top, 'crown'); assert.equal(config.shape, 'hex');
  assert.equal(await page.getByLabel('Animation', { exact: true }).locator('option').count(), 26);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const animation of await page.getByLabel('Animation', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value))) {
    await page.getByLabel('Animation', { exact: true }).selectOption(animation);
    const motion = await page.locator('.team-design-preview svg').evaluate(svg => {
      const parts = [...svg.querySelectorAll('g')];
      return { id: svg.dataset.animation, names: parts.map(el => getComputedStyle(el).animationName), active: svg.getAnimations({ subtree: true }).length };
    });
    assert.equal(motion.id, animation);
    assert.equal(motion.active, animation === 'none' ? 0 : 1, animation);
    if (animation !== 'none') assert.ok(motion.names.includes('bot-' + animation), animation);
    assert.equal(await page.locator('#team-members svg').getAttribute('data-animation'), animation);
  }
  await page.getByLabel('Animation', { exact: true }).selectOption('dance');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.locator('#team-design-board').isVisible(), false);
  await page.addScriptTag({ content: 'openDesignPicker(0);' });
  assert.equal(await page.getByLabel('Eyes', { exact: true }).inputValue(), 'wink');
  assert.equal(await page.getByLabel('Animation', { exact: true }).inputValue(), 'dance');
  await page.getByText('Start from a preset', { exact: true }).click();
  await page.getByRole('button', { name: 'Tide scout', exact: true }).click();
  assert.equal(await page.getByLabel('Animation', { exact: true }).inputValue(), 'dance');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.team-design-preview svg').evaluate(svg => svg.getAnimations({ subtree: true }).length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const width of [1000, 360]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
  }
  await page.getByRole('button', { name: 'Shuffle bot', exact: true }).click();
  assert.equal(await page.locator('.team-design-preview svg').count(), 1);
  return { independentFeatures: true, reopenPreservesDesign: true, widths: [1000, 360], shuffle: true };
}
