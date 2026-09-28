# RCH market value and AI credit

## Required behavior

When a holder redeems RCH, its accepted value at redemption should determine the AI credit received. For example, 100 RCH accepted at USD 0.10 each funds USD 10 of credit; at USD 0.20 each it funds USD 20. These are hypothetical prices, not a current RCH market valuation. A previously completed redemption keeps the value agreed for that redemption. Unredeemed RCH continues to float with its accepted price.

The account should hold a monetary allowance in integer micro-USD (one million units per USD), with a visible currency denomination. It must not treat one million model tokens as the same value for every model. Input, output, cached-input and other billable categories can have different published prices. Pricing is snapshotted per request; provider usage is measured, then the held monetary allowance is settled and the unused portion returned. Never silently reinterpret existing token balances as money.

## Price and quote

The backend needs an explicitly configured, verified RCH/USD source. An ETH/USD feed used to sell RCH does not provide RCH's secondary-market price. A sale target is also not evidence that holders can sell RCH for that amount.

A market-priced deployment should validate source identity, chain, data freshness, sufficient liquidity, and deviation limits. A time-weighted price is more resistant to brief trades than a single instantaneous pool quote, but low-liquidity markets still need limits. If those requirements cannot be met, market-price redemption is unavailable. A separately disclosed operator-funded redemption rate can be offered only as an explicit product policy; it must not be labelled an observed market price.

The Ethereum-mainnet Uniswap v3 RCH/USDC 0.3% pool is `0x245Bb5E69641FBb90c5284577439e3FA4b445629`, created in transaction `0xe3101b250be169c799baeb4d52b6484d958dd624119a850595291416395c36eb` on 2026-09-27. The initial position NFT is `1374637`, owned by `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`. Its approximately 100 RCH inventory sold in transaction `0xb2817eb4bff5d32b8931e04d5aed908d11b5c1c82ec1acc0e2be78d460172333` for 1.424457 USDC. At block 26072751, the pool held 0.000000000000000001 RCH and 1.424457 USDC with zero active liquidity; the position was out of range. These observations are historical and must be checked again before any action. The swap price is not a verified RCH/USD market price. Live redemption still requires sufficient real liquidity, observation history, manipulation limits, and a funded AI service. Until those checks pass, the accepted market price is unavailable and no RCH should be burned for AI credit.

For this position, `0xDa68602c9d65337C75BF0593972d9731895592e3` paid the RCH and gas; the NFT recipient above controls fee collection and liquidity withdrawal. The 1.424457 USDC is in the pool, not directly in the recipient wallet. The owner must decrease liquidity and collect to receive the proceeds; fees require collection too. The one-sided listing and subsequent sale do not establish a reliable RCH/USD market price for AI redemption.

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

Burning RCH does not supply dollars or pay an AI provider. The service must fund the promised usage, or a separately designed redemption path must obtain spendable treasury proceeds. The pricing UI must make clear which mechanism is offered. Do not claim that token price appreciation automatically funds the service.

## Account and usage implementation

Supabase should store wallet/account links, subscription entitlement, versioned model prices, quotes, an append-only monetary ledger, usage reservations/settlements and unique confirmed-redemption events. Server transactions enforce account isolation, one-time crediting and concurrent spending limits. Clients read through authenticated service endpoints and never write balances.

The first confirmed market-priced redemption starts access to eligible REACH AI models, even when the wallet has no active plan. The plan entitlement and monetary credit must be committed together after finality; a failed or unverified burn must grant neither. The existing fixed-token implementation still requires an already active plan and does not implement this rule. A USD balance can fund any included model according to that model's displayed rates. Remaining model tokens or minutes are estimates; the monetary balance and settled charge are authoritative.

## Delivery state

The Supabase adapter in this change preserves the existing fixed-token API as infrastructure. Dynamic RCH valuation, monetary usage billing, first-redemption access, and an expiring on-chain monetary quote are required before live redemption. They are not activated, and the current deployed redemption remains disabled. Only a verified RCH market price is acceptable; the fixed primary-sale price or an operator estimate cannot substitute for one. Do not enable the fixed-token redemption path as if it fulfills the market-value requirement.

References: [Uniswap oracle design](https://developers.uniswap.org/docs/protocols/v2/concepts/oracles), [Chainlink feed selection and liquidity risks](https://docs.chain.link/data-feeds/selecting-data-feeds).
