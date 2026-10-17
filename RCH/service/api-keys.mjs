import { randomBytes, createHash } from 'node:crypto';
import { fail } from './errors.mjs';

export const API_KEY_TTL_MS = 90 * 24 * 3600000;
export const MAX_ACTIVE_API_KEYS = 10;
export const apiKeyHash = key => createHash('sha256').update(key).digest('hex');
export function validateApiKeyName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) {
    fail(400, 'invalid_api_key_name', 'Use a key name between 1 and 64 characters without control characters.');
  }
  return name.trim();
}
export function validateApiKeyId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail(400, 'invalid_api_key_id', 'Invalid API key ID.');
  return id;
}
export function validateApiKey(key) {
  if (typeof key !== 'string' || !/^rch_key_[a-f0-9]{64}$/.test(key)) fail(401, 'api_key_invalid', 'The API key is invalid, expired, or revoked.');
  return apiKeyHash(key);
}
export function newApiKey(name, now) {
  name = validateApiKeyName(name);
  const key = `rch_key_${randomBytes(32).toString('hex')}`;
  return { key, row: { id: randomBytes(32).toString('hex'), name, prefix: key.slice(0, 16), hash: apiKeyHash(key), created: now, expires: now + API_KEY_TTL_MS, revoked: null } };
}
export const publicApiKey = row => ({ id: row.id, name: row.name, prefix: row.prefix,
  createdAt: new Date(row.created).toISOString(), expiresAt: new Date(row.expires).toISOString(),
  revokedAt: row.revoked == null ? null : new Date(row.revoked).toISOString() });
