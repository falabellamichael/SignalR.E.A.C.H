# SignalREACH website

A six-page, responsive website built from the visual and product references in the existing SignalR.E.A.C.H repository. The homepage is intentionally longer; supporting pages are focused and compact.

## Open it

Open `SignalREACH-preview.html` in a browser for the complete six-page offline preview. The preview embeds its own styles, scripts, and pages. It does not need an installation, API key, internet connection, or development server. External documentation links naturally need the internet.

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

The site includes animated signal paths, floating nodes, scroll reveals, a reading-progress line, tab transitions, a guided tour, a scripted streaming-style chat demonstration, sample file switching, code-language tabs, copy controls, native dialogs, responsive navigation, and FAQ accordions.

Theme and motion choices are saved in browser local storage when it is available. The operating system's reduced-motion preference takes precedence. A footer control can pause other animation. Tabs support arrow keys, Home, and End; dialogs and the mobile menu support Escape. Content remains visible with JavaScript disabled, but dynamic controls require JavaScript.

## Important scope

This is a working **website frontend**, not a running copy of REACH Studio. The example workspace and chat are explicitly labeled demonstrations. They do not read files, call AI models, provision accounts, store credentials, or activate provider subscriptions. Demo prompts remain in page memory. The package contains no analytics, external fonts, remote scripts, or trackers.

Download buttons link to setup instructions or the upstream releases page. They do not pretend that an unverified installer exists. Product availability, subscriptions, release assets, and provider permissions are controlled by their respective hosts.

The website source is kept separate from the REACH Studio application. The GitHub Pages workflow publishes the static frontend after Pages is enabled for this repository.

## Edit the site

- **Visual design:** `assets/styles.css`.
- **Interactions and dynamic documentation:** `assets/app.js`.
- **Early theme preferences:** `assets/theme.js`.
- **Page markup, shared navigation/footer, icon definitions, and integration content:** `tools/build.py`.

You can edit the HTML files directly, but running the page generator later will replace those edits. Prefer editing the generator for shared or ongoing changes. `assets/data.js` and `assets/integration-data.json` are generated files.

To regenerate pages and the portable preview, using Python 3.9 or newer:

```sh
python tools/build.py
python tools/standalone.py SignalREACH-preview.html
```

The preview is written to the path supplied to `standalone.py`.

## Build for static hosting

```sh
npm run build
```

Upload the **contents of `dist/`** to a static host. It includes all six HTML files and their shared assets; no server-side routing or single-page-app rewrite is required. Relative links also support hosting under a subdirectory. A ready-built `dist/` is included in this handoff.

The repository workflow at `.github/workflows/signalreach-pages.yml` rebuilds and publishes this `dist/` folder from the approved `gh-pages` branch. To publish website changes from `main`, merge those changes into `gh-pages`. The default GitHub Pages URL is <https://falabellamichael.github.io/SignalR.E.A.C.H/>. For the first deployment, open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**. No custom domain is required.

Choose a custom domain before adding canonical URLs, a sitemap, or domain-specific social metadata.

## Verify

```sh
npm test
```

This runs the dependency-free source and link checks. See `QA.md` for the completed browser checks.

Optional browser regression test, after installing Python Playwright and a Chromium browser in your development environment:

```sh
python tests/browser_smoke.py SignalREACH-preview.html
```

Set `CHROMIUM_EXECUTABLE` to your Chromium binary to use an existing installation instead of Playwright's browser cache. The test loads the self-contained preview with `set_content`; it does not need to navigate to an external website.

Reference provenance is recorded in `SOURCES.md`.
