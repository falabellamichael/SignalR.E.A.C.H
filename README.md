# SimpleREACH

**REACH** = **R**AG **E**ndpoint & **A**I **C**hat **H**ost

A plugin for [SimpleRAG](https://github.com/falabellamichael) — installable straight from this GitHub URL — that adds a hosted OpenAI-compatible endpoint with **unlimited gpt-4o for everyone**. No API key, no quotas, no signup. Requests are relayed through a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) instance's `codegpt` provider.

| | |
|---|---|
| **Endpoint pointer (always current URL)** | <https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt> |
| **Model** | `gpt-4o` (upstream: `codegpt/codegpt-gpt-4o`) |
| **Auth** | none — open for everyone |
| **Streaming** | SSE, OpenAI wire format |

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

**In SimpleRAG:** Endpoint settings → add an OpenAI-compatible endpoint → Base URL `<URL>/v1`, model `gpt-4o`, API key blank.

> The public URL is a tunnel that changes when the host restarts it — always resolve it through the pointer gist above (the REACH page inside SimpleRAG does this automatically).

## Install the plugin (from the GitHub URL)

```bash
git clone https://github.com/falabellamichael/SimpleREACH.git
cd SimpleREACH
python tools/reach.py install
```

`install` does everything:

1. **Plugin page** — installs a "REACH" page into SimpleRAG's app bar via the *local-extension registry* (`%LOCALAPPDATA%\RAGWorkspace\extensions\`). **Zero SimpleRAG files are modified**; uninstall removes just the registry entry.
2. **Relay server** — copies a dependency-free relay to `%LOCALAPPDATA%\SimpleREACH\` and auto-detects the OmniRoute API key from `~/.omniroute/storage.sqlite` (it is stored only in the local `config.json` — never committed, never exposed to public clients).
3. **Hosting** — starts the relay on `127.0.0.1:20777` and opens an **ngrok** tunnel (`--tunnel cloudflared` uses the cloudflared binary OmniRoute ships, no account needed). The public URL is then published to the endpoint-pointer gist so the plugin page and everyone else always resolve the live URL.
4. **SimpleRAG page** — open SimpleRAG → Advanced → **REACH**: live status, copyable public URL, one-click endpoint test, and curl/Python/SimpleRAG snippets.

```bash
python tools/reach.py status              # relay + tunnel + public URL
python tools/reach.py start|stop|restart  # manage relay + tunnel
python tools/reach.py publish             # push current URL to the pointer gist
python tools/reach.py register-autostart  # Windows logon task: relay + tunnel + publish
python tools/reach.py uninstall --all     # remove plugin page + stop everything
```

## Architecture

```
any OpenAI client ──► https://<tunnel>/v1  (public, no auth, CORS *)
                          │
                 reachd.py  (127.0.0.1:20777, stdlib-only relay)
                          │  injects Bearer key server-side,
                          │  pins model → codegpt/codegpt-gpt-4o
                          ▼
             OmniRoute http://127.0.0.1:20128/v1
                          ▼
              codegpt free tier (gpt-4o)
```

- The relay binds **loopback only**; the tunnel exposes just the keyless relay surface. OmniRoute's dashboard and API keys are never reachable from outside.
- `/v1/models` serves exactly `gpt-4o`; anything else returns `model_not_found`.
- The OmniRoute key never leaves the host machine and never enters this repository.

## Requirements (self-hosting)

- Python 3.8+ (stdlib only — no pip installs)
- A running local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) with a codegpt connection (the installer auto-detects its API key)
- `ngrok` (winget) or the cloudflared binary that ships with OmniRoute, for public hosting

## License

MIT — © 2026 Michael Anthony Falabella
