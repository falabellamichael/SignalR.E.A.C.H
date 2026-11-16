# Reference provenance

## Automations guide — November 14, 2026

- Inspected the current local `studio/agent/app-connections.cjs`, `studio/agent/mail-connections.cjs`, and `studio/agent/plugins.cjs`: connected mail tools expose reading and sending separately, enforce sending permissions, and report actual tool results. `studio/README.md` documents Settings → App Connections.
- The guide describes an on-demand chat workflow and reusing instructions. It does not claim that a prompt creates a recurring schedule or an unattended job.
- Maple & Co., the client conversation, and the reply are illustrative sample content. The website animation makes no network requests and never reads or sends real email.

## Business homepage pricing — November 14, 2026

- REACH Plus: `studio/agent/hosted-account.cjs`, `studio/renderer/account.js`, and the existing `subscription.html` agree on CAD $25/month, tax included, with unlimited requests on the qualified subscription catalog. Service limits and separately billed provider usage remain applicable.
- [Microsoft's Canadian Copilot pricing](https://www.microsoft.com/en-ca/copilot/pricing/business), checked November 14, 2026: Microsoft 365 Copilot Business add-on is CAD $34.20/user/month on a monthly subscription, plus applicable tax. Its displayed annual offer was CAD $24.43/user/month, paid yearly, plus tax. Both terms appear in the homepage comparison so the lower annual base price is visible.
- The CAD $9.20 monthly and CAD $110.40 annual differences are arithmetic from the monthly prices, before adding Microsoft's tax. This is a price comparison, not a claim of equivalent features or replacement of Microsoft 365 business controls.
- The calculator starts with an explicitly illustrative CAD $60 monthly spend and one REACH Plus subscription: CAD $35/month or CAD $420/year less, approximately 58%. Visitors supply their own replaceable costs and subscription count. No measured productivity improvement, customer result, or guaranteed saving is claimed.

Reference repository: https://github.com/falabellamichael/SignalR.E.A.C.H

Inspected source snapshot: `bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d`, on 29 September 2026.

The repository was read through the connected GitHub integration. The connected desktop was offline. No source files in the original repository were overwritten.

## Visual reference

- `copilot/tray/panel.html`: brand treatment, status-oriented home layout, provider/model controls, compact navigation surfaces.
- `copilot/tray/panel.css`: `#161618` background, `#1f1f24` and `#232329` raised surfaces, `#33333c` border, `#eceade` text, and **`#d4af37` gold**.
- `vscode/media/chat.html`: node-mark concept, provider/model selection, chat composition, and workspace-related controls.
- `src/reach-theme.css`: related theme structure. The website retains the tray's gold identity rather than mixing in the unrelated theme override colors.

Canonical snapshot links:

https://github.com/falabellamichael/SignalR.E.A.C.H/blob/bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d/copilot/tray/panel.html

https://github.com/falabellamichael/SignalR.E.A.C.H/blob/bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d/copilot/tray/panel.css

https://github.com/falabellamichael/SignalR.E.A.C.H/blob/bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d/vscode/media/chat.html

## Product copy

- Root `README.md`: RAG Endpoint & AI Chat Host; Studio, SimpleRAG panel/relay, VS Code extension, desktop tray/bridge; endpoint compatibility and host-managed access.
- `studio/README.md`: source setup, supported desktop platforms, files/editing, conversations, personas, agent teams, connection controls, budgets, optional routing, creator attribution, and credential-storage caveats.
- Existing `panel.html` and `chat.html`: the provider controls reflected in the integration cards and illustrative UI.

https://github.com/falabellamichael/SignalR.E.A.C.H/blob/bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d/README.md

https://github.com/falabellamichael/SignalR.E.A.C.H/blob/bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d/studio/README.md

No adoption statistics, endorsements, testimonials, performance percentages, or guaranteed-free provider access were invented. All demonstrated activity is local sample content. The repository is presented as open source based on its documentation; software licensing does not imply free model inference or hosted service access.
