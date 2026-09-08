# SignalR.E.A.C.H

**REACH** = **R**AG **E**ndpoint & **A**I **C**hat **H**ost

A plugin for SimpleRAG — installable straight from this GitHub URL — that adds a hosted OpenAI-compatible endpoint with **unlimited gpt-4o for everyone**. No API key, no quotas, no signup. Requests are relayed through a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) instance's `codegpt` provider.

The plugin installs a full **control panel** into SimpleRAG's app bar — a menu panel with seven pages: **Dashboard, Endpoint, Models, Usage, Logs, Settings, About** — plus a dependency-free relay server, hosting tunnel, and a pointer URL that always resolves the live endpoint.

| | |
|---|---|
| **Endpoint pointer (always current URL)** | <https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt> |
| **Models** | `gpt-4o`, `gpt-4o-mini` (aliases → `codegpt/codegpt-gpt-4o[-mini]`, fully tunable per alias) |
| **Auth** | none by default (optional shared access key, IP allow/block lists) |
| **Streaming** | SSE, OpenAI wire format |
| **Caching** | optional response cache (LRU, TTL, temperature-aware keys) |
| **Version** | 26.9.1 <!-- x-release-please-version --> |

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

## Install the plugin — one-click

```powershell
# Windows
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/falabellamichael/SimpleREACH/main/install.ps1 | iex"
```

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/falabellamichael/SimpleREACH/main/install.sh | sh
```

Or install manually:

```bash
git clone https://github.com/falabellamichael/SignalR.E.A.C.H.git
cd SignalR.E.A.C.H
python tools/reach.py install
```

`install` does everything:

1. **Plugin panel** — installs the REACH control panel into SimpleRAG's app bar via the *local-extension registry* (`%LOCALAPPDATA%\RAGWorkspace\extensions\`). **Zero SimpleRAG files are modified**; uninstall removes just the registry entry. Old plugin versions of SignalR.E.A.C.H are pruned on upgrade.
2. **Relay server v2** — copies a dependency-free relay to `%LOCALAPPDATA%\SignalREACH\` and auto-detects the OmniRoute API key from `~/.omniroute/storage.sqlite` (stored only in local `config.json` — never committed, never exposed). `install` restarts the relay so new server versions load immediately.
3. **Hosting** — starts the relay on `127.0.0.1:20777` and opens an **ngrok** tunnel (`--tunnel cloudflared` uses the cloudflared binary OmniRoute ships, no account needed). The public URL is published to the endpoint-pointer gist.
4. **VS Code extension** — side-loads the REACH chat extension into VS Code (`~/.vscode/extensions/`, no marketplace/vsce needed). Reload the window and click the **REACH icon** in the Activity Bar for a chat panel with model picker + streaming. Skip it with `--no-vscode`; manage it later with `python tools/reach.py vscode install|uninstall|status`.
5. **Control panel** — open SimpleRAG → Advanced → **REACH** for the full menu panel.

## VS Code

The bundled extension (`vscode/`) is a zero-dependency chat panel for VS Code:

- **Activity Bar icon** opens the REACH chat — model dropdown, streaming replies, conversation history.
- **Zero config by default** — points at `http://127.0.0.1:20777/v1` and loads the model list from the relay. Override via Settings → Extensions → SimpleREACH (`simplereach.endpoint` also accepts the public pointer URL, e.g. `https://<pointer>/v1`).
- Installed automatically by `install` / `install.ps1`; standalone: `python tools/reach.py vscode install` (copy-based side-load, no vsce/npm build step).

## The panel

| Page | What it does |
|---|---|
| **Dashboard** | Live health: requests/tokens/errors today, avg + p95 latency, public URL, relay + upstream status, circuit state, quick actions (publish, clear log, refresh) |
| **Endpoint** | Base URL, one-click **Add to SimpleRAG**, route table, curl/Python/JS/SimpleRAG snippets (auto-filled with the live URL) |
| **Models** | Alias table (public → upstream), enable/disable toggles, add/remove aliases — applied instantly |
| **Usage** | 24h request + token charts, by-model breakdown, top clients, error rate — auto-refreshes |
| **Logs** | Recent request log (IP, model, status, latency, tokens, error), filters, clear |
| **Settings** | The full endpoint suite — ten sections: Relay, Upstream & failover, Request handling, **Models (per-alias editors)**, Rate limits, Access & security, Caching, Observability, Hosting, System. Export/import/reset included. |
| **About** | Backronym, architecture, facts, privacy notes |

### Per-model settings (the Models section)

Every alias carries its own spec: upstream id, enabled/public visibility, description, default temperature + clamp window, default/capped max tokens, injected system prompt, fallback alias (tried when the upstream fails), context window, streaming/tool-call toggles, and per-model rate limits (RPM + tokens/day, 0 = inherit global). The Models page deep-links into the editor.

### Request policy (Request handling)

`default_model`, `default_stream`, message/input-size caps, global max-tokens cap, temperature clamp window, global injected system prompt, tools/response_format/logprobs toggles, and blocked-field policy (strip silently or reject with 400).

## CLI

```bash
python tools/reach.py install [--no-start] [--no-restart] [--tunnel ngrok|cloudflared|none]
python tools/reach.py status                 # relay + tunnel + public URL
python tools/reach.py start|stop|restart     # manage relay + tunnel
python tools/reach.py publish                # push current URL to the pointer gist
python tools/reach.py register-autostart     # logon/startup: relay + tunnel + publish
python tools/reach.py settings [key [value]] # read/update settings live; keys may be
                                             # dotted: models.gpt-4o.temperature 0.7
python tools/reach.py models list|add|remove # manage model aliases live
python tools/reach.py stats [-v]             # today's usage + breakdowns
python tools/reach.py logs [--limit N] [--status 4*] [--model gpt-4o]
python tools/reach.py test                   # live upstream completion test
python tools/reach.py update                 # git pull + reinstall (upgrade path)
python tools/reach.py uninstall --all        # remove panel + stop everything

### The chat CLI (`tools/reach-cli.py`)

A terminal suite for using the endpoint — stdlib-only, keyless, streaming:

```bash
python tools/reach-cli.py chat                # interactive REPL (/help for commands)
python tools/reach-cli.py ask "question"      # one-shot answer
python tools/reach-cli.py ask "…" --web       # grounded in live web search
python tools/reach-cli.py web "question"      # search → read top pages → cited answer
python tools/reach-cli.py models              # list served aliases
# flags: --model gpt-4o | --base URL | --system "…" | --no-stream | --no-color
```

Web mode ports SimpleRAG's websearch: DuckDuckGo HTML scraping (lite
fallback), rotating user agents, rich answer modules, page excerpt fetch,
and a grounding prompt with `[n]` citations. Auto-discovers the endpoint
(local relay → public pointer gist).
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

## Development

```bash
python -m unittest tests.test_reachd tests.test_reach_cli -v   # 48 tests, stdlib only
git config core.hooksPath .githooks                            # once per clone
```

`main` is the development branch: branch off it, open a PR, and merge with squash. The PR title is the only string release-please parses, so it must be a Conventional Commit (`feat:`, `fix:`, `fix!:`, …) — CI and the `commit-msg` hook both enforce that. Merging the release PR tags the version and rewrites every version string in the repo.

## License

MIT — © 2026 Michael Anthony Falabella
