# REACH architecture: surfaces, relay request path, model routing

Mermaid source for [SignalR.E.A.C.H](../README.md). Node names, ports and module paths come from the working tree: server/reachd/, copilot/tray/, src/, studio/. Relay ships VERSION = 26.11.0 from server/reachd/const.py.

## 1. Four surfaces, one endpoint

The endpoint URL is a rotating tunnel, always resolved through a pointer gist.

```mermaid
flowchart LR
    G["Pointer gist<br>id e261e0c31ad08c373bcd667b6982847a<br>simple-reach-endpoint.txt"]
    R1["1 Relay server<br>Python, stdlib only<br>server/reachd/"]
    R2["2 SimpleRAG panel<br>JavaScript<br>src/ - 8 pages"]
    R3["3 VS Code tray<br>Electron<br>copilot/tray/"]
    R4["4 REACH Studio<br>Electron, Node 24<br>studio/ - 44 agent modules"]
    R1 -. "publish_url() re-posts live tunnel" .-> G
    G --> R2
    G --> R3
    G --> R4
    G --> R1


## 2. Request path through the relay

```mermaid
flowchart TD
    C["Client<br>curl, openai SDK, SimpleRAG, Studio<br>Authorization: Bearer sk-reach-..."]
    C -->|POST /v1/chat/completions| L["Relay<br>127.0.0.1:20777<br>server/reachd/core.py"]
    L --> A["handler.py<br>constant-time API key check<br>failed-attempt lockout<br>IP allow/block"]
    A -->|denied| E["401 / 429<br>limits.py<br>MAX_RATE_BUCKETS = 10000"]
    A -->|allowed| K["cache.py<br>LRU, TTL, temperature-aware keys"]
    K -->|hit| S
    K -->|miss| M["model_routes.py<br>alias maps to an upstream prefix"]
    M --> U1["gpu/ private GPU hosts<br>ports 18000 to 18006<br>gemma-4-12b-qat, qwen3.6-35b-a3b-fp8"]
    M --> U2["direct/ subscription accounts<br>deepseek-v4.1-flash, gpt-5.6-luna<br>gemini-3.8-flash, glm-5.2, MiniMax-M3"]
    M --> U3["bridge/ signed-in pages<br>chatgpt-chat, copilot-chat<br>gemini-chat, devin-chat, codex-chat"]
    M --> U4["bridge/codegpt-eco- economy tier<br>local tray bridge<br>127.0.0.1:21302/v1, no token"]
    U1 --> S
    U2 --> S
    U3 --> S
    U4 --> B["tray bridge.js<br>one queue per provider<br>single-session pages"]
    S["stream SSE<br>OpenAI wire format to client"]
    B --> S
    S --> P["analytics.py, publish.py<br>record usage, re-publish tunnel URL"]


`codegpt-eco-*` never reaches OmniRoute: the economy tier exists only in the host's signed-in CodeGPT session, so the tray bridge serves it locally.

## 3. Economy model discovery - live, not baked in

```mermaid
sequenceDiagram
    participant R as Relay :20777
    participant B as tray bridge.js :21302/v1
    participant SC as CodeGPT sidecar :54112/54113
    R->>B: POST /v1/chat/completions codegpt-eco-<id>
    alt sidecar answers
        SC-->>B: credits menu, per-model pro flag
    else sidecar down
        B->>B: FALLBACK catalog, last known good
    end
    B->>B: queue per provider, single-session page
    B-->>R: SSE stream
    R->>R: analytics.py records usage
    B->>SC: re-discover every CACHE_MS = 5 min


`pro ? premium : economy` is the whole split - the same line the extension launcher draws. Economy ids are never hardcoded: economy-models.js probes ports 54113 to 54165.
