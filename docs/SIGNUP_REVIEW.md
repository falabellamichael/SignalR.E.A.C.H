# Signup review signals

The hosted Supabase account service can record one first-observed verified-email
signup signal per account after successful PKCE exchange. It never resets trials,
changes paid plans, or blocks existing sessions. VPN/proxy classification is not
performed.

Matching order:
1. Same verified email: no duplicate flag.
2. Different email, matching observed IP: `different_email_same_ip`.
3. Different email, matching device identifier (even on another IP):
   `different_email_same_device`.

The device identifier is a random website localStorage token, not a hardware ID.
Clearing site data, using a different browser, or deliberately replacing the
token defeats matching. Shared computers and networks can produce legitimate
matches, so flags require operator review and do not deny access.

Only loopback relay connections may supply X-Reach-Client-IP. Remote forwarded
headers are ignored. The relay must continue to derive its client IP through its
trusted-proxy policy. An observed VPN exit address is not a residential IP.

The database stores salted SHA-256 email/IP/device matches, not raw IPs or device
tokens, in private RLS-enabled tables. Its salt is private. The service-role-only
RPC derives email from the verified account, never from the request body.
Review `reach_accounts.signup_signals.flags` using an operator database session;
no customer-facing endpoint exposes other members or matching information.

Signals are best-effort and held for up to ten minutes in memory during login.
A service restart during sign-in can lose the pending signals; successful login
is preserved if signal storage fails. Existing accounts without recorded signals
establish a baseline at their next verified-email login. Wallet-only accounts are
not recorded until they have a verified email. Local SQLite is not implemented.

Deployment requires migration `20261023130000_rch_signup_signals.sql`, the updated
account service, and rebuilt/published website assets. A dedicated admin review UI,
retention policy, hosted sign-in page device token, and native-client installation
identifier remain follow-up work. No browser fingerprinting is used.
