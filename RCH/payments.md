# Payments ledger

Every payment, whether it comes from Stripe, PayPal, or an operator recording one
by hand, is reduced to one normalized record and applied by the same rules in
SQLite and Postgres. Stripe is the first automatic provider (see
[Stripe](#stripe) below); PayPal will use the same ledger.

## The record

| Field | Meaning |
| --- | --- |
| `provider` | `stripe`, `paypal`, or `manual` |
| `eventId` | the provider event that delivered it (kept for support, not for deduping) |
| `objectId` | the provider's payment object (invoice, capture, sale). This is the idempotency key |
| `kind` | `subscription_period` or `top_up` |
| `accountId` | the REACH account the payment is for |
| `amountUsdMicros` | what bought the product, in USD micro-dollars. Excludes tax and processor fees |
| `periodEnd` | subscription only; epoch milliseconds (Stripe reports seconds, so convert) |

## Rules

- A payment is applied once per `(provider, objectId, kind)`. Replays return the
  original result with `duplicate: true`. The same object with different values
  is a `409 payment_conflict`.
- A Basic payment must equal the Basic price exactly.
- A period that already ended is recorded as `expired`; one more than 400 days out
  is `rejected` (`period_too_long`). Both catch seconds-versus-milliseconds mistakes.
  A rejected period outside JavaScript's Date range appears as `periodEnd: null`
  in payment lists; the original timestamp remains in the ledger.
- A late, older invoice never shortens a newer paid period: it is recorded as
  `superseded` and the plan is left alone.
- A payment never replaces a different plan an operator granted by hand.
- Top-ups must be between US$1 and US$500, repay any debt first, and cannot push
  the balance past the ceiling.
- Business-rule failures are recorded, not thrown, so a provider is told "received"
  and does not retry forever. `rejected` and `expired` rows need an operator's look.
- The ledger is append-only. A refund or dispute will be a new entry.

## Recording a payment by hand

```text
npm run accounts -- payment --config /private/path/accounts.json --file payment.json
npm run accounts -- payments --config /private/path/accounts.json            # needs review
npm run accounts -- payments --config /private/path/accounts.json --wallet 0x...
```

```json
{ "wallet": "0x...", "objectId": "bank-ref-0001", "kind": "subscription_period",
  "amountUsdMicros": 15000000, "periodEnd": "2026-11-01T00:00:00Z" }
```

Use this instead of the plain `grant` command for anything that was paid for, so
the payment is recorded and cannot be applied twice.

## Postgres

Migration `20261001120000_rch_payments_ledger.sql` adds `reach_accounts.payments`
and `public.reach_payment_store`. It changes no existing table or function and is
service-role only. The same 23-case suite (`test/helpers/payments-suite.mjs`)
runs against SQLite and Postgres (PGlite).

The legacy `import-sqlite` snapshot cannot preserve payment history. It refuses
any source with payment records, including rejected payments, so importing a
balance cannot discard the identifiers that prevent double credit. Keep a full
database backup until payment-ledger snapshot migration is supported. Databases
with an empty payment ledger can still use the legacy export.

Subscription checkout retries share a durable intent and Stripe idempotency key,
including after a service restart. Apply the additional generated
`20261002072512_rch_subscription_checkout.sql` migration before deploying this
version to Supabase. The legacy SQLite export also refuses pending checkout
records, preserving their protection against a second subscription charge.

## Stripe

Customers pay on Stripe's hosted Checkout page; REACH never sees a card.
The account service creates the page, and Stripe calls a webhook when money
arrives. The webhook is the only thing that changes a plan or a balance.

| What the customer does | Stripe event | Ledger entry |
| --- | --- | --- |
| Subscribes to Basic ($15/month) | `invoice.paid` (first and every renewal) | `subscription_period`, keyed on the invoice |
| Adds $1–$500 of credit | `checkout.session.completed`, or `checkout.session.async_payment_succeeded` for bank debits | `top_up`, keyed on the Checkout Session |

Every Checkout this service creates carries `reach_account_id` and `reach_kind`
metadata, and the subscription copies it to every renewal invoice. Stripe events
without that metadata (anything else sold from the same Stripe account) are
acknowledged and ignored. Amounts exclude tax. A $0 invoice is ignored.

### Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/billing/checkout` | customer session | `{"kind":"subscription"}` or `{"kind":"top_up","amountUsdMicros":20000000}`; returns a `checkout.stripe.com` URL |
| `GET /v1/billing/payments` | customer session | the customer's own payments, without Stripe IDs |
| `POST /v1/billing/stripe/webhook` | Stripe signature | verified against the raw body; 5-minute replay window |
| `GET /billing/return` | none | the page Stripe sends the customer back to |

A second subscription checkout is refused while a plan is active, so nobody is
charged twice. Studio and the VS Code extension show **Subscribe to Basic** and
**Add credit by card** only when the service reports `cardPayments: true`, and
they open only `https://checkout.stripe.com` pages.

### Setting it up (test mode first)

1. In the Stripe Dashboard, switch to **Test mode**.
2. **Product catalog → Add product**: "REACH Basic", recurring, monthly, US$15.00.
   Copy the price ID (`price_...`).
3. **Developers → API keys → Create restricted key** with write access to
   Checkout Sessions. If Checkout creation fails with a permission error, also
   grant read access to Prices and Products. A full secret key (`sk_test_...`)
   also works, but a restricted key limits the damage if it leaks.
4. **Developers → Webhooks → Add endpoint**:
   `https://<your public service origin>/v1/billing/stripe/webhook`, with the
   events `invoice.paid`, `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`. Copy the signing secret (`whsec_...`).
5. Put the keys in the host's environment, never in the config file:

   ```text
   STRIPE_SECRET_KEY=rk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

6. Add to `accounts.json` (Basic must already be configured under `subscription`):

   ```json
   "payments": { "stripe": { "mode": "test", "secretKeyEnv": "STRIPE_SECRET_KEY",
     "webhookSecretEnv": "STRIPE_WEBHOOK_SECRET", "basicPriceId": "price_..." } }
   ```

7. Restart the account service and pay with test card `4242 4242 4242 4242`
   (any future date, any CVC). Check the result with
   `npm run accounts -- payments --config ... --wallet 0x...`.

For local testing without the public tunnel,
`stripe listen --forward-to http://127.0.0.1:20978/v1/billing/stripe/webhook`
prints a temporary `whsec_...` to use instead. `stripe trigger` events carry no
REACH metadata, so they are correctly ignored; use a real test Checkout.

The service refuses to start if the key does not match `mode` (`sk_test_`/`rk_test_`
for test, `sk_live_`/`rk_live_` for live), if either secret shares an environment
variable with another credential, or if live mode is used without a public
HTTPS origin.

### Not yet handled (needed before live mode)

- Cancelling a subscription, and the Stripe customer portal. Until then, cancel
  in the Stripe Dashboard; the plan simply runs to the end of its paid period.
- Refunds and disputes. They do not yet reverse a grant or a credit; record a
  correction by hand and watch `payments` for anything flagged.
- Sign-in by email. Payments are tied to the internal account ID, not the
  wallet, so adding email sign-in needs no change here.
