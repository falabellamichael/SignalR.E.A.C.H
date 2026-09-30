# Homepage heuristic chat upgrade

## Scope

Prepared from the supplied SignalREACH website. The original `assets/app.js` matched the GitHub `main` blob `4f05d6040299e04c5094379a53646e1586cece50` when checked. Desktop Commander reported the connected PC offline, so this package does not represent a local-PC edit or a GitHub push.

## Added

- 47 curated topics and 484 keywords/phrases across setup, connections, workspace, building, troubleshooting, and exploration.
- Contiguous phrase matching, bounded typo tolerance, specific error handling, and an honest fallback for unsupported questions.
- Context for “tell me more”, “show an example”, “shorter”, “yes”, and “what next”.
- Topic browser with category filters, keyword search, and useful empty states.
- Quick, step-by-step, and example responses; contextual suggestions and local preview actions.
- Reply copying, local transcript export, reset, typing cancellation, slash commands, and keyboard controls.
- Guarded submissions, IME handling, safe text rendering, bounded history, and cleanup when changing pages.
- Matching light/dark styling and reduced-motion behavior.

## Files

The engine and UI are separate, dependency-free scripts: `assets/chat-engine.js` and `assets/chat-ui.js`. The homepage markup generator, lifecycle hookup in `assets/app.js`, styles, standalone bundler, tests, and built `dist/` are updated. Other pages retain their design.

## Run

```sh
cd SignalREACH-website
npm test
npm start
```

Open `http://127.0.0.1:4173`. Alternatively open the sibling `SignalREACH-preview.html` directly for an offline six-page preview.

## Apply the accompanying patch safely

The patch is relative to the repository root and affects only `SignalREACH-website/`. Review existing changes first. Do not replace a newer local project blindly.

```sh
git status
git apply --check /path/to/SignalREACH-chat-upgrade.patch
git apply /path/to/SignalREACH-chat-upgrade.patch
cd SignalREACH-website
npm test
```

If the check reports conflicts, stop and merge the affected files rather than forcing the patch. Applying the patch does not commit or push.

## Limits

This is a local website guide. It does not read computer files, discover installed models, execute commands, call a model, collect credentials, or publish code. Prepared examples are illustrative. Live product setup and provider policies remain separate.
