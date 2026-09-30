#!/usr/bin/env node
// Small service-manager entry point. The upstream key is read from a private
// file, never placed in launchd/systemd arguments or the desktop renderer.
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../service/config.mjs';
import { createAccountService } from '../service/server.mjs';
export function loadHostConfig(args) {
  const [configFile,keyFile,supabaseKeyFile,quoteSignerKeyFile,providerKeyFile] = args;
  if(!configFile||!keyFile||args.length<2||args.length>5)throw new Error('Usage: accounts-host.mjs <private config.json> <private upstream.key> [private supabase.key] [private quote-signer.key] [private provider-keys.json]');
  for(const file of [configFile,keyFile,supabaseKeyFile,quoteSignerKeyFile,providerKeyFile].filter(Boolean)) {
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Host configuration and credential files must be private regular files (mode 600).');
  }
  function readJson(file) {
    try { return JSON.parse(readFileSync(file,'utf8')); }
    catch { throw new Error('Could not read the private configuration or credential JSON.'); }
  }
  const raw=readJson(configFile);
  const credentials = new Map();
  if(!/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.upstreamKeyEnv||''))throw new Error('Invalid upstream credential variable name.');
  if (raw.supabase) {
    if (!supabaseKeyFile || !/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.supabase.secretKeyEnv || '') || raw.supabase.secretKeyEnv === raw.upstreamKeyEnv) throw new Error('Supply a separate private Supabase credential file.');
    credentials.set(raw.supabase.secretKeyEnv, readFileSync(supabaseKeyFile,'utf8').trim());
  } else if (supabaseKeyFile) throw new Error('A Supabase credential requires Supabase storage configuration.');
  if(raw.redemption?.mode==='treasury'&&raw.redemption.enabled) {
    const variable=raw.redemption.quoteSignerKeyEnv;
    if(!quoteSignerKeyFile||!/^[A-Z][A-Z0-9_]{2,80}$/.test(variable||'')||[raw.upstreamKeyEnv,raw.supabase?.secretKeyEnv].includes(variable))throw new Error('Supply a separate private quote signing credential.');
    credentials.set(variable,readFileSync(quoteSignerKeyFile,'utf8').trim());
  } else if(quoteSignerKeyFile)throw new Error('A quote signing credential requires enabled treasury redemption.');
  credentials.set(raw.upstreamKeyEnv,readFileSync(keyFile,'utf8').trim());
  if (providerKeyFile) {
    const declared = new Set((Array.isArray(raw.models) ? raw.models : []).filter(model => model?.providerApi).map(model => model.providerApi.keyEnv));
    const providers = readJson(providerKeyFile);
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)
        || Object.keys(providers).some(name => !declared.has(name) || !/^[A-Z][A-Z0-9_]{2,80}$/.test(name)
          || credentials.has(name) || name === raw.redemption?.quoteSignerKeyEnv
          || typeof providers[name] !== 'string' || providers[name].length < 16 || /[\r\n]/.test(providers[name]))
        || Array.from(declared).some(name => !Object.hasOwn(providers,name))) throw new Error('Provider credential JSON must contain only the declared host-only provider keys.');
    Object.entries(providers).forEach(([name,key]) => credentials.set(name,key));
  }
  const previous = new Map(Array.from(credentials.keys(),name => [name, process.env[name]]));
  try {
    credentials.forEach((key,name) => { process.env[name] = key; });
    return loadConfig(configFile);
  } finally {
    previous.forEach((value,name) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  process.umask(0o077);
  const config=loadHostConfig(process.argv.slice(2));
  const {server}=createAccountService({config});
  server.on('error',()=>{console.error('Account service could not listen.');process.exit(1);});
  server.listen(config.port,config.listenHost,()=>console.log(`REACH account service listening on loopback:${config.port} for ${config.origin}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeIdleConnections();});
}catch{console.error('Account service setup failed. Check its private configuration, credential file, and Node version.');process.exitCode=1;}
