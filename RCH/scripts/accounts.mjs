#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../service/config.mjs';
import { createAccountStore } from '../service/account-store.mjs';
import { readAccountSnapshot, accountTables } from '../service/account-import.mjs';
import { createAccountService } from '../service/server.mjs';

const [command, ...args]=process.argv.slice(2);
const help=`REACH account service
  npm run accounts -- serve --config /private/path/accounts.json
  npm run accounts -- grant --config /private/path/accounts.json --file /private/path/grant.json
  npm run accounts -- payment --config /private/path/accounts.json --file /private/path/payment.json
  npm run accounts -- payments --config /private/path/accounts.json [--wallet 0x... | --email you@example.com]
  npm run accounts -- reversals --config /private/path/accounts.json [--wallet 0x... | --email you@example.com]
  npm run accounts -- status --config /private/path/accounts.json --wallet 0x... | --email you@example.com
  npm run accounts -- reconcile --config /private/path/accounts.json
  npm run accounts -- unsettled --config /private/path/accounts.json
  npm run accounts -- settle --config /private/path/accounts.json --file /private/path/measured-usage.json
  npm run accounts -- import-sqlite --config /private/path/supabase-accounts.json --source-sqlite /private/path/accounts.sqlite

Grant JSON: {wallet,grantId,planId,name,models:[qualified model IDs],tokens,expiresAt:ISO timestamp}.
Payment JSON: {wallet or email,objectId,kind:"subscription_period"|"top_up",amountUsdMicros,periodEnd:ISO timestamp (subscription only)}.
Records a payment you have already confirmed by hand, with the same rules as an automatic one: it is recorded once per
objectId, a Basic payment must be exactly the Basic price, and an expired or out-of-order period is recorded for review
instead of granted. amountUsdMicros excludes tax and processor fees. Prefer this to the grant command for anything that was paid for.
The payments command lists one account's payments, or every payment that needs review when no account is given.
An email account must already exist (its owner signs in once); a wallet account is created if needed.
The reversals command does the same for refunds and disputes.
Settlement JSON: {reservationId,usage:{promptTokens,completionTokens,totalTokens,provider,model}}.
Only use a verified provider usage record for manual settlement. No wallet keys are requested.
Use a unique grantId per renewal. Granting a plan replaces its included allowance; prepaid credit persists.
For import-sqlite, stop the source service first and keep its database backup. The Supabase target must be empty; existing data is never overwritten.`;
if(!command||['help','--help','-h'].includes(command)){console.log(help);process.exit(0);}
const options={};
try {
  for(let i=0;i<args.length;i+=2) {if(!['--config','--file','--wallet','--email','--source-sqlite'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error(help);options[args[i]]=args[i+1];}
  if(!options['--config'])throw new Error('Supply --config.');
  const config=loadConfig(resolve(options['--config']));
  if(command==='serve') {
    const {server}=createAccountService({config});
    server.on('error',()=>{console.error('Account service could not listen. Check its address and port.');process.exitCode=1;});
    server.listen(config.port,config.listenHost,()=>console.log(`REACH account service: ${config.origin} (loopback port ${config.port})`));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeIdleConnections();});
  } else {
    const store=createAccountStore(config);
    // One account, named by exactly one of its identities.
    const named=async()=>{
      if(!!options['--wallet']===!!options['--email'])throw new Error('Name the account with --wallet or --email.');
      const row=options['--wallet']?await store.findAccountByWallet(options['--wallet']):await store.findAccountByEmail(options['--email']);
      if(!row)throw new Error('No account has that wallet or email.');return row;
    };
    const someone=()=>options['--wallet']||options['--email'];
    try {
      if(command==='import-sqlite') {
        if (!config.supabase || !options['--source-sqlite']) throw new Error('Import requires a Supabase destination and --source-sqlite.');
        const snapshot = readAccountSnapshot(resolve(options['--source-sqlite']));
        await store.importSnapshot(snapshot);
        console.log(JSON.stringify({ imported: Object.fromEntries(accountTables.map(table => [table, snapshot[table].length])) }, null, 2));
      } else if(command==='grant') {
        const grant=JSON.parse(readFileSync(options['--file'],'utf8'));grant.expiresAt=Date.parse(grant.expiresAt);
        console.log(JSON.stringify(await store.grantPlan(grant),null,2));
      } else if(command==='payment') {
        const {wallet,email,periodEnd,...entry}=JSON.parse(readFileSync(options['--file'],'utf8'));
        if(!!wallet===!!email)throw new Error('Name the account with wallet or email in the payment file.');
        const account=wallet?await store.ensureAccount(wallet):await store.findAccountByEmail(email);
        if(!account)throw new Error('No account has that email. Its owner must sign in once first.');
        // A hand-entered payment is always provider "manual"; the file cannot claim another.
        const payment={eventId:`manual-${entry.objectId}`,...entry,provider:'manual',accountId:account.id,...(periodEnd===undefined?{}:{periodEnd:Date.parse(periodEnd)})};
        console.log(JSON.stringify(await store.applyPayment(payment),null,2));
      } else if(command==='payments') {
        if(someone())console.log(JSON.stringify(await store.listPayments((await named()).id),null,2));
        else console.log(JSON.stringify(await store.flaggedPayments(),null,2));
      } else if(command==='reversals') {
        if(someone())console.log(JSON.stringify(await store.listReversals((await named()).id),null,2));
        else console.log(JSON.stringify(await store.flaggedReversals(),null,2));
      } else if(command==='status') {
        console.log(JSON.stringify(await store.account((await named()).id),null,2));
      } else if(command==='unsettled') {
        console.log(JSON.stringify(await store.unsettledReservations(),null,2));
      } else if(command==='settle') {
        const record=JSON.parse(readFileSync(options['--file'],'utf8'));
        if(!record.usage?.provider||!record.usage?.model)throw new Error('Provider and model are required in the measured usage record.');
        await store.settle(record.reservationId,{...record.usage,source:'provider_manual_reconciliation'});console.log('Measured usage settled.');
      } else if(command==='reconcile') {
        const {createRedemptionService}=await import('../service/redemption.mjs');
        const redemption=createRedemptionService({store,config});
        try{console.log(JSON.stringify(await redemption.reconcile(),null,2));}finally{redemption.close();}
      } else throw new Error(help);
    }finally{await store.close();}
  }
}catch(error){console.error(error?.code==='ENOENT'?'Required configuration or input file not found.':error.message||'Account operation failed.');process.exitCode=1;}
