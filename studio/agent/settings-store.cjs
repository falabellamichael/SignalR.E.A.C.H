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
    if (raw.plugins && typeof raw.plugins === 'object') {
      const p = { ...raw.plugins };
      if (p.github) {
        p.github = { ...p.github };
        if (p.github.encryptedToken) {
          try {
            if (!available()) throw new Error('Vault unavailable.');
            p.github.token = safeStorage.decryptString(Buffer.from(p.github.encryptedToken, 'base64'));
          } catch { p.github.token = ''; locked = true; }
          delete p.github.encryptedToken;
        }
      }
      for (const id of ['gmail', 'drive', 'calendar', 'github', 'outlook', 'todo', 'slack', 'notion', 'discord']) if (p[id]) {
        p[id] = { ...p[id] };
        for (const field of ['clientSecret', 'accessToken', 'refreshToken']) {
          const encrypted = 'encrypted' + field[0].toUpperCase() + field.slice(1);
          if (p[id][encrypted]) {
            try {
              if (!available()) throw new Error('Vault unavailable.');
              p[id][field] = safeStorage.decryptString(Buffer.from(p[id][encrypted], 'base64'));
            } catch { p[id][field] = ''; locked = true; }
            delete p[id][encrypted];
          }
        }
      }
      if (p.gmail) {
        if (p.gmail.encryptedPassword) {
          try {
            if (!available()) throw new Error('Vault unavailable.');
            p.gmail.password = safeStorage.decryptString(Buffer.from(p.gmail.encryptedPassword, 'base64'));
          } catch { p.gmail.password = ''; locked = true; }
          delete p.gmail.encryptedPassword;
        }
      }
      if (p.outlook) {
        p.outlook = { ...p.outlook };
        if (p.outlook.encryptedPassword) {
          try {
            if (!available()) throw new Error('Vault unavailable.');
            p.outlook.password = safeStorage.decryptString(Buffer.from(p.outlook.encryptedPassword, 'base64'));
          } catch { p.outlook.password = ''; locked = true; }
          delete p.outlook.encryptedPassword;
        }
      }
      for(const id of require('./extra-apps.cjs').ids)if(p[id]){
        p[id]={...p[id]};if(p[id].encryptedToken){try{if(!available())throw new Error('Vault unavailable');p[id].token=safeStorage.decryptString(Buffer.from(p[id].encryptedToken,'base64'));}catch{p[id].token='';locked=true;}delete p[id].encryptedToken;}
      }
      decoded.plugins = p;
    }
    if (raw.encryptedJevApiKey !== undefined) {
      try {
        if (!available()) throw new Error('Credential vault unavailable.');
        decoded.jevApiKey = safeStorage.decryptString(Buffer.from(raw.encryptedJevApiKey, 'base64'));
      } catch { decoded.jevApiKey = ''; locked = true; }
      delete decoded.encryptedJevApiKey;
    }
    return { decoded, locked };
  }
  function encode(settings) {
    const out = { ...settings, schemaVersion: SCHEMA_VERSION };
    delete out.credentialStorage;
    delete out.encryptedAccessKey;
    // The legacy projection is only needed in memory; never duplicate its key
    // on disk alongside the canonical connection list.
    delete out.accessKey;
    delete out.encryptedJevApiKey;
    delete out.jevApiKey;
    if (settings.jevApiKey) {
      if (available()) out.encryptedJevApiKey = safeStorage.encryptString(settings.jevApiKey).toString('base64');
      else out.jevApiKey = settings.jevApiKey;
    }
    out.connections = settings.connections.map(connection => {
      const entry = { ...connection };
      if (entry.accessKey && available()) {
        entry.encryptedAccessKey = safeStorage.encryptString(entry.accessKey).toString('base64');
        delete entry.accessKey;
      }
      return entry;
    });
    if (settings.plugins && typeof settings.plugins === 'object') {
      const p = { ...settings.plugins };
      if (p.github) {
        p.github = { ...p.github };
        if (p.github.token && available()) {
          p.github.encryptedToken = safeStorage.encryptString(p.github.token).toString('base64');
          delete p.github.token;
        }
      }
      for (const id of ['gmail', 'drive', 'calendar', 'github', 'outlook', 'todo', 'slack', 'notion', 'discord']) if (p[id]) {
        p[id] = { ...p[id] };
        for (const field of ['clientSecret', 'accessToken', 'refreshToken']) {
          const encrypted = 'encrypted' + field[0].toUpperCase() + field.slice(1);
          delete p[id][encrypted];
          if (p[id][field]) {
            if (!available()) throw new Error('Unlock your system credential vault before saving OAuth credentials.');
            p[id][encrypted] = safeStorage.encryptString(p[id][field]).toString('base64');
            delete p[id][field];
          }
        }
      }
      if (p.gmail) {
        if (p.gmail.password && available()) {
          p.gmail.encryptedPassword = safeStorage.encryptString(p.gmail.password).toString('base64');
          delete p.gmail.password;
        }
      }
      if (p.outlook) {
        p.outlook = { ...p.outlook };
        if (p.outlook.password && available()) {
          p.outlook.encryptedPassword = safeStorage.encryptString(p.outlook.password).toString('base64');
          delete p.outlook.password;
        }
      }
      for(const id of require('./extra-apps.cjs').ids)if(p[id]){
        p[id]={...p[id]};if(p[id].token){if(!available())throw new Error('Unlock your system credential vault before saving app tokens.');p[id].encryptedToken=safeStorage.encryptString(p[id].token).toString('base64');delete p[id].token;}
      }
      out.plugins = p;
    }
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
    const hasPlaintext = !!raw.accessKey || !!raw.jevApiKey || raw.connections?.some(entry => entry?.accessKey);
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
