# CodeGPT Economy Models — Operating Notes & Handoff

**Audience:** any AI assistant (or human) picking this up cold.
**Scope:** how the CodeGPT economy tier is wired through SignalR.E.A.C.H, why it
503s when misconfigured, and exactly where the project stands right now.

Read this before touching `bridge/` routing, the tray provider selector, or
anything that lists/forwards `codegpt-eco-*`.

---

## 1. The 30-second mental model

There are **two independent upstreams**, and conflating them is the single
biggest source of confusion in this codebase:

| | Free upstream | CodeGPT economy tier |
|---|---|---|
| **What** | OmniRoute → CodeGPT free tier (`gpt-4o`, `gpt-4o-mini`) | The unlimited economy models of a paid CodeGPT plan |
| **Served by** | OmniRoute on `127.0.0.1:20128/v1` | The **Electron tray bridge** on `127.0.0.1:21302/v1` |
| **Needs** | An OmniRoute install + API key | VS Code/CodeGPT **signed in** on that machine |
| **Alias** | `gpt-4o` → `codegpt/codegpt-gpt-4o` | `ox-alpha` → `bridge/codegpt-eco-ox-alpha` |
| **Wire id** | provider-prefixed, straight to OmniRoute | `codegpt-eco-<id>`, posted to the bridge |

**The economy tier only exists inside a signed-in CodeGPT browser session.**
That is why it is served by a bridge running *in the tray process* — there is no
API for it and no key that grants it.

### Why the prefix matters

A relay alias whose upstream starts with `bridge/` is routed to `bridge_url`
and **never** given the OmniRoute bearer token (`server/reachd/chat.py`).
`chat.py` strips the `bridge/` prefix before posting, so the bridge receives
exactly the id it advertises.

This means the same model has **two spellings** depending on who you ask:

| Where you are | Ask for |
|---|---|
| The **relay** (`:20777`) | `ox-alpha` (the alias) |
| The **bridge directly** (`:21302`) | `codegpt-eco-ox-alpha` (the wire id) |

Asking the relay for `codegpt-eco-ox-alpha` returns `model_not_found`.
Asking the bridge for `ox-alpha` returns 400. **Both are correct.**

---

## 2. The `127.0.0.1` trap (this caused a multi-hour 503)

`bridge_url` is hard-coded loopback by design (`state.py` even refuses a
non-local `bridge_url` from a hand-edited config, for SSRF safety):

```python
"bridge_url": "http://127.0.0.1:21302/v1",   # server/reachd/settings.py:53
```

So a relay resolves `bridge/...` against **its own machine's** loopback.

> **If your relay runs on machine A and your tray runs on machine B, economy
> models will 503 — while still being listed in `/v1/models`.**

The remote relay calls *its own* `127.0.0.1:21302`, where no tray lives. This is
not a bug to fix by rewriting `bridge_url`; exposing a signed-in CodeGPT session
over a network is exactly what the loopback guard prevents. The correct
interpretation is: **economy models are host-local.**

Real-world instance: VS Code's `simplereach.endpoint` pointed at an ngrok host
(`https://<host>.ngrok-free.dev/v1`). Free Providers listed the economy aliases
(because the remote relay advertised them) and every call 503'd. The tray's own
CodeGPT provider worked fine, because it talks to local `:21302` directly.

---

## 3. Don't confuse these three 503s

They have different causes and different fixes. Check `/status` before assuming.

| Message | Source | Cause |
|---|---|---|
| `Relay is at capacity — retry shortly.` | `chat.py` concurrency gate (`max_concurrency`, default 6) | A streaming request holds its slot for the whole generation (`if not stream: gate.release()`), so stuck generations exhaust the pool |
| `SignalR.E.A.C.H is not configured yet (no OmniRoute key).` | `chat.py` upstream guard | OmniRoute isn't running / no key. **Bridge-routed models are exempt from this one.** |
| `Upstream is in a failure cool-down` | circuit breaker | See §4 |
| `CodeGPT bridge unreachable (is the SignalREACH tray running?)` | `chat.py` bridge error path | Tray not up, or not signed in |

Also: a log line reading `codegpt still waiting (503s)` is a **seconds counter**,
not an HTTP status. We lost time to that one.

---

## 4. Circuit breakers are PER UPSTREAM (fixed)

**Was:** one global breaker guarded the request path, so an OmniRoute outage
took the economy models down with it — a different process, on a different port,
sharing nothing.

**Now:** `state.py` keeps `self._circuits = {upstream: {failures, open_until}}`
with two named circuits:

```python
circuit = "bridge" if use_bridge else "omniroute"      # chat.py
core.STATE.circuit_open(circuit)
core.STATE.note_failure(circuit)
core.STATE.note_success(circuit)
```

`chat_finalize` reads `ctx["circuit"]` so a *successful* bridge reply cannot
mask a broken OmniRoute (and vice versa). `/status` reports both:

```json
"circuits": { "omniroute": false, "bridge": false }
```

`circuit_open` with no argument still means OmniRoute, so older callers work.

---

## 5. Free Providers now hosts the economy tier (the integrated fix)

Previously: economy models worked only under the **CodeGPT** provider, and
appeared under **Free endpoints** only as aliases that 503'd.

Now, in `vscode/extension.js`:

**a. Grouped discovery.** A Free-endpoints refresh probes two sources —
the configured endpoint *and* the local bridge — and emits sections:

```javascript
groups: [
  { label: 'Free models',     models: [...] },
  { label: 'CodeGPT economy', models: [...] },
]
```

`vscode/media/chat.js` renders these as `<optgroup>`s (falls back to a flat list
if only `models` arrives, so an older host still works).

**b. Routing follows the model, not just the provider.** One chokepoint:

```javascript
async _modelEndpoint(connection, model) {
  if (isEconomyModel(model)) {
    if (TRAY_PROVIDERS.includes(connection.provider)) return resolveEndpoint(connection.endpoint);
    return resolveEndpoint(TRAY_BRIDGE_ENDPOINT);   // 127.0.0.1:21302
  }
  return resolveEndpoint(connection.endpoint);
}
```

**c. Auth follows the destination.** `_authHeaders(extra, connection, model)`
suppresses `Authorization` for anything bound to the bridge — the free
endpoint's access key must never be sent to the tray.

**d. No phantom listings.** Economy ids from a non-tray endpoint are filtered
out, so a remote endpoint can't advertise models it cannot answer.

**e. Graceful degradation.** A dead tray does **not** fail the refresh: free
aliases load, the economy group is absent, and the chat gets
`CodeGPT economy models are unavailable — start the SignalREACH tray and sign in to CodeGPT.`

`copilot-chat` / `chatgpt-chat` are filtered off the bridge leg so they can't
leak into the Free Providers list.

---

## 6. Environment: what must be true

| Requirement | Check |
|---|---|
| Relay running | `lsof -nP -iTCP:20777 -sTCP:LISTEN` — should show **`Python`**, not `node` |
| Tray running + signed in | `curl -s http://127.0.0.1:21302/health` |
| OmniRoute (only for `gpt-4o` etc.) | `lsof -nP -iTCP:20128 -sTCP:LISTEN` |
| Public URL (only for remote clients) | `python3 tools/reach.py status` |
| VS Code endpoint | `simplereach.endpoint` in `~/Library/Application Support/Code/User/settings.json` |

### The `node`-on-20777 trap

`tools/endpoint-client.cjs` (a *client* bridge that follows the published
pointer to a **remote** host) also binds `20777`. If it owns the port, your
"local" requests go to the remote relay and economy models 503.

It may be respawned by launchd:

```
~/Library/LaunchAgents/com.signalreach.endpoint-client.plist
```

```bash
launchctl unload ~/Library/LaunchAgents/com.signalreach.endpoint-client.plist
kill <pid>
python3 tools/reach.py start
```

A `kill` that appears to "not work" is usually this supervisor restarting it.

### Tray provider setting

`~/Library/Application Support/signalreach-copilot-tray/tray-settings.json`
(Electron `userData`, named for the package — **not** the `SignalREACH/` dir):

```json
{ "provider": "codegpt", "model": "codegpt-eco-ox-alpha" }
```

Left at `endpoint`, the tray acts as a *client* of the relay and never uses its
own working bridge — surfacing the relay's 503 as its own.

---

## 7. Verification harness

`tools/_probe_all_models.py` hits **every model on both paths** and exits
non-zero on any failure. Run it after touching anything in this area.

```bash
python3 -B tools/_probe_all_models.py
```

Last run (green):

```
RELAY — all models            (http://127.0.0.1:20777)   6 ok
  ox-alpha, deepseek-v4.1-flash, gemini-3.8-flash,
  gpt-5.6-luna, glm-5.2, MiniMax-M3
TRAY BRIDGE — economy models  (http://127.0.0.1:21302)   8 ok
  codegpt-eco, codegpt-eco-<each economy id>, codegpt-eco-gpt-4o-mini
TOTAL: 14 ok, 0 failed
```

**Note on `tools/_probe_config.js`:** it only tests `parseHeaderLines` (header
parsing). It has nothing to do with the chat path and is not evidence either
way about a 503. It got re-pasted several times during debugging.

### Test suites

```bash
python3 -m unittest discover -s tests      # 135 pass
node --test tests/*.test.cjs               # see note below
node --test tests/vscode_provider.test.cjs # 25 pass
```

**Known pre-existing failure:** `tests/vscode_answer_now.test.cjs` →
`rafPending is not defined`. It is **uncommitted WIP in `vscode/extension.js`**,
not related to the economy work. It passes on a stashed tree.

---

## 8. Model inventory — the single source of truth

Two lists must agree on **ids** (labels are cosmetic):

- `server/reachd/settings.py` → `CODEGPT_ECONOMY_MODELS`
- `copilot/tray/economy-models.js` → `FALLBACK`

Current ids: `deepseek-v4.1-flash`, `ox-alpha`, `gemini-3.8-flash`,
`gpt-5.6-luna`, `glm-5.2`, `MiniMax-M3`.

> **The live menu wins.** `economy-models.js` polls the CodeGPT sidecar
> (`127.0.0.1:54112/api/fetch-data/catalog`) every 5 minutes and treats
> `!entry.pro` as economy — the same rule CodeGPT's own launcher uses. The
> bundled `FALLBACK` is only for when the sidecar is down; it drifts. Never
> hardcode a discovered id as authoritative.

`settings.py` deliberately **only fills aliases that are not already routed**,
so an existing alias (e.g. `gemini-3.7-flash` → OmniRoute) is never silently
stolen by the economy defaults.

### `chatgpt-chat` was removed

It was a default alias pointing at `copilot/chatgpt-chat` — a **tray-bridge**
provider, not OmniRoute — so the relay advertised a model it could never serve.
It now lives only where it works (the ChatGPT provider / bridge).

---

## 9. Where the project stands

### Working and verified

- ✅ Economy models — **8/8** on the tray bridge, **6/6** on the local relay
- ✅ Free Providers host a grouped **CodeGPT economy** section that routes to the bridge
- ✅ Per-upstream circuit breakers (OmniRoute outages no longer kill economy)
- ✅ Auth never leaks the free endpoint key to the bridge
- ✅ Graceful degradation + a specific message when the tray is down
- ✅ `chatgpt-chat` no longer shipped as an unroutable default alias

### Not working here (environmental, not code)

- ❌ `gpt-4o`, `gpt-4o-mini`, `gemini-2.5-flash`, `gemini-3.7-flash` —
  **OmniRoute is not installed on this machine** (`~/.omniroute/` absent,
  nothing on `:20128`). Disabled live so they stop being advertised.
  Re-enable once OmniRoute runs:
  ```bash
  python3 tools/reach.py settings omniroute_key
  python3 tools/reach.py test
  curl -X PUT http://127.0.0.1:20777/_reach/settings \
    -H 'Content-Type: application/json' \
    -d '{"models":{"gpt-4o":{"enabled":true,"public":true}}}'
  ```
- ⚠️ No tunnel: `python3 tools/reach.py start` reports **`ngrok not found`**,
  so the published pointer is stale.

### Loose ends / suggestions

1. **Dead alias detection.** The relay could stop advertising (or flag) any
   alias whose upstream is unreachable — that is the honest fix for
   "listed but 503s", the pattern that cost the most time here.
2. **`gemini-*` economy variants** are reachable as `codegpt-eco-gemini-3.7-flash`
   but need a hand-added alias, by design.
3. `tests/` has probe scratch files (`tools/_probe_*.js`) that are not tests —
   consider a `tools/probes/` folder or gitignore.

### Uncommitted state to review

```
M README.md                        M server/reachd/chat.py
M copilot/tray/panel.html          M server/reachd/settings.py
M tests/vscode_answer_now.test.cjs M server/reachd/state.py
M tests/vscode_provider.test.cjs   M tools/reach/tray.py
M vscode/extension.js              M vscode/media/chat.js
?? tests/tray_economy.test.cjs     ?? tools/_probe_all_models.py
?? tools/_probe_config.js          ?? tools/_probe_send.js
?? tools/_probe_slash.js
```

`tests/vscode_answer_now.test.cjs` + `tools/_probe_*.js` are **pre-existing
WIP, not part of the economy fix**. `copilot/tray/panel.html` had a large diff
predating this work; the `codegpt` option is present exactly once (verified).

---

## 10. Debugging checklist

Work top-down; each step rules out a layer.

```bash
# 1. Is the relay alive, and is it *our* relay?
lsof -nP -iTCP:20777 -sTCP:LISTEN        # want: Python  (not node)

# 2. Breakers + upstream health
curl -s http://127.0.0.1:20777/status | python3 -m json.tool | head -20
#    look at: circuits, upstream_ok, in_flight

# 3. Is the tray up and signed in?
curl -s http://127.0.0.1:21302/health

# 4. Does the bridge actually serve the model?
curl -s -X POST http://127.0.0.1:21302/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codegpt-eco-ox-alpha","messages":[{"role":"user","content":"say OK"}]}'

# 5. Does the relay serve the same model by ALIAS?
curl -s -X POST http://127.0.0.1:20777/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"ox-alpha","messages":[{"role":"user","content":"say OK"}]}'

# 6. Everything at once
python3 -B tools/_probe_all_models.py

# 7. Logs
tail -40 "$HOME/Library/Application Support/SignalREACH/reach.log"
tail -40 "$HOME/Library/Application Support/SignalREACH/copilot-tray.log"
```

**Decision shortcut.** If the bridge (step 4) answers but the relay (step 5)
does not → routing/circuit. If neither answers → tray or sign-in. If step 1
shows `node` → you are testing a different relay.

---

## 11. Rules of engagement (learned the hard way)

1. **Identify the process before theorizing about the code.** Multiple times
   the "bug" was a stale deployed copy, a dead process, or `node` holding the
   port. `lsof` first.
2. **`--extension-only` install ≠ running the new code.** Redeploy *and*
   restart; verify the new symbol exists in the deployed path
   (`grep -c "<new_thing>" "$HOME/Library/Application Support/SignalREACH/server/reachd/<file>"`).
3. **Run the probe before claiming a fix.** Reading source is not evidence that
   a request succeeds.
4. **The two spellings are not interchangeable.** Relay = alias; bridge = wire id.
5. **Economy models are host-local.** `127.0.0.1:21302` means "on the relay's
   machine", and that is intentional.
6. **A listing is not a capability.** `/v1/models` advertising a model does not
   mean the caller can reach its upstream.
