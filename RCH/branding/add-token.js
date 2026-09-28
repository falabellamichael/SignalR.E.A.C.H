'use strict';
const button = document.getElementById('add-token');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const wallet = window.ethereum;
    if (!wallet) throw new Error('Open this page in Edge with MetaMask installed and enabled.');
    if (await wallet.request({ method: 'eth_chainId' }) !== '0x1') throw new Error('Select Ethereum mainnet in MetaMask, then try again.');
    const response = await fetch('/wallet/rch-tokenlist.json');
    if (!response.ok) throw new Error('RCH token information could not load.');
    const { tokens: [token] } = await response.json();
    if (token.chainId !== 1 || token.address !== '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792') throw new Error('RCH token information does not match Ethereum mainnet.');
    const accepted = await wallet.request({ method: 'wallet_watchAsset', params: {
      type: 'ERC20', options: { address: token.address, symbol: token.symbol, decimals: token.decimals, image: token.logoURI },
    } });
    status.textContent = accepted ? 'RCH display information was sent to MetaMask. Check its token list for the logo.' : 'The token display request was declined.';
  } catch (error) { status.textContent = error.message || 'The wallet could not update the token display.'; }
  finally { button.disabled = false; }
});
