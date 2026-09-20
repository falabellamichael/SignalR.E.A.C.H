'use strict';

const fs = require('node:fs');
const { atomicWriteJson } = require('./atomic-write.cjs');
const { normalizeSettings } = require('./connections.cjs');
const SCHEMA_VERSION = 1;

// safeStorage is injected: this module can be tested without loading Electron.
// Linux's basic_text backend is obfuscation, not a system credential vault.
function createSettingsStore({ file, safeStorage }) {
  let loadFailed = false;
  const available = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  function read() {
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings object.');
      return raw;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Settings could not be read. Preserve settings.json and restore a backup before saving.');
    }
  }
  function decode(raw) {
    if (raw.schemaVersion !== undefined && (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion > SCHEMA_VERSION || raw.schemaVersion < 0)) {
      throw new Error('Settings were written by an unsupported version. Update Studio before saving.');
    }
    let locked = false;
    const decodeKey = entry => {
      const out = { ...entry };
      if (out.encryptedAccessKey !== undefined) {
        try {
          if (!available()) throw new Error('Credential vault unavailable.');
          out.accessKey = safeStorage.decryptString(Buffer.from(out.encryptedAccessKey, 'base64'));
        } catch { out.accessKey = ''; locked = true; }
        delete out.encryptedAccessKey;
      }
      return out;
    };
    const decoded = decodeKey(raw);
    if (Array.isArray(raw.connections)) decoded.connections = raw.connections.map(decodeKey);
    return { decoded, locked };
  }
  function encode(settings) {
    const out = { ...settings, schemaVersion: SCHEMA_VERSION };
    delete out.credentialStorage;
    delete out.encryptedAccessKey;
    // The legacy projection is only needed in memory; never duplicate its key
    // on disk alongside the canonical connection list.
    delete out.accessKey;
    out.connections = settings.connections.map(connection => {
      const entry = { ...connection };
      if (entry.accessKey && available()) {
        entry.encryptedAccessKey = safeStorage.encryptString(entry.accessKey).toString('base64');
        delete entry.accessKey;
      }
      return entry;
    });
    return out;
  }
  function persist(value) {
    atomicWriteJson(file(), value);
    fs.chmodSync(file(), 0o600);
  }
  function loadDecoded() {
    const raw = read();
    const { decoded, locked } = decode(raw);
    const settings = normalizeSettings(decoded).settings;
    const hasPlaintext = !!raw.accessKey || raw.connections?.some(entry => entry?.accessKey);
    const exists = fs.existsSync(file());
    if (exists && !locked && (raw.schemaVersion !== SCHEMA_VERSION || hasPlaintext && available())) {
      const encoded = encode(settings); // Encrypt everything before touching disk.
      const backup = file() + '.bak';
      if (!fs.existsSync(backup)) {
        // Keep the original shape recoverable without creating a new plaintext
        // secret copy when the OS vault is available.
        const snapshot = available()
          ? { encryptedSettings: safeStorage.encryptString(JSON.stringify(raw)).toString('base64') }
          : raw;
        atomicWriteJson(backup, snapshot);
        fs.chmodSync(backup, 0o600);
      } else if (available()) {
        // A previous run without an OS vault may have made a plaintext backup.
        // Upgrade it too, preserving its ORIGINAL contents rather than replacing
        // it with today's settings or leaving a forgotten readable key behind.
        const original = JSON.parse(fs.readFileSync(backup, 'utf8'));
        if (!original.encryptedSettings) {
          atomicWriteJson(backup, { encryptedSettings: safeStorage.encryptString(JSON.stringify(original)).toString('base64') });
          fs.chmodSync(backup, 0o600);
        }
      }
      persist(encoded);
    }
    settings.schemaVersion = SCHEMA_VERSION;
    settings.credentialStorage = {
      encrypted: available(), locked,
      warning: locked ? 'Some saved keys could not be unlocked. Settings are read-only to protect them; unlock your system keychain and restart Studio.'
        : available() ? '' : 'System credential encryption is unavailable. API keys are stored as plaintext in settings.json (owner-only permissions).',
    };
    return settings;
  }
  function load() {
    try { const result = loadDecoded(); loadFailed = false; return result; }
    catch {
      loadFailed = true;
      // theme:get is synchronous during renderer startup. A corrupt file or
      // keychain failure must not throw across that IPC and strand the window.
      // Do not rewrite the unreadable file; save() independently fails closed.
      return { ...normalizeSettings({}).settings, credentialStorage: {
        encrypted: available(), locked: true,
        warning: 'Settings could not be loaded safely. The original file is preserved. Check your keychain, settings.json and its backup before saving; a newer settings version requires an updated Studio.',
      } };
    }
  }
  function save(settings) {
    if (loadFailed) {
      load();
      if (loadFailed) throw new Error('Settings are read-only until the original file and credential vault can be loaded safely.');
      throw new Error('Settings are available again. Reload Settings before saving so the recovered values are not overwritten.');
    }
    if (decode(read()).locked) throw new Error('Saved keys are locked. Unlock your system keychain before saving settings.');
    persist(encode(normalizeSettings(settings).settings));
  }
  return { load, save };
}

module.exports = { createSettingsStore, SCHEMA_VERSION };
