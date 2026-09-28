# RCH market value and AI credit

## Required behavior

When a holder redeems RCH, its accepted market value at redemption determines the AI credit received. The pilot quotes the entire submitted amount because selling more RCH moves this small market's price; a displayed per-token spot price multiplied by holdings is not a realizable quotation. A previously completed redemption keeps the USD value agreed for that redemption. Unredeemed RCH continues to float with its accepted price.

The account implementation holds monetary allowance in integer USD microcredits (one million units per USD), displayed separately from legacy token allowances. Input, output, and cached-input prices are snapshotted per request; provider usage is measured, then the held monetary allowance is settled and the unused portion returned. Existing token balances are never reinterpreted as money.

## Price and quote

The backend obtains exact-input RCH/USDC quotations from the verified Uniswap v3 pool and converts the proceeds using Chainlink's USDC/USD feed. The old ETH/USD sale feed and fixed primary-sale target do not determine redemption credit.

`RCH/service/market-quote.mjs` validates Ethereum mainnet, pool tokens and fee, the factory's canonical pool address, active liquidity, finalized-block age, and a canonical block recheck. It asks QuoterV2 for the exact RCH amount at the finalized state and current state, taking the lower output. It converts that output with the positive, complete USDC/USD round: eight decimals, no more than 24 hours old, and within USD 0.95–1.05. Amounts exceeding the configured quote cap are rejected rather than silently credited at a lower amount.

This is an **owner-only, operator-funded pilot**, not a manipulation-resistant public price oracle or cash-backed redemption promise. Configuration requires an explicit wallet allowlist, caps each quote at USD 1 or less, and caps cumulative quoted credit at USD 5 or less per account. Every issued quote counts toward that account's budget, including expired or unsubmitted quotes; spending credited funds does not reset it. This conservative cap needs operator reconciliation if unused quotes exhaust it. Broader access needs a separately reviewed liquidity, pricing, and funding policy. Time-weighted observations can improve resistance to short trades but do not make a tiny market safe for unlimited credit.

The old Ethereum-mainnet Uniswap v3 RCH/USDC 0.3% pool is `0x245Bb5E69641FBb90c5284577439e3FA4b445629`, created in transaction `0xe3101b250be169c799baeb4d52b6484d958dd624119a850595291416395c36eb` on 2026-09-27. The initial position NFT is `1374637`, owned by `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`. Its approximately 100 RCH inventory sold in transaction `0xb2817eb4bff5d32b8931e04d5aed908d11b5c1c82ec1acc0e2be78d460172333` for 1.424457 USDC. At block 26072751 it was out of range, with zero active liquidity. These historical observations are not the pilot's quotation source.

For the original position, `0xDa68602c9d65337C75BF0593972d9731895592e3` paid the RCH and gas; the NFT recipient above controlled fee collection and liquidity withdrawal. The owner [recovered the old position's USDC](https://etherscan.io/tx/0xb20704e1fb2ffa812e3bbe792ea00a09901d60c52cac5bfd632a6c6daff4504b). The one-sided listing and subsequent sale did not establish a reliable RCH/USD market price for AI redemption.

A new, two-sided Ethereum-mainnet Uniswap v3 0.05% RCH/USDC pool is `0x2621d7b87776f9B4e72797D4E41E326916649124`, created in [transaction `0x9a3c1fc2…cca7029672`](https://etherscan.io/tx/0x9a3c1fc22c4fda8c3628b21ec48e79f2d33225bfbca4e7ba1becb4cca7029672). At block 26072950 it held approximately 142 RCH and 1.42 USDC with active liquidity. Position NFT `1374664` belongs to `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`. The pilot reads this pool through mainnet QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` and Chainlink USDC/USD `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6`. Its original reserves are historical; every redemption requests a fresh quotation under the pilot limits.

For every proposed exchange, persist an immutable quote with:

- Quote ID, account/wallet, chain and contract, and exact RCH base-unit amount.
- Exact-size USDC output, USDC/USD reference, source block/hash, observation time, and pricing-policy version.
- Accepted integer USD credit. The pilot adds no redemption fee; the wallet pays Ethereum network gas separately.
- Expiry, one-use nonce, and the settlement transaction/event key.

The user sees the RCH amount, USD credit, any fees, and expiry before signing. Amount, recipient, quote and expiry must be enforced by the transaction path, not only by a button in the UI. Never reprice an already accepted, valid transaction because finality took longer than the displayed signing window.

## Current contract constraints

`ReachCredits.sol` hardcodes `AI_TOKENS_PER_RCH = 1_000_000`, and its `Redeemed` event reports that fixed entitlement. The legacy burn implementation remains available for development tests, but mainnet configuration refuses to enable it. These deployed constants cannot be changed by editing application configuration. Its redemption IDs also do not enforce quote expiry or monetary credit on chain.

The original `ReachCreditsSale.sol` hardcodes a USD 0.01 primary-sale price. Its ETH/USD oracle adjusts the ETH charged, not the RCH dollar price. If cheap issuance remains open while the service promises a higher redeemable value, repeated purchase/redemption can consume the service's funding. Issuance pricing and redemption funding must therefore be reviewed together.

The replacement path uses a separate contract that validates signed monetary quote terms, a one-use redemption ID, and a deadline. It transfers the authorized RCH to the treasury and emits the holder's USD credit. The existing token contract is retained; its fixed-token burn event is never relabelled as dollars.

`RCH/contracts/ReachTreasuryRedemption.sol` now provides the transfer variant for review. A holder approves that separate contract, then submits a backend-signed EIP-712 quote binding the holder, exact RCH amount, USD microcredit amount, redemption ID, and a maximum 15-minute signing window. The contract sends the exact RCH amount to an immutable treasury address and emits the quoted credit; it starts paused. It does **not** call the deployed token's burn function, so the RCH supply is unchanged. The intended Ethereum-mainnet treasury is `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`, but a deployed contract and its constructor parameters must be independently verified before use. No quote signer key belongs in this repository or any client.

`RCH/service/treasury-redemption.mjs` connects this contract interface to immutable market quotes and atomic USD credit settlement. It pins the deployed runtime hash, checks the token/treasury/quote-signer getters, validates the complete direct transaction and event, and requires canonical mainnet finality. The service issues five-minute signing windows. A valid transaction confirmed after that window keeps its saved credit amount. Implementation and passing tests do not prove deployment or activation: the service must be configured for the actual verified adapter address, and its owner must separately unpause it. Keep the old token burn path paused. Manual treasury transfers do not create account credit.

Burning RCH does not supply dollars or pay an AI provider. The service must fund the promised usage, or a separately designed redemption path must obtain spendable treasury proceeds. The pricing UI must make clear which mechanism is offered. Do not claim that token price appreciation automatically funds the service.

## Account and usage implementation

The SQLite and Supabase implementations store wallet/account links, subscription entitlement, immutable quotes, USD prepaid/reserved/debt balances, price snapshots on usage reservations, usage settlements, and unique confirmed-redemption event keys. Server transactions enforce account isolation, one-time crediting, the pilot budget, and concurrent spending limits. Clients read through authenticated service endpoints and never write balances. Supabase financial tables remain in the private `reach_accounts` schema with RLS; only the server service role may execute the accounting RPC.

The first confirmed treasury redemption starts access to eligible priced REACH models even when the wallet has no active plan. USD credit commits atomically after finality; failed or unverified transactions grant none. Legacy token allowance remains separate. A USD balance funds included priced models according to their configured input, cached-input, and output rates. Remaining model tokens or minutes are estimates; the monetary balance and settled charge are authoritative.

The existing relay's dedicated `rch-gpt-4o-mini` alias routes to `openai/gpt-4o-mini` with fallback and response trimming disabled. Its streaming and nonstreaming responses have been verified to preserve provider usage. Current configured price inputs are USD 0.15 per million input tokens, USD 0.075 per million cached-input tokens, and USD 0.60 per million output tokens. These are monetary model rates, not an RCH exchange rate. The current CodeGPT bridge and legacy CodeGPT shim do not provide reliable billable usage and remain unqualified.

## Delivery state

The treasury contract, exact-size market quotation, wallet approval/redemption flow, USD accounting, provider-priced settlement, and Studio balance display are implemented. Activation requires a verified deployment record, matching host configuration and quote signer, applied database migrations, a qualified priced model catalog, and a separate owner transaction to unpause the adapter. This document does not assert that those operational steps or a customer's first redemption have completed. The deployment helper's readiness file gates its activation button; source code or a displayed quote alone is not proof of credited mainnet funds.

References: [Uniswap v3 oracle design](https://developers.uniswap.org/docs/protocols/v3/concepts/price-oracles), [official mainnet deployment addresses](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments), [Chainlink USDC/USD feed](https://data.chain.link/feeds/ethereum/mainnet/usdc-usd), [GPT-4o-mini model pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini).
