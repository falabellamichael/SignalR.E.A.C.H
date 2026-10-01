# Basic wallet request billing

Basic costs US$15 and includes 1,500 successfully completed text requests per paid
subscription period. Additional completed requests deduct US$0.01 from the
existing USD wallet credit. Pro is unavailable. A wallet without an active Basic
grant can use funded USD credit at US$0.01 per completed request; connecting a
wallet does not grant free requests or activate a subscription.

The allowance belongs to the existing server-side plan grant: `planId` is
`basic-wallet` (legacy `basic` is also recognized), `grantId` identifies the paid
period, and `expiresAt` defines its end. A verified renewal needs a new grant ID.
The server does not reset the allowance on a calendar timer or extend an unpaid
period. Stripe/PayPal payment verification and activation remain separate work.
No payment credentials or new customer grants are included in this change.

## Approved bridge routing

Merge the `subscription` and `models` fields from
[subscription-bridges.example.json](config/subscription-bridges.example.json)
into the private account-service configuration. Keep the host configuration and
credentials outside the repository. `metered: true` is an operator-controlled
qualification; customers cannot supply or modify a route.

Request models use fixed loopback endpoints: the signed-in browser/Code GPT eco
bridge at port 21302, or the existing Code GPT agent shim at port 21300. Requests
carry no relay or provider API credential and never enter the relay's direct API
or fallback routing. The account service checks the exact bridge model selector
in the response. Code GPT agent selectors identify configured agents; their names
are not independent proof of the agents' underlying model configuration.

The catalogue contains 18 unique model entries, retaining `rch-gpt-4o-mini` and
omitting its duplicate. The currently advertised routes include Code GPT,
Copilot chat, Gemini chat, and ChatGPT chat. `glm-5.2`, `claude-opus-4.6`,
`claude-opus-4.6-fast`, and `gemini-3.7-flash` are disabled because their exact
selectors are absent from the current bridge catalogues. Do not substitute a
personal OpenAI, Google, Alibaba, or other provider API key for a missing bridge.
The `ox-alpha` selector is currently displayed as GLM 5.3 Flash by Code GPT.

The gateway accepts text messages and a single answer. Explicit client tools,
images, hosted actions, and unsupported sampling controls are rejected before
reserving credit. Positive `max_tokens` or `max_completion_tokens` values are
accepted as client compatibility hints and omitted from bridge requests; these
bridges do not enforce an output token ceiling. Public model metadata reports
`capabilities.outputTokenLimit: false`. Input and response byte limits protect
the gateway, and do not represent provider token or spending limits. Existing
tools configured inside a Code GPT agent are controlled by that agent, not by
this text interface. The existing shim can retry a provider request internally.
Provider account limits and availability remain external constraints.

The Code GPT agent shim authenticates to Code GPT's API using the existing
private host credential. The agent list confirms the mapped records, but does
not expose authoritative tool attachments or provider credential settings.
Those properties remain unverified. Code GPT documents API agent usage
separately from interactive Economy usage and supports both BYOK and its own
credits. The customer request price and allowance do not cap that host-side
billing or establish permission to share an interactive subscription.
See [API plans](https://developers.codegpt.co/what-does-the-api-plan-include),
[provider keys](https://www.codegpt.co/docs/api-keys), and
[Economy usage](https://www.codegpt.co/pricing).

## Accounting and recovery

Apply `supabase/migrations/20260930144634_rch_request_subscription_ledger.sql`
before enabling this configuration on the Supabase host. It adds private
`reach_accounts.request_periods` and `request_reservations` tables with RLS and
service-role-only RPC access. It preserves existing accounts, plan grants,
credits, redemption records, and token-priced reservations. SQLite creates the
same request ledger additively.

The service reserves one included request, or exactly 10,000 USD microcredits,
atomically before dispatch. It validates and buffers the finished response,
then commits one completion and returns the answer. Bridge streams reach the
client after completion validation. Failed or cancelled requests release their
hold. If database settlement has an unknown outcome, the durable hold remains
pending operator reconciliation; an automatic refund could otherwise permit a
duplicate answer or charge. A completion from an old period stays in that period.

Clients should reuse the same `Idempotency-Key` when recovering the same input.
A completed replay returns the stored answer without another dispatch or charge;
an in-progress or uncertain request blocks another generation. A changed input
with an existing key is rejected. Clients that omit this header receive a new
request ID and each new submission can count as another request.

Prefer the `payment` command (see [payments.md](payments.md)) to record a confirmed
payment: it is recorded once and enforces the Basic price. The plain grant command
still works for non-paid grants. For
request billing the grant uses `tokens: 0`, `planId: "basic-wallet"`, qualified
model IDs, a unique paid-period `grantId`, and an explicit `expiresAt`. It does
not debit the US$15 subscription price itself. Keep request holds with uncertain
settlement for review; legacy token-usage settlement is not request settlement.

## Verification

Run the request billing, gateway, configuration, and account UI regressions:

```text
node --test RCH/test/request-billing.test.mjs RCH/test/model-gateway-requests.test.mjs RCH/test/model-gateway.test.mjs RCH/test/subscription-bridge-config.test.mjs RCH/test/subscription-account-ui.test.mjs RCH/test/supabase-ledger.test.mjs tests/account_request_ui.test.cjs studio/test/hosted-account.test.cjs tests/vscode_hosted_account.test.cjs
```

These tests use SQLite, local PostgreSQL via PGlite, and controlled bridge
fixtures. Live bridge qualification is separate: verify a completed answer and
an idempotent replay through each enabled exact selector, without funding or
granting a real customer account for the test.
