# RCH market value and AI credit

## Required behavior

When a holder redeems RCH, its accepted value at redemption should determine the AI credit received. For example, 100 RCH accepted at USD 0.10 each funds USD 10 of credit; at USD 0.20 each it funds USD 20. These are hypothetical prices, not a current RCH market valuation. A previously completed redemption keeps the value agreed for that redemption. Unredeemed RCH continues to float with its accepted price.

The account should hold a monetary allowance in integer micro-USD (one million units per USD), with a visible currency denomination. It must not treat one million model tokens as the same value for every model. Input, output, cached-input and other billable categories can have different published prices. Pricing is snapshotted per request; provider usage is measured, then the held monetary allowance is settled and the unused portion returned. Never silently reinterpret existing token balances as money.

## Price and quote

The backend needs an explicitly configured, verified RCH/USD source. An ETH/USD feed used to sell RCH does not provide RCH's secondary-market price. A sale target is also not evidence that holders can sell RCH for that amount.

A market-priced deployment should validate source identity, chain, data freshness, sufficient liquidity, and deviation limits. A time-weighted price is more resistant to brief trades than a single instantaneous pool quote, but low-liquidity markets still need limits. If those requirements cannot be met, market-price redemption is unavailable. A separately disclosed operator-funded redemption rate can be offered only as an explicit product policy; it must not be labelled an observed market price.

The Ethereum-mainnet Uniswap v3 RCH/USDC 0.3% pool is `0x245Bb5E69641FBb90c5284577439e3FA4b445629`, created in transaction `0xe3101b250be169c799baeb4d52b6484d958dd624119a850595291416395c36eb` on 2026-09-27. The initial position NFT is `1374637`, owned by `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`. Its approximately 100 RCH inventory sold in transaction `0xb2817eb4bff5d32b8931e04d5aed908d11b5c1c82ec1acc0e2be78d460172333` for 1.424457 USDC. At block 26072751, the pool held 0.000000000000000001 RCH and 1.424457 USDC with zero active liquidity; the position was out of range. These observations are historical and must be checked again before any action. The swap price is not a verified RCH/USD market price. Live redemption still requires sufficient real liquidity, observation history, manipulation limits, and a funded AI service. Until those checks pass, the accepted market price is unavailable and no RCH should be burned for AI credit.

For the original position, `0xDa68602c9d65337C75BF0593972d9731895592e3` paid the RCH and gas; the NFT recipient above controlled fee collection and liquidity withdrawal. The owner [recovered the old position's USDC](https://etherscan.io/tx/0xb20704e1fb2ffa812e3bbe792ea00a09901d60c52cac5bfd632a6c6daff4504b). The one-sided listing and subsequent sale did not establish a reliable RCH/USD market price for AI redemption.

A new, two-sided Ethereum-mainnet Uniswap v3 0.05% RCH/USDC pool is `0x2621d7b87776f9B4e72797D4E41E326916649124`, created in [transaction `0x9a3c1fc2…cca7029672`](https://etherscan.io/tx/0x9a3c1fc22c4fda8c3628b21ec48e79f2d33225bfbca4e7ba1becb4cca7029672). At block 26072950 it had active liquidity `14199999999999`, approximately 142 RCH and 1.42 USDC. The position NFT is `1374664`, owned by `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`. An on-chain exact-input quote for 0.10 USDC returned approximately 9.337741 RCH. The initial reserves are too small to establish a dependable market price for AI credit; redemption remains disabled until a verified pricing source, manipulation controls, sufficient liquidity, and funded usage service exist. All balances and quotes are a snapshot and must be refreshed before use.

For every proposed exchange, persist an immutable quote with:

- Quote ID, account/wallet, chain and contract, and exact RCH base-unit amount.
- Accepted RCH/USD price, source reference and observation time.
- Gross and net credit, any explicitly disclosed fees, and pricing-policy version.
- Expiry, one-use nonce, and the settlement transaction/event key.

The user sees the RCH amount, USD credit, any fees, and expiry before signing. Amount, recipient, quote and expiry must be enforced by the transaction path, not only by a button in the UI. Never reprice an already accepted, valid transaction because finality took longer than the displayed signing window.

## Current contract constraints

`ReachCredits.sol` hardcodes `AI_TOKENS_PER_RCH = 1_000_000`, and its `Redeemed` event reports that fixed entitlement. The current service validates that exact rate and credits the reported entitlement. These deployed constants cannot be changed by editing application configuration. Existing redemption IDs also do not enforce quote expiry or a minimum monetary credit on chain.

The original `ReachCreditsSale.sol` hardcodes a USD 0.01 primary-sale price. Its ETH/USD oracle adjusts the ETH charged, not the RCH dollar price. If cheap issuance remains open while the service promises a higher redeemable value, repeated purchase/redemption can consume the service's funding. Issuance pricing and redemption funding must therefore be reviewed together.

A new, reviewed redemption path is needed for firm market-value quotes. One possible extension is a separate redemption contract that validates signed quote terms, uses a one-use nonce and deadline, and atomically transfers/burns the authorized RCH while emitting the holder's monetary credit. It would require its own implementation, tests, deployment, wallet approvals and backend verification. Keeping the existing token contract may be possible through an adapter, but the existing fixed-token event must not be silently relabelled as dollars.

`RCH/contracts/ReachTreasuryRedemption.sol` now provides the transfer variant for review. A holder approves that separate contract, then submits a backend-signed EIP-712 quote binding the holder, exact RCH amount, USD microcredit amount, redemption ID, and a maximum 15-minute signing window. The contract sends the exact RCH amount to an immutable treasury address and emits the quoted credit; it starts paused. It does **not** call the deployed token's burn function, so the RCH supply is unchanged. The intended Ethereum-mainnet treasury is `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`, but a deployed contract and its constructor parameters must be independently verified before use. No quote signer key belongs in this repository or any client.

The transfer contract is not deployed or connected to the account service. The service still understands only the old fixed-token burn event, and must be extended to verify the new contract, event, finality and immutable quote, then credit a USD-denominated Supabase ledger atomically. The RCH market price and qualified model rates remain unavailable. Do not unpause the old token burn path, transfer RCH to the treasury manually as a substitute for redemption, or ask a holder to approve the new contract until the full quote-to-credit flow has been tested and enabled.

Burning RCH does not supply dollars or pay an AI provider. The service must fund the promised usage, or a separately designed redemption path must obtain spendable treasury proceeds. The pricing UI must make clear which mechanism is offered. Do not claim that token price appreciation automatically funds the service.

## Account and usage implementation

Supabase should store wallet/account links, subscription entitlement, versioned model prices, quotes, an append-only monetary ledger, usage reservations/settlements and unique confirmed-redemption events. Server transactions enforce account isolation, one-time crediting and concurrent spending limits. Clients read through authenticated service endpoints and never write balances.

The first confirmed market-priced redemption must start access to eligible REACH AI models, even when the wallet has no active plan. The monetary credit must be committed atomically after finality; a failed or unverified burn must grant no credit. The fixed-token ledger now supports access from confirmed prepaid credit without an active plan, including in the private Supabase account schema. A future USD balance can fund any included model according to that model's displayed rates. Remaining model tokens or minutes are estimates; the monetary balance and settled charge are authoritative.

## Delivery state

The Supabase adapter preserves the existing fixed-token API as infrastructure. Dynamic RCH valuation, monetary usage billing, and an expiring on-chain monetary quote are required before live redemption. First-redemption access is implemented for the existing prepaid ledger, but the current deployed redemption remains disabled. Only a verified RCH market price is acceptable; the fixed primary-sale price or an operator estimate cannot substitute for one. Do not enable the fixed-token redemption path as if it fulfills the market-value requirement.

References: [Uniswap oracle design](https://developers.uniswap.org/docs/protocols/v2/concepts/oracles), [Chainlink feed selection and liquidity risks](https://docs.chain.link/data-feeds/selecting-data-feeds).
