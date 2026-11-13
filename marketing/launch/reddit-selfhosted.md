# r/selfhosted draft (verify the sub's current self-promo rules; post manually)

**Title:** REACH – open-source AI agent workspace + self-hostable OpenAI-compatible relay, BYOK or local models

**Body:**

Disclosure: I'm the developer.

Two pieces that may interest this sub:

1. **REACH Studio** (desktop, Win/macOS/Linux): agent teams, a built-in sandboxed browser, budgets, and reviewed file edits. Works with any OpenAI-compatible endpoint – your own OpenAI/Gemini/DeepSeek key or local Ollama/LM Studio/Lemonade.
2. **The relay** (`server/reachd`, stdlib-only Python): an OpenAI-compatible relay you run yourself. Loopback bind by default, API keys with failed-attempt lockout, IP lists, token-bucket rate limits, SQLite request analytics, retry + circuit breaker. There's a Dockerfile (`docker/reachd`).

Nothing is hosted by me in this setup and I don't resell model access – you bring your own keys/models. MIT-licensed.

Repo: https://github.com/falabellamichael/SignalR.E.A.C.H – feedback on the security defaults especially welcome.
