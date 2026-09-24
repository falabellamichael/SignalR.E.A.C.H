# RCH wallet access and shared model allowance

## Implementation status

Wallet sign-in, the hosted account gateway, durable shared usage accounting, the Studio Home account controls, and RCH burn-to-credit settlement are implemented. The chosen public origin is `https://unbent-semicolon-hermit.ngrok-free.dev` on the existing SignalREACH host.

The supplied initial configuration enables account sign-in with **no paid models and no live redemption** once installed. The account service must run on the PC serving the public SignalREACH endpoint, with the relay configured to proxy account routes to it. Actual plan sizes/renewals have not been chosen, the current CodeGPT bridge does not supply reliable usage records, and RCH has not been deployed to Ethereum mainnet. These conditions are represented as unavailable UI states, not simulated purchases or invented balances. Card checkout, automated subscription payments, wallet recovery/linking, mobile WalletConnect, and a token exchange are separate future work.

## Product rules

- CodeGPT and operator-qualified free endpoint models share one account allowance across chats, agents, teams, and devices. A free upstream route does not grant unlimited use of the hosted service.
- Wallet ownership alone grants no subscription or model access. The host must provision an active plan with an explicit model list, allowance, and expiry.
- **1 RCH = 1,000,000 AI usage tokens.** Redemption permanently burns the holder's RCH. Ordinary transfers do not burn it.
- Confirmed redemption credits a durable prepaid ledger once. Model calls subsequently consume this ledger; they do not submit blockchain transactions.
- Included allowance is spent first, prepaid credit second. Prepaid credit persists across plan renewal/expiry, but an active plan is required to use it or begin a new redemption.
- An explicit renewal grant replaces the included allowance. Late refunds from an older plan period cannot inflate the new period. Existing prepaid refunds remain available.
- If a provider reports usage above the reserved balance, the account pays from remaining allowance and records any shortfall as debt. Further requests stop until reconciliation; redemption pays debt before adding usable prepaid credit.

## Customer flow in Studio

1. Open **Home → Wallet sign-in**, save the service origin, and choose **Connect wallet**.
2. The system browser opens the service's wallet page. A browser wallet selects the account and Ethereum chain. Review and sign the login message.
3. Studio receives an expiring session through a proof-key-protected exchange. It displays the wallet, plan, permitted models, and included/prepaid/reserved balances.
4. Choose **Use REACH models**. The managed `REACH subscription` connection uses the same main-process connection routing as Home chat, normal chat, agents, teams, Playground, and refactor. Personal endpoints remain separately managed connections.
5. When live redemption is enabled and the account has an active plan, enter an RCH amount and review the burn. The browser wallet separately approves the transaction and network gas.
6. Refresh the account after finality to see credited usage. Disconnect revokes the current service session and removes its local ciphertext.

Sign-in only signs a message. It does not authorize a payment, transfer, approval, or burn. Studio and the service never request a private key, seed phrase, keystore file, or wallet password. The existing local operator wallet and its private backup are separate from customer account storage.

## Authentication and session handling

`RCH/service/server.mjs` constructs the exact [ERC-4361 sign-in message](https://eips.ethereum.org/EIPS/eip-4361), with a configured domain/URI, chain ID, random nonce, issue time, and expiry. The domain is never taken from a request's Host or forwarding headers. Verification uses the stored message and consumes its challenge atomically.

EOA signatures use ethers recovery. ERC-1271 contract signatures are supported when an `authRpcUrl` is configured for the correct chain. Without that RPC, contract-wallet validation is unavailable. Redemption currently supports direct EOA transactions only and refuses to offer a burn for smart accounts or multisigs.

Studio generates a random state and SHA-256 proof-key challenge. Sign-in flows last ten minutes; signature challenges last at most five; exchanges are single-use. A successful exchange creates a one-hour session. Only session hashes are stored on the service. Electron stores the session through OS-backed `safeStorage`, rejects plaintext fallback storage, and keeps the bearer out of renderer settings, exports, logs, and connection drafts. Cancelled exchanges cannot replace the current connection.

Browser links stay within the configured origin. Redemption capabilities travel in URL fragments and are scoped to one intent. Cross-origin browser API requests are rejected; wallet pages apply CSP, no-referrer, no-store, and no framing. The loopback relay supplies a sanitized client-IP header for rate limits. Expired authentication records are pruned; financial/usage reconciliation records are retained.

## Hosted model accounting

The Node gateway fronts the existing Python relay. The relay routes `/wallet/*`, account/auth/redemption APIs, and requests using `rch_session_` customer credentials to the account service before legacy authentication. Invalid or unavailable customer routing fails closed. Existing operator API keys remain owner credentials; never distribute the gateway's upstream key to customers. Configuring the hosted account service automatically disables remote anonymous model access, even if the legacy anonymous-access setting was left enabled. Set `access.key_required: true` as well so the intended policy is explicit.

Each model route is explicitly qualified with `metered: true`, its upstream model ID, an input size limit, its upstream-enforced input token ceiling, and an output cap. Unqualified models do not appear in customer catalogs. Plans restrict the qualified catalog further.

Before dispatch, a SQLite `BEGIN IMMEDIATE` transaction reserves the input ceiling plus requested output limit from the account. This conservative hold prevents concurrent requests spending the same balance. It is not an estimated bill. On success, **provider-reported input plus output tokens** settle once and unused held tokens are refunded. Cached input and reasoning detail counts are subsets of the totals, not extra charges. Text and tool calls are supported; image/audio/video billing is not enabled.

The gateway requires `X-Reach-Metering: provider-v1` and `usage_source: provider` from the relay. Metered relay requests disable automatic caching, retries, and fallback that would conceal separate generations. Estimated character-based counts remain explicitly estimated and cannot settle paid usage. Missing/conflicting usage, cancellation, dropped streams, and ambiguous upstream outcomes preserve an uncertain hold. A proven pre-dispatch rejection releases it. Matching `Idempotency-Key` retries replay a completed result or report the existing request; they do not start a second generation. Released, undispatched attempts can be retried with the same key.

**CodeGPT limitation:** its current browser bridge returns answer text without reliable aggregate token usage, and can internally continue/retry. It is therefore not yet qualified for paid metering. Do not mark it metered until its adapter captures verifiable usage for every provider generation. Other endpoint models also require operator verification before enabling them. There is no assumption that one million model tokens costs the $0.01 RCH sale target.

The ledger includes request/model/provider/usage records and bounded response replays. These may contain model output; protect the database and backups as customer data. Uncertain requests require genuine provider records for manual settlement; elapsed time is not evidence of zero usage.

## Redemption and recovery

`ReachCredits.redeem(amount, redemptionId)` burns only `msg.sender` holdings. It rejects zero/dust amounts and reused IDs. One AI token corresponds to `1e12` RCH base units; the service accepts 0.000001–1,000,000 RCH per intent. Redemption is separately paused at deployment until the token administrator enables it. `totalRedeemed` and `totalUsageTokensRedeemed` expose cumulative totals.

The server creates an unpredictable wallet-bound intent. Before crediting it, `redemption.mjs` checks the configured chain and token, transaction success and direct call envelope, exact calldata/value/from/to, and the `Redeemed` event's wallet, ID, amount, usage count, contract, transaction hash, block, and log index. A transfer or unrelated burn cannot credit the account. Event keys are unique by chain/transaction/log index.

Ethereum mainnet requires a canonical block at or below the node's `finalized` block, with a canonical recheck before credit. Development chains use an explicit confirmation count. An unavailable RPC, changed chain, missing receipt, or reorganization leaves the intent pending. Mainnet correctness trusts the configured RPC's chain data.

Pending submitted transactions reconcile every 30 seconds and after restart. Signing expiry and later plan expiry do not discard a previously submitted burn. If the browser broadcasts but loses contact before submitting the hash, reopen the original redemption link and use **Recover a submitted transaction**. Preserve that link and transaction hash. Only a definitively finalized failed or unrelated transaction may be replaced with a corrected hash; ambiguous pending transactions remain protected. Credit-limit or event mismatches need operator attention rather than repeated burns.

## Operator setup on the existing host

Node 22.13+ with built-in SQLite is required. No Docker is involved.

1. Install production dependencies with `npm ci --omit=dev --ignore-scripts` in `RCH` (or its deployed service copy).
2. Copy `RCH/config/accounts.example.json` outside the checkout, set the durable database path, and keep the configuration and dedicated upstream key private (`600`, parent directory `700`). Keep `models: []` and `redemption.enabled: false` until those systems are configured.
3. Create a dedicated relay operator key. Keep it only on the host. Set `account_service_url` to `http://127.0.0.1:20978` and remote `access.key_required` to `true` in the existing relay configuration.
4. Run the account service under the host's service manager:

   ```text
   node RCH/scripts/accounts-host.mjs /private/accounts.json /private/upstream.key
   ```

   This reads the credential file without putting its value in process arguments or service definitions. The existing ngrok tunnel still fronts relay port 20777; the account service binds only loopback 20978. No extra public port is needed.
5. Verify public account config and wallet pages; anonymous model requests should fail. Customer session requests must reach the account gateway, and owner keys must remain private.

For local development, use a loopback HTTP `origin` and the environment-based CLI:

```text
npm run accounts -- serve --config /private/accounts.json
```

Set the configuration's named upstream-key environment variable privately in the process environment. Never paste a key into a Projects command log. A model configuration entry, **only after qualification**, has this shape:

```json
{
  "id": "your-qualified-model",
  "name": "Your supplied model",
  "provider": "your-provider",
  "upstreamModel": "the-actual-relay-model-id",
  "metered": true,
  "maxInputTokens": 8192,
  "maxInputBytes": 24000,
  "maxOutputTokens": 2048
}
```

The example limits illustrate the schema; replace them with verified limits for that provider. An empty catalog is a valid unavailable state.

### Plans and reconciliation

Plan provisioning is an operator CLI operation with no public admin-grant endpoint. Create a private JSON file with the actual wallet, unique `grantId`, `planId`, name, qualified model IDs, integer `tokens`, and ISO `expiresAt`. Then run:

```text
npm run accounts -- grant --config /private/accounts.json --file /private/grant.json
npm run accounts -- status --config /private/accounts.json --wallet CUSTOMER_PUBLIC_ADDRESS
npm run accounts -- unsettled --config /private/accounts.json
npm run accounts -- reconcile --config /private/accounts.json
```

The environment-based commands require the named upstream credential environment variable. Retrying an identical grant is idempotent; changing its values under the same ID fails. Subscription checkout and automatic renewals are not implemented.

For an uncertain model request, inspect the reservation ID and obtain actual provider usage. A private settlement JSON contains `reservationId` and `usage: {promptTokens, completionTokens, totalTokens, provider, model}`. Apply it with `npm run accounts -- settle --config /private/accounts.json --file /private/usage.json`. This is privileged reconciliation; do not fabricate a count to clear a hold.

Back up the SQLite database using SQLite's backup API or stop the service before copying it. Do not copy only the main database while WAL writes are active. Preserve grants, redemptions, usage holds, and event uniqueness together. A lost database cannot automatically reconstruct subscription allowances and unsent redemption intents from chain history.

### Enable real redemption later

Use the existing reviewed RCH deployment workflow and a separate deployment authorization. Configure the correct deployed token and a trusted chain RPC under `redemption`, verify the runtime/build and conversion, test recovery/finality, provision actual plans/models, and then enable the service and unpause contract redemption. This implementation did not deploy a contract, move ETH, sign with the operator wallet, or enable real purchases.

## Verification

The RCH suite exercises wallet challenge replay/PKCE/origin/session rejection, shared durable reservations, debt, renewal boundaries, grant/event idempotency, provider metering and SSE failure paths, contract burn permissions and dust/ID handling, wrong-chain/event/reorganization/finality failures, and an actual local Ganache burn settling once into SQLite. Relay tests exercise customer routing before local bypass, header handling, unavailable upstreams, credential isolation, and metered provenance. Studio tests exercise encrypted persistence, cancellation races, expiry, routing, and credential redaction; native Electron fixtures verify the Home states at wide and narrow sizes.
