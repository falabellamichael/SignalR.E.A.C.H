import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isAddress, Wallet } from 'ethers';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
function keys(value, allowed, name) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`Invalid ${name} configuration fields.`);
}
function modelPricing(value, schedule) {
  keys(value, ['inputUsdMicrosPerMillion','outputUsdMicrosPerMillion','cachedInputUsdMicrosPerMillion',
    ...(schedule === 'after' ? ['effectiveAt'] : schedule === 'daily' ? ['utcStartHour','utcEndHour'] : [])], 'model pricing');
  if (![value.inputUsdMicrosPerMillion,value.outputUsdMicrosPerMillion].every(v=>Number.isSafeInteger(v)&&v>0&&v<=1_000_000_000)
      || value.cachedInputUsdMicrosPerMillion!==undefined&&(!Number.isSafeInteger(value.cachedInputUsdMicrosPerMillion)||value.cachedInputUsdMicrosPerMillion<0||value.cachedInputUsdMicrosPerMillion>value.inputUsdMicrosPerMillion)) throw new Error('Invalid USD model pricing.');
  if (schedule === 'after') {
    const stamp = typeof value.effectiveAt === 'string' ? Date.parse(value.effectiveAt) : NaN;
    if (!Number.isSafeInteger(stamp) || stamp < 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.effectiveAt)
        || new Date(stamp).toISOString() !== value.effectiveAt) throw new Error('Invalid scheduled model pricing date; use canonical ISO UTC.');
  }
  if (schedule === 'daily' && (!Number.isInteger(value.utcStartHour) || value.utcStartHour < 0 || value.utcStartHour > 23
      || !Number.isInteger(value.utcEndHour) || value.utcEndHour <= value.utcStartHour || value.utcEndHour > 24)) {
    throw new Error('Invalid daily model pricing hours; use an increasing UTC interval within 0 through 24.');
  }
}
export function validateConfig(raw, directory = process.cwd(), env = process.env) {
  keys(raw, ['origin','listenHost','port','database','supabase','chainId','authRpcUrl','upstreamUrl','upstreamKeyEnv','models','redemption'], 'service');
  const url = new URL(raw.origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Service origin must be HTTPS, or loopback HTTP for development, without a path.');
  if (!['127.0.0.1','::1'].includes(raw.listenHost ?? '127.0.0.1')) throw new Error('Bind the service to loopback behind the existing HTTPS proxy.');
  if (!Number.isSafeInteger(raw.port) || raw.port < 1 || raw.port > 65535 || !Number.isSafeInteger(raw.chainId) || raw.chainId < 1) throw new Error('Invalid service port or chain ID.');
  let supabase;
  if (raw.supabase !== undefined) {
    if (raw.database !== undefined) throw new Error('Choose Supabase or a local account database, not both.');
    keys(raw.supabase, ['url','secretKeyEnv'], 'Supabase');
    const projectUrl = new URL(raw.supabase.url);
    if (projectUrl.protocol !== 'https:' || projectUrl.username || projectUrl.password || projectUrl.search || projectUrl.hash || projectUrl.pathname !== '/') throw new Error('Supabase requires a HTTPS project URL without credentials or a path.');
    if (typeof raw.supabase.secretKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.supabase.secretKeyEnv)) throw new Error('Configure the host-only Supabase secret environment variable name.');
    const secretKey = env[raw.supabase.secretKeyEnv];
    let serviceRole = false;
    try { serviceRole = JSON.parse(Buffer.from(String(secretKey).split('.')[1], 'base64url')).role === 'service_role'; } catch { /* Opaque modern keys are not JWTs. */ }
    if (typeof secretKey !== 'string' || secretKey.length < 32 || /\s/.test(secretKey) || !(secretKey.startsWith('sb_secret_') || serviceRole)) throw new Error('Set the host-only Supabase secret or service-role key.');
    if (raw.supabase.secretKeyEnv === raw.upstreamKeyEnv) throw new Error('Use separate environment variables for Supabase and the model upstream.');
    supabase = { ...raw.supabase, url: projectUrl.origin, secretKey };
  } else if (typeof raw.database !== 'string' || !raw.database || raw.database === ':memory:') throw new Error('Configure a durable account database path.');
  if (!Array.isArray(raw.models)) throw new Error('Configure the hosted model catalog.');
  const providerVariables = new Map();
  const models = raw.models.map(model => {
    keys(model, ['id','name','provider','upstreamModel','metered','maxInputTokens','maxInputBytes','maxOutputTokens','pricing','pricingAfter','pricingDaily','providerApi'], 'model');
    if (model.pricing !== undefined) modelPricing(model.pricing);
    if ((model.pricingAfter !== undefined || model.pricingDaily !== undefined) && model.pricing === undefined) throw new Error('Model pricing schedules require baseline pricing.');
    if (model.pricingAfter !== undefined && model.pricingDaily !== undefined) throw new Error('Choose one model pricing schedule.');
    if (model.pricingAfter !== undefined) modelPricing(model.pricingAfter, 'after');
    if (model.pricingDaily !== undefined) modelPricing(model.pricingDaily, 'daily');
    let providerApi;
    if (model.providerApi !== undefined) {
      keys(model.providerApi, ['provider','keyEnv'], 'model provider API');
      const { provider, keyEnv } = model.providerApi;
      if (!['openai','gemini','opencode','alibaba'].includes(provider) || typeof keyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/.test(keyEnv)) throw new Error('Configure a supported provider and host-only provider credential variable.');
      if ([raw.upstreamKeyEnv,raw.supabase?.secretKeyEnv,raw.redemption?.quoteSignerKeyEnv].includes(keyEnv)
          || providerVariables.has(keyEnv) && providerVariables.get(keyEnv) !== provider) throw new Error('Use separate credential variables for provider APIs and other host authorities.');
      providerVariables.set(keyEnv, provider);
      const apiKey = env[keyEnv];
      if (typeof apiKey !== 'string' || apiKey.length < 16 || /[\r\n]/.test(apiKey)) throw new Error('Set the host-only model provider API credential.');
      providerApi = { provider, apiKey };
    }
    return { ...model, ...(providerApi ? { providerApi } : {}) };
  });
  if (typeof raw.upstreamKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.upstreamKeyEnv)) throw new Error('Configure the upstream key environment variable name.');
  const upstreamKey = env[raw.upstreamKeyEnv];
  if (typeof upstreamKey !== 'string' || upstreamKey.length < 16 || /[\r\n]/.test(upstreamKey)) throw new Error(`Set ${raw.upstreamKeyEnv} to a host-only relay credential.`);
  const redemption = raw.redemption ?? { enabled:false };
  keys(redemption,['enabled','mode','tokenAddress','rpcUrl','confirmations','contractAddress','contractCodeHash','treasuryAddress','quoteSignerKeyEnv','allowedWallets','maxCreditUsdMicros','creditBudgetUsdMicros'],'redemption');
  if (typeof redemption.enabled !== 'boolean') throw new Error('redemption.enabled must be explicit.');
  if (redemption.mode!==undefined&&!['burn','treasury'].includes(redemption.mode)) throw new Error('Invalid redemption mode.');
  if (redemption.enabled && raw.chainId === 1 && redemption.mode!=='treasury') throw new Error('Legacy fixed-rate RCH redemption cannot be enabled on Ethereum mainnet; it does not satisfy market-priced credit.');
  let quoteSignerKey;
  if(redemption.enabled&&redemption.mode==='treasury') {
    if(raw.chainId!==1 || redemption.tokenAddress?.toLowerCase()!=='0x6cfb2531696f99cd4511f281abece4b6a67c3792'
       || ![redemption.contractAddress,redemption.treasuryAddress].every(a=>isAddress(a)&&!/^0x0{40}$/i.test(a))
       || !/^0x[0-9a-f]{64}$/i.test(redemption.contractCodeHash||'')) throw new Error('Configure the reviewed mainnet treasury redemption deployment.');
    if(!Array.isArray(redemption.allowedWallets)||redemption.allowedWallets.length<1||redemption.allowedWallets.length>10||!redemption.allowedWallets.every(isAddress)
       || !Number.isSafeInteger(redemption.maxCreditUsdMicros)||redemption.maxCreditUsdMicros<1||redemption.maxCreditUsdMicros>1_000_000
       || !Number.isSafeInteger(redemption.creditBudgetUsdMicros)||redemption.creditBudgetUsdMicros<redemption.maxCreditUsdMicros||redemption.creditBudgetUsdMicros>5_000_000) throw new Error('Configure the owner pilot wallet list and bounded USD quote budget.');
    if(!/^[A-Z][A-Z0-9_]{2,80}$/.test(redemption.quoteSignerKeyEnv||'')||[raw.upstreamKeyEnv,raw.supabase?.secretKeyEnv].includes(redemption.quoteSignerKeyEnv))throw new Error('Use a separate host-only quote signing credential.');
    quoteSignerKey=env[redemption.quoteSignerKeyEnv];
    try { new Wallet(quoteSignerKey); } catch { throw new Error('Set the private quote signing credential.'); }
    if(!raw.models.some(m=>m.metered===true&&m.pricing))throw new Error('Treasury redemption needs at least one qualified priced model.');
  }
  if (redemption.enabled && (!isAddress(redemption.tokenAddress) || !redemption.rpcUrl || !Number.isSafeInteger(redemption.confirmations) || redemption.confirmations < 1)) throw new Error('Redemption needs the reviewed token address, chain RPC, and confirmation policy.');
  if ((redemption.tokenAddress || redemption.rpcUrl) && (!isAddress(redemption.tokenAddress) || /^0x0{40}$/i.test(redemption.tokenAddress) || !redemption.rpcUrl)) throw new Error('Wallet balances need the reviewed RCH token address and chain RPC.');
  for (const address of [raw.authRpcUrl, redemption.rpcUrl].filter(Boolean)) {
    const rpc = new URL(address);
    if (rpc.username || rpc.password || rpc.hash || !(rpc.protocol === 'https:' || rpc.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(rpc.hostname))) throw new Error('RPC URLs require HTTPS or loopback HTTP.');
  }
  return { ...raw, models, origin:url.origin, listenHost:raw.listenHost ?? '127.0.0.1', ...(supabase ? { supabase } : { database:resolve(directory,raw.database) }), upstreamKey, redemption:{...redemption,...(quoteSignerKey?{quoteSignerKey}:{})} };
}
export const loadConfig = file => {
  let raw;
  try { raw = JSON.parse(readFileSync(file,'utf8')); }
  catch { throw new Error('Could not read the private service configuration JSON.'); }
  return validateConfig(raw,dirname(resolve(file)));
};
