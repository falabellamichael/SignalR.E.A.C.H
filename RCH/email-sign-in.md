# Email sign-in

Customers without an Ethereum wallet can sign in with an email address. The
sign-in page Studio and VS Code already open (`/wallet/connect`) shows an
**Email me a code** option next to the wallet. The customer types the 6-digit
code from the email on that page, and the app finishes connecting exactly as it
does after a wallet signature: same proof-key exchange, same session, same
billing.

## How it behaves

- The first sign-in with an address creates the account. Later sign-ins with
  the same address, in any letter case, reach the same account.
- Codes last 10 minutes, work only for the sign-in that requested them, and
  allow 5 wrong attempts. Requesting a new code cancels the previous one.
- Limits: one code a minute and five an hour per address, ten an hour per
  network, and 500 an hour for the whole service. A refused request sends nothing.
- Only a hash of the code is stored, and the code never appears in a response
  or in the email subject.
- An email account can subscribe, top up and be refunded like a wallet account.
  It cannot redeem RCH, which needs a wallet (`409 wallet_required`).
- Wallet accounts and email accounts are separate. Linking an email to an
  existing wallet account is not supported yet.

## Setting it up

1. Create a [Resend](https://resend.com) account, add your sending domain under
   **Domains**, and add the DNS records it shows until the domain is verified.
2. **API Keys → Create API key** with "Sending access" for that domain.
3. Put the key in the host's environment, never in the config file:

   ```text
   RESEND_API_KEY=re_...
   ```

4. Add to `accounts.json`:

   ```json
   "email": { "resend": { "apiKeyEnv": "RESEND_API_KEY", "from": "REACH <login@your-domain.com>" } }
   ```

5. Restart the account service. `GET /v1/account/config` now reports
   `"emailLogin": true`, and the apps show **Sign in with wallet or email**.

With Supabase storage, apply migration `20261004120000_rch_email_sign_in.sql`
first. It makes the wallet optional on an account, adds the email column and the
code table, and changes no existing row. A SQLite database upgrades itself on
the next start: its accounts table is rebuilt once with every row kept.

## Operator commands

Every account command that takes `--wallet` also takes `--email`:

```text
npm run accounts -- status --config /private/path/accounts.json --email customer@example.com
npm run accounts -- payments --config /private/path/accounts.json --email customer@example.com
```

A hand-recorded payment file can name `email` instead of `wallet`; the account
must already exist (its owner signs in once).
