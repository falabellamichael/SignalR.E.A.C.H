# Lead finder

Goal: find people *already asking* for this, and help them. Never DM unsolicited; reply publicly where self-promo is allowed. Always disclose you're the developer. Max a few replies/day; skip threads where a simpler answer fits.

## Search queries

Google / Reddit / HN (use `site:reddit.com`, `site:news.ycombinator.com`):
- "local" "agent team" desktop app
- multi-agent GUI ollama
- "alternative to" (Cursor OR Devin OR "Claude Code") local models
- LM Studio agents tool calling app
- "bring your own key" AI workspace
- BYOK coding agent desktop
- crewai OR autogen GUI desktop
- "AI agent" "built-in browser" app
- "self-hosted" "openai compatible" relay rate limit
- Lemonade server AMD agents

HN: https://hn.algolia.com — "multi-agent", "local LLM IDE", "BYOK".
GitHub Discussions/Issues: "GUI" requests in Ollama, LM Studio, Open WebUI, CrewAI repos (reply only if on-topic).

## Subreddits
r/LocalLLaMA, r/ollama, r/LMStudio, r/selfhosted, r/LocalLLM, r/AI_Agents, r/ChatGPTCoding, r/vscode, r/opensource, r/SideProject, r/AMDHelp (Lemonade/NPU threads only)

## Keywords to monitor (e.g. F5Bot, free)
"agent team", "multi-agent desktop", "BYOK", "local AI workspace", "ollama GUI agents", "openai compatible endpoint desktop", "SignalREACH", "REACH Studio"

## Reply templates

**1 – "Is there a desktop app for multi-agent with local models?"**
> Disclosure: I'm the dev of one, so weigh accordingly. REACH Studio (MIT) lets you define personas and run them as a team (parallel or handoff) against any OpenAI-compatible endpoint, so Ollama/LM Studio work. Other options worth a look: [name 1–2 genuine alternatives]. Repo if useful: <link>

**2 – "I don't want to pay another subscription, I already have an API key"**
> Same frustration here, which is why I made mine BYOK (disclosure: I built it). REACH Studio uses your OpenAI/Gemini/DeepSeek key directly or a local model, nothing is resold. Budget settings help keep spend bounded. <link>

**3 – "My small local model breaks on tool calls / agents"**
> [Actual advice first: lower temperature, shorter context, model X/Y handle tool calls better, one agent per task.] FWIW I hit this building REACH Studio (I'm the dev) and per-agent budgets/timeouts plus sequential handoffs helped more than parallel teams on small models.

**4 – "Want agents that can browse the web safely"**
> If you're OK with a desktop app: REACH Studio (my project, disclosure) has a built-in browser where agents read/click/type only under your approval setting, and pages are sandboxed from your files and agent bridge. Password/file inputs aren't exposed to agents. <link>

**5 – "Self-hosting an OpenAI-compatible gateway"**
> [Mention LiteLLM etc. if more suitable.] I maintain a small stdlib-only Python relay as part of SignalREACH (disclosure: mine): loopback by default, API keys with lockout, rate limits, SQLite analytics, Docker image. Use your own upstream keys. <link>
