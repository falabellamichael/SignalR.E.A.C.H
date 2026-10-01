# Payments ledger

Every payment, whether it comes from Stripe, PayPal, or an operator recording one
by hand, is reduced to one normalized record and applied by the same rules in
SQLite and Postgres. This change adds the ledger and the rules only. It contains
no provider credentials, webhooks, or checkout, and it moves no money.

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
service-role only. The same 22-case suite (`test/helpers/payments-suite.mjs`)
runs against SQLite and Postgres (PGlite).
