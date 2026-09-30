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
