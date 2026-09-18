# Changelog

## [26.9.4](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.3...v26.9.4) (2026-09-18)


### Features

* add workspace telemetry views and agent controls ([3fbbe03](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/3fbbe03170a1bb84ac46d4006b532fe23035737c))
* **agent:** add budget controls and reliable continuation ([#81](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/81)) ([263238d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/263238d28665ea4f03eb129b3fde1aa308c5cf6e))
* **browser:** decode compressed responses, render inline SVG, and fall back to the readable snapshot ([#80](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/80)) ([9f122a2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9f122a2292605c1aa996e3403228db8add448074))
* **cli:** style streamed replies with response borders ([e3652f6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e3652f6b0410d37048757d405882c8317befdc3a))
* **panel:** PRD diagnostics, payload inspector, audit trail, and command palette ([#86](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/86)) ([cf41fdd](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/cf41fdd699892879f7f10ca0bf7c207aaa0073c3))
* **reach-cli:** agent tool loop with live waiting indicators ([efadf32](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/efadf3212c3a559f118c217699f6da31a9acc071))
* **relay:** Docker image and compose for the relay server ([b6439d0](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b6439d006f6b447e86f0054f18568345c6163719))
* **studio:** add browser panel and Files menu ([a1820d0](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/a1820d006d90688b4e3f5a5fbf30a3b747587284))
* **studio:** add desktop app with configurable agent budgets ([470a9d6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/470a9d6e782259d98bd49ce9c135a8c0bd0d91f7))
* **studio:** add Flatpak target and fix Linux CI smoke sandbox ([0624068](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/06240686be1fa5ffa83242143d44d8c6201277d4))
* **studio:** add macOS support and resilient agent UI ([c20a521](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c20a5212c65a8024bd0500a00ecd1ce8d83d44b5))
* **studio:** add portable zip to Linux build targets ([a5286e1](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/a5286e1636ccbd83141e63d56dd5d0e392041674))
* **studio:** add universal stop and resumable agent controls ([744b34e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/744b34e3eba39f638f007af132aa066b59f86861))
* **studio:** build Linux AppImage and deb installers ([f86a4d8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f86a4d860a135dbc80e71f19534f07d5f2581d86))
* **studio:** Docker GUI container with noVNC streaming ([4977ac8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/4977ac8af9215f83df6de70b5b5842ac597d7ef6))
* **studio:** enable agent browser control and element selection ([6319c13](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6319c1367343014efc43be46bafbf9889fdc23d5))
* **studio:** native-window mode for the GUI container ([1d01487](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1d0148790a9f43149c165b8615ddb4920ea89d8c))
* **studio:** reveal themed chat scrollbar near the pointer ([07d4a8e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/07d4a8e3485142843fe9e5929952cf824f014086))
* **studio:** workspace shell, prompt console, and six agentic engines ([#87](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/87)) ([92b4da1](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/92b4da16f1e0ff695305fa10288851b02d1f7cce))


### Bug Fixes

* **agent:** improve action compatibility and command execution ([2df140b](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2df140b4a5c08f2e9a02884f42b14ecc780f01dd))
* **agent:** improve action compatibility and command execution ([#82](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/82)) ([96ca831](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/96ca831041b931469bd7559c15e3d35aa945ceab))
* compact the composer with two-line auto sizing ([e18030a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e18030aaf707ca5f1f5ea96372e923c270ba704a))
* **provider:** merge stacked system messages into one leading system for strict endpoints ([#78](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/78)) ([0c30b9e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/0c30b9e527a2a2e797caf7365efa85e9a5e996ca))
* **studio:** center conversations within a readable page width ([7598acb](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/7598acb3156a62f9cbcfe0823dc1e7a1c706d723))
* **studio:** hide browser action scrollbar ([32bea19](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/32bea191cefa44f3e9207bf557c54b25dcc952c8))
* **studio:** make element picking optional and dismiss on click away ([1d77dfd](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1d77dfd7d41ae443e6dabfdd18e329c3ed1b8c71))
* **studio:** preserve browser tab clicks during state updates ([3c02b67](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/3c02b670fb4b412a0fa89a51be8a5043993c06ba))
* **studio:** reserve conversation space at narrow window sizes ([f4d3270](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f4d32705cedb2557b1a03b4509e4366b9bf9621e))
* **studio:** reserve conversation space below expanded activity ([d626daa](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/d626daa414f20dc67a6f084c7252067aa59168b2))
* **studio:** scroll browser actions in a single row ([328bd2a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/328bd2a0f431c5f4b7f5b81b37f02f5bb65485c4))
* **studio:** synchronize project selection across views ([8726e5f](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8726e5f1c8744afdc3a1d4f23879e9119f0a3e08))
* **studio:** upgrade Electron to resolve dependency vulnerabilities ([8a63c57](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8a63c575a1d352535a5f3c2eb51a48099aeff62e))
* **studio:** use POSIX paths for non-Windows environments ([d7b4726](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/d7b4726b1d70845aee4ca10b827db1ccf062eac9))
* **vscode:** recover stalled agent runs and preserve request context ([86412c7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/86412c73a9b728ca4f2e9a81c9a9f4a87b0faf70))

## [26.9.3](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.2...v26.9.3) (2026-09-12)


### Bug Fixes

* **server:** evict stale rate-limit buckets instead of clearing all ([a08198c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/a08198c33bf9d41ca483c6fe6c0c5929e4b092a7))

## [26.9.2](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.1...v26.9.2) (2026-09-11)


### Features

* **agent:** implement agent capabilities upgrade with browser tools and plan state ([9fbea3a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9fbea3a85d28ee482767eecb89316c3cbd6335ca))
* **clients:** add desktop providers and per-endpoint settings ([#65](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/65)) ([568bb4a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/568bb4a320b996646dbafaf019b6f658a4f2f120))
* **clients:** update desktop providers, endpoint settings, and VS Code agent workflows ([#69](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/69)) ([c646f9d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c646f9de808c07e31558bc85d947c84af4fe1b09))
* **codegpt:** wire unlimited economy models into endpoint, tray and extension ([#74](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/74)) ([f922a1d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f922a1d4efc830d01edbf90614ed5bcf966b27f7))
* consolidate outstanding client work — tray supervisor, attach & browse tools, CLI agent mode, right-click actions ([#63](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/63)) ([083068e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/083068ed5f3b35c41b0519ad490f3891be6697fa))
* economy concurrency handling, tray + vscode improvements ([bc0b7d9](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/bc0b7d957db37aad7613ed9bfbd985b7d62cb4be))
* **host:** bind the host PC and encrypt secrets at rest ([38827ed](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/38827eda7c534df389ae5f69e95a8b4f54400daa))
* restore browser and improve VS Code integration ([#67](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/67)) ([9fdcb0e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9fdcb0edf5e99c5ed88f97831db2a901c39ff5ef))
* **server:** add chatgpt-chat free-provider alias; tolerate internal config keys ([#71](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/71)) ([35747f6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/35747f6c10ac564c07e8edf8aaf0a3d976909690))
* **server:** add gemini-2.5-flash alias (CodeGPT free tier) ([#72](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/72)) ([464e221](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/464e221056745f577e30b468cedd5aa109649311))
* **settings:** one-click remote client + private-repo access tooling ([65c26ad](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/65c26ad0b48e54311bd892de3c048a84a7167244))
* **tray:** add CodeGPT interactive browser (economy models bridge) ([#73](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/73)) ([c285761](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c285761885e184c33412ebce9bb68ba71688ecfa))
* **vscode:** collapsible edit drop-up, header parsing tests, and relay fixes ([55ca4b7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/55ca4b72c146fd2f110ba7a60a4de97a248c9db8))
* **vscode:** Copilot-style narrated work log ([#61](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/61)) ([1126ef9](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1126ef937556eb9ded2e24f29cce8b11040c919b))
* **vscode:** slash commands, agent template, sampling + header settings ([ad5fdb8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ad5fdb821651c281b246761f098befd71c89a956))


### Bug Fixes

* **clients:** restore agent continuity and endpoint connectivity ([#66](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/66)) ([139ca2d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/139ca2d0ceacbdaf0905d2f140224a54d8e9a43b))
* **host:** make sealing safe to live with ([9adbc46](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9adbc462a646b7668896bba022b4a1b786bd0c29))
* **host:** report on-disk sealed state in `host status` ([330b7ed](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/330b7ed9d9488a6ebb11b6258cfa2557975fa211))
* **server:** add missing sys imports crashing relay startup on Windows ([#70](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/70)) ([6857b4c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6857b4c2865d51a7a508d5e6d1a91f06cd7b0fc3))
* **server:** release concurrency gate on streaming failures and retain stream socket timeout ([19be8d3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/19be8d381061b299a9dfb497e7f46fac46eb77a4))
* **tray:** make the CodeGPT Send click robust and verified ([7076239](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/7076239f88e75804cb53e040501ecafeeacd7225))
* **tray:** stop_tray used Unix pkill on Windows, crashing tray start ([ce0ca85](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ce0ca85736819f61bdc3d4c53f4a6e6b2c80c568))
* **vscode:** visible attachment remove button + frame-batched smooth streaming ([#64](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/64)) ([67a70d3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/67a70d306c865f764a8720ac7f567e2d634a1ac3))

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
