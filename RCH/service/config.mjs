import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isAddress } from 'ethers';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
function keys(value, allowed, name) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`Invalid ${name} configuration fields.`);
}
export function validateConfig(raw, directory = process.cwd(), env = process.env) {
  keys(raw, ['origin','listenHost','port','database','chainId','authRpcUrl','upstreamUrl','upstreamKeyEnv','models','redemption'], 'service');
  const url = new URL(raw.origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Service origin must be HTTPS, or loopback HTTP for development, without a path.');
  if (!['127.0.0.1','::1'].includes(raw.listenHost ?? '127.0.0.1')) throw new Error('Bind the service to loopback behind the existing HTTPS proxy.');
  if (!Number.isSafeInteger(raw.port) || raw.port < 1 || raw.port > 65535 || !Number.isSafeInteger(raw.chainId) || raw.chainId < 1) throw new Error('Invalid service port or chain ID.');
  if (typeof raw.database !== 'string' || !raw.database || raw.database === ':memory:') throw new Error('Configure a durable account database path.');
  if (!Array.isArray(raw.models)) throw new Error('Configure the hosted model catalog.');
  for (const model of raw.models) keys(model, ['id','name','provider','upstreamModel','metered','maxInputTokens','maxInputBytes','maxOutputTokens'], 'model');
  if (typeof raw.upstreamKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.upstreamKeyEnv)) throw new Error('Configure the upstream key environment variable name.');
  const upstreamKey = env[raw.upstreamKeyEnv];
  if (typeof upstreamKey !== 'string' || upstreamKey.length < 16 || /[\r\n]/.test(upstreamKey)) throw new Error(`Set ${raw.upstreamKeyEnv} to a host-only relay credential.`);
  const redemption = raw.redemption ?? { enabled:false };
  keys(redemption,['enabled','tokenAddress','rpcUrl','confirmations'],'redemption');
  if (typeof redemption.enabled !== 'boolean') throw new Error('redemption.enabled must be explicit.');
  if (redemption.enabled && (!isAddress(redemption.tokenAddress) || !redemption.rpcUrl || !Number.isSafeInteger(redemption.confirmations) || redemption.confirmations < 1)) throw new Error('Redemption needs the reviewed token address, chain RPC, and confirmation policy.');
  for (const address of [raw.authRpcUrl, redemption.rpcUrl].filter(Boolean)) {
    const rpc = new URL(address);
    if (rpc.username || rpc.password || rpc.hash || !(rpc.protocol === 'https:' || rpc.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(rpc.hostname))) throw new Error('RPC URLs require HTTPS or loopback HTTP.');
  }
  return { ...raw, origin:url.origin, listenHost:raw.listenHost ?? '127.0.0.1', database:resolve(directory,raw.database), upstreamKey, redemption:{...redemption} };
}
export const loadConfig = file => validateConfig(JSON.parse(readFileSync(file,'utf8')),dirname(resolve(file)));
