'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSettingsStore } = require('../agent/settings-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const key = crypto.randomBytes(32);
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(16), cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final()]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-cbc', key, value.subarray(0, 16));
      return Buffer.concat([cipher.update(value.subarray(16)), cipher.final()]).toString('utf8');
    },
  };
  return { file, vault, store: createSettingsStore({ file: () => file, safeStorage: vault }) };
}

test('legacy keys migrate, remain usable, and second load does not rewrite settings or backup', t => {
  const { file, vault, store } = fixture(t);
  const original = { endpoint: 'https://example.test/v1', accessKey: 'secret-fixture-key', model: 'fixture', theme: 'light' };
  fs.writeFileSync(file, JSON.stringify(original));
  const loaded = store.load();
  assert.equal(loaded.accessKey, original.accessKey);
  assert.equal(loaded.connections[0].accessKey, original.accessKey);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.credentialStorage.warning, '');
  const disk = fs.readFileSync(file, 'utf8'), backup = fs.readFileSync(file + '.bak', 'utf8');
  assert.ok(!disk.includes(original.accessKey) && !backup.includes(original.accessKey));
  assert.equal(JSON.parse(disk).accessKey, undefined);
  assert.deepEqual(JSON.parse(vault.decryptString(Buffer.from(JSON.parse(backup).encryptedSettings, 'base64'))), original);
  assert.deepEqual(store.load(), loaded);
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup);
  store.save({ ...loaded, theme: 'dark' });
  assert.equal(store.load().accessKey, original.accessKey);
  assert.equal(store.load().theme, 'dark');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('unavailable and basic_text vaults expose an explicit plaintext warning', t => {
  const { file, vault, store } = fixture(t);
  vault.isEncryptionAvailable = () => false;
  store.save({ endpoint: 'https://example.test', accessKey: 'fallback-key' });
  assert.match(store.load().credentialStorage.warning, /plaintext/);
  assert.match(fs.readFileSync(file, 'utf8'), /fallback-key/);
  vault.isEncryptionAvailable = () => true;
  vault.getSelectedStorageBackend = () => 'basic_text';
  assert.equal(store.load().credentialStorage.encrypted, false);
  delete vault.getSelectedStorageBackend;
  assert.equal(store.load().accessKey, 'fallback-key');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('fallback-key'));
});

test('locked vault and decryption errors never overwrite the stored ciphertext', t => {
  const { file, vault, store } = fixture(t);
  store.save({ endpoint: 'https://example.test', accessKey: 'locked-key' });
  const disk = fs.readFileSync(file, 'utf8');
  vault.decryptString = () => { throw new Error('Vault locked'); };
  const loaded = store.load();
  assert.equal(loaded.accessKey, '');
  assert.equal(loaded.credentialStorage.locked, true);
  assert.throws(() => store.save({ ...loaded, theme: 'dark' }), /locked/);
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
});

test('plaintext migration backups are encrypted when the vault becomes available later', t => {
  const { file, vault, store } = fixture(t);
  const original = { endpoint: 'https://example.test', accessKey: 'old-plaintext-key' };
  fs.writeFileSync(file, JSON.stringify(original));
  vault.isEncryptionAvailable = () => false;
  store.load();
  assert.match(fs.readFileSync(file + '.bak', 'utf8'), /old-plaintext-key/);
  vault.isEncryptionAvailable = () => true;
  store.load();
  assert.ok(!fs.readFileSync(file + '.bak', 'utf8').includes(original.accessKey));
  assert.deepEqual(JSON.parse(vault.decryptString(Buffer.from(JSON.parse(fs.readFileSync(file + '.bak')).encryptedSettings, 'base64'))), original);
});

test('failed encryption, corrupt JSON and future schemas preserve the previous file', t => {
  const { file, vault, store } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ endpoint: 'https://example.test', accessKey: 'legacy-key' }));
  const disk = fs.readFileSync(file, 'utf8');
  vault.encryptString = () => { throw new Error('Vault failed'); };
  assert.equal(store.load().credentialStorage.locked, true);
  assert.throws(() => store.save({}), /read-only/);
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  fs.writeFileSync(file, '{');
  assert.match(store.load().credentialStorage.warning, /original file is preserved/);
  assert.throws(() => store.save({}), /read-only|could not be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  fs.writeFileSync(file, '{"schemaVersion":999}');
  assert.equal(store.load().credentialStorage.locked, true);
  assert.throws(() => store.save({}), /read-only|unsupported version/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion":999}');
});
