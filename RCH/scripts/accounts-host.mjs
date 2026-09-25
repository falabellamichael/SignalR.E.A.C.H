#!/usr/bin/env node
// Small service-manager entry point. The upstream key is read from a private
// file, never placed in launchd/systemd arguments or the desktop renderer.
import { readFileSync, lstatSync } from 'node:fs';
import { loadConfig } from '../service/config.mjs';
import { createAccountService } from '../service/server.mjs';
const [configFile,keyFile]=process.argv.slice(2);
try {
  if(!configFile||!keyFile||process.argv.length!==4)throw new Error('Usage: accounts-host.mjs <private config.json> <private upstream.key>');
  process.umask(0o077);
  for(const file of [configFile,keyFile]) {
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Host configuration and credential files must be private regular files (mode 600).');
  }
  const raw=JSON.parse(readFileSync(configFile,'utf8'));
  if(!/^[A-Z][A-Z0-9_]{2,80}$/.test(raw.upstreamKeyEnv||''))throw new Error('Invalid upstream credential variable name.');
  process.env[raw.upstreamKeyEnv]=readFileSync(keyFile,'utf8').trim();
  const config=loadConfig(configFile);delete process.env[raw.upstreamKeyEnv];
  const {server}=createAccountService({config});
  server.on('error',()=>{console.error('Account service could not listen.');process.exit(1);});
  server.listen(config.port,config.listenHost,()=>console.log(`REACH account service listening on loopback:${config.port} for ${config.origin}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeIdleConnections();});
}catch{console.error('Account service setup failed. Check its private configuration, credential file, and Node version.');process.exitCode=1;}
