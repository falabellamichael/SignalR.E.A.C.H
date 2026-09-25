import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {getAddress,Interface} from 'ethers';
import {saveAddress,readRecord,saveRecord} from './profile.mjs';
import {createProvider} from './rpc.mjs';
import {checkReceipt} from './public/operations.mjs';

export function openBrowser(url,browser,platform=process.platform) {
  const names={opera:'Opera',chrome:'Google Chrome',firefox:'Firefox',safari:'Safari',edge:'Microsoft Edge'};
  if(browser&&!names[browser])throw new Error('Browser must be opera, chrome, firefox, safari, or edge.');
  let command,args;
  if(platform==='darwin'){command='open';args=browser?['-a',names[browser],url]:[url];}
  else if(platform==='win32'){command=browser?({chrome:'chrome.exe',opera:'opera.exe',firefox:'firefox.exe',edge:'msedge.exe'})[browser]:'rundll32.exe';if(!command)throw new Error('That browser is not supported on Windows.');args=browser?[url]:['url.dll,FileProtocolHandler',url];}
  else{command=browser?({chrome:'google-chrome',opera:'opera',firefox:'firefox',edge:'microsoft-edge'})[browser]:'xdg-open';if(!command)throw new Error('That browser is not supported on this platform.');args=[url];}
  return new Promise((resolve,reject)=>{const child=spawn(command,args,{shell:false,stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Browser could not open. Paste the printed URL into your browser.')));});
}

export function validateRecord(deployment,record) {
  if(!record||!['requesting','submitted','confirmed','failed','rejected'].includes(record.status))throw new Error('Invalid transaction record.');
  const q=record.prepared,tx=q?.transaction;
  if(!tx||getAddress(tx.from)!==deployment.account||getAddress(tx.to)!==deployment.sale||BigInt(tx.chainId)!==BigInt(deployment.chainId))throw new Error('Transaction does not match this approval session.');
  const decoded=new Interface(deployment.saleAbi).parseTransaction({data:tx.data,value:tx.value});
  if(!((q.action==='open'&&decoded.name==='unpause'&&BigInt(tx.value)===0n)||(q.action==='buy'&&decoded.name==='buy'&&BigInt(tx.value)>0n)))throw new Error('Only sale activation and RCH purchases are allowed.');
  if(record.hash&&!/^0x[0-9a-f]{64}$/i.test(record.hash))throw new Error('Invalid transaction hash.');
  return record;
}

export async function startApproval({deployment,action='ui',amount,feeCeiling='0.0002',directory,log=console.log,ttlMs=15*60*1000,rpcUrl,providerFactory=createProvider}) {
  const token=randomBytes(24).toString('hex'),prefix=`/${token}/`;
  const files=new Map([['',['index.html','text/html']],['app.mjs',['app.mjs','text/javascript']],['operations.mjs',['operations.mjs','text/javascript']],['fees.mjs',['fees.mjs','text/javascript']],['style.css',['style.css','text/css']]]);
  let origin;
  const server=createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const send=(status,body,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
    if(req.headers.host!==new URL(origin).host||!req.url.startsWith(prefix)){send(404,{error:'Not found'});return;}
    const resource=req.url.slice(prefix.length);
    try {
      if(req.method==='GET'){
        if(resource==='deployment.json'){send(200,{...deployment,action,amount,feeCeiling,record:await readRecord(deployment.account,directory)});return;}
        if(resource==='ethers.mjs'){send(200,await readFile(new URL('../node_modules/ethers/dist/ethers.min.js',import.meta.url)),'text/javascript');return;}
        const file=files.get(resource);if(!file){send(404,{error:'Not found'});return;}
        send(200,await readFile(new URL(`public/${file[0]}`,import.meta.url)),file[1]);return;
      }
      if(req.method!=='POST'||req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json')){send(403,{error:'Request origin rejected'});return;}
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>32768){send(413,{error:'Request too large'});return;}}
      const value=JSON.parse(raw);
      if(resource==='wallet'){
        const address=getAddress(value.address);
        if(deployment.account&&address!==deployment.account)throw new Error('Select the configured account, or run rch connect to change it.');
        deployment.account=await saveAddress(address,directory);
        log(`Connected public wallet: ${address}`);send(200,{address,record:await readRecord(address,directory)});return;
      }
      if(resource==='record'){
        const record=validateRecord(deployment,value);
        const previous=await readRecord(deployment.account,directory);
        if(['requesting','submitted'].includes(previous?.status)){
          const old=previous.prepared.transaction,next=record.prepared.transaction;
          if(record.status==='requesting'||old.nonce!==next.nonce||old.data!==next.data||BigInt(old.value)!==BigInt(next.value))throw new Error('Resolve the saved transaction before starting another.');
        }
        if(['confirmed','failed'].includes(record.status)){
          const provider=providerFactory(rpcUrl);
          try{const checked=await checkReceipt(provider,deployment,record);if(checked.status!==record.status)throw new Error('Receipt status does not match the network.');record.receipt=checked;}
          finally{provider.destroy();}
        }
        await saveRecord(deployment.account,record,directory);
        log(`${record.prepared.action==='open'?'Sale activation':'RCH purchase'}: ${record.status}${record.hash?' — '+record.hash:''}`);
        if(record.hash)log(`Check from another terminal tab: rch tx ${record.hash}`);
        send(200,{saved:true});return;
      }
      send(404,{error:'Not found'});
    }catch(error){send(400,{error:error.shortMessage||error.message||'Request failed'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const timer=setTimeout(()=>{log('Wallet approval session expired. Saved transaction records are preserved.');server.close();server.closeAllConnections();},ttlMs);timer.unref();
  server.once('close',()=>clearTimeout(timer));
  return {server,url:origin+prefix,close:()=>{server.close();server.closeAllConnections();}};
}
