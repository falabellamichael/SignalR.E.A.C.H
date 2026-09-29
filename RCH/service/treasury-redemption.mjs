import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, formatUnits, getAddress, keccak256, parseUnits } from 'ethers';
import { AccountError, fail } from './store.mjs';
import { finalizedReceipt } from './chain-finality.mjs';
import { createMarketQuoteReader, RCH_MARKET } from './market-quote.mjs';

export const treasuryInterface = new Interface([
  'function token() view returns(address)', 'function treasury() view returns(address)',
  'function quoteSigner() view returns(address)', 'function paused() view returns(bool)',
  // Credit bounds live in the contract. Reading them lets the service quote against the real
  // ceiling instead of a config value that can drift away from the deployment.
  'function minCreditUsdMicros() view returns(uint256)', 'function maxCreditUsdMicros() view returns(uint256)',
  'function redeem(uint256 amount,uint256 creditUsdMicros,bytes32 redemptionId,uint64 issuedAt,uint64 deadline,bytes signature)',
  'event RedeemedToTreasury(address indexed wallet,bytes32 indexed redemptionId,address indexed treasury,uint256 amount,uint256 creditUsdMicros)',
]);
export const treasuryTokenInterface = new Interface([
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const quoteTypes = { RedemptionQuote: [
  { name: 'wallet', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'creditUsdMicros', type: 'uint256' }, { name: 'redemptionId', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' }, { name: 'deadline', type: 'uint64' },
] };
const hash = value => /^0x[0-9a-f]{64}$/i.test(value || '');
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// EIP-7702 delegation code is exactly the three-byte marker plus one nonzero
// address. Arbitrary contract code is not an externally owned wallet.
export const isDelegatedEoaCode = code => typeof code === 'string'
  && /^0xef0100[0-9a-f]{40}$/i.test(code) && !/^0xef01000{40}$/i.test(code);

export function createTreasuryRedemptionService({ store, config, provider: suppliedProvider, quoteReader, quoteSigner }) {
  const settings = config.redemption, enabled = settings.enabled === true;
  let provider = suppliedProvider;
  if (enabled && !provider) {
    const request = new FetchRequest(settings.rpcUrl); request.timeout = 15000;
    provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 5, cacheTimeout: -1 });
  }
  const signer = enabled ? quoteSigner || new Wallet(settings.quoteSignerKey) : null;
  const domain = { name:'REACH Treasury Redemption', version:'1', chainId:config.chainId, verifyingContract:settings.contractAddress };
  const adapter = enabled ? new Contract(settings.contractAddress, treasuryInterface, provider) : null;
  const token = enabled ? new Contract(settings.tokenAddress, treasuryTokenInterface, provider) : null;
  // The deployed contract is the authority on credit bounds. Once read, its ceiling replaces the
  // configured one for both quotation and settlement, so a service config that disagrees with the
  // chain can never produce a quote the contract will reject.
  let chainMaxCreditUsdMicros = null;
  let chainMinCreditUsdMicros = null;
  const effectiveMaxCredit = () => chainMaxCreditUsdMicros ?? BigInt(settings.maxCreditUsdMicros);
  const marketQuote = enabled ? quoteReader || createMarketQuoteReader({provider,maxCreditUsdMicros:settings.maxCreditUsdMicros,now:store.now}) : null;
  const requireEnabled = () => { if (!enabled) fail(503,'redemption_disabled','RCH redemption is not enabled on this service.'); };
  const safely = async fn => {
    try { return await fn(); } catch(error) {
      if (error instanceof AccountError) throw error;
      fail(503,'redemption_rpc_unavailable','The market or Ethereum connection is unavailable. Your saved redemption remains recoverable.');
    }
  };
  const boundQuote = row => {
    let quote; try { quote = typeof row.quote_json === 'string' ? JSON.parse(row.quote_json) : row.quote_json; } catch {}
    if (!quote || row.usd_micros !== quote.creditUsdMicros || quote.amount !== row.amount
        || !same(quote.wallet,row.wallet) || quote.chainId !== config.chainId
        || !same(quote.tokenAddress,settings.tokenAddress) || !same(quote.treasuryAddress,settings.treasuryAddress)
        || !same(quote.redemptionContract,settings.contractAddress) || quote.contractCodeHash !== settings.contractCodeHash) {
      fail(409,'redemption_quote_mismatch','This redemption requires its original verified service configuration.');
    }
    return quote;
  };
  const readIntent = async (id,ticket) => {
    if (!hash(id) || !/^[a-f0-9]{64}$/.test(ticket || '')) fail(404,'redemption_missing','Redemption is unavailable.');
    const row = await store.getRedemption(id,ticket);
    return {row,quote:boundQuote(row)};
  };
  const checkContract = async (requireOpen = false) => safely(async () => {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) fail(503,'redemption_wrong_chain','The redemption connection is on the wrong network.');
    const code = await provider.getCode(settings.contractAddress);
    if (code === '0x' || keccak256(code) !== settings.contractCodeHash) fail(503,'redemption_contract_mismatch','The redemption contract does not match the reviewed deployment.');
    const [asset,treasury,authorizedSigner,paused,decimals,onChainMin,onChainMax] = await Promise.all([
      adapter.token(),adapter.treasury(),adapter.quoteSigner(),adapter.paused(),token.decimals(),
      adapter.minCreditUsdMicros(),adapter.maxCreditUsdMicros(),
    ]);
    if (!same(asset,settings.tokenAddress) || !same(treasury,settings.treasuryAddress)
        || !same(authorizedSigner,await signer.getAddress()) || decimals !== 18n) {
      fail(503,'redemption_contract_mismatch','The redemption contract settings do not match this service.');
    }
    // Refuse a config ceiling LOOSER than the deployed contract: that combination is what makes the
    // service issue quotes the chain then reverts, quoting credit it can never actually grant.
    // A stricter configured ceiling is allowed, because it only narrows what the service offers.
    if (BigInt(settings.maxCreditUsdMicros) > onChainMax) {
      fail(503,'redemption_bound_mismatch',
        `The configured credit ceiling of ${settings.maxCreditUsdMicros} micro-dollars exceeds the deployed contract ceiling of ${onChainMax}. Lower the configuration to match the deployment.`);
    }
    chainMinCreditUsdMicros = onChainMin;
    chainMaxCreditUsdMicros = onChainMax;
    if (requireOpen && paused) fail(503,'redemption_paused','Treasury redemption is paused.');
  });
  const status = row => ({ redemptionId:row.id, mode:'treasury',
    status:row.status==='credited'?'credited':row.tx_hash?'pending':row.expires<=store.now()?'expired':'created',
    txHash:row.tx_hash||null, creditUsdMicros:row.usd_micros });
  const signedTransaction = async (row,quote) => {
    const signature = await signer.signTypedData(domain,quoteTypes,{wallet:row.wallet,amount:row.amount,
      creditUsdMicros:row.usd_micros,redemptionId:row.id,issuedAt:quote.issuedAt,deadline:quote.deadline});
    return {to:settings.contractAddress,value:'0x0',chainId:`0x${config.chainId.toString(16)}`,
      data:treasuryInterface.encodeFunctionData('redeem',[row.amount,row.usd_micros,row.id,quote.issuedAt,quote.deadline,signature])};
  };
  async function start(account,amountRch) {
    requireEnabled();
    const current = await store.account(account?.id);
    if (!settings.allowedWallets.some(wallet=>same(wallet,current.walletAddress))) fail(403,'redemption_pilot_wallet','This initial redemption rollout is enabled for the configured owner wallet only.');
    if (!config.models.some(model=>model.metered===true && model.pricing)) fail(503,'redemption_models_unavailable','No priced REACH model is ready for this credit.');
    if (typeof amountRch!=='string' || !/^(0|[1-9][0-9]{0,6})(?:\.[0-9]{1,18})?$/.test(amountRch)) fail(400,'invalid_redemption_amount','Enter a positive RCH amount using decimal digits.');
    const amount=parseUnits(amountRch,18);
    if(amount<=0n || amount>parseUnits('1000000',18)) fail(400,'invalid_redemption_amount','Enter an amount above zero and at most 1000000 RCH.');
    await checkContract(true);
    const [walletCode,balance]=await safely(()=>Promise.all([provider.getCode(current.walletAddress),token.balanceOf(current.walletAddress)]));
    if (walletCode!=='0x'&&!isDelegatedEoaCode(walletCode)) fail(400,'unsupported_redemption_wallet','This rollout supports Ethereum wallets and EIP-7702 delegated wallets.');
    if (balance<amount) fail(400,'insufficient_rch','Your wallet does not hold that much RCH.');
    const market=await safely(()=>marketQuote(amount));
    // Clamp to the deployed ceiling, which checkContract(true) above has just read from the chain.
    const maxCredit = effectiveMaxCredit();
    if (BigInt(market.creditUsdMicros) > maxCredit) {
      fail(400,'redemption_credit_too_large',
        `This redemption quotes $${(BigInt(market.creditUsdMicros)/1_000_000n)} in credit, above the contract ceiling of $${(maxCredit/1_000_000n)}.`);
    }
    const issuedAt=Math.floor(store.now()/1000),deadline=issuedAt+300;
    const quote={...market,issuedAt,deadline,expiresAtMs:deadline*1000,amount:amount.toString(),
      wallet:current.walletAddress,walletMode:isDelegatedEoaCode(walletCode)?'eip7702':'eoa',chainId:config.chainId,tokenAddress:settings.tokenAddress,
      treasuryAddress:settings.treasuryAddress,redemptionContract:settings.contractAddress,
      contractCodeHash:settings.contractCodeHash,creditBudgetUsdMicros:settings.creditBudgetUsdMicros};
    const created=await store.createMarketRedemption(current.id,amount.toString(),quote);
    return {redemptionId:created.redemptionId,expiresAt:created.expiresAt,
      url:`${config.origin}/wallet/redeem#${new URLSearchParams({id:created.redemptionId,ticket:created.ticket})}`};
  }
  async function details(id,ticket) {
    requireEnabled();
    const {row,quote}=await readIntent(id,ticket);
    const result={...status(row),walletAddress:row.wallet,walletMode:quote.walletMode||null,amountRch:formatUnits(row.amount,18),
      treasuryAddress:quote.treasuryAddress,chainId:config.chainId,expiresAt:new Date(row.expires).toISOString(),
      quote:{source:quote.source,observedAt:quote.observedAt},approvalTransaction:null,transaction:null};
    if(row.tx_hash||row.status==='credited')return {...result,signingUnavailableReason:'already_submitted'};
    if(row.expires<=store.now())return {...result,signingUnavailableReason:'intent_expired'};
    try {
      await checkContract(true);
      const [balance,allowance,walletCode]=await Promise.all([token.balanceOf(row.wallet),token.allowance(row.wallet,settings.contractAddress),provider.getCode(row.wallet)]);
      if(walletCode!=='0x'&&!isDelegatedEoaCode(walletCode))fail(400,'unsupported_redemption_wallet','This rollout supports Ethereum wallets and EIP-7702 delegated wallets.');
      result.walletMode=isDelegatedEoaCode(walletCode)?'eip7702':'eoa';
      if(balance<BigInt(row.amount))fail(400,'insufficient_rch','Your wallet no longer holds the quoted RCH amount.');
      const refreshed=await readIntent(id,ticket);
      if(refreshed.row.tx_hash||refreshed.row.status==='credited')return {...result,...status(refreshed.row),signingUnavailableReason:'already_submitted'};
      if(refreshed.row.expires<=store.now())return {...result,status:'expired',signingUnavailableReason:'intent_expired'};
      if(allowance<BigInt(row.amount))return {...result,approvalTransaction:{to:settings.tokenAddress,value:'0x0',
        chainId:`0x${config.chainId.toString(16)}`,data:treasuryTokenInterface.encodeFunctionData('approve',[settings.contractAddress,row.amount])}};
      return {...result,transaction:await signedTransaction(row,quote)};
    } catch(error) {
      return {...result,signingUnavailableReason:error instanceof AccountError?error.code:'redemption_rpc_unavailable',
        message:error instanceof AccountError?error.message:'The Ethereum connection is unavailable. Retry this saved quote.'};
    }
  }
  const matchingEvent = (log,row,quote) => {
    if(!same(log.address,settings.contractAddress)||log.removed)return false;
    try {const parsed=treasuryInterface.parseLog(log);return parsed?.name==='RedeemedToTreasury'
      &&same(parsed.args.wallet,row.wallet)&&same(parsed.args.redemptionId,row.id)
      &&same(parsed.args.treasury,quote.treasuryAddress)&&parsed.args.amount===BigInt(row.amount)
      &&parsed.args.creditUsdMicros===BigInt(row.usd_micros);}catch{return false;}
  };
  const matchingTransfer = (log,row,quote) => {
    if(!same(log.address,settings.tokenAddress)||log.removed)return false;
    try {const parsed=treasuryTokenInterface.parseLog(log);return parsed?.name==='Transfer'
      &&same(parsed.args.from,row.wallet)&&same(parsed.args.to,quote.treasuryAddress)
      &&parsed.args.value===BigInt(row.amount);}catch{return false;}
  };
  const receiptLogIndex = (log,row,receipt) => {
    const index=log.index??log.logIndex;
    return Number.isSafeInteger(index)&&index>=0&&same(log.transactionHash,row.tx_hash)
      &&same(log.blockHash,receipt.blockHash)&&log.blockNumber===receipt.blockNumber?index:null;
  };
  async function verify(row,quote) {
    await checkContract();
    const receipt=await provider.getTransactionReceipt(row.tx_hash);
    if(!receipt)return 'transaction_pending';
    if(!same(receipt.hash??receipt.transactionHash,row.tx_hash))return 'transaction_mismatch';
    if(receipt.status!==1)return 'transaction_failed';
    const tx=await provider.getTransaction(row.tx_hash);
    if(!tx||!same(tx.hash,row.tx_hash)||tx.chainId!==BigInt(config.chainId)
       ||!same(tx.from,receipt.from)||!same(tx.to,receipt.to)
       ||!same(tx.blockHash,receipt.blockHash)||tx.blockNumber!==receipt.blockNumber)return 'transaction_mismatch';
    const walletCode=await provider.getCode(row.wallet,receipt.blockNumber),delegated=isDelegatedEoaCode(walletCode);
    if(!delegated){
      const expected=await signedTransaction(row,quote);
      if(walletCode!=='0x'||!same(tx.from,row.wallet)||!same(tx.to,settings.contractAddress)
        ||!same(tx.data,expected.data)||tx.value!==0n)return 'transaction_mismatch';
    }
    const matches=(receipt.logs||[]).filter(log=>matchingEvent(log,row,quote));
    if(matches.length!==1)return 'redemption_event_mismatch';
    const log=matches[0],index=receiptLogIndex(log,row,receipt);
    if(index===null)return 'redemption_event_mismatch';
    if(delegated){
      // A sponsored/batched wallet call has a different outer sender and target.
      // The pinned immutable redemption runtime verifies the wallet-bound quote
      // itself. Require its exact event plus the exact token transfer preceding
      // it in this same canonical receipt, rather than trusting a relay wrapper.
      const transferred=(receipt.logs||[]).some(entry=>matchingTransfer(entry,row,quote)
        &&receiptLogIndex(entry,row,receipt)!==null&&receiptLogIndex(entry,row,receipt)<index);
      if(!transferred)return 'redemption_transfer_mismatch';
    }
    if(!await finalizedReceipt(provider,config.chainId,settings.confirmations,receipt))return 'awaiting_finality';
    await store.creditRedemption(row.id,`${config.chainId}:${row.tx_hash.toLowerCase()}:${index}`);
    return null;
  }
  async function reconcileOne(row,quote) {
    if(row.status==='credited')return status(row);
    let reason;try{reason=await safely(()=>verify(row,quote));}catch(error){reason=error.code||'redemption_verification_unavailable';}
    return {...status(row),status:reason?'pending':'credited',...(reason?{reason}:{})};
  }
  async function submit(id,ticket,txHash) {
    requireEnabled();if(!hash(txHash))fail(400,'invalid_transaction','Enter a valid Ethereum transaction hash.');
    const {row,quote}=await readIntent(id,ticket);
    if(row.tx_hash&&!same(row.tx_hash,txHash)) {
      if(row.status==='credited')fail(409,'transaction_conflict','This redemption is already credited.');
      await safely(async()=>{
        const receipt=await provider.getTransactionReceipt(row.tx_hash);
        if(!receipt||!same(receipt.hash??receipt.transactionHash,row.tx_hash)
           ||receipt.status!==0&&(receipt.status!==1||!Array.isArray(receipt.logs)||receipt.logs.some(log=>matchingEvent(log,row,quote)))
           ||!await finalizedReceipt(provider,config.chainId,settings.confirmations,receipt)) {
          fail(409,'transaction_conflict','The earlier transaction must be finalized and proven not to redeem this quote before its hash can be replaced.');
        }
        await store.replaceFailedRedemption(id,ticket,row.tx_hash,txHash);
      });
    }
    const pending=await store.submitRedemption(id,ticket,txHash);
    return reconcileOne(pending,quote);
  }
  async function reconcile(accountId) {
    if(!enabled)return [];
    const result=[];
    for(const row of await store.pendingRedemptions(accountId)) {
      if(!row.quote_json)continue;
      try {const quote=boundQuote(row);
        result.push(await reconcileOne(row,quote));
      }catch{/* Preserve the record for operator reconciliation. */}
    }
    return result;
  }
  return {enabled,mode:'treasury',start,details,submit,reconcile,close(){if(!suppliedProvider)provider?.destroy();}};
}
