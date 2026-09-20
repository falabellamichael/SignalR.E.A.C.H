# Deployed team tabs design QA — September 19, 2026

final result: passed
## Target and scope

User direction: Orbit Deck (#3) architecture and activity rings, Relay Rail (#1)
compactness, useful step metadata, and neutral professional borders.

Source visual truth:
`/Users/macbooka12/.codex/generated_images/01a0bc39-3425-7652-8918-89bd881f542c/exec-5da1402e-dbd2-4267-9e8a-f58a9805f759.png`

This is an integration into the existing Electron app, not a replacement of its
navigation, 960px chat column, typography system, composer, or backend. The shared
review group remains outside the selected member panel so pending team edits
remain accessible on every tab. This is an intentional safety/usability adaptation
of the mock. Model names, steps, elapsed times and statuses come from actual events;
illustrative counts and invented roles in the concept are not production data.

## Evidence and normalization

Final native-renderer evidence directory:
`/var/folders/m3/c4cpqbvj4b52ms8181btf7v80000gn/T/reach-team-deck-ui-mwKzGe/`

- `desktop-dark.png`: five members, Seeker selected, two working, one awaiting
  review, one completed, one queued; activity expanded, three pending files.
- `desktop-review.png`: same selection, README diff expanded, activity collapsed.
- `desktop-dark-deck.png`, `desktop-review-deck.png`: focused native captures.
- `narrow-light.png`, `narrow-dark.png`: minimum window with six members.
- `finished.png`: final outcomes remain inspectable after the active run ends.

Source raster: 1487×1058. Desktop CSS viewport: 1440×1024, native screenshot
2880×2048 at macOS compositor density 2. Minimum CSS viewport: 1000×640,
native screenshot 2000×1280. Compare the implementation at half its raster
dimensions and align corresponding chat regions rather than the concept's
invented outer navigation. The native capture rectangle is in CSS coordinates.
The source and rendered captures were opened together in the same comparison
input, including a full-window pair and a focused deck comparison. This was a
paired-image review, not a claim of pixel-identical full-window composition.

In-app Browser tooling was unavailable after discovery. These are native
Electron/Chromium captures from the real app renderer and isolated preload/IPC,
using the repository's existing native integration-test approach, not a web mock.

## Findings and comparison history

- [P2, resolved] Initial 180px activity viewport crowded out review controls.
  Evidence: `reach-team-deck-ui-qlZiqO/desktop-dark.png` in the same temporary
  parent. Reduced it to 96px, preserving every step/result in its scrollable
  disclosure. Post-fix: `reach-team-deck-ui-W8gd6g/desktop-review.png` and final
  focused deck capture.
- [P2, resolved] Review summary and toolbar retained gold-heavy outlines and
  excess padding. Scoped neutral structural borders and tighter spacing to team
  reviews; removed a redundant eyebrow. Post-fix captures show neutral selected,
  waiting and completed panels, with semantic color only on small indicators
  and diff text.
- No remaining actionable P0/P1/P2 visual findings. Scrolling long histories and
  expanded reviews is intentional; the composer stays visible at both sizes.
  The existing app shell takes more vertical space than the concept's invented
  shell, so the entire expanded batch is not expected above the fold.

## Required fidelity surfaces

- Fonts/typography: existing system sans for team tabs, 12px member names,
  10px model metadata, 10.5px action labels and 14px selected-member heading.
  This intentionally scales the mock down for #1's compactness. Long labels
  truncate in the rail with full accessible names/tooltips; panel metadata wraps.
- Spacing/layout: 230×82px hanging tabs (214px wide at smaller windows), lower
  corner rounding, one full-width selected panel. Horizontal overflow has
  arrows, wheel/trackpad scrolling, and roving keyboard focus. Tabs remain
  attached to a neutral top rule; status does not move or resize the layout.
- Colors/tokens: graphite outlines and neutral selected surface. Small sage,
  amber and error icons carry semantic state; words and icon shapes ensure
  status does not depend on color alone. Light theme retains the app palette.
- Assets: locally packaged, unmodified Phosphor 2.1.1 regular SVG icons with MIT
  license. Rings are actual library icons; initials are editable name metadata.
  No decorative raster asset is required in this control-only design. No fake
  waveform or percentage is substituted for real progress.
- Copy/content: model, action, step, round, elapsed time, transcript, tools,
  expanded results, review decisions and controls remain available. Background
  questions show “Answer needed” without stealing focus or discarding a draft.
  Source mock's illustrative Share/menu/role labels are intentionally omitted.

## Verification

- `npm run test:teams-ui`: passed. Single visible panel, actual event-derived
  statuses/steps, click/keyboard tabs, scroll arrows/wheel, background questions,
  draft preservation, pause/resume, detached conversation restoration, spawned
  workers, literal untrusted metadata, both themes, minimum window, reduced
  motion, bulk review, and terminal outcomes. Zero renderer console errors.
- `npm run smoke`: passed, including real local fixture teams, individual/team
  Stop/Resume, spawned workers, links mode, native tools, reviews and saved answers.
- `npm run check` and `git diff --check`: passed.
- Full `npm test`: 414 passed, 5 failed in existing audit-log/rotation tests.
  Those backend files were already modified outside this task and were not
  changed for the redesign. This is a repository-wide test limitation, not a
  passing full-suite claim.

## Implementation checklist

- [x] Neutral medium tabs and full-width member panel.
- [x] Real status rings, step metadata and reduced-motion behavior.
- [x] Shared batch approvals and individual controls retained.
- [x] Native functional verification and post-fix visual comparison.
- [x] Earlier workspace QA preserved below.
- [ ] Rebuild/reinstall the user's installed app separately; it was not replaced.

## Follow-up polish

P3 only: the compact tab action can expose a raw tool name such as
`agent.await`; a future shared tool-label dictionary could make these friendlier.
This does not obscure status or results.

---

# Agents workspace design QA

final result: passed

## Compact composer follow-up

The user's one-line/two-line request replaces the earlier tall composer. The
message input now shares one row with the model picker and Send/Stop. It starts at
25px, grows to 45px for two lines, and reveals a native vertical corner grip only
when the draft needs more space. Manual expansion survives further typing;
shortening the draft returns it to automatic sizing. Browser context insertion
and suggested replies trigger the same sizing path without submitting the draft.

Verified with `npm run test:workspace`: single line, explicit newlines, wrapped
long text, two-line cap, resize availability, retained manual height, collapse on
deletion/clearing, both themes and minimum window geometry. Syntax check passed.
Evidence: `C:/Users/Falab/AppData/Local/Temp/reach-workspace-ui-haLYvb/`, including
`composer-one-line.png`, `composer-two-lines.png`, `composer-expanded.png`, and
`overview-light-1000.png`. The compact composer is 97px high at the desktop test
viewport. A scrollbar width change initially reset manual height; measuring the
outer input width fixed it and the regression now passes. No remaining P0/P1/P2
layout issues were found in the rendered captures.

## Scope and visual evidence

The three approved concepts are implemented as Overview, Activity, and Models &
Memory, selected by the dropdown beside Telemetry. This adapts their content
layouts to the existing 960px conversation column, header, sidebar, and two themes.
It is not a replacement of the app's established navigation or brand assets.

Source visual truth: generated concepts under
`C:/Users/Falab/.codex/generated_images/01a0990d-3178-7e02-8d6a-f1e334c66ba2/`:

- Overview: `exec-a7a84830-08ca-4691-8a15-9b403af95e34.png`
- Activity: `exec-49a5c717-7a37-4f5d-aebb-eeeb06b487a2.png`
- Models & Memory: `exec-22aceee0-cbff-47b0-9aae-3e169bae4293.png`

Final implementation screenshots and geometry:
`C:/Users/Falab/AppData/Local/Temp/reach-workspace-ui-ldyvuB/`:
`{overview,activity,models}-{dark,light}-{1440,1000}.png` and `results.json`.
These are native Chromium-rendered captures from the real Electron renderer,
preload and IPC in an isolated temporary profile. Model rows carry an explicit
preview-data label; production measurements were checked separately through IPC.

Source images are 1488x1056; implementation captures are 1440x1024 and 1000x640,
matching their CSS viewports with scale factor 1. Comparisons use corresponding
content regions and proportional scaling rather than claiming pixel identity
between differently sized frames. The fixed-width conversation column and retained
conversation header intentionally occupy different proportions than the concepts.
An earlier in-app Browser capture had Windows DPI/compositor scaling problems;
those raw captures were excluded from visual judgments. Browser interactions and
console checks were still performed on the actual renderer with a disposable bridge.

## Findings and comparison history

- P2, resolved: composer switches initially used solid status pills. The reference
  used recognizable switches. Added a moving thumb, with distinct on/off position,
  visible keyboard focus, and accessible switch state. Final composer bands were
  inspected at full resolution in both themes.
- P2, resolved: initial vertical spacing pushed too much dashboard information
  below the composer. Removed the empty status row, reduced dashboard gaps, and
  shortened the empty-chat input while preserving the message composer. Compacted
  the Models & Memory hardware column so all four readings fit at desktop height.
- P2, resolved: switching from Models & Memory back to Overview could leave the
  metric row below the tables. Corrected DOM ordering and reset dashboard scroll
  when selecting a view. Added a native regression assertion across repeated
  switches, both themes, and both window sizes.

Initial evidence: `reach-workspace-ui-iYxprW` and `reach-workspace-ui-OFbSqF` in the
same temporary parent. Intermediate spacing evidence: `reach-workspace-ui-CIynlD`.
Final paired comparison: approved Models & Memory concept and
`reach-workspace-ui-ldyvuB/models-dark-1440.png`; Overview/Activity checked against
their corresponding concept captures, with final view-order geometry assertions.
The composer, table rows, metric labels, and small-window footer were inspected
as focused regions in the full-resolution captures; no cropped asset substitution
was used.

## Required fidelity surfaces

- Typography: retained Georgia display headings and the app's sans-serif controls.
  Metric values, headings, table labels and footnotes have a consistent hierarchy.
  Smaller type than the concepts supports the requested 960px page width. Long
  hardware names retain full text in tooltips; model names wrap within the table.
- Spacing: four columns in Overview, a prominent history plot in Activity, and a
  hardware column beside models/processes in Models & Memory. At minimum window
  size the dashboard scrolls while composer, Send and view selector stay visible.
  Footer tool controls remain horizontally scrollable when needed.
- Colors: uses existing dark gold/charcoal and warm light theme tokens. Transparent
  proximity scrollbar remains intact. Switch state has position as well as color.
- Images/assets: retained existing app branding. Concepts contained no new required
  photographic asset. Canvas plots render measured data; no fabricated decorative
  history is inserted. Short chart lines on startup are intentional until samples
  accumulate. Native buttons, tables and switches remain functional controls.
- Copy: provider-loaded state is distinguished from downloaded model files and
  process working sets. Unavailable readings are explicit. Remote model residency
  is labeled separately; memory numbers are not fabricated from model disk size.

## Verification

- Full unit/regression command `npm test`: passed, including ten new policy and
  telemetry tests. Syntax check passed.
- `npm run test:workspace`: passed through actual Electron preload/IPC, including
  rejected invalid settings, tool changes, Clear Chat, preserved settings and
  independent branches, native modal focus, real hardware sampling, three views,
  both themes, and minimum-size layout. Twelve screenshots; zero renderer errors.
- Browser: view selection, Tools search/save, Terminal switch, Permissions save,
  conversation start hiding telemetry, confirmed Clear Chat restoring it, light
  theme, and console checks passed in a disposable conversation.
- Windows live readings returned Ryzen 9 5900X, physical RAM, Radeon RX 6750 XT
  utilization and full 12GB capacity, and 30 process rows. Provider inventory was
  read without generating prompts or loading models.

No actionable P0/P1/P2 findings remain. Expected limits: minimum-height windows
require scrolling the dashboard; model-memory availability depends on the provider;
non-Windows GPU/network/disk counters are explicitly unavailable. macOS native
hardware behavior was not exercised on this Windows machine.

---

# Model information disclosure design QA

**Source visual truth**

- `C:\Users\Falab\AppData\Local\Temp\codex-clipboard-9dd7b0d0-97c5-4055-9f26-4e25fcc15250.png`
- Source pixels: 1661 × 792 PNG.

**Rendered implementation evidence**

- Teams expanded: `C:\Users\Falab\AppData\Local\Temp\qa-model-info-team.png`
- Teams collapsed: `C:\Users\Falab\AppData\Local\Temp\qa-model-info-team-collapsed.png`
- Teams scrolled 504px with header pinned: `C:\Users\Falab\AppData\Local\Temp\qa-model-info-team-scrolled.png`
- Regular chat expanded: `C:\Users\Falab\AppData\Local\Temp\qa-model-info-regular.png`
- Regular chat collapsed: `C:\Users\Falab\AppData\Local\Temp\qa-model-info-regular-collapsed.png`
- Source/Teams composite: `C:\Users\Falab\AppData\Local\Temp\qa-model-info-comparison.png`
- Implementation pixels: 1661 × 792 for every capture. Browser CSS viewport: 1661 × 792. Device scale factor: 1. No density normalization was required.
- State: dark theme; populated regular conversation; active four-member Links team; expanded, collapsed, selected-member-change, and scrolled states.

**Findings**

- No actionable P0, P1, or P2 difference remains for the requested model-information behavior.
- The source hierarchy is retained: team identity/counts, member rail, selected model identity, live state, timing, and control remain above member output.
- The intentional difference is the new disclosure summary above the expanded information. It gives both regular chat and Teams the requested compact dropdown state without removing any information.

**Required fidelity surfaces**

- Fonts and typography: existing REACH font stack, weights, truncation, and small metadata hierarchy are preserved. Long model names truncate in the compact summary and remain readable in the expanded row.
- Spacing and layout rhythm: the new 40–42px summary rows align with the existing compact controls; expanded details retain the existing 8–14px spacing scale. No horizontal viewport overflow was visible at the reference width.
- Colors and visual tokens: the disclosure uses the existing surface, card, line, text, dim, gold, success, and error tokens. No parallel palette was introduced.
- Image and icon fidelity: no raster assets were added. Both disclosures reuse the existing Phosphor caret-right asset and rotate it for expanded state.
- Copy and content: agent/team names, full model names, current state, round/timing metadata, context information, and Stop/Start controls remain present. The compact summaries provide the same information at a glance.

**Interaction and accessibility evidence**

- Native `details`/`summary` semantics expose expanded and collapsed state to keyboard and assistive technology.
- Regular chat: collapsing hid the expanded content while the retained DOM still contained `Research Agent`; scrolling the conversation from 0 to 330.29px left the disclosure top unchanged at 46.29px.
- Teams: collapsing hid the expanded selected-member row; selecting Seeker updated the summary and expanded row to `Seeker`, `deepseek-flash`, `Waiting for an update`, `Round 2 · 3m 35s`, and `Stop`.
- Teams: scrolling team activity from 0 to 504px left the sticky header top unchanged at 46.29px.
- Browser console: zero warnings or errors in the QA fixture.
- At the app's 1000 × 640 minimum test viewport, neither surface overflowed horizontally; the team Stop/Start control and regular Send control both remained inside the viewport.

**Full-view comparison evidence**

- The 3322 × 792 side-by-side composite compares the 1661 × 792 source and implementation at equal size. The existing dark visual language, team hierarchy, member cards, state treatment, and selected-model information remain consistent. The new summary/expanded split is an intentional functional addition.

**Focused region comparison evidence**

- Separate expanded, collapsed, and scrolled captures were required because disclosure state and stickiness cannot be judged from one still image. These focused states verify the selected-model area rather than relying only on the full-view composite.

**Comparison history**

- Initial behavior capture placed the artificial scroll filler after the team component, which tested scrolling beyond the component rather than scrolling its activity. The QA fixture was corrected so the filler represents team-run content. The post-fix capture and geometry check show the header pinned during a 504px team-content scroll. This was a test-fixture alignment correction, not a production UI defect.
- No production P0/P1/P2 visual finding required a second implementation iteration.

**Implementation checklist**

- [x] Regular-agent model/run information is a native dropdown.
- [x] Regular conversation scrolls independently beneath stationary information.
- [x] Teams selected-member information is a native dropdown inside the sticky team header.
- [x] Team member selection keeps the pinned information synchronized.
- [x] Stop/Start control state is mirrored into the visible pinned information.
- [x] Expanded information remains in the DOM when collapsed.
- [x] Reference-width expanded, collapsed, selection, scroll, and console checks completed.
- [x] Minimum-viewport overflow and persistent-control checks completed.

**Follow-up polish**

- No P3 follow-up is required for this scoped change.

final result: passed
