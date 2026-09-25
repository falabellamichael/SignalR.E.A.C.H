import {FetchRequest,JsonRpcProvider} from 'ethers';
export function createProvider(url=process.env.RCH_RPC_URL||'https://ethereum-rpc.publicnode.com') {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))throw new Error('Use an HTTPS RPC endpoint (HTTP is allowed only on loopback).');
  const request=new FetchRequest(url);request.timeout=15000;
  return new JsonRpcProvider(request,undefined,{batchMaxCount:3,cacheTimeout:-1});
}
