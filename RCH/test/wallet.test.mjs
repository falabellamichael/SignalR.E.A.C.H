import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { createWallet, walletInfo, checkWallet, unlockWallet } from '../scripts/wallet.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rch-wallet-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const passwords = new Map();
  const vault = {
    async put(address, password) { assert.equal(passwords.has(address), false); passwords.set(address, Buffer.from(password)); },
    async get(address) { if (!passwords.has(address)) throw new Error('Fixture missing secret'); return Buffer.from(passwords.get(address)); },
  };
  t.after(() => { for (const password of passwords.values()) password.fill(0); });
  return { root, vault, passwords };
}

test('saved keystore recovers its signer without exposing keys in public output or files', async (t) => {
  const f = await fixture(t);
  const result = await createWallet('primary', f);
  assert.equal(result.decryptVerified, true);
  assert.equal(result.offlineSignatureVerified, true);
  assert.equal(result.transactionSent, false);
  const encrypted = await readFile(result.keystore, 'utf8');
  const parsed = JSON.parse(encrypted);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.Crypto.kdf, 'scrypt');
  assert.equal(parsed.Crypto.cipher, 'aes-128-ctr');
  assert.equal(parsed['x-ethers'], undefined);
  const recovered = await unlockWallet('primary', f);
  assert.equal(recovered.address, result.address);
  const publicMaterial = encrypted + JSON.stringify(result) + await readFile(result.backupInstructions, 'utf8');
  assert.equal(publicMaterial.includes(recovered.privateKey.slice(2)), false);
  assert.equal(publicMaterial.includes(f.passwords.get(result.address).toString('ascii')), false);
  assert.equal((await stat(result.keystore)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, 'primary'))).mode & 0o777, 0o700);
  assert.equal((await walletInfo('primary', { root: f.root })).address, result.address);
  const before = encrypted;
  await assert.rejects(createWallet('primary', f), /already exists/);
  assert.equal(await readFile(result.keystore, 'utf8'), before);
});

test('incorrect Keychain password and altered keystore address cannot unlock', async (t) => {
  const f = await fixture(t);
  const info = await createWallet('primary', f);
  const original = Buffer.from(f.passwords.get(info.address));
  f.passwords.set(info.address, Buffer.alloc(64, 'a'));
  await assert.rejects(checkWallet('primary', f), /Could not decrypt/);
  f.passwords.set(info.address, original);
  const data = JSON.parse(await readFile(info.keystore, 'utf8'));
  const replacement = Wallet.createRandom().address;
  data.address = replacement.slice(2).toLowerCase();
  f.passwords.set(replacement, Buffer.from(original));
  await writeFile(info.keystore, JSON.stringify(data));
  await assert.rejects(checkWallet('primary', f), /Could not decrypt|does not match/);
});

test('wallet names, file permissions, and symlinks cannot redirect or expose a wallet', async (t) => {
  const f = await fixture(t);
  for (const name of ['../outside', '/tmp/wallet', 'a\ncommand', 'UPPER', '']) {
    await assert.rejects(createWallet(name, f), /Wallet names/);
  }
  const info = await createWallet('primary', f);
  await chmod(info.keystore, 0o644);
  await assert.rejects(walletInfo('primary', f), /private, regular file/);
  await chmod(info.keystore, 0o600);
  await symlink(join(f.root, 'primary'), join(f.root, 'linked'));
  await assert.rejects(walletInfo('linked', f), /not symbolic links/);
  await chmod(join(f.root, 'primary'), 0o755);
  await assert.rejects(walletInfo('primary', f), /private/);
});

test('a failed Keychain save keeps encrypted recovery data and prevents accidental replacement', async (t) => {
  const f = await fixture(t);
  const vault = { async put() { throw new Error('Fixture locked Keychain'); } };
  await assert.rejects(createWallet('primary', { root: f.root, vault }), /locked Keychain/);
  const info = await walletInfo('primary', f);
  assert.equal(JSON.parse(await readFile(info.keystore, 'utf8')).version, 3);
  await assert.rejects(createWallet('primary', f), /already exists/);
});

test('password change preserves the address, supports recovery without Keychain, and imports on a fresh machine', async (t) => {
  const { changeWalletPassword, verifyWalletBackup, importWalletBackup } = await import('../scripts/wallet.mjs');
  const f = await fixture(t);
  const before = await createWallet('primary', f);
  const oldBytes = await readFile(before.keystore, 'utf8');
  const password = Buffer.from(' a long test passphrase: "quoted" cafe! ');
  const portable = join(f.root, 'portable.json');
  const changed = await changeWalletPassword('primary', password, { ...f, out: portable });
  assert.equal(changed.address, before.address);
  assert.equal(changed.passwordChanged, true);
  assert.notEqual(changed.keychainAccount, before.keychainAccount);
  assert.equal(await readFile(changed.previousKeystore, 'utf8'), oldBytes);
  assert.ok(f.passwords.has(before.keychainAccount));
  assert.ok(f.passwords.has(changed.keychainAccount));
  assert.equal((await checkWallet('primary', f)).address, before.address);
  const recovered = await verifyWalletBackup(portable, password, before.address);
  assert.equal(recovered.keychainUsed, false);
  assert.equal(recovered.address, before.address);
  await assert.rejects(verifyWalletBackup(portable, Buffer.from('wrong password')), /Could not decrypt/);
  await assert.rejects(verifyWalletBackup(portable, password, Wallet.createRandom().address), /does not match/);
  // Fresh root and empty vault model a reformatted Mac, without the old Keychain.
  const fresh = await fixture(t);
  const restored = await importWalletBackup('restored', portable, password, fresh);
  assert.equal(restored.address, before.address);
  assert.equal(restored.restored, true);
  assert.notEqual(restored.keychainAccount, changed.keychainAccount);
  await assert.rejects(importWalletBackup('restored', portable, password, fresh), /already exists/);
  const publicMaterial = JSON.stringify(changed) + await readFile(portable, 'utf8');
  assert.equal(publicMaterial.includes(password.toString()), false);
  password.fill(0);
});

test('failed password change, weak passwords, and existing output leave the active wallet intact', async (t) => {
  const { changeWalletPassword } = await import('../scripts/wallet.mjs');
  const f = await fixture(t);
  const info = await createWallet('primary', f);
  const before = await readFile(info.keystore, 'utf8');
  const password = Buffer.from('long enough test passphrase');
  await assert.rejects(changeWalletPassword('primary', Buffer.from('short'), f), /at least 12/);
  await assert.rejects(changeWalletPassword('primary', password, { ...f, out: info.keystore }), /already exists/);
  const failedVault = { ...f.vault, async put() { throw new Error('Fixture Keychain unavailable'); } };
  await assert.rejects(changeWalletPassword('primary', password, { root: f.root, vault: failedVault }), /Keychain unavailable/);
  assert.equal(await readFile(info.keystore, 'utf8'), before);
  assert.equal((await checkWallet('primary', f)).address, info.address);
  await assert.rejects(stat(join(f.root, 'primary', '.password-change.lock')), { code: 'ENOENT' });
  password.fill(0);
});

test('hidden password input rejects pipes, hides typed characters, and restores terminal mode on cancellation', async () => {
  const { hiddenPassword } = await import('../scripts/wallet-password.mjs');
  const { PassThrough, Writable } = await import('node:stream');
  assert.throws(() => hiddenPassword('Password: ', { input: {}, output: {} }), /real|Terminal/);
  function terminal() {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw) => { input.isRaw = raw; };
    let outputText = '';
    const output = new Writable({ write(chunk, encoding, done) { outputText += chunk.toString(); done(); } });
    output.isTTY = true;
    return { input, output, text: () => outputText };
  }
  const io = terminal();
  const pending = hiddenPassword('Password: ', io);
  io.input.write('fixture passphrasX\u007fe\r');
  const value = await pending;
  assert.equal(value.toString(), 'fixture passphrase');
  assert.equal(io.text(), 'Password: \n');
  assert.equal(io.input.isRaw, false);
  value.fill(0);
  const cancel = terminal();
  const cancelled = hiddenPassword('Password: ', cancel);
  cancel.input.write('never-visible\u0003');
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(cancel.text(), 'Password: \n');
  assert.equal(cancel.input.isRaw, false);
});
