# Taking payments live

A checklist for turning on card, PayPal and email sign-in for real customers.
Details for each provider are in [payments.md](payments.md) and
[email-sign-in.md](email-sign-in.md).

## 1. Prepare the service

- [ ] Back up the account database (or Supabase project).
- [ ] With Supabase, apply the migrations in order:
      `20261001120000_rch_payments_ledger.sql`,
      `20261002072512_rch_subscription_checkout.sql`,
      `20261002081418_rch_checkout_provider_reference.sql`,
      `20261003120000_rch_payment_reversals.sql`,
      `20261004120000_rch_email_sign_in.sql`.
      Apply only migrations not already installed: reconcile the remote history
      by name and SQL as well as timestamp. For example, an installed payments
      ledger may have a different timestamp from the repository filename.
      Verify backup and restore before applying these changes. Email sign-in
      makes wallet identity optional; reverting it requires a data-aware restore,
      not simply making wallet NOT NULL again.
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
      never charges, creates or sends anything. Provider errors are `PROBLEM`
      lines. `CHECK` lines mean a setting remains unverified because the key
      could not read it. Both exit non-zero, and CHECK never produces Ready.
      Confirm each CHECK in the dashboard and record that verification, or
      repeat the check using authorized read access. A send-only Resend key can
      remain the service key; do not broaden its access just to silence CHECK.
      Ready verifies only these provider settings. It does not verify database
      migrations, public reachability, webhook signatures, email delivery or
      real payments; complete the remaining checklist separately.

## 3. Try every path once in test mode

Use separate test accounts for Stripe and PayPal in Studio or VS Code, then confirm with
`npm run accounts -- status --config ... --email you@example.com` (or `--wallet`).
An active Basic plan or unresolved checkout blocks another subscription,
including one through the other provider. Cancelled access lasts until the
paid period ends, so do not reuse that account to test another subscription.

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
