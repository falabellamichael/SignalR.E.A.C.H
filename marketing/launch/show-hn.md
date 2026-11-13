# Show HN draft (post manually)

**Title:** Show HN: REACH Studio – open-source desktop agent workspace, bring your own keys or local models

**URL:** https://github.com/falabellamichael/SignalR.E.A.C.H

**Text:**

Hi HN, I build SignalREACH. REACH Studio is an Electron desktop app (Windows/macOS/Linux) for working with AI agents on a real project folder.

What it does today:

- Agent teams: create personas (each has a plain-markdown SOUL.md and MEMORY.md you can edit) and dispatch a team for parallel reviews or sequential handoffs. Each member has its own Stop/Start.
- Built-in browser: tabs, bookmarks, find. Agents can browse, search, read rendered pages, and click/type on element references, gated by the conversation's approval setting. Pages run sandboxed without Node or the file bridge.
- Budgets and telemetry: per-agent budget/timeout settings, a live activity view, and a telemetry dashboard (CPU/RAM/GPU on Windows) that can list loaded models from Ollama, LM Studio, or Lemonade.
- Files: conversations bound to project folders, branching, and file edits you review before they're written.
- There's also a VS Code extension with chat and agent tools.

It's BYOK: point it at any OpenAI-compatible endpoint – your own OpenAI, Gemini, or DeepSeek key, or a local Ollama/LM Studio/Lemonade server. I don't proxy or resell model access.

MIT-licensed. There's an optional hosted Subscription Plus and GitHub Sponsors to fund the work. The core stays open.

Feedback I'd love: the team/handoff UX, and what local-model setups you'd want first-class support for.
