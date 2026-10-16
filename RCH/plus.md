# REACH Subscription Plus

Plus is a separate Stripe subscription for CAD $25.00 per month with inclusive
price tax behavior. The plan has unlimited completed requests for the service's
qualified subscription model catalog (`access: "requests"`). It has no monthly
request quota and no usage overage charges. The existing service concurrency,
rate, request-size, provider timeout and reconciliation protections still apply.
RCH/token-priced wallet routes remain separately metered and explicitly labelled;
Plus does not mint RCH, add USD wallet credit, or spend wallet balances for its
subscription requests. When a Plus paid period expires, subscription requests
stop rather than silently charging the wallet. Existing Basic subscriptions and
wallet pay-as-you-go accounts keep their original behavior.

## Configuration and activation

The fragment in `config/plus.example.json` contains only non-secret Plus policy.
Merge `subscription.plus` into the operator's existing subscription configuration
while retaining its Basic fields. The Stripe configuration additionally accepts
`payments.stripe.plusPriceId`. This is the exact recurring `price_...` ID copied
from Stripe, not a product name, product ID, profile link or customer-chosen amount
link. Record the operator's verified Price ID in the private plan configuration as
`payments.stripe.plusPriceId` after checking its Stripe account, mode and terms.
This documentation does not configure or activate a running service, and a Price
ID alone does not establish whether it belongs to live or test mode.
`basicPriceId` stays separate and may be retained for existing Basic subscriptions.
Each ID must be distinct.

Stripe API and webhook secrets remain in two separate host environment variables
named by `secretKeyEnv` and `webhookSecretEnv`. Studio and website code never need
these values. Live mode also requires the account service's public HTTPS `origin`.
Once the backend deployment target is identified, Michael enters the values in
that host's protected Environment variables/Secrets settings as
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. The server configuration contains
only those variable names. Do not enter the values in chat, source files, plan
JSON, Studio or the static website. A GitHub Pages website alone is not the
account-service deployment target.
Before activation, back up the account database and review/apply the source
migration `20261015172359_reach_plus_unlimited.sql` for Supabase. SQLite creates
the new side tables on the next controlled service startup. Neither deployment
nor database migration is performed by this source change. No existing customer
is upgraded or moved to Plus automatically.
An old operator grant or a plan merely named Plus cannot become an unlimited
entitlement: access also requires its applied Plus payment receipt and matching
grant version and paid expiry. Existing unresolved usage debt still requires
reconciliation; Plus requests do not create usage overage debt.

The runtime reads the configured Price from Stripe before Plus checkout and when
processing a paid Plus invoice. It verifies Price ID, mode, native currency,
amount, fixed per-unit licensed monthly interval, no trial or quantity transform,
and inclusive tax behavior. The approved example is CAD 2500 minor units monthly.
Product display names never grant access. Discounts, zero-cost invoices,
prorations, mixed invoices, out-of-band payment marking and custom quantities do
not activate Plus in this implementation. Existing subscriptions may renew using
an archived Price if its immutable terms still match.

The Stripe restricted key requires Prices read in addition to the existing
Checkout Sessions read/write, Invoices read, Subscriptions read and Customer Portal
write access. Read access to webhook endpoints and default portal configuration
is needed for the optional operator `check-billing` diagnostic. The diagnostic
loads secrets and makes authenticated provider reads; run it only after a secure
credential handoff. No credentials are included in its sanitized report.

Webhook: `POST https://<account-service-origin>/v1/billing/stripe/webhook`.
Keep the events `invoice.paid`, `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated`
and `charge.dispute.created`. Raw-body signature validation precedes all handling.
Plus access comes only from an exact, paid, signed Plus invoice. Its customer,
subscription, account and server-generated checkout ID must agree with the
service's stored Checkout Session and Stripe's completed, paid session in the
configured mode. A delayed invoice arriving before its checkout is stored retries
without granting access. Historical receipts retain this binding for renewals
even after the pending-checkout slot changes. Metadata alone cannot grant access.
Each invoice is applied once, even when Stripe sends another event ID.
Cancellation and failed renewal do not extend access; the last paid period stays
active until its expiry. A full refund/dispute of the current period revokes it;
partial refunds and older-period reversals remain recorded for operator review.
The Plus Customer Portal uses the customer on the current verified payment
receipt, so an older Basic customer cannot displace the paid Plus subscription.
Expired stored card checkouts are read and verified before another checkout or
plan switch is created. Older intents with no stored provider reference, another
provider's checkout, and subscriptions still capable of billing require operator
reconciliation before replacement; expiry alone never authorizes double billing.

Plus invoices/receipts are stored as native `amountMinor` plus `currency`, never
as `amountUsdMicros`. Inclusive tax is not mistaken for USD wallet credit. This
change does not enable Managed Payments, Stripe Tax automatic collection, or any
tax registration setting. Use a full database backup: the legacy seven-table
snapshot export refuses databases containing Plus records to preserve replay
protection and accounting history.

## Studio and website integration contract

`GET /v1/account/config` returns public `subscription.plus` terms and
`cardPlans.plus`, which is false until the exact Price ID is configured. Studio
shows the native CAD amount and Unlimited usage. Basic remains independently
selectable when enabled. An active plan blocks a second subscription checkout.

An authenticated account session calls:

```http
POST /v1/billing/checkout
Authorization: Bearer <customer-session>
Content-Type: application/json

{"kind":"subscription","planId":"plus"}
```

The service chooses the Price ID and account metadata and returns a URL on
`https://checkout.stripe.com`. A client cannot choose a Price ID, amount, currency,
account ID or entitlement. Checkout success/cancel redirects never grant access.
Refresh `GET /v1/account` after payment; active Plus returns
`requestAllowance.plusActive: true`, `unlimited: true`, `includedLimit: null`,
`remaining: null` and zero usage overage. Null represents no quota, not zero or a
large finite allowance. Usage counters remain descriptive and support recovery.

The existing service permits browser requests only from its configured origin.
An unrelated hosted website must not bypass authentication or create an anonymous
Payment Link and expect access to appear in Studio. A website purchase CTA needs
a supported sign-in/account handoff on the account service origin or an approved
same-origin backend integration; the current Studio session stays in its OS
credential vault. The Price ID alone is not a public checkout URL.

## Secure activation checklist

Read the intended host's `/v1/account/config` to verify payment and Plus readiness.
A reachable tunnel-backed access path alone does not verify an active Plus
release, database migration state, or protected secret-entry mechanism. Keep
operator-specific endpoint addresses and provider identifiers in private host
configuration rather than this source documentation.

The next setup prerequisite is to identify the actual account-service launcher,
its active non-secret configuration path and its protected secret-entry facility
on this Windows host, or select the intended managed backend host. Enter Stripe
secrets only into that account-service process's protected environment. Source
files and the GitHub Pages website are not the place to enter credentials.

1. Verify the configured Plus Price ID in the intended Stripe account and mode:
   CAD $25.00/month, fixed flat rate, inclusive price tax
   behavior. The ID is recorded here; its live configuration is not verified.
   Identify the backend host/project and public HTTPS account-service origin
   before entering any secrets or registering its webhook destination.
2. Review backup/restore and the new schema source, then deploy the migration and
   service/client changes through the normal operator release process.
3. Enter live restricted-key and webhook-signing-secret values through the
   supported secure host handoff; configure only their variable names in JSON.
4. Register the HTTPS webhook/events and default cancellation portal in Stripe.
   Review the sanitized read-only provider diagnostic when authorized.
5. Rehearse checkout, renewal, failed renewal, cancellation, expiry and reversal
   in Stripe test mode before separately approving live activation. Confirm
   that Stripe's account review/payout requirements are resolved independently.
