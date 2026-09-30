# SignalREACH website

A six-page, responsive website built from the visual and product references in the existing SignalR.E.A.C.H repository. The homepage is intentionally longer; supporting pages are focused and compact.

## Open it

The ZIP contains this project folder and a sibling `SignalREACH-preview.html`. Open that single HTML file in a browser for the complete six-page offline preview. The preview embeds its own styles, scripts, and pages. It does not need an installation, API key, internet connection, or development server. External documentation links naturally need the internet.

For the normal separate-page version, open `index.html` in this folder. Keep `assets/` beside the six HTML pages. A local server is preferable when testing URLs and clipboard behavior:

```sh
cd SignalREACH-website
npm start
```

Open `http://127.0.0.1:4173`. Press Ctrl+C to stop. Node.js 18 or newer is sufficient for this **website**; there are no npm dependencies and no `npm install` step. The separate **REACH Studio application** has its own prerequisites in the linked upstream documentation.

To choose another port, set the `PORT` environment variable before starting. The preview server deliberately listens on loopback only.

## Pages

| File | Purpose |
| --- | --- |
| `index.html` | Long homepage: animated signal map, workspace preview, feature grid, workflow, code examples, FAQ, and calls to action |
| `platform.html` | Four product surfaces with interactive feature panels |
| `integrations.html` | Search, category filters, and connection-detail dialogs for nine project-related integration options |
| `docs.html` | Six local guide sections, search, and links to upstream documentation |
| `about.html` | Project identity, R.E.A.C.H meaning, design principles, and creator attribution |
| `download.html` | OS-specific source-setup guidance and current GitHub releases link |

## Design and interactions

The original `#D4AF37` gold is retained with the existing charcoal family. Light mode uses warm ivory surfaces and a darker gold for readable text. Colors and spacing are centralized in `assets/styles.css`.

The site includes animated signal paths, floating nodes, scroll reveals, a reading-progress line, tab transitions, a guided tour, a local heuristic chat with 47 topics, 484 keywords and phrases, contextual follow-ups, a searchable topic browser, quick/step-by-step/example response styles, copy/export/reset/stop controls, sample file switching, code-language tabs, copy controls, native dialogs, responsive navigation, and FAQ accordions.

Theme and motion choices are saved in browser local storage when it is available. The operating system's reduced-motion preference takes precedence. A footer control can pause other animation. Tabs support arrow keys, Home, and End; dialogs and the mobile menu support Escape. Content remains visible with JavaScript disabled, but dynamic controls require JavaScript.

## Important scope

This is a working **website frontend**, not a running copy of REACH Studio. The example workspace and chat are explicitly labeled demonstrations. They do not read files, call AI models, provision accounts, store credentials, or activate provider subscriptions. Demo prompts remain in page memory. The package contains no analytics, external fonts, remote scripts, or trackers.

Download buttons link to setup instructions or the upstream releases page. They do not pretend that an unverified installer exists. Product availability, subscriptions, release assets, and provider permissions are controlled by their respective hosts.

This handoff is an editable website package. Opening or building it does not install files on another computer, push a GitHub commit, or publish a live site. The chat upgrade was prepared while the Desktop Commander device was offline.

## Edit the site

- **Visual design:** `assets/styles.css`.
- **Website interactions and dynamic documentation:** `assets/app.js`.
- **Chat topics, keywords, matching, examples, and follow-up rules:** `assets/chat-engine.js`.
- **Chat controls, safe text rendering, cancellation, and transcript export:** `assets/chat-ui.js`.
- **Early theme preferences:** `assets/theme.js`.
- **Page markup, shared navigation/footer, icon definitions, and integration content:** `tools/build.py`.

You can edit the HTML files directly, but running the page generator later will replace those edits. Prefer editing the generator for shared or ongoing changes. `assets/data.js` and `assets/integration-data.json` are generated files.

To regenerate pages and the portable preview, using Python 3.9 or newer:

```sh
python tools/build.py
python tools/standalone.py
```

The preview is written beside the project folder. An optional output path can be supplied to `standalone.py`.

## Build for static hosting

```sh
npm run build
```

Upload the **contents of `dist/`** to a static host. It includes all six HTML files and their shared assets; no server-side routing or single-page-app rewrite is required. Relative links also support hosting under a subdirectory. A ready-built `dist/` is included in this handoff.

Choose your actual domain before adding canonical URLs, a sitemap, domain-specific social metadata, or production analytics. Publishing or configuring a host is not part of this package.

## Verify

```sh
npm test
```

This runs 89 dependency-free source, link, and chat-matching checks. See `QA.md` for completed browser checks and `CHAT-UPGRADE.md` for the chat changes.

Optional browser regression test, after installing Python Playwright and a Chromium browser in your development environment:

```sh
python tests/browser_smoke.py ../SignalREACH-preview.html
python tests/chat_browser.py ../SignalREACH-preview.html
```

Set `CHROMIUM_EXECUTABLE` to your Chromium binary to use an existing installation instead of Playwright's browser cache. The test loads the self-contained preview with `set_content`; it does not need to navigate to an external website.

Reference provenance is recorded in `SOURCES.md`.

## Extend the heuristic chat

Add a topic to `TOPICS` in `assets/chat-engine.js`, with a unique `id`, label, category, keyword phrases, summary, steps, example, related topic IDs, and optional action IDs. Keywords use word-boundary-aware phrase matching; longer, specific phrases and error cases outrank generic terms. Common typos in longer words are handled with bounded edit distance.

Run the matching tests after each catalog change, including the catalog-size expectation. Add regression prompts for ambiguous phrases rather than increasing every keyword’s weight. Link actions must be declared in the engine’s action allowlist. User prompts and reply content must remain text, not executable markup.

The UI keeps at most 24 exchanges in page memory. It clears that history on reset or page teardown, and does not persist prompts to storage. The Export button explicitly creates a local text file. Theme and motion preferences retain their existing local-storage behavior.

Try `conect a modle`, then `tell me more`, then `show an example`. Commands include `/help`, `/topics`, `/steps`, `/example`, `/random`, `/clear`, and `/export`. This remains a heuristic demo, not an open-ended language model.
