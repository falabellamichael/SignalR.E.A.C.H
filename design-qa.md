# Agents workspace design QA

final result: passed

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
