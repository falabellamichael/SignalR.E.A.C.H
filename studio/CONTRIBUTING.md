# Contributing to REACH Studio

Use Node.js 24 or newer and npm. From the repository root:

```sh
cd studio
npm ci
npx install-electron
npm test
npm start
```

`npm test` recursively parses the source and discovers `test/**/*.test.cjs`.
Tests use temporary projects and mock endpoints; no provider key is required.

`npm run smoke` builds the editor and exercises the real Electron app with an
isolated temporary profile. It opens windows and needs a graphical session
(`xvfb-run -a npm run smoke` on headless Linux). Never point tests at your real
user-data directory. `npm run test:agents-ui` covers chat scrolling and member
restart controls; `npm run test:workspace` covers workspace UI.

`npm run test:coverage` reports coverage of executed agent/browser/renderer
modules. It does not measure the entire Electron application or replace smoke
tests. The CI baseline is informational, not a coverage-percentage gate.

## Installing the Electron binary

`npx install-electron` is required after `npm ci`. Electron 44 publishes no
`install` script (`scripts` is empty in the registry manifest) and exposes the
download as the separate `install-electron` bin instead, so nothing fetches
`node_modules/electron/dist` during install. Without this step `npm ci` reports
success and leaves a tree that cannot launch: `electron .` falls through to
plain Node and fails with
`does not provide an export named 'BrowserWindow'`.

This is not a sandbox or `ignore-scripts` problem, so an `allowScripts` entry in
`package.json` does not help — there is no script to allow. Run the command (or
have it cached from a previous install) before `npm start` or `npm run smoke`.

On Windows, launch from a shell that does not set `ELECTRON_RUN_AS_NODE`. VS
Code's integrated terminal injects `ELECTRON_RUN_AS_NODE=1`, which makes
`electron.exe` behave as plain Node and produces the same import error. `npm
start` and `npm run smoke` inherit it; clear it for the process.

## Extension points

- **Tools:** register a tool in `agent/tool-registry.cjs` with its class,
  approval requirement, result budget, help, example and executor. Route calls
  through `agent-tool-runner.cjs`; do not bypass policy, sandbox or review checks.
  Test both successful execution and refusal using temporary projects.
- **Pages:** renderer files are classic scripts, not ES modules. Add markup to
  `renderer/index.html`, load the new script after its dependencies, and wire it
  through the existing navigation in `renderer/workspace-shell.js`. Keep script
  code out of inline HTML because the CSP only permits same-origin scripts.
- **IPC:** add the handler, preload wrapper, and `ipc-manifest.json` entry
  together. The manifest test compares both sets and checks ownership. It does
  not validate argument/result types; validate untrusted input in the handler
  and test rejection. See [the IPC audit](../docs/STUDIO_IPC.md) for known gaps.
  `browser:command` is the only explicitly dynamic invocation channel.
- **Persistence:** use `agent/atomic-write.cjs` for replace-in-place JSON.
  Credential settings go through `agent/settings-store.cjs`; never serialize
  the in-memory settings projection directly. Preserve old data on migration
  failure and test migration, second-load idempotence, and unavailable keychains.

## Verification and scope

For each change, add a regression test, run `npm test`, and run `npm run smoke`
when changing main, preload or renderer behavior. Update the item's status and
evidence in [the canonical improvement plan](../docs/IMPROVEMENTS.md).
Use `PARTIAL` when a CI-only platform check or a larger part of an item remains.
Do not label a passing mock as proof of an actual Windows build or OS notification.
Preserve unrelated local changes; do not discard or stash another contributor's
work. Commit, push, publish and installation are separate operations.

Build targets are `npm run dist:mac`, `npm run dist:win` and `npm run dist:linux`.
Local macOS builds are ad-hoc signed, not notarized. See the Studio README for
platform prerequisites and the repository [security policy](../SECURITY.md).
