# SimpleRAG extension editions

SignalREACH Public connects to a provider account or local model selected by the user. REACH Admin contains the operator control panel for the existing local REACH runtime. The packages have separate plugin IDs, page IDs, JavaScript globals, and preference keys, so they can coexist in SimpleRAG.

| Edition | Plugin ID | Page ID | Runtime scope |
| --- | --- | --- | --- |
| Public | `signal-reach-public` | `signal-reach-public.reach-page` | User-selected provider through SimpleRAG |
| Admin | `signal-reach-admin` | `signal-reach-admin.reach-page` | Existing owner-operated local relay |

The public package contains exactly three frontend assets: `manifest.js`, `reach-public.js`, and `reach-public.css`. It includes no relay control scripts, owner endpoint discovery, publishing tools, browser sessions, wallet, billing service, Supabase files, VS Code extension, or tray runtime. API keys belong to the connection the user explicitly creates; local UI preferences must not contain keys.

The Admin build transforms the current operator frontend into separate generated globals and IDs. It preserves the original source files and uses the existing relay. Installing the Admin frontend does not install, restart, migrate, or copy that runtime or its configuration.

## Public control panel (26.11.1)

The public panel opens on **Usage**. **Playground** includes its recent request activity on the same page. **Settings** brings saved connections, connection editing, model defaults, and the optional shared settings hub together. Previous Dashboard, Endpoint, Models, Logs, Shared Settings, and About routes resolve to these three views. The right pane is a connection summary rather than another set of page launchers.

Usage shows account-wide REACH totals for the last 7, 30, or 90 days, including requests made outside this extension. Select the saved REACH account connection and refresh explicitly. The comparison API dropdown uses enabled connections already saved in SimpleRAG; its model dropdown uses their cached catalog/default. Choosing a comparison does not change the active chat connection or call that provider. Enter the selected model's input/output prices per million tokens, optionally its cached-input price, and the CAD-per-USD assumption when currencies differ. Rates are remembered separately per connection/model. Provider prices are not guessed or fetched automatically.

Accounting definitions and boundaries:

- Subscription payments are the recorded subscription receipts in the selected period, minus linked refunds recorded before the period end, capped at the receipt amount. They are not prorated subscription accruals. Refunds of payments outside the period are not included.
- Crypto credit used is settled USD credit consumed from RCH-funded balances, after unused reservation holds are released. Other credit used is the remaining settled USD credit. Pending and released requests do not contribute spending or tokens.
- Crypto redeemed is the USD credit granted at redemption. It is shown separately, never added again to credit consumed. Purchase price, market gains/losses, and network fees are not available from the usage ledger.
- The REACH comparison cost is net subscription receipts plus consumed USD credit. The alternative is the same measured input, output, and cached-token volume at the user's selected rates. The result can show REACH costing more, less, or the same.
- Only complete provider-reported token counts are used. Any completed request missing measured tokens, or legacy token credits without a cash value, disables the full-period cost difference. Missing data never becomes zero spending or invented savings.
- Periods use request/payment creation time, with an inclusive start and exclusive end. Summaries reflect current settlement state, so a previously unresolved request can change a later refresh of that period.

Live statistics require all three layers:

1. The account service in `RCH/service` provides authenticated `GET /v1/usage?from=<milliseconds>&to=<milliseconds>` (also `/api/v1/usage`). Default window: 30 days; maximum: 366 days. It derives account identity from the credential and ignores caller-supplied account IDs. Customer API keys gain only this read-only aggregate route; account identity and payment-management routes remain session-only. Normal key eligibility and revocation still apply.
2. For Supabase storage, apply `supabase/migrations/20261114195130_rch_usage_summary.sql` before updating the service. It adds a service-role-only, security-invoker summary RPC and period indexes. Existing RLS policies and private tables are unchanged. SQLite uses the same accounting rules without a new schema. The relay must include both usage routes in `server/reachd/account_proxy.py`.
3. The SimpleRAG host needs `GUI/reach_usage.py` and the `GET /model-endpoints/{endpoint_id}/reach-usage?days=30` route in `GUI/router.py`. These companion changes are in the SimpleRAG checkout. It reads the selected connection's existing securely stored key, disables redirects/environment proxies, and whitelists only aggregates. A frontend ZIP alone cannot update a compiled SimpleRAG host or a deployed account service.

The public package continues to contain no account-service implementation, database credentials, or provider keys. Building the package does not deploy these backend changes. Source and isolated preview verification do not establish that an already-installed SimpleRAG executable supports the route.

1. Build both packages into a fresh output directory:

   ```powershell
   python tools/extension_editions.py build --edition all --out dist/extension-editions
   ```

2. Install the public frontend directly. This is also the default edition:

   ```powershell
   python tools/extension_editions.py install
   ```

   To install the Admin page instead:

   ```powershell
   python tools/extension_editions.py install --edition admin
   ```

   Reload SimpleRAG's Advanced page after installation. For review without changing the live host, pass `--extension-home` with a temporary directory.

3. Export source snapshots for separate repositories:

   ```powershell
   python tools/extension_editions.py export --edition all --out dist/extension-sources
   ```

   Public exports contain the public sources, a public-only builder, a frontend-only installer, and reproducible package/frontend tests. Private Admin exports contain the Admin frontend sources, the edition builder, a tracked allowlist of relay/runtime-maintenance sources, and relevant tests. Both exports use fresh snapshots with no Git history, installed config, credentials, browser profiles, financial tooling, or unrelated product trees. Existing output folders are never overwritten.

4. Verify the build/install boundaries and frontend behavior:

   ```powershell
   python -m unittest tests.test_extension_editions -v
   node --test tests/public_extension.test.cjs tests/settings_model_dropdowns.test.cjs
   ```

The standalone package installer verifies asset sizes and SHA-256 hashes, stages the edition package, preserves other registry entries, and atomically replaces the registry. Invalid registries and linked package paths are rejected. Failed same-version registry replacement restores the prior package. These hashes detect accidental corruption; they do not constitute a publisher signature.

The default `python tools/reach.py install` command also installs only the public frontend, before any operator runtime modules are imported. Use `python tools/reach.py install --edition admin` for the private page. The legacy full runtime installer requires the explicit `python tools/reach.py install-runtime` command. Its relay, tunnel, tray, publishing, and account-discovery behavior belongs to operator maintenance.

The relay now rejects nonlocal operator requests unless `system.allow_remote_admin` is exactly `true`. A valid Admin token cannot override the disabled setting. Genuine direct local operator access keeps its existing behavior; public model API calls still require their configured client authorization.

SimpleRAG executes extension scripts within its own application origin. Separate package IDs and preferences prevent accidental overlap; they do not sandbox arbitrary modified JavaScript installed on the operator's own machine. Install trusted extension code on an Admin machine. The public edition running on another user's computer has no owner connection, credentials, or granted hosted-service authority.

Repository privacy does not revoke previously shared keys or secure a deployed server. These source changes require a deliberate runtime update before the new remote-Admin guard applies to an already-running relay. No Supabase policies, projects, storage, subscriptions, financial accounts, or live provider credentials are changed by building or installing the frontend editions.
