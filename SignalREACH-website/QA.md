# Website QA — 29 September 2026

## Completed

**7 automated static checks passed** with Node.js 22.16.0: page structure, one H1 per page, descriptions, unique IDs, local page/asset targets, safe external-link attributes, brand tokens, reduced-motion CSS, script syntax, and prompt-as-text handling.

**55 browser checks passed** in headless Chromium through Python Playwright. The exact result list and layout measurements are in `tests/last-browser-results.json`.

Covered:

- Light/dark switching, one correct theme icon, and theme retained across preview routes.
- Workspace sample files, agent preview, keyboard tab navigation, and scripted chat output.
- Untrusted prompt markup rendered literally rather than interpreted as HTML.
- Workflow panels, three code-language views, clipboard feedback, guided tour, dialogs, and Escape behavior.
- All four platform views, all nine integration cards, filters, search, empty state, reset, and detail dialog.
- Six documentation sections and documentation search.
- Three operating-system setup tabs.
- Mobile menu open/close, Escape, and route navigation.
- Every page checked at **320, 390, 768, 1024, and 1440 CSS pixels**; no document-level horizontal overflow.
- System reduced-motion behavior.
- No JavaScript page errors and no outgoing network requests during the offline interaction suite.

Separate motion-on testing confirmed that signal paths animate and that the footer motion control stops and resumes CSS animation. Full-page screenshots were rendered for all six pages; the homepage was also rendered in both themes and at mobile size. The theme icon and narrow-screen code-grid overflow found during QA were corrected before the final run.

## Scope and limitations

Browser interaction tests loaded the self-contained preview using Playwright `set_content`. Navigation to file and localhost URLs is restricted in this execution environment, so this was not a network-served, cross-browser end-to-end test. The normal multi-file site shares the same HTML, CSS, and core interaction script; its file paths were checked separately.

Clipboard success depends on browser permissions and context; the site provides a selection/manual-copy fallback. The test verified the feedback path, not every platform's native clipboard permissions.

Preference retention was verified across routes. Browser local-storage persistence code includes graceful failure handling, but long-term storage across separate browser sessions was not exercised in the restricted preview origin.

No live AI endpoint, production deployment, external account, installer download, provider availability, or upstream release artifact was tested. The work does not constitute a full accessibility audit or broad cross-browser certification.
