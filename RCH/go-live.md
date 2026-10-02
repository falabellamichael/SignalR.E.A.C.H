# Taking payments live

A checklist for turning on card, PayPal and email sign-in for real customers.
Details for each provider are in [payments.md](payments.md) and
[email-sign-in.md](email-sign-in.md).

## 1. Prepare the service

- [ ] Back up the account database (or Supabase project).
- [ ] With Supabase, apply the migrations in order:
      `20261001120000_rch_payments_ledger.sql`,
      `20261003120000_rch_payment_reversals.sql`,
      `20261004120000_rch_email_sign_in.sql`.
      A SQLite database upgrades itself on the next start.
- [ ] The service's public origin is HTTPS and reachable by Stripe and PayPal
      (their webhooks call it). Live mode refuses to start otherwise.

## 2. Set up in test mode

- [ ] Stripe **test mode**: Basic price, restricted key, webhook, customer portal.
- [ ] PayPal **sandbox**: REST app, Basic plan, webhook.
- [ ] Resend: verified sending domain and API key.
- [ ] Keys in the host environment; `payments` and `email` blocks in `accounts.json`.
- [ ] Run the read-only check until it says **Ready**:

      npm run accounts -- check-billing --config /private/path/accounts.json

      It confirms each key works, the Basic price or plan is exactly US$15.00 a
      month, each webhook points at this service with every needed event, the
      Stripe portal allows cancelling, and the sending domain is verified. It
      never charges, creates or sends anything. `CHECK` lines mean the key was
      not allowed to read that setting; confirm it in the dashboard.

## 3. Try every path once in test mode

Use a test account in Studio or VS Code, then confirm with
`npm run accounts -- status --config ... --email you@example.com` (or `--wallet`).

- [ ] Sign in with an email code.
- [ ] Subscribe to Basic by card (test card 4242 4242 4242 4242): plan active.
- [ ] Add US$5 credit by card: balance up by US$5.
- [ ] Refund that top-up in Stripe: balance back down.
- [ ] Open **Manage or cancel subscription** and cancel: the plan stays until its period ends.
- [ ] Subscribe and add credit with a PayPal sandbox buyer.
- [ ] Refund the PayPal top-up in the sandbox: balance back down.
- [ ] `npm run accounts -- payments --config ...` and `reversals` show nothing
      unexpected waiting for review.

## 4. Switch to live

- [ ] Repeat step 2 with **live** keys, price, plan and webhooks, and set
      `"mode": "live"` for Stripe and PayPal.
- [ ] Run `check-billing` again until it says **Ready**.
- [ ] Make one small real top-up with your own card, check it arrives, then
      refund it and check the balance goes back down.

## 5. Keep an eye on it

- [ ] Weekly, run `payments` and `reversals` without `--wallet`/`--email`: they
      list only what needs a person (wrong amounts, expired periods, partial
      refunds, refunds of an older month).
- [ ] Stripe and PayPal email you about failed webhook deliveries; a failing
      delivery usually means the service was down. They retry for several days,
      and every payment is applied once however often it arrives.
- [ ] A dispute you win is not re-credited automatically. Use the `payment`
      command to restore it if fair.
