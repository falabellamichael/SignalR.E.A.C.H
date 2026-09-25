#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../service/config.mjs';
import { AccountStore } from '../service/store.mjs';
import { createAccountService } from '../service/server.mjs';

const [command, ...args]=process.argv.slice(2);
const help=`REACH account service
  npm run accounts -- serve --config /private/path/accounts.json
  npm run accounts -- grant --config /private/path/accounts.json --file /private/path/grant.json
  npm run accounts -- status --config /private/path/accounts.json --wallet 0x...
  npm run accounts -- reconcile --config /private/path/accounts.json
  npm run accounts -- unsettled --config /private/path/accounts.json
  npm run accounts -- settle --config /private/path/accounts.json --file /private/path/measured-usage.json

Grant JSON: {wallet,grantId,planId,name,models:[qualified model IDs],tokens,expiresAt:ISO timestamp}.
Settlement JSON: {reservationId,usage:{promptTokens,completionTokens,totalTokens,provider,model}}.
Only use a verified provider usage record for manual settlement. No wallet keys are requested.
Use a unique grantId per renewal. Granting a plan replaces its included allowance; prepaid credit persists.`;
if(!command||['help','--help','-h'].includes(command)){console.log(help);process.exit(0);}
const options={};
try {
  for(let i=0;i<args.length;i+=2) {if(!['--config','--file','--wallet'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error(help);options[args[i]]=args[i+1];}
  if(!options['--config'])throw new Error('Supply --config.');
  const config=loadConfig(resolve(options['--config']));
  if(command==='serve') {
    const {server}=createAccountService({config});
    server.on('error',()=>{console.error('Account service could not listen. Check its address and port.');process.exitCode=1;});
    server.listen(config.port,config.listenHost,()=>console.log(`REACH account service: ${config.origin} (loopback port ${config.port})`));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeIdleConnections();});
  } else {
    const store=new AccountStore(config.database,{models:config.models});
    try {
      if(command==='grant') {
        const grant=JSON.parse(readFileSync(options['--file'],'utf8'));grant.expiresAt=Date.parse(grant.expiresAt);
        console.log(JSON.stringify(store.grantPlan(grant),null,2));
      } else if(command==='status') {
        const row=store.db.prepare('SELECT id FROM accounts WHERE wallet=? COLLATE NOCASE').get(options['--wallet']);
        if(!row)throw new Error('Wallet has no account.');console.log(JSON.stringify(store.account(row.id),null,2));
      } else if(command==='unsettled') {
        console.log(JSON.stringify(store.db.prepare("SELECT id,account_id,request_id,model,amount,status,created,reason FROM reservations WHERE status IN ('reserved','uncertain') ORDER BY created").all(),null,2));
      } else if(command==='settle') {
        const record=JSON.parse(readFileSync(options['--file'],'utf8'));
        if(!record.usage?.provider||!record.usage?.model)throw new Error('Provider and model are required in the measured usage record.');
        store.settle(record.reservationId,{...record.usage,source:'provider_manual_reconciliation'});console.log('Measured usage settled.');
      } else if(command==='reconcile') {
        const {createRedemptionService}=await import('../service/redemption.mjs');
        const redemption=createRedemptionService({store,config});
        try{console.log(JSON.stringify(await redemption.reconcile(),null,2));}finally{redemption.close();}
      } else throw new Error(help);
    }finally{store.close();}
  }
}catch(error){console.error(error?.code==='ENOENT'?'Required configuration or input file not found.':error.message||'Account operation failed.');process.exitCode=1;}
