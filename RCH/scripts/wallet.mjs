import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, rmdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Wallet, getAddress, verifyMessage } from 'ethers';

export class WalletError extends Error {}
export const keychainService = 'REACH Credits CLI';
export const defaultWalletRoot = () => join(homedir(), 'Library', 'Application Support', 'REACH Credits', 'wallets');

function walletPath(name, root) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    throw new WalletError('Wallet names must start with a lowercase letter and contain only lowercase letters, digits, or hyphens (up to 40 characters).');
  }
  return join(root, name);
}

// Capture subprocess output in memory. Never attach a secret-bearing error or
// child-process output to an exception, console, shell argument, or log.
function security(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const chunks = [];
    let failed = false, size = 0;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 30_000);
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.on('data', (part) => {
      size += part.length;
      if (size > 16_384) { failed = true; child.kill(); }
      else chunks.push(part);
    });
    // The interactive security command can return success even when an individual
    // command failed; create() also reads back and compares the exact password.
    child.stderr.resume();
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        for (const chunk of chunks) chunk.fill(0);
        reject(new WalletError('macOS Keychain access failed or timed out. Unlock your login keychain and retry wallet-check; existing wallet files are preserved.'));
      } else {
        const result = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        resolve(result);
      }
    });
    child.stdin.end(input);
  });
}

function validateAccount(account) {
  const [address, slot, extra] = account.split(':');
  if (extra !== undefined || (slot !== undefined && !/^[a-f0-9]{32}$/.test(slot))) throw new WalletError('Invalid wallet Keychain reference.');
  return getAddress(address) + (slot === undefined ? '' : `:${slot}`);
}

export function macKeychain() {
  if (process.platform !== 'darwin') throw new WalletError('Local wallet storage requires macOS Keychain. Portable backup verification works without Keychain.');
  return {
    async put(account, password) {
      account = validateAccount(account);
      if (!Buffer.isBuffer(password) || !password.length || password.length > 256 || !/^[\x20-\x7e]+$/.test(password.toString('utf8'))) throw new WalletError('Keychain wallet passwords must use printable ASCII: English letters, numbers, spaces, and punctuation.');
      // Hex encoding prevents command injection while preserving spaces and punctuation.
      // Secret bytes travel through stdin; no -U overwrite or -A global access.
      const input = Buffer.from(`add-generic-password -s "${keychainService}" -a ${account} -l "RCH wallet ${account}" -X ${password.toString('hex')}\n`, 'utf8');
      try { (await security(['-i'], input)).fill(0); }
      finally { input.fill(0); }
      const saved = await this.get(account);
      try {
        if (saved.length !== password.length || !timingSafeEqual(saved, password)) throw new WalletError('Keychain password could not be verified. Preserve the wallet files and inspect Keychain Access.');
      } finally { saved.fill(0); }
    },
    async get(account) {
      const raw = await security(['find-generic-password', '-s', keychainService, '-a', validateAccount(account), '-w']);
      try {
        // security appends one newline. Preserve password spaces. This adapter
        // accepts printable ASCII because security renders non-ASCII data as hex.
        const end = raw.length && raw[raw.length - 1] === 10 ? raw.length - 1 : raw.length;
        if (!end || end > 256) throw new WalletError('The wallet password in Keychain has an unexpected format.');
        return Buffer.from(raw.subarray(0, end));
      } finally { raw.fill(0); }
    },
  };
}

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new WalletError('Wallet directories must be owned by you, private (mode 700), and not symbolic links.');
  }
}

async function writePrivate(path, data) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
}

function parseKeystore(encrypted) {
  try {
    const parsed = JSON.parse(encrypted);
    if (parsed.version !== 3 || !/^[a-fA-F0-9]{40}$/.test(parsed.address)) throw new Error();
    const address = getAddress(`0x${parsed.address}`);
    const slot = parsed['x-rch']?.keychainId;
    if (parsed['x-rch'] !== undefined && (parsed['x-rch'].version !== 1 || !/^[a-f0-9]{32}$/.test(slot))) throw new Error();
    return { address, keychainAccount: address + (slot === undefined ? '' : `:${slot}`) };
  } catch { throw new WalletError('The encrypted wallet file has an invalid format.'); }
}

async function readEncrypted(path, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 262_144 || (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new WalletError('Wallet file must be a private, regular file owned by you.');
    const encrypted = await file.readFile('utf8');
    return { encrypted, ...parseKeystore(encrypted) };
  } finally { await file.close(); }
}

async function readKeystore(name, root) {
  const directory = walletPath(name, root);
  await privateDirectory(root);
  await privateDirectory(directory);
  const path = join(directory, 'wallet.json');
  return { ...await readEncrypted(path, true), directory, path };
}

async function decryptVerified(encrypted, password, address) {
  let wallet;
  try { wallet = await Wallet.fromEncryptedJson(encrypted, password); }
  catch { throw new WalletError('Could not decrypt the wallet. Preserve its file and check the matching password or Keychain item.'); }
  if (wallet.address !== address) throw new WalletError('Decrypted wallet does not match its public address.');
  return wallet;
}

function offlineCheck(wallet) {
  const message = `REACH Credits local wallet recovery check\n${randomBytes(32).toString('hex')}`;
  const signature = wallet.signMessageSync(message);
  if (verifyMessage(message, signature) !== wallet.address) throw new WalletError('Offline wallet signature verification failed.');
}

export function backupInstructions(name, address, account = address) {
  return `# RCH wallet: ${name}

Public Ethereum address: ${address}

## Set a password you know

In macOS Terminal, from the RCH project directory:

    npm run rch -- wallet-password --wallet ${name}

Type your new password twice at the hidden prompts. It never goes in chat or a
command argument. The current password is retrieved privately from Keychain.
The command replaces wallet.json only after verifying the new encrypted file
and its separate Keychain entry. Your public address stays the same.

## Before reformatting or moving computers

1. Copy the CURRENT wallet.json to an offline device such as a USB drive.
2. Keep the password you chose separately and securely. A password alone cannot
   restore this account; both the encrypted JSON file and password are required.
3. Test your actual backup in Terminal:

       npm run rch -- wallet-verify-backup --file /path/to/your/backup.json

   Enter its password privately and check that the verified address matches above.
   This check does not use Keychain. Do not reformat until it succeeds and your
   encrypted file and password are available independently of this Mac.

## Restore

On a new or reformatted Mac, install the RCH CLI and its dependencies, then run:

    npm run rch -- wallet-import --wallet ${name} --file /path/to/your/backup.json

Enter your backup password. A new local Keychain entry is created. Existing wallets
are never overwritten. The same address controls the same on-chain assets; there
is no transfer fee just to restore access. There is no separately retained seed.

Elsewhere, import the encrypted JSON into a compatible Ethereum wallet. MetaMask
Extension supports Add wallet > Import an account > Select Type > JSON File;
select your backup and enter its file password (not the MetaMask app password).
Official instructions: https://support.metamask.io/start/use-an-existing-wallet

## This Mac's saved password

Keychain service: ${keychainService}
Keychain account: ${account}

Use Keychain Access and authenticate to inspect the matching RCH wallet item.
Passwords and private keys should never be pasted into chat or source code.
This software wallet is accessible to programs authorized under your macOS user
when Keychain is unlocked; it is not hardware isolated.

Changing a file's password does not revoke old copies of this wallet. Previous
keystores still work with their corresponding old passwords. A recovery copy
before a password change is retained locally with its original Keychain entry.
Files remaining only on this computer are not an independent backup.
`;
}

export async function walletInfo(name = 'primary', { root = defaultWalletRoot() } = {}) {
  const { address, directory, path, keychainAccount } = await readKeystore(name, root);
  return { name, address, keystore: path, backupInstructions: join(directory, 'BACKUP.md'), keychainService, keychainAccount, network: 'Ethereum (the same address can be used on mainnet and testnets; balances are separate)' };
}

export async function unlockWallet(name = 'primary', { root = defaultWalletRoot(), vault } = {}) {
  const { encrypted, address, keychainAccount } = await readKeystore(name, root);
  const password = await (vault ?? macKeychain()).get(keychainAccount);
  try { return await decryptVerified(encrypted, password, address); }
  finally { password.fill(0); }
}

export async function checkWallet(name = 'primary', options = {}) {
  const wallet = await unlockWallet(name, options);
  offlineCheck(wallet);
  return { ...await walletInfo(name, options), decryptVerified: true, offlineSignatureVerified: true, transactionSent: false };
}

export async function createWallet(name = 'primary', { root = defaultWalletRoot(), vault } = {}) {
  const directory = walletPath(name, root);
  const keychain = vault ?? macKeychain();
  await privateDirectory(root, true);
  // Exclusive reservation prevents replacing an existing wallet, including a
  // partially completed creation. A failed operation deliberately keeps files.
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new WalletError('That wallet already exists. Use wallet-info or wallet-check; creation never replaces a wallet.');
    throw error;
  }
  const password = Buffer.from(randomBytes(32).toString('hex'), 'ascii');
  // A single-account keystore: recovery requires its encrypted file and password.
  // No separate mnemonic is retained or printed.
  const wallet = new Wallet(Wallet.createRandom().privateKey);
  try {
    const encrypted = await wallet.encrypt(password);
    await writePrivate(join(directory, 'wallet.json'), encrypted + '\n');
    await writePrivate(join(directory, 'BACKUP.md'), backupInstructions(name, wallet.address));
    await keychain.put(wallet.address, password);
  } finally { password.fill(0); }
  return checkWallet(name, { root, vault: keychain });
}

export function validateNewPassword(password) {
  if (!Buffer.isBuffer(password) || [...password.toString('utf8')].length < 12 || password.length > 256 || !/^[\x20-\x7e]+$/.test(password.toString('utf8'))) {
    throw new WalletError('Choose at least 12 characters (maximum 256), using English letters, numbers, spaces, or punctuation.');
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function refreshedInstructions(name, address, keychainAccount, directory) {
  const pending = join(directory, `.instructions-${randomUUID()}.tmp`);
  await writePrivate(pending, backupInstructions(name, address, keychainAccount));
  await rename(pending, join(directory, 'BACKUP.md'));
  await syncDirectory(directory);
}

async function encryptWithReference(wallet, password) {
  const parsed = JSON.parse(await wallet.encrypt(password));
  parsed['x-rch'] = { version: 1, keychainId: randomBytes(16).toString('hex') };
  const encrypted = JSON.stringify(parsed) + '\n';
  return { encrypted, ...parseKeystore(encrypted) };
}

export async function changeWalletPassword(name, password, { root = defaultWalletRoot(), vault, out } = {}) {
  validateNewPassword(password);
  const directory = walletPath(name, root);
  await privateDirectory(root);
  await privateDirectory(directory);
  const lock = join(directory, '.password-change.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new WalletError('Another password change is active or was interrupted. Preserve all files and resolve its lock before retrying.');
    throw error;
  }
  try {
    // Reject existing export paths before touching Keychain or replacing a file.
    const exportPath = out ? join(await realpath(dirname(resolve(out))), resolve(out).split('/').pop()) : null;
    if (exportPath) {
      try { await lstat(exportPath); throw new WalletError('The backup output already exists. Choose a new path; backups are never overwritten.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const previous = await readKeystore(name, root);
    const keychain = vault ?? macKeychain();
    const wallet = await unlockWallet(name, { root, vault: keychain });
    const next = await encryptWithReference(wallet, password);
    const id = randomUUID();
    const pending = join(directory, `.wallet-pending-${id}.json`);
    await writePrivate(pending, next.encrypted);
    // Each generation gets an independent Keychain item. An interruption cannot
    // replace the old password while the old keystore is still active.
    await keychain.put(next.keychainAccount, password);
    const persisted = await keychain.get(next.keychainAccount);
    try { offlineCheck(await decryptVerified(next.encrypted, persisted, previous.address)); }
    finally { persisted.fill(0); }
    const previousFile = join(directory, `wallet.previous-${id}.json`);
    await writePrivate(previousFile, previous.encrypted);
    if (exportPath) {
      await writePrivate(exportPath, next.encrypted);
      await syncDirectory(dirname(exportPath));
    }
    await syncDirectory(directory);
    await rename(pending, previous.path);
    await syncDirectory(directory);
    await refreshedInstructions(name, next.address, next.keychainAccount, directory);
    return { ...await checkWallet(name, { root, vault: keychain }), passwordChanged: true, previousKeystore: previousFile, portableBackup: exportPath ?? previous.path, independentBackupRequired: true };
  } finally { await rmdir(lock); }
}

export async function verifyWalletBackup(path, password, expectedAddress) {
  const { encrypted, address } = await readEncrypted(path);
  if (expectedAddress && getAddress(expectedAddress) !== address) throw new WalletError('Backup address does not match the expected wallet.');
  offlineCheck(await decryptVerified(encrypted, password, address));
  return { address, backup: resolve(path), decryptVerified: true, offlineSignatureVerified: true, keychainUsed: false, transactionSent: false };
}

export async function importWalletBackup(name, path, password, { root = defaultWalletRoot(), vault } = {}) {
  const directory = walletPath(name, root);
  if (!password.length || password.length > 256 || !/^[\x20-\x7e]+$/.test(password.toString('utf8'))) throw new WalletError('Local Keychain import supports printable ASCII passwords. Use a compatible Ethereum wallet to import this backup.');
  const backup = await readEncrypted(path);
  const wallet = await decryptVerified(backup.encrypted, password, backup.address);
  offlineCheck(wallet);
  const keychain = vault ?? macKeychain();
  await privateDirectory(root, true);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new WalletError('That wallet already exists. Import never replaces a wallet; choose a different name.');
    throw error;
  }
  // Re-encryption assigns a new reference, so importing another copy of an
  // address can never overwrite another local wallet's Keychain password.
  const next = await encryptWithReference(wallet, password);
  await writePrivate(join(directory, 'wallet.json'), next.encrypted);
  await writePrivate(join(directory, 'BACKUP.md'), backupInstructions(name, next.address, next.keychainAccount));
  await keychain.put(next.keychainAccount, password);
  return { ...await checkWallet(name, { root, vault: keychain }), restored: true };
}
