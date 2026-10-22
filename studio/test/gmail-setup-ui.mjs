import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
export default async function(page) {
  await page.setContent('<div id="connections"></div>');
  await page.evaluate(source => (0, eval)(source), await fs.readFile(new URL('../renderer/app-connections.js', import.meta.url), 'utf8'));
  await page.evaluate(async () => {
    window.calls = []; let saved = {};
    window.panel = ReachAppConnections.mount(document.querySelector('#connections'), async (action, value) => {
      calls.push({ action, value });
      if (action === 'save') saved = { ...saved, ...value.patch };
      return { ok: true, items: [{ id: 'gmail', name: 'Gmail', enabled: true, allowSend: saved.allowSend,
        status: { state: 'disconnected' }, fields: [{ key: 'clientId', label: 'OAuth client ID', value: saved.clientId || '' }] }] };
    });
    await panel.refresh();
  });
  await page.locator('summary').click();
  await page.getByLabel('OAuth client ID').fill('client.apps.googleusercontent.com');
  await page.getByLabel('Also allow sending', { exact: false }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.evaluate(() => panel.refresh());
  assert.equal(await page.getByLabel('Also allow sending', { exact: false }).isChecked(), true);
  assert.equal(await page.getByLabel('OAuth client ID').inputValue(), 'client.apps.googleusercontent.com');
  await page.getByLabel('OAuth client ID').fill('second.apps.googleusercontent.com');
  await page.getByRole('button', { name: 'Connect Google', exact: true }).click();
  await page.waitForTimeout(100);
  const calls = await page.evaluate(() => window.calls);
  const connect = calls.findIndex(call => call.action === 'gmail-connect');
  assert.ok(connect > 0);
  assert.equal(calls[connect - 1].action, 'save');
  assert.equal(calls[connect - 1].value.patch.clientId, 'second.apps.googleusercontent.com');
  assert.equal(calls[connect].value.allowSend, true);
  return { savedClientRestored: true, sendPreferenceRestored: true, connectSavesDraftFirst: true };
}
