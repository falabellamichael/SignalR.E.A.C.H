# r/LocalLLaMA draft (check sub rules on self-promo first; post manually)

**Title:** I built an open-source desktop agent workspace that works with Ollama / LM Studio / Lemonade (agent teams + built-in browser)

**Body:**

Disclosure: I'm the developer.

REACH Studio is an MIT-licensed Electron app for running agent teams against a project folder. It talks to any OpenAI-compatible endpoint, so local servers work the same as cloud keys.

Local-relevant bits:
- Point Settings → Connection at your Ollama / LM Studio / Lemonade OpenAI-compatible URL.
- Telemetry dashboard can register up to eight Ollama, LM Studio, or Lemonade servers and lists the models they report as loaded (read-only – it doesn't load models or send prompts). On Windows it also shows GPU engine use and dedicated/shared VRAM.
- Per-agent budget and timeout settings (including no timeout for slow local runs).
- Teams: parallel reviews or sequential handoffs; each member can be stopped/resumed.
- Agents can use a sandboxed built-in browser, with your approval setting.

Small local models struggle with long multi-agent handoffs – I'd genuinely like to know which models you find reliable for tool calls.

Repo: https://github.com/falabellamichael/SignalR.E.A.C.H
