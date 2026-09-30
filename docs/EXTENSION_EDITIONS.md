# SimpleRAG extension editions

SignalREACH Public connects to a provider account or local model selected by the user. REACH Admin contains the operator control panel for the existing local REACH runtime. The packages have separate plugin IDs, page IDs, JavaScript globals, and preference keys, so they can coexist in SimpleRAG.

| Edition | Plugin ID | Page ID | Runtime scope |
| --- | --- | --- | --- |
| Public | `signal-reach-public` | `signal-reach-public.reach-page` | User-selected provider through SimpleRAG |
| Admin | `signal-reach-admin` | `signal-reach-admin.reach-page` | Existing owner-operated local relay |

The public package contains exactly three frontend assets: `manifest.js`, `reach-public.js`, and `reach-public.css`. It includes no relay control scripts, owner endpoint discovery, publishing tools, browser sessions, wallet, billing service, Supabase files, VS Code extension, or tray runtime. API keys belong to the connection the user explicitly creates; local UI preferences must not contain keys.

The Admin build transforms the current operator frontend into separate generated globals and IDs. It preserves the original source files and uses the existing relay. Installing the Admin frontend does not install, restart, migrate, or copy that runtime or its configuration.

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
