# RCH wallet access and shared model allowance

## Implementation status

Wallet sign-in, the hosted account gateway, durable shared usage accounting, account dropdowns in Studio and the VS Code extension, and the treasury redemption implementation are present. The new path transfers RCH to the receiving treasury and settles quoted USD AI credit. The chosen public origin is `https://unbent-semicolon-hermit.ngrok-free.dev` on the existing SignalREACH host.

The supplied example configuration starts with **no paid models and no live redemption**. The existing relay now also has a qualified `rch-gpt-4o-mini` alias using its configured OpenAI provider. An operator must add that priced model to the account catalog and configure a verified treasury adapter deployment before activation. The account service runs on the PC serving the public SignalREACH endpoint; the relay proxies account routes to it. The service and treasury contract each have a separate redemption switch. A build, migration, or wallet connection does not prove a completed deployment, activation, or credit. Actual plan sizes/renewals, card checkout, automated subscription payments, wallet recovery/linking, and mobile WalletConnect remain separate work.

Account persistence supports local SQLite and a server-only Supabase backend. USD prepaid, reserved, and debt balances are separate from legacy token allowances; immutable redemption quotes and model-price snapshots survive restarts. The schema migration does **not** activate redemption by itself. The implemented market policy and contract boundaries are documented in [RCH_VALUE_PRICING.md](RCH_VALUE_PRICING.md).

## Product rules

- Qualified models share the account ledger across chats, agents, teams, and devices. A free upstream route does not grant unlimited use of the hosted service. CodeGPT remains unqualified because its existing adapters lack reliable usage measurements.
- Wallet ownership alone grants no subscription or model access. An operator plan or confirmed prepaid credit grants access to qualified models. The first confirmed treasury redemption starts access to eligible priced models without a separate plan.
- The token's legacy **1 RCH = 1,000,000 AI usage tokens** burn remains paused; mainnet configuration rejects that mode. Treasury mode quotes USD credit for the exact RCH amount, transfers those tokens to the treasury, and leaves supply unchanged. Ordinary transfers do not credit the account.
- Confirmed redemption credits a durable prepaid ledger once. Model calls subsequently consume this ledger; they do not submit blockchain transactions.
- Legacy token accounting spends eligible included allowance first and token prepaid credit second. USD credit uses priced-model reservations and settlement; it is never relabelled as model tokens.
- The initial market rollout requires an owner-wallet allowlist, at most USD 1 per quote, and at most USD 5 of cumulative issued quotes per account. Every issued quote counts toward this conservative budget, including expired or unsubmitted quotes. It is operator-funded AI credit, not a promise that the treasury receives spendable dollars.
- An explicit renewal grant replaces the included allowance. Late refunds from an older plan period cannot inflate the new period. Existing prepaid refunds remain available.
- If a provider reports usage above the reserved balance, the account pays from remaining allowance and records any shortfall as debt. Further requests stop until reconciliation; redemption pays debt before adding usable prepaid credit.

## Customer flow in Studio

1. Open the **account bubble at the top right → Account**, save the service origin, and choose **Connect wallet**. Account, **Usage & RCH**, and **Settings** remain inside this dropdown; closing it preserves unsaved form values.
2. The system browser opens the service's wallet page. A browser wallet selects the account and Ethereum chain. Review and sign the login message.
3. Studio receives an expiring session through a proof-key-protected exchange. It displays the wallet, plan, permitted models, legacy token allowances, and separate available/reserved USD credit.
4. Choose **Use REACH models**. The managed `REACH subscription` connection uses the same main-process connection routing as Home chat, normal chat, agents, teams, Playground, and refactor. Personal endpoints remain separately managed connections.
5. Open **Usage & RCH** and enter the RCH amount. Once treasury mode is configured and activated for this wallet, the system browser shows the exact RCH amount, receiving treasury, USD AI credit, quotation source, and expiry. MetaMask first approves the exact RCH allowance when needed, then reviews the redemption transaction. Each transaction costs Ethereum gas. The first finalized redemption starts model access.
6. Refresh the account after finality to see credited usage. Disconnect revokes the current service session and removes its local ciphertext.

Sign-in only signs a message. It does not authorize a payment, transfer, approval, or burn. Studio and the service never request a private key, seed phrase, keystore file, or wallet password. The existing local operator wallet and its private backup are separate from customer account storage.

## Customer flow in the VS Code extension

1. Open REACH Chat and select the **account bubble at the top right → Account**. Save the same account service URL used in Studio, then select **Sign in with wallet**.
2. Sign the login message in the browser wallet. The extension completes the same proof-key exchange and stores the session in VS Code SecretStorage. Neither settings nor the chat webview receive the session credential.
3. The dropdown shows the shared subscription, wallet holdings, available usage, and redemption controls. Select **Use REACH models** when the account has an active plan or prepaid credit and qualified models. Requests go through the account gateway and share Studio's ledger.
4. Use **Settings** and **Budgets** in the same dropdown for the existing endpoint, provider, and usage settings. Escape closes the dropdown and returns focus to the bubble. Ordinary wallet approvals still take place in the browser wallet.

RCH holdings are read from the configured chain at one block and are displayed separately from prepaid usage. An unavailable balance lookup is never shown as a zero balance. Signing in or holding RCH does not itself grant a plan or credit usage.

## Authentication and session handling

`RCH/service/server.mjs` constructs the exact [ERC-4361 sign-in message](https://eips.ethereum.org/EIPS/eip-4361), with a configured domain/URI, chain ID, random nonce, issue time, and expiry. The domain is never taken from a request's Host or forwarding headers. Verification uses the stored message and consumes its challenge atomically.

EOA signatures use ethers recovery. ERC-1271 contract signatures are supported when an `authRpcUrl` is configured for the correct chain. Without that RPC, contract-wallet validation is unavailable. The treasury pilot supports direct EOA redemption transactions only; smart-account and multisig redemption is unavailable.

Studio generates a random state and SHA-256 proof-key challenge. Sign-in flows last ten minutes; signature challenges last at most five; exchanges are single-use. A successful exchange creates a one-hour session. Only session hashes are stored on the service. Electron stores the session through OS-backed `safeStorage`, rejects plaintext fallback storage, and keeps the bearer out of renderer settings, exports, logs, and connection drafts. Cancelled exchanges cannot replace the current connection.

Browser links stay within the configured origin. Redemption capabilities travel in URL fragments and are scoped to one intent. Cross-origin browser API requests are rejected; wallet pages apply CSP, no-referrer, no-store, and no framing. The loopback relay supplies a sanitized client-IP header for rate limits. Expired authentication records are pruned; financial/usage reconciliation records are retained.

## Hosted model accounting

The Node gateway fronts the existing Python relay. The relay routes `/wallet/*`, account/auth/redemption APIs, and requests using `rch_session_` customer credentials to the account service before legacy authentication. Invalid or unavailable customer routing fails closed. Existing operator API keys remain owner credentials; never distribute the gateway's upstream key to customers. Configuring the hosted account service automatically disables remote anonymous model access, even if the legacy anonymous-access setting was left enabled. Set `access.key_required: true` as well so the intended policy is explicit.

Each model route is explicitly qualified with `metered: true`, its upstream model ID, an input size limit, its upstream-enforced input token ceiling, and an output cap. Unqualified models do not appear in customer catalogs. Plans restrict the qualified catalog further.

Before dispatch, an atomic database transaction reserves the model's input ceiling plus requested output limit. USD requests price that hold with the configured model rates and snapshot those rates on the reservation. SQLite uses `BEGIN IMMEDIATE`; Supabase uses PostgreSQL transactions with account-row locks and unique idempotency keys. On success, provider-reported uncached input, cached input, and output usage settle the actual USD charge once, rounded up to a whole USD microcredit; unused held credit returns to the account. Legacy token requests retain token-denominated settlement. Cached input and reasoning counts remain subsets of the totals. Text and tool calls are supported; image/audio/video billing is not enabled.

The gateway requires `X-Reach-Metering: provider-v1` and `usage_source: provider` from the relay. Metered relay requests disable automatic caching, retries, and fallback that would conceal separate generations. Estimated character-based counts remain explicitly estimated and cannot settle paid usage. Missing/conflicting usage, cancellation, dropped streams, and ambiguous upstream outcomes preserve an uncertain hold. A proven pre-dispatch rejection releases it. Matching `Idempotency-Key` retries replay a completed result or report the existing request; they do not start a second generation. Released, undispatched attempts can be retried with the same key.

**CodeGPT limitation:** its current browser bridge returns answer text without reliable aggregate token usage, and can internally continue/retry. It is therefore not yet qualified for paid metering. Do not mark it metered until its adapter captures verifiable usage for every provider generation. Other endpoint models also require operator verification before enabling them. There is no assumption that one million model tokens costs the $0.01 RCH sale target.

The dedicated `rch-gpt-4o-mini` relay alias points explicitly to `openai/gpt-4o-mini`, with fallback and trailing-role trimming disabled. Streaming and nonstreaming canaries preserve actual provider usage. Its current pricing is USD 0.15 per million input tokens, USD 0.075 per million cached-input tokens, and USD 0.60 per million output tokens. Existing CodeGPT-backed aliases are unchanged. [Provider model pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini)

The ledger includes request/model/provider/usage records and bounded response replays. These may contain model output; protect the database and backups as customer data. Uncertain requests require genuine provider records for manual settlement; elapsed time is not evidence of zero usage.

## Redemption and recovery

Mainnet uses `ReachTreasuryRedemption.redeem` with a backend-signed EIP-712 quote. It binds the wallet, amount, USD microcredits, redemption ID, issue time, and deadline. The contract transfers RCH to its immutable treasury and emits `RedeemedToTreasury`; the token supply does not change. The service issues five-minute quotes, while the contract rejects any signing window above fifteen minutes. The old token's `redeem(amount, redemptionId)` and fixed-rate burn counters remain separate and paused on mainnet.

`treasury-redemption.mjs` creates an unpredictable wallet-bound intent and persists its complete monetary quote. Before crediting it, the service checks the pinned runtime hash and immutable token/treasury/signer addresses, transaction success and direct call envelope, exact calldata/value/from/to, and the `RedeemedToTreasury` event's wallet, ID, RCH amount, USD amount, treasury, contract, transaction hash, block, and log index. A manual transfer or unrelated burn cannot credit the account. Event keys are unique by chain/transaction/log index. `redemption.mjs` retains the legacy development path.

Ethereum mainnet requires a canonical block at or below the node's `finalized` block, with a canonical recheck before credit. Development chains use an explicit confirmation count. An unavailable RPC, changed chain, missing receipt, or reorganization leaves the intent pending. Mainnet correctness trusts the configured RPC's chain data.

Pending submitted transactions reconcile every 30 seconds and after restart. Signing expiry and later plan expiry do not discard a valid submitted redemption or change its USD value. If the browser broadcasts but loses contact before submitting the hash, reopen the original redemption link and use **Recover a submitted transaction**. Preserve that link and transaction hash. Only a definitively finalized failed or unrelated transaction may be replaced with a corrected hash; ambiguous pending transactions remain protected. Credit-limit or event mismatches need operator attention rather than another transfer.

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
  "id": "gpt-4o-mini",
  "name": "GPT-4o mini",
  "provider": "openai",
  "upstreamModel": "rch-gpt-4o-mini",
  "metered": true,
  "maxInputTokens": 8192,
  "maxInputBytes": 24000,
  "maxOutputTokens": 2048,
  "pricing": {
    "inputUsdMicrosPerMillion": 150000,
    "cachedInputUsdMicrosPerMillion": 75000,
    "outputUsdMicrosPerMillion": 600000
  }
}
```

The example input/output limits illustrate the schema; configure bounds that match the served route and input guard. The pricing fields are integer USD microcredits per million provider tokens. An empty catalog remains a valid unavailable state, but enabled treasury redemption requires at least one qualified priced model.

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

### Supabase storage

1. Create a dedicated project in the intended Supabase organization after verifying its cost. Apply the SQL in `supabase/migrations` to that project and run the database security advisors.
2. Copy `RCH/config/accounts.supabase.example.json` to the host's private configuration directory. Set the real project URL and existing public REACH origin. Choose either `supabase` or `database`; configuration rejects both together and never silently falls back to local storage when Supabase is unavailable.
3. Put the project's server secret key (or legacy `service_role` key) in a separate private credential file. Never distribute it to Studio, the browser, customer devices, or source control. The service supports modern `sb_secret_` keys and rejects publishable/anon keys for accounting.
4. Start the host with the existing private upstream credential and separate Supabase credential:

   ```text
   node RCH/scripts/accounts-host.mjs /private/accounts.json /private/upstream.key /private/supabase.key
   ```

   Environment-based CLI operations use the variable named by `supabase.secretKeyEnv` as well as `upstreamKeyEnv`. The host launcher reads files without putting their contents in command arguments, then removes its temporary credential environment variables.
5. Verify wallet sign-in, account isolation, shared reservations, idempotency, and confirmed redemption with a test account before switching production storage. Stop the source account service and keep a database backup, then import its existing state into the empty Supabase target:

   ```text
   npm run accounts -- import-sqlite --config /private/supabase-accounts.json --source-sqlite /private/accounts.sqlite
   ```

   The importer reads a consistent SQLite snapshot without modifying it, preserves account IDs and all seven tables, and refuses to overwrite a nonempty target. The import commits as one transaction. The command reports counts only. Verify counts and an existing account before starting the new service. Switching configuration alone does not migrate records; do not keep two independently writable ledgers running after cutover.

Tables live in the private `reach_accounts` schema. RLS is enabled, anonymous and authenticated client roles have no data privileges, and the fixed-operation RPC is executable only by the backend service role. The existing REACH wallet session identifies the account at the service boundary. The Supabase organization owner's login is not a customer account or a substitute for wallet authentication.

All financial mutations execute inside one RPC transaction. The market-USD migration adds separate USD balances, currency-tagged reservations with price snapshots, and redemption quote/credit columns while preserving legacy token data. Browser requests cannot set a balance, grant a plan, choose the credited amount, or assert that redemption succeeded. Database outages fail closed; a provider request is not dispatched before its reservation succeeds, and an uncertain dispatched request is not automatically refunded or retried. No new Storage buckets or object access policies are needed.

### Activate the treasury redemption pilot

Use the [treasury deployment review helper](../RCH/tools/treasury-deployment.md) to deploy the compiled adapter through MetaMask. The owner/payer is `0xDa68602c9d65337C75BF0593972d9731895592e3`; the immutable receiving treasury is `0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`. Verify the saved receipt, deployed runtime, owner, token, treasury, and quote signer. The new adapter starts paused.

Configure `redemption.mode: "treasury"`, the verified `contractAddress` and `contractCodeHash`, `tokenAddress`, `treasuryAddress`, a trusted `rpcUrl`, `confirmations`, `allowedWallets`, `maxCreditUsdMicros` (at most 1000000), and `creditBudgetUsdMicros` (at most 5000000). `quoteSignerKeyEnv` names a separate host-only signing credential whose public address must equal the adapter's `quoteSigner`. Never place its private key in JSON configuration, browser URLs, command arguments, or source control.

For Supabase, the file-based launcher accepts the separate quote credential as its fourth file argument:

```text
node RCH/scripts/accounts-host.mjs /private/accounts.json /private/upstream.key /private/supabase.key /private/quote-signer.key
```

Apply the account migrations and verify quotation, replay rejection, event/finality recovery, and priced model settlement before setting `redemption.enabled: true` and completing the adapter's separate owner activation. The helper's activation button requires a fresh private readiness file matching that exact deployment. Keep the old token burn paused. Source changes and these setup instructions do not claim that a mainnet deployment, activation, or customer redemption has completed.

## Verification

The RCH suite exercises wallet challenge replay/PKCE/origin/session rejection, shared durable reservations, debt, renewal boundaries, grant/event idempotency, provider metering and SSE failure paths, contract burn permissions and dust/ID handling, wrong-chain/event/reorganization/finality failures, and an actual local Ganache burn settling once into SQLite. The Supabase tests execute the migration in local PostgreSQL through PGlite and cover role/RLS denial, transactional mutations, snapshot import, transport failures, and asynchronous gateway boundaries. They do not replace hosted Supabase concurrency and cutover checks. Relay tests exercise customer routing before local bypass, header handling, unavailable upstreams, credential isolation, and metered provenance. Studio and extension tests exercise protected persistence, cancellation races, expiry, routing, and credential redaction; native Electron fixtures cover dropdown layout and interaction at wide and narrow sizes.
