import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {getAddress} from 'ethers';

export function profileDirectory() {
  return process.env.RCH_CLI_HOME || (process.platform==='win32'
    ? join(process.env.LOCALAPPDATA||homedir(),'REACH Credits','cli')
    : process.platform==='darwin'?join(homedir(),'Library','Application Support','REACH Credits','cli')
      :join(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'reach-credits'));
}
export async function readProfile(dir=profileDirectory()) {
  try{return JSON.parse(await readFile(join(dir,'profile.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return {};throw new Error('RCH profile could not be read. Preserve the file and check its JSON.');}
}
async function atomicJson(dir,name,value) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const temporary=join(dir,`.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,join(dir,name));
}
export async function saveAddress(address,dir=profileDirectory()) {
  const normalized=getAddress(address);
  const previous=await readProfile(dir);
  await atomicJson(dir,'profile.json',{address:normalized,...(previous.browser?{browser:previous.browser}:{})});
  return normalized;
}
export async function saveBrowser(browser,dir=profileDirectory()) {
  if(!['opera','chrome','firefox','safari','edge','default'].includes(browser))throw new Error('Choose opera, chrome, firefox, safari, edge, or default.');
  const previous=await readProfile(dir);
  await atomicJson(dir,'profile.json',{...(previous.address?{address:previous.address}:{}),...(browser!=='default'?{browser}:{})});
}
function recordFile(address){return `transaction-${getAddress(address).toLowerCase()}.json`;}
export async function readRecord(address,dir=profileDirectory()) {
  if(!address)return null;
  try{return JSON.parse(await readFile(join(dir,recordFile(address)),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw new Error('Saved transaction could not be read. Preserve it before retrying.');}
}
export async function saveRecord(address,record,dir=profileDirectory()) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const lockPath=join(dir,recordFile(address)+'.lock');
  let lock;
  try{lock=await open(lockPath,'wx',0o600);}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    let stale=false;
    try{const pid=Number(await readFile(lockPath,'utf8'));if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){stale=e.code==='ESRCH';}}}catch{}
    if(!stale)throw new Error('Another RCH command is updating this wallet record. Try the status check again shortly.');
    await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
  }
  try{
    await lock.writeFile(String(process.pid));
    const previous=await readRecord(address,dir);
    if(['requesting','submitted'].includes(previous?.status)){
      const old=previous.prepared.transaction,next=record.prepared?.transaction;
      if(record.status==='requesting'||!next||old.nonce!==next.nonce||old.data!==next.data||BigInt(old.value)!==BigInt(next.value))throw new Error('Resolve the saved transaction before starting another.');
    }
    await atomicJson(dir,recordFile(address),record);
  }finally{await lock.close();await unlink(lockPath);}
}
