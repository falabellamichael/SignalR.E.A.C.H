import * as ethers from './ethers.mjs';
import * as operations from './operations.mjs';
import {mountCheckout} from './client.mjs?v=purchase-link-1';
try {
  const response=await fetch(new URL('./deployment.json',import.meta.url),{headers:{'ngrok-skip-browser-warning':'true'},cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('The checkout configuration is unavailable.');
  const manifest=await response.json();
  if(manifest.chainId!==1)throw Error('The checkout must use Ethereum Mainnet.');
  mountCheckout({window,document,ethers,operations,manifest,initialAmount:new URL(window.location.href).searchParams.get('eth')});
} catch(error) { document.getElementById('status').textContent=`Checkout unavailable: ${error.message}. Reload to try again.`; }
