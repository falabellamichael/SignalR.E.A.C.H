# SimpleREACH

**REACH** = **R**AG **E**ndpoint & **A**I **C**hat **H**ost

A plugin for SimpleRAG — installable straight from this GitHub URL — that adds a hosted OpenAI-compatible endpoint with **unlimited gpt-4o for everyone**. No API key, no quotas, no signup. Requests are relayed through a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) instance's `codegpt` provider.

The plugin installs a full **control panel** into SimpleRAG's app bar — a menu panel with seven pages: **Dashboard, Endpoint, Models, Usage, Logs, Settings, About** — plus a dependency-free relay server, hosting tunnel, and a pointer URL that always resolves the live endpoint.

| | |
|---|---|
| **Endpoint pointer (always current URL)** | <https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt> |
| **Models** | `gpt-4o`, `gpt-4o-mini` (aliases → `codegpt/codegpt-gpt-4o[-mini]`, configurable) |
| **Auth** | none by default (optional shared access key) |
| **Streaming** | SSE, OpenAI wire format |
| **Version** | 2.0.0 |

## Use the endpoint

```bash
curl "$(curl -s https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt)/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="<URL from the pointer above>/v1", api_key="not-needed")
reply = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)
```

**In SimpleRAG:** open the REACH page → **Endpoint** → hit **Add to SimpleRAG** (one click), or do it manually: Endpoint settings → OpenAI-compatible → Base URL `<URL>/v1`, model `gpt-4o`, API key blank.

> The public URL is a tunnel that changes when the host restarts it — always resolve it through the pointer gist above (the REACH panel and README do this automatically).

## Install the plugin (from the GitHub URL)

```bash
git clone https://github.com/falabellamichael/SimpleREACH.git
cd SimpleREACH
python tools/reach.py install
```

`install` does everything:

1. **Plugin panel** — installs the REACH control panel into SimpleRAG's app bar via the *local-extension registry* (`%LOCALAPPDATA%\RAGWorkspace\extensions\`). **Zero SimpleRAG files are modified**; uninstall removes just the registry entry. Old plugin versions of SimpleREACH are pruned on upgrade.
2. **Relay server v2** — copies a dependency-free relay to `%LOCALAPPDATA%\SimpleREACH\` and auto-detects the OmniRoute API key from `~/.omniroute/storage.sqlite` (stored only in local `config.json` — never committed, never exposed). `install` restarts the relay so new server versions load immediately.
3. **Hosting** — starts the relay on `127.0.0.1:20777` and opens an **ngrok** tunnel (`--tunnel cloudflared` uses the cloudflared binary OmniRoute ships, no account needed). The public URL is published to the endpoint-pointer gist.
4. **Control panel** — open SimpleRAG → Advanced → **REACH** for the full menu panel.

## The panel

| Page | What it does |
|---|---|
| **Dashboard** | Live health: requests/tokens/errors today, avg + p95 latency, public URL, relay + upstream status, circuit state, quick actions (publish, clear log, refresh) |
| **Endpoint** | Base URL, one-click **Add to SimpleRAG**, route table, curl/Python/JS/SimpleRAG snippets (auto-filled with the live URL) |
| **Models** | Alias table (public → upstream), enable/disable toggles, add/remove aliases — applied instantly |
| **Usage** | 24h request + token charts, by-model breakdown, top clients, error rate — auto-refreshes |
| **Logs** | Recent request log (IP, model, status, latency, tokens, error), filters, clear |
| **Settings** | Relay (port, host, upstream, key), tunnel + publishing, rate limits (per-IP RPM, daily tokens, global RPM, burst), optional access key, data retention |
| **About** | Backronym, architecture, facts, privacy notes |

## CLI

```bash
python tools/reach.py install [--no-start] [--no-restart] [--tunnel ngrok|cloudflared|none]
python tools/reach.py status                 # relay + tunnel + public URL
python tools/reach.py start|stop|restart     # manage relay + tunnel
python tools/reach.py publish                # push current URL to the pointer gist
python tools/reach.py register-autostart     # logon/startup: relay + tunnel + publish
python tools/reach.py settings [key [value]] # read/update relay settings live
python tools/reach.py models list|add|remove # manage model aliases live
python tools/reach.py stats [-v]             # today's usage + breakdowns
python tools/reach.py logs [--limit N] [--status 4*] [--model gpt-4o]
python tools/reach.py test                   # live upstream completion test
python tools/reach.py update                 # git pull + reinstall (upgrade path)
python tools/reach.py uninstall --all        # remove panel + stop everything
```

## Architecture

```
any OpenAI client ──► https://<tunnel>/v1  (public · no auth · CORS *)
                          │
                 reachd.py  (127.0.0.1:20777, stdlib-only relay)
                          │  injects OmniRoute key server-side
                          │  alias → codegpt/codegpt-gpt-4o pinning
                          │  token-bucket rate limits (per-IP + global + daily)
                          │  optional shared access key
                          │  SQLite analytics (requests, tokens, latency)
                          │  upstream retry + circuit breaker + concurrency cap
                          ▼
             OmniRoute http://127.0.0.1:20128/v1
                          ▼
              codegpt free tier (gpt-4o)
```

- The relay binds **loopback only**; the tunnel exposes just the keyless relay surface. OmniRoute's dashboard and API keys are never reachable from outside, and the relay's admin API (`/_reach/*`) refuses non-loopback clients even if the bind host is widened.
- `/v1/models` serves exactly the enabled aliases; anything else returns `model_not_found`.
- Rate limiting protects the free upstream: per-IP requests/minute + daily token budget, a global cap, and burst headroom (all tunable in Settings).
- Requests are logged locally (IP, model, tokens, latency) for the Usage/Logs pages and pruned on the configured retention.

## Requirements (self-hosting)

- Python 3.8+ (stdlib only — no pip installs)
- A running local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) with a codegpt connection (the installer auto-detects its API key)
- `ngrok` (winget) or the cloudflared binary that ships with OmniRoute, for public hosting

## License

MIT — © 2026 Michael Anthony Falabella
