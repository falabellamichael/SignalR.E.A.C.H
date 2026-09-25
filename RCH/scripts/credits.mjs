#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {getAddress,formatEther} from 'ethers';
import {createProvider} from '../terminal/rpc.mjs';
import {readProfile,saveAddress,saveBrowser,readRecord,saveRecord} from '../terminal/profile.mjs';
import {loadState,prepareOperation,checkReceipt} from '../terminal/public/operations.mjs';
import {startApproval,openBrowser} from '../terminal/approval.mjs';

export const help=`RCH — REACH Credits on Ethereum Mainnet (no Docker)

  rch connect                 Connect MetaMask; save its public address
  rch wallet                  Show the saved public address
  rch wallet 0xADDRESS        Set an address for balance/quote checks
  rch browser opera           Choose browser (or chrome/firefox/edge/default)
  rch status                  Check the verified token and sale
  rch balance                 Show your ETH and RCH balances
  rch quote 0.0005             Show RCH output and gas; spends nothing
  rch open-sale               Review sale activation in MetaMask (owner only)
  rch buy 0.0005               Review an ETH-for-RCH purchase in MetaMask
  rch tx 0xHASH                Check transaction outcome and actual gas charged
  rch ui                      Open all wallet controls
  rch help

Options: --address 0xADDRESS, --rpc HTTPS_URL, --max-fee ETH,
         --browser opera|chrome|firefox|edge|safari, --no-open
Gas fee ceiling defaults to 0.0002 ETH per operation; purchase ETH is additional.
open-sale and buy prepare a review page; they never sign or broadcast from the CLI.
Only your own MetaMask confirmation can send a transaction. Keep the command running
while reviewing (15-minute session). Stop closes the page service, not a pending transaction.
Projects and Home: choose Project command mode. Run rch help for this list.
`;

export function parseCommand(args) {
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{help:{type:'boolean'},address:{type:'string'},rpc:{type:'string'},'max-fee':{type:'string'},browser:{type:'string'},'no-open':{type:'boolean'}}});
  const command=values.help?'help':positionals[0]||'help';
  const count={help:0,connect:0,wallet:1,browser:1,status:0,balance:0,quote:1,'open-sale':0,buy:1,tx:1,ui:0};
  if(!(command in count)||positionals.length>count[command]+1)throw new Error('Unknown command or extra arguments. Run rch help.');
  const argument=positionals[1];
  if(['buy','quote'].includes(command)&&(!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(argument||'')||!/[1-9]/.test(argument)))throw new Error(`Use rch ${command} ETH_AMOUNT, for example rch ${command} 0.0005. Gas is additional.`);
  if(command==='tx'&&!/^0x[0-9a-f]{64}$/i.test(argument||''))throw new Error('Use rch tx followed by a public transaction hash.');
  if(command==='browser'&&!argument)throw new Error('Use rch browser opera (or chrome, firefox, edge, safari, default).');
  if(values.address)getAddress(values.address);
  if(values['max-fee']&&(!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(values['max-fee'])||!/[1-9]/.test(values['max-fee'])))throw new Error('--max-fee must be a positive ETH amount.');
  if(values.browser&&!['opera','chrome','firefox','edge','safari'].includes(values.browser))throw new Error('Unsupported browser. Run rch help.');
  return {command,argument,values};
}
export function formatQuote(q) {
  return `${q.action==='open'?'Open the RCH sale to everyone':`Purchase: ${q.expectedRch} RCH (minimum ${q.minimumRch} RCH)`}\nETH payment: ${q.amountEth}\nEstimated gas: ${q.estimatedFeeEth} ETH\nMaximum gas allowance: ${q.maximumFeeEth} ETH\nMaximum payment + gas: ${q.maximumTotalEth} ETH\nBalance remaining at maximum: ${q.remainingEth} ETH${q.deadline?'\nQuote deadline: '+new Date(q.deadline*1000).toISOString():''}\nNothing signed or sent.`;
}
export async function main(args=process.argv.slice(2),{log=console.log,providerFactory=createProvider}={}) {
  const {command,argument,values}=parseCommand(args);
  if(command==='help'){log(help);return;}
  if(command==='wallet'){if(argument)log(`Public wallet saved: ${await saveAddress(argument)}`);else log((await readProfile()).address||'No wallet selected. Run rch connect or rch wallet 0xADDRESS.');return;}
  if(command==='browser'){await saveBrowser(argument);log(`Browser: ${argument}`);return;}
  const profile=await readProfile(),base=JSON.parse(await readFile(new URL('../terminal/mainnet.json',import.meta.url),'utf8'));
  const account=values.address?getAddress(values.address):profile.address;
  const deployment={...base,account:command==='connect'?null:account};
  const feeCeiling=values['max-fee']||'0.0002';
  let provider;
  try {
    if(['status','balance','quote','tx'].includes(command)||(['buy','open-sale'].includes(command)&&account))provider=providerFactory(values.rpc);
    if(command==='status'||command==='balance'){
      if(command==='balance'&&!account)throw new Error('Connect a wallet first: rch connect. Or set a public address: rch wallet 0xADDRESS.');
      const state=await loadState(provider,{...deployment,account:account||base.treasury},account||base.treasury);
      log(`Ethereum Mainnet\nRCH token: ${base.token}\nSale: ${base.sale}\nSale status: ${state.closed?'CLOSED':state.paused?'PAUSED':'OPEN'}\nSale owner: ${state.owner}\nAI redemption: ${state.redemptionPaused?'PAUSED':'enabled on chain'}`);
      if(account)log(`Wallet: ${account}\nETH: ${state.eth}\nRCH: ${state.rch}`);
      else log('No wallet selected. Run rch connect.');
      return;
    }
    if(command==='tx'){
      if((await provider.getNetwork()).chainId!==1n)throw new Error('RPC must be Ethereum Mainnet.');
      const receipt=await provider.getTransactionReceipt(argument);
      if(!receipt){log('Pending or unknown. No receipt is available; do not assume it failed or retry blindly.');return;}
      log(`Transaction: ${argument}\nStatus: ${receipt.status===1?'CONFIRMED':'FAILED'}\nBlock: ${receipt.blockNumber}\nActual gas fee: ${formatEther(receipt.fee)} ETH`);
      const record=await readRecord(account);
      if(record&&(record.hash===argument||!record.hash)){
        const checked=await checkReceipt(provider,deployment,{...record,hash:argument});
        if(checked.status!=='pending')await saveRecord(account,{...record,hash:argument,status:checked.status,receipt:checked});
      }
      return;
    }
    if(command==='quote'){
      if(!account)throw new Error('Run rch connect first, or use --address 0xADDRESS for a read-only quote.');
      log(formatQuote(await prepareOperation(provider,deployment,account,'buy',argument,feeCeiling)));return;
    }
    if(['buy','open-sale'].includes(command)&&account){
      const record=await readRecord(account);
      if(['requesting','submitted'].includes(record?.status)){
        if(!record.hash)throw new Error('A previous wallet request needs checking. Run rch ui to recover its hash; do not retry the transaction.');
        const result=await checkReceipt(provider,deployment,record);
        if(result.status==='pending')throw new Error(`A transaction is pending. Run rch tx ${record.hash} first.`);
        await saveRecord(account,{...record,status:result.status,receipt:result});
      }
      if(command==='open-sale'){
        const state=await loadState(provider,deployment,account);
        if(!state.paused&&!state.closed){log('The RCH sale is already open. No activation transaction or gas fee is needed.');return;}
      }
      log(formatQuote(await prepareOperation(provider,deployment,account,command==='buy'?'buy':'open',argument,feeCeiling)));
    }
  } finally {provider?.destroy();}
  const approval=await startApproval({deployment,action:command,amount:command==='buy'?argument:undefined,feeCeiling,log,rpcUrl:values.rpc});
  log(`Wallet review: ${approval.url}\nLeave this command running. Stop closes the local review service; it does not cancel a transaction already sent.\nMetaMask handles signing. No password or private key is requested by this CLI.`);
  if(!values['no-open']){
    try{await openBrowser(approval.url,values.browser||profile.browser);}
    catch(error){log(error.message);}
  }
  const close=()=>{approval.close();};process.once('SIGINT',close);process.once('SIGTERM',close);
  approval.server.once('close',()=>{process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);});
  return approval;
}
let isEntry=false;try{isEntry=!!process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{}
if(isEntry){
  main().catch(error=>{console.error(`RCH: ${error.shortMessage||error.message||'Command failed'}`);process.exitCode=1;});
}
