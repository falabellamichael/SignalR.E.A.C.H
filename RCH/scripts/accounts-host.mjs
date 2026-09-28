#!/usr/bin/env node
// Small service-manager entry point. The upstream key is read from a private
// file, never placed in launchd/systemd arguments or the desktop renderer.
import { readFileSync, lstatSync } from 'node:fs';
import { loadConfig } from '../service/config.mjs';
import { createAccountService } from '../service/server.mjs';
const [configFile,keyFile,supabaseKeyFile,quoteSignerKeyFile]=process.argv.slice(2);
try {
  if(!configFile||!keyFile||![4,5,6].includes(process.argv.length))throw new Error('Usage: accounts-host.mjs <private config.json> <private upstream.key> [private supabase.key] [private quote-signer.key]');
  process.umask(0o077);
  for(const file of [configFile,keyFile,supabaseKeyFile,quoteSignerKeyFile].filter(Boolean)) {
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Host configuration and credential files must be private regular files (mode 600).');
  }
  const raw=JSON.parse(readFileSync(configFile,'utf8'));
  if(!/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.upstreamKeyEnv||''))throw new Error('Invalid upstream credential variable name.');
  if (raw.supabase) {
    if (!supabaseKeyFile || !/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.supabase.secretKeyEnv || '') || raw.supabase.secretKeyEnv === raw.upstreamKeyEnv) throw new Error('Supply a separate private Supabase credential file.');
    process.env[raw.supabase.secretKeyEnv] = readFileSync(supabaseKeyFile,'utf8').trim();
  } else if (supabaseKeyFile) throw new Error('A Supabase credential requires Supabase storage configuration.');
  if(raw.redemption?.mode==='treasury'&&raw.redemption.enabled) {
    const variable=raw.redemption.quoteSignerKeyEnv;
    if(!quoteSignerKeyFile||!/^[A-Z][A-Z0-9_]{2,80}$/.test(variable||'')||[raw.upstreamKeyEnv,raw.supabase?.secretKeyEnv].includes(variable))throw new Error('Supply a separate private quote signing credential.');
    process.env[variable]=readFileSync(quoteSignerKeyFile,'utf8').trim();
  } else if(quoteSignerKeyFile)throw new Error('A quote signing credential requires enabled treasury redemption.');
  process.env[raw.upstreamKeyEnv]=readFileSync(keyFile,'utf8').trim();
  const config=loadConfig(configFile);delete process.env[raw.upstreamKeyEnv];
  if (raw.supabase) delete process.env[raw.supabase.secretKeyEnv];
  if(raw.redemption?.quoteSignerKeyEnv)delete process.env[raw.redemption.quoteSignerKeyEnv];
  const {server}=createAccountService({config});
  server.on('error',()=>{console.error('Account service could not listen.');process.exit(1);});
  server.listen(config.port,config.listenHost,()=>console.log(`REACH account service listening on loopback:${config.port} for ${config.origin}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeIdleConnections();});
}catch{console.error('Account service setup failed. Check its private configuration, credential file, and Node version.');process.exitCode=1;}
