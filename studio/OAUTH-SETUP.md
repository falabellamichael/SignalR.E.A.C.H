# REACH Studio connection applications

Studio supports customer authorization and optional pasted credentials. The
publisher application identifies REACH; it does not sign customers into the
publisher's account. No owner access token, refresh token, bot token, email, or
password belongs in a desktop package.

## Implementation map

- `renderer/mcp-settings.js` calls the existing Settings save API correctly.
- `agent/plugins.cjs` merges partial settings without erasing saved connections;
  `agent/settings-store.cjs` encrypts each provider's customer credentials.
- `agent/app-auth.cjs` normalizes pasted authorization headers and long opaque
  tokens without imposing a JWT format or truncating them.
- `agent/app-connections.cjs` manages connection checks and sign-in sessions;
  `agent/oauth-clients.cjs` validates publisher metadata, and
  `agent/oauth-grants.cjs` exchanges and renews customer authorizations.
- `agent/mail-connections.cjs` and `agent/extra-apps.cjs` use those credentials
  for provider requests and return safe, actionable connection errors.
- `main.mjs` wires the connection IPC, and `renderer/app-connections.js` exposes
  Connect/Reconnect, cancellation, account choice and storage disclosures.
- `scripts/import-oauth-clients.cjs`, `package.json` and the repository's
  `.gitignore` provision publisher metadata for builds without committing it.
- `../RCH/service/connections-oauth.mjs` implements the hosted OAuth callbacks
  and Discord permission checks. `../RCH/service/server.mjs` and
  `../RCH/scripts/accounts-host.mjs` load it as an optional service, while
  `../server/reachd/account_proxy.py` forwards only its explicit public routes.

Focused regression coverage lives in the Studio app-auth, settings-store,
gmail-setup and oauth-connections tests, the Electron
`test/connections-settings-ui.cjs` test, `../RCH/test/connections-oauth.test.mjs`,
the account-service tests and `../tests/test_reachd_account_proxy.py`.

## Publisher metadata

`oauth-clients.json` is ignored by Git and explicitly included by the Studio
packager. Provision it before building a release, using
`node scripts/import-oauth-clients.cjs`:

- Google: import the downloaded **Desktop** client JSON. Web clients are rejected.
  Google's Desktop client secret is public native-client metadata, not a
  confidential web-client credential.
- GitHub and Microsoft: import the public client ID.
- Slack, Notion and Discord: import the public client ID followed by the HTTPS
  REACH callback-service origin. Confidential client secrets are rejected here.

Google uses PKCE and a loopback callback. Microsoft is a public native client
supporting organizational and personal accounts, with
`http://localhost/oauth/callback` registered; Microsoft ignores the loopback port.
GitHub uses its device flow. Slack, Notion and Discord use a hosted callback at
`/oauth/<provider>/callback` and a one-use handoff bound to the initiating desktop
session's secret proof.

## Private callback service

The account host optionally loads `connections-oauth.json` beside its private
`accounts.json`. That server-only file holds each provider's `clientId` and
`clientSecret`; Discord additionally needs `botToken`. Never copy it into Studio,
commit it, log it, or expose it through an account-config response. Restrict its
Windows ACL to the service owner and SYSTEM. On Unix it must be a regular file
with mode 600. An invalid optional registration file leaves the existing account
service available and disables hosted app connections.

The callback service keeps pending grants in memory for at most ten minutes,
clears them after exchange/cancellation, validates state and desktop proof, and
does not persist customer grants. Studio saves customer grants encrypted through
the operating-system vault. Rotated refresh tokens are saved only if that
connection has not changed or been disconnected.

Discord chat is documented in [DISCORD-CHAT.md](DISCORD-CHAT.md). Its shared bot
credential stays on the server. Each message read validates
the customer's OAuth grant, guild membership, current roles and channel
overwrites. The read tool supports server text and announcement channels. The
conversation bridge additionally supports DMs from the linked customer. Bot
installation requests Administrator permission. Enable Message Content intent
for message text. The customer can enter a default text channel ID for reading
messages after authorization. Chat accepts mentions across accessible server
text channels and keeps a separate conversation per channel; the read default
does not restrict chat or invalidate the account grant. A customer-owned pasted bot token remains an alternative for
reading channels; chat uses customer OAuth to identify the Studio owner.

## Release gates

Registration is distinct from provider approval and a successful customer grant.
Google External Testing permits only configured test users, and its scoped
refresh grants can expire after seven days. Public distribution needs the
publisher's verified branding/domain, accurate privacy disclosures and any
required sensitive/restricted-scope verification. Do not label a Testing build
as approved for all customers.

Slack must have public distribution enabled and an HTTPS redirect registered.
Workspace administrators can still restrict installations. Discord bot tokens
must be provisioned privately, with the required intent and channel permissions;
its application registration alone does not establish message access. The
hosted callback origin must remain available for authorization and renewal.

Before release, run the focused connection, encryption, hosted callback and
proxy suites, then `electron test/connections-settings-ui.cjs`. Finally test
Connect, the provider's actual consent page, Check, an app restart and a
read request using each customer's own account. Fixtures do not prove a live
provider grant. Retain a rollback archive and preserve local profile state.
