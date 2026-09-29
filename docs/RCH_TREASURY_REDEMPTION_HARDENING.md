# Treasury redemption hardening — review note

Follow-up to the review point that the treasury redemption signing key is locked in
permanently and that the $1/$5 limits live only in the backend. Both are correct, and
a third gap was found while confirming them.

**Changes:** commits `d7f4733` and `7e07bbf` on `main`.
**Contract:** `RCH/contracts/ReachTreasuryRedemption.sol`

## Losing or leaking the key led to the same dead end

The contract had two `onlyOwner` functions, `pause()` and `unpause()`, and no setter for
`quoteSigner`. So both failure modes converged on the same outcome:

- **Lose the key:** the service cannot sign quotes. Redemption stops, with no attacker
  involved.
- **Leak the key:** an attacker can sign quotes. `pause()` stops the bleeding.

Either way the feature is off and **cannot be resumed**, because there is no way to point
the contract at a replacement signer. Pausing contains the theft but is not recovery; it
turns a compromised feature into a permanently dead one. Restoring it required
redeploying and migrating every holder's RCH.

That is the defect this change fixes, and it is why the fix is the setter rather than
better key custody.

## The third gap

`allowedWallets` was service-side only, in the same way the credit limits were. The
signed quote binds `msg.sender`, but nothing asserted *who* `msg.sender` is. A
compromised signer could therefore mint a valid quote for **any** address, so the
pilot's containment was not enforced anywhere the chain could see it.

## What changed

| Concern | Before | Now |
| --- | --- | --- |
| Quote signer | `immutable`, no setter anywhere | storage variable + owner-only `setQuoteSigner()` |
| Credit bounds | validated only in `service/config.mjs` at startup | `minCreditUsdMicros` / `maxCreditUsdMicros` enforced in `redeem()` |
| Wallet allowlist | service-side list only | `allowedWallet` mapping + owner-only `setAllowedWallet()` |

Deliberate design choices:

- The **bounds are immutable**. Tightening policy is free; loosening it requires a new
  deployment, in the open, rather than a quiet config edit.
- `token` and `treasury` stay **immutable**. A re-pointable treasury would let the owner
  redirect every future redemption.
- The **signer is the only mutable identity**. The service holds the signing key and
  never the owner key, so a compromised signer cannot call the setter that replaces it.

The EIP-712 quote format, domain, separate `DOMAIN_TYPEHASH`, typehash, deadline window,
and the `RedeemedToTreasury` event are **unchanged**, so the existing off-chain service
keeps signing and reading exactly as before. It simply gains a contract that refuses
out-of-bounds quotes instead of trusting the caller.

## Deploy-time checklist

1. **The constructor now takes six arguments, not four:**
   `(initialOwner, token, treasury, quoteSigner, minCreditUsdMicros, maxCreditUsdMicros)`.
   Anything outside this repository that builds the deployment transaction must be
   updated. `scripts/treasury-deployment-ui.mjs` already is.

2. **Call `setAllowedWallet` before `unpause`, or redemption is bricked.** `redeem()`
   reverts `WalletNotAllowed` for any address not on the on-chain allowlist, and the
   constructor leaves the contract paused. Safe order:
   deploy → `setAllowedWallet` for each pilot wallet → `unpause()`.

3. **Resolve the ceiling drift before deploying.** A parallel uncommitted change to
   `service/config.mjs` raises the ceilings to `1_000_000_000` / `5_000_000_000`
   micro-dollars ($1000 / $5000), while `DEPLOYMENT.maxCreditUsdMicros` is
   `1_000_000` ($1). The on-chain value now takes precedence, so a mismatch produces
   quotes that pass service validation and then revert on-chain. Pick one value.

4. **Verification now checks the bounds**, not just identity — a deployment with looser
   bounds than reviewed fails the readiness check even if every address matches.

## Evidence

- Compiles clean: 4 production contracts, solc 0.8.37.
- Deployed size 4,583 bytes, well inside the EIP-170 limit of 24,576.
- **168 tests pass.** The 8 failures are pre-existing and unrelated: a missing optional
  `@electric-sql/pglite` package makes the two ledger test files fail at import, and the
  remainder are the macOS-only Keychain wallet tests.
- New coverage asserts that rotation removes the old key's authority, that only the owner
  may rotate the signer or edit the allowlist, that the ceiling rejects an over-limit
  quote while accepting an exactly-at-limit one, and that a correctly signed quote for a
  non-allowlisted wallet is refused.