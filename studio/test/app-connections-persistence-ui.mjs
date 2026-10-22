import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

export default async function(page) {
  await page.setContent('<main><section id="settings"></section><section id="pet"></section></main>');
  await page.evaluate(source => (0, eval)(source), await fs.readFile(new URL('../renderer/app-connections.js', import.meta.url), 'utf8'));
  await page.evaluate(() => {
    let saved = { token: 'original', enabled: true };
    const command = async (action, value) => {
      if (action === 'save') {
        await new Promise(resolve => { window.finishSave = resolve; });
        saved = { ...saved, ...value.patch };
      }
      if (action === 'disconnect') saved = { enabled: false };
      window.savedConnection = saved;
      return { ok: true, items: [{ id: 'slack', name: 'Slack', enabled: saved.enabled, configured: !!saved.token,
        status: { state: saved.enabled ? 'saved' : 'disabled' }, fields: [{ key: 'token', label: 'Token', secret: true }] }] };
    };
    window.panels = ['settings', 'pet'].map(id => window.ReachAppConnections.mount(document.getElementById(id), command));
    return Promise.all(window.panels.map(panel => panel.refresh()));
  });
  for (const id of ['settings', 'pet']) {
    const panel = page.locator('#' + id);
    await panel.locator('summary').click();
    await panel.getByLabel('Token', { exact: true }).fill('replacement-' + id);
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await panel.getByLabel('Token', { exact: true }).isDisabled(), true);
    await page.evaluate(() => window.finishSave());
    assert.equal(await page.evaluate(() => window.savedConnection.token), 'replacement-' + id);
    await page.waitForFunction(id => !document.querySelector('#' + id + ' input').disabled, id);
    assert.equal(await panel.getByLabel('Token', { exact: true }).inputValue(), '');
    await panel.getByLabel('Token', { exact: true }).fill('unsaved-secret');
    await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.waitForFunction(id => document.querySelector('#' + id + ' .app-connection-badge').textContent === 'Disabled', id);
    assert.equal(await panel.getByLabel('Token', { exact: true }).inputValue(), '');
    assert.equal(await panel.getByLabel('Enable app tools').isChecked(), false);
  }
  return { settingsAndPet: true, savesComplete: true, inputsLockedDuringSave: true, disconnectClearsDrafts: true };
}
