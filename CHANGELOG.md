# Changelog

## [26.9.1](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.0...v26.9.1) (2026-09-08)


### Features

* **copilot:** system tray + custom invisible browser for the M365 Copilot bridge ([#7](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/7)) ([4217cf2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/4217cf2a15486e21a0835542d77ad8984c7fdca4))
* **copilot:** tray home page + improved minichat with web search ([#47](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/47)) ([29622fe](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/29622fec7356d834212bb4dbff45b5ad076aed56))
* **copilot:** tray visual polish — aligned SVG icon set, window show/hide toggle ([#50](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/50)) ([bbae035](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/bbae035e8558adca02745924dc37c78d966a909a))
* implement client API key generation (sk-reach) and upstream key isolation ([d6b7e88](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/d6b7e880bf828b20e828687980f6190bd068b4e5))
* **install:** add one-click install scripts (ps1 + sh) ([830aa28](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/830aa28fc5a464486647456613098ac3b0bbd0e2))
* **panel:** extract shared page widgets to pages-common.js ([8d843d2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8d843d2c667fdad0c2e941fc69520a0e03e3a1e1))
* **release:** calendar versioning — YY.MM.revision with monthly rollover ([#57](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/57)) ([c409e0c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c409e0c5924378876bc787caa7701f5d87a6db41))
* **telemetry:** add tokens/s to dashboard, panel metrics, and broadcast through endpoint for AI chats ([2eae075](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2eae075f635472d1296341cd204718a363138915))
* **theme:** align SignalR.E.A.C.H styling with SimpleRAG advanced warm theme and Codalio ([51e82f7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/51e82f7b980271a79e5cb2beafbaaf7085a41450))
* **ui:** add isolated accent color switcher and upgrade all pages with pro developer tools ([097e46b](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/097e46bfbc578a51c0636d1ef777dfbddbe93a53))
* **ui:** high-density compact layout overhaul across all 7 pages and stationary panel ([c578834](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c578834ebb016997f517595f4875443fdd0eeaf0))
* **vscode:** Cursor-style agentic chat — edit diff cards, tool loop, LaTeX, step tracker ([#6](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/6)) ([ca35cdd](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ca35cddb3f50caae6c1c61d3105c98cf28d00472))


### Bug Fixes

* **cli:** block web-search SSRF to internal addresses ([685f524](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/685f5243c30ce1f50c0d698b5844496760d36a84))
* **cli:** send the admin token on /_reach/* calls ([20e7b14](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/20e7b1452f35980f0499405944f498f27e406dbb))
* close 7 findings from GHSA-m439-vg8j-pf3x (admin auth, key leak, SSRF, XSS) ([ffd2fb9](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ffd2fb9a7b3303967fef06dbc567a0243689acbe))
* **copilot:** tray panel CSP blocked external panel.css — panel rendered unstyled ([#49](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/49)) ([6311351](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6311351053978d43d9f3d28c11643dcc8cb755d9))
* **dashboard:** destructure esc so Test endpoint renders its result ([#12](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/12)) ([f7a8b81](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f7a8b81a0e75eabfd8889a661330002c40fd3678))
* **install:** keep install.ps1 ASCII-only for Windows PowerShell 5.1 ([1506b1e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1506b1ee89b9c73e6101c5ccbd5c37b938319096))
* **install:** prefer current checkout, fix python probe ([678d62a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/678d62ae103b619ce936d6d9989e81432f9c6c58))
* **server:** authenticate the admin API instead of trusting peer address ([4f5d520](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/4f5d520c3670ee731df7eaac4678ebe38c242ba4))
* **spec:** align gemini-3.7-flash upstream and description to proper 3.7 ([1b63db5](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1b63db59d4a85aaa2eb0dc706c2bfbcb4a58ee72))
* **streaming:** scrub transcript role continuations in stream and extend TTFT timeout for Gemini ([2662715](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/26627155cf3e37b0b0fe3c98a3f39e81790ffdf5))
* **ui:** prevent stored XSS from client IP on the Usage page ([004fbea](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/004fbea7c595eb17e9b42d547b268a342b020660))
* **vscode:** collapse adjacent masked tool/edit blocks during streaming ([#55](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/55)) ([0df3c4d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/0df3c4dfb217996aba13891e3835f7d5dd9add87))
* **vscode:** kill blank-line gaps in agentic replies ([#54](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/54)) ([39bd021](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/39bd021006cfeddd38f4646f38bb8977a386a501))
* **vscode:** lock model switching while the AI is responding ([#58](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/58)) ([6eab27e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6eab27e802d8485a63d53141b334f899b6795f5d))

## [3.4.0](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v3.3.0...v3.4.0) (2026-09-08)


### Features

* **copilot:** system tray + custom invisible browser for the M365 Copilot bridge ([#7](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/7)) ([4217cf2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/4217cf2a15486e21a0835542d77ad8984c7fdca4))
* **vscode:** Cursor-style agentic chat — edit diff cards, tool loop, LaTeX, step tracker ([#6](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/6)) ([ca35cdd](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ca35cddb3f50caae6c1c61d3105c98cf28d00472))


### Bug Fixes

* **cli:** block web-search SSRF to internal addresses ([685f524](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/685f5243c30ce1f50c0d698b5844496760d36a84))
* **cli:** send the admin token on /_reach/* calls ([20e7b14](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/20e7b1452f35980f0499405944f498f27e406dbb))
* close 7 findings from GHSA-m439-vg8j-pf3x (admin auth, key leak, SSRF, XSS) ([ffd2fb9](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ffd2fb9a7b3303967fef06dbc567a0243689acbe))
* **server:** authenticate the admin API instead of trusting peer address ([4f5d520](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/4f5d520c3670ee731df7eaac4678ebe38c242ba4))
* **ui:** prevent stored XSS from client IP on the Usage page ([004fbea](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/004fbea7c595eb17e9b42d547b268a342b020660))

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
