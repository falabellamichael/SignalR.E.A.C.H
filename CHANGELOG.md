# Changelog

## [3.3.0](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v3.2.0...v3.3.0) (2026-09-07)


### Features

* implement client API key generation (sk-reach) and upstream key isolation ([d6b7e88](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/d6b7e880bf828b20e828687980f6190bd068b4e5))
* **install:** add one-click install scripts (ps1 + sh) ([830aa28](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/830aa28fc5a464486647456613098ac3b0bbd0e2))
* **panel:** extract shared page widgets to pages-common.js ([8d843d2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8d843d2c667fdad0c2e941fc69520a0e03e3a1e1))
* **telemetry:** add tokens/s to dashboard, panel metrics, and broadcast through endpoint for AI chats ([2eae075](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2eae075f635472d1296341cd204718a363138915))
* **theme:** align SignalR.E.A.C.H styling with SimpleRAG advanced warm theme and Codalio ([51e82f7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/51e82f7b980271a79e5cb2beafbaaf7085a41450))
* **ui:** add isolated accent color switcher and upgrade all pages with pro developer tools ([097e46b](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/097e46bfbc578a51c0636d1ef777dfbddbe93a53))
* **ui:** high-density compact layout overhaul across all 7 pages and stationary panel ([c578834](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c578834ebb016997f517595f4875443fdd0eeaf0))


### Bug Fixes

* **install:** keep install.ps1 ASCII-only for Windows PowerShell 5.1 ([1506b1e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1506b1ee89b9c73e6101c5ccbd5c37b938319096))
* **install:** prefer current checkout, fix python probe ([678d62a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/678d62ae103b619ce936d6d9989e81432f9c6c58))
* **spec:** align gemini-3.7-flash upstream and description to proper 3.7 ([1b63db5](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1b63db59d4a85aaa2eb0dc706c2bfbcb4a58ee72))
* **streaming:** scrub transcript role continuations in stream and extend TTFT timeout for Gemini ([2662715](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/26627155cf3e37b0b0fe3c98a3f39e81790ffdf5))
