'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function credentialOrigin(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('Model keys require an HTTPS origin.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Model keys require an HTTPS origin without credentials or a path.');
    }
    return url.origin;
}
function validKey(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value); }

function createModelCredentialStore({ file, safeStorage, prompt }) {
    const available = () => {
        try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
        catch (_) { return false; }
    };
    function read() {
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new Error('Saved model credential is unavailable. Re-enter it locally.');
        }
        if (data?.version !== 1 || typeof data.encryptedPayload !== 'string'
                || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.encryptedPayload) || data.encryptedPayload.length > 20000) {
            throw new Error('Saved model credential is unavailable. Re-enter it locally.');
        }
        try { credentialOrigin(data.origin); } catch (_) { throw new Error('Saved model credential is unavailable. Re-enter it locally.'); }
        return data;
    }
    function status() {
        try { const record = read(); return { configured: !!record, origin: record?.origin || '', secureStorageAvailable: available(), locked: false }; }
        catch (_) { return { configured: true, origin: '', secureStorageAvailable: available(), locked: true }; }
    }
    function forOrigin(origin) {
        const record = read();
        if (!record) return null;
        if (!available()) throw new Error('Secure model credential storage is unavailable.');
        if (credentialOrigin(origin) !== record.origin) throw new Error('Model credential is bound to another HTTPS origin. Re-enter it locally for this endpoint.');
        try {
            const payload = JSON.parse(safeStorage.decryptString(Buffer.from(record.encryptedPayload, 'base64')));
            // The origin is inside the authenticated OS-vault ciphertext as well
            // as the public envelope. Editing the envelope cannot retarget a key.
            if (payload.version !== 1 || payload.origin !== record.origin || !validKey(payload.key)) throw new Error();
            return payload.key;
        } catch (_) { throw new Error('Saved model credential could not be unlocked. Re-enter it locally.'); }
    }
    async function promptForOrigin(origin) {
        origin = credentialOrigin(origin);
        if (!available()) throw new Error('Secure model credential storage is unavailable. No key was saved.');
        let key = await prompt(origin);
        if (key === null) return false;
        if (!validKey(key)) throw new Error('Enter a valid relay API key in the native prompt.');
        let encrypted;
        try { encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, origin, key })); }
        catch (_) { throw new Error('Secure model credential storage is unavailable. No key was saved.'); }
        finally { key = null; }
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Secure model credential storage is unavailable. No key was saved.');
        const record = { version: 1, origin, encryptedPayload: encrypted.toString('base64'), updatedAt: Date.now() };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = file + '.' + crypto.randomUUID() + '.tmp';
        try {
            fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, file);
        } catch (_) {
            try { fs.unlinkSync(temporary); } catch (_) { /* encrypted temporary only */ }
            throw new Error('Encrypted model credential could not be saved.');
        }
        return true;
    }
    return { status, forOrigin, promptForOrigin };
}
module.exports = { createModelCredentialStore, credentialOrigin, validKey };
