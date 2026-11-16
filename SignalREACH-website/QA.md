# SignalREACH chat-upgrade verification

Executed against the final generated website package.

| Suite | Result | Evidence |
| --- | --- | --- |
| Node source, link, and intent tests | 89 passed; 0 failed | `tests/last-source-results.txt` |
| Existing six-page browser regressions | 55 passed | `tests/last-browser-results.json` |
| Homepage chat browser regressions | 141 passed | `tests/last-chat-browser-results.json` |
| Node-server asset delivery and source/dist parity | 7 passed | `tests/last-packaging-results.json` |

The chat suite checks all 47 topic buttons, keyword search, category filters, error-specific matches, typo tolerance, contextual follow-ups, response styles, escaped HTML-like input, copying, transcript export, slash commands, empty states, cancellation, reset while typing, rapid submissions, IME input, history limits, route teardown, and guide navigation.

The layout matrix includes light and dark themes at 320, 390, 768, 1024, and 1440 pixels, with conversation, topics, and example views open. There was no horizontal page overflow in these checks. The offline preview recorded no outgoing requests and no browser JavaScript errors. The included Node server also returned the expected source and dist HTML/JavaScript bytes in HTTP checks. Browser navigation to the local HTTP server was blocked by the managed environment (ERR_BLOCKED_BY_ADMINISTRATOR), so live HTTP browsing, file-URL browsing, and preference persistence after an HTTP reload were not verified here. Browser interaction tests used the self-contained preview loaded directly into the test page.

## Run again

```sh
npm test
npm run build
python tools/standalone.py
python tests/browser_smoke.py ../SignalREACH-preview.html
python tests/chat_browser.py ../SignalREACH-preview.html
```

Browser tests require Python Playwright and Chromium. Set `CHROMIUM_EXECUTABLE` to an existing Chromium binary as needed. No browser dependency is required to run the website or Node tests.

## Scope and limitations

These tests verify the website demo, not a live AI connection, the actual Studio application, or a production host. Screenshots were inspected for the chat layout. This is not a formal accessibility certification or a full audit of all upstream product claims. The PC was offline in Desktop Commander during preparation; the package has not been applied to that PC or pushed to GitHub by this task.

## Business homepage and integration views — November 14, 2026

- Preserved the existing homepage hero, product strip, and interactive demo markup exactly. Kept the five-card benefits layout, with business-facing copy.
- Confirmed the original integration directory markup is unchanged and the technical setup workflow and code examples moved intact to the developer overview.
- Website suite: 141 tests passed. Static deployment build completed with `npm run build`.
- Chromium browser verification: calculator default example, multiple subscriptions, lower/equal/higher costs, zero spend, blank/negative/out-of-range inputs, and fractional subscription counts; view toggles, arrow-key navigation, URL reload, browser history, search, filters, empty results, filter reset, retained filter state, and details dialogs all passed.
- Homepage and both integration views had no page-level horizontal overflow at 320, 390, 768, 1024, and 1440 pixels. Fixed the existing navigation overflow at tablet and narrow-phone widths.
- Reviewed light and dark screenshots, mobile navigation, and content visibility without JavaScript. No browser JavaScript exceptions were recorded. Both integration views are readable without JavaScript; the calculator retains a labeled static example.
- Validation used the local preview and source files. No live hosted AI requests, payment transactions, or production deployment were performed.

## Automations documentation — November 14, 2026

- Docs opens on Automations, first in the sidebar above Quick start. The original Quick start article is preserved in a template, and all six existing guides remain accessible.
- Browser checks passed for timed playback, Pause, manual steps, the review stop, simulated approval, Replay, the global motion toggle, system reduced motion, guide search, copy prompt, navigation away during playback, and browser Back/Forward.
- Fixed the walkthrough's state-attribute collision with the existing workflow click handler. No new browser warnings or errors appeared during the final interaction checks.
- Reviewed dark and light layouts. No horizontal overflow at rendered viewport widths of 320, 390, 768, 1025, and 1440 pixels. Tightened the shared phone header spacing to accommodate the browser's scrollbar and zoom.
- All 141 website tests passed, including syntax validation for the new animation module. The static hosting build completed. The cPanel archive is checked for integrity, local links, complete build parity, and HTTP preview parity for Docs and its animation script as well as the homepage and integrations.
- The example is local sample content. It does not access accounts, read mail, send mail, or create a recurring job. This verifies the documentation website, not a live Studio email workflow.
