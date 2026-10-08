# Changelog

## [26.10.0](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.14...v26.10.0) (2026-10-08)


### Bug Fixes

* **cli:** mask API keys without exposing suffix ([#26](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/26)) ([#147](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/147)) ([e175085](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e175085ae84761c73a0dbb8fc6555289eb192d2b))


### Miscellaneous Chores

* release-as 26.10.0 ([#157](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/157)) ([8d8d760](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8d8d760cb0dbe36ef7152a079e5c668d2430b21c))

## [26.9.14](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.13...v26.9.14) (2026-10-07)


### Features

* **studio:** add theme accents and tighten the workspace layout ([e270b9e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e270b9e90a2b29eb8e9f8624a7a05a65ac72a5a1))
* **studio:** make the Create page a compact operational workbench ([cbaea04](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/cbaea04521878b3029bb5145d89fbdecc12c282f))
* **studio:** show what each tool ran and when ([38bc70c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/38bc70cb0f878ae9cfe29fddf38277efe3b54b55))
* **studio:** start theme tint at zero ([14cf8be](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/14cf8be8c2c3070295a838d8cea6e8b1929cb63d))
* **studio:** VS Code-style activity bar and a denser agent explorer ([b9dfa03](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b9dfa03553539f3b823c65387720cf4553dccb39))


### Bug Fixes

* harden public access and operator UI ([#151](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/151)) ([3b6707a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/3b6707a81cae6073bdcb8503f830ee976ac05a61))
* **studio:** find the pinned New Chat row in the Start section in smoke ([#152](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/152)) ([c48af26](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c48af26a6743438683b0c8de61ec4dfa4aa21935))
* **studio:** hide tool-call activity rows in Agents chat ([#153](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/153)) ([26f7435](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/26f7435b577851317b0196c65cd88d1048cb8bee))

## [26.9.13](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.12...v26.9.13) (2026-10-06)


### Features

* **studio:** add message actions tray, file previews, and prompt resend ([#145](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/145)) ([687e4ef](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/687e4efffcb7ee36f0d6a130b0fb784163be6968))
* **studio:** port the Create workbench (library + detail pane) ([54f1d30](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/54f1d30c4a8e223529522a758f39fbe6a43bb62e))
* **studio:** restore the advanced agent-capability engines ([5c07099](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/5c07099bc1e1e8bdb150a4cbf4e01a0d55cca45c))


### Bug Fixes

* fit Studio compression to subscription request limits ([8452023](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/84520236475511477a1d80a67f2d776fa4db16d4))
* **reach:** make the panel's endpoint buttons work and adopt the real account service ([3868c96](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/3868c96b511a130e9e4dfea9432d7fe125102104))
* **reach:** never hold back the first endpoint publish after boot ([#149](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/149)) ([52a0838](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/52a083893bb8d46118671255f25c42e3c4d20539))
* **reach:** report a provisioned account service as running, not missing ([c6bc766](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c6bc766115a746b90d83bc2d0d34511ccd7378da))
* recover browser chat action responses independently ([83d67a0](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/83d67a02f9272d940edd28ac2bf8aaaf24669e00))
* **studio:** hide the native browser view under floating menus ([#146](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/146)) ([8bbc8f6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8bbc8f61135c88761139eeada24741c6b32584ea))
* **website:** prevent page scroll at horizontal rail edges ([#137](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/137)) ([888e953](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/888e953e2ff538e296b1b1f510a8de3128e02a6a))

## [26.9.12](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.11...v26.9.12) (2026-10-02)


### Features

* **accounts:** sign in with an email code ([#133](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/133)) ([1a6d755](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1a6d75585357609e377df45651c1747d4a444b59))
* **payments:** PayPal checkout, subscriptions and refunds (Phase 4) ([#134](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/134)) ([b03b6bf](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b03b6bfd9422c6805abe834244f489203e717b85))
* **payments:** read-only go-live check and checklist ([#135](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/135)) ([8e05098](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8e05098e75b0a9198e8c9d6872c3b5c6e08a9d10))
* **payments:** refunds, disputes and the Stripe customer portal (Phase 3) ([#132](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/132)) ([e6f805b](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e6f805b0c10a9584365f115a5837fba90a16d60b))
* **payments:** Stripe Checkout and webhook (Phase 2) ([#131](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/131)) ([2c72783](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2c72783743cd31856f09d5937d24311ba85474e0))

## [26.9.11](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.10...v26.9.11) (2026-10-01)


### Features

* **rch:** add provider-neutral payments ledger ([#127](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/127)) ([a0ca214](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/a0ca2146a72ccadfc43b759835311d66e28e11a6))


### Bug Fixes

* relay socket timeout + connection cap, current-launch cloudflared URL, http(s)-only tray openExternal ([#130](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/130)) ([cd2315a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/cd2315a136a4a2daff22bdca5cd19fef91d9ceab))
* **studio:** restore light theme border contrast ([#129](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/129)) ([136383d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/136383d0c39d425a509a9ddd36390f91e8077cd6))

## [26.9.10](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.9...v26.9.10) (2026-10-01)


### Features

* add Basic wallet billing for subscription bridges ([#125](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/125)) ([12f38d8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/12f38d86c6fd296aab272a290668372180100dcf))
* add Jev compliance checks to Studio and VS Code ([1a0ada5](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1a0ada541129e216d5ffa80c11cdfdee99278dea))
* add Links Code agent communication contract ([6b3eb7c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6b3eb7c70361046c23dca4a599103d3495200cc1))
* add orange RAG branding for RCH tokens ([26dd957](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/26dd9576f0166cfcdbbdad7f1d6003452b6ab741))
* add quoted RCH treasury redemption contract ([e0b1acd](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e0b1acdc588c233d3a7d3f605957beb29f8e1e69))
* add subscription account menus and Supabase ledger ([419421a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/419421a5f58dced957f302f9f24adccd3e2d8f9f))
* add verified treasury deployment with bounded fees ([eefd94a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/eefd94a2d924b74753946842fdadca1cbf7a7ab5))
* **rch:** make the sale USD price a deployment parameter, not a constant ([bed4c23](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/bed4c23e6c0ad0593dd767d2b4cb3da9bc4cf67d))
* record RCH mainnet market position ([f6a0b2d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f6a0b2d8bfed9e4ec3a75145b4994975d4280af1))
* redeem RCH to treasury for metered USD credit ([a105d6d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/a105d6d2e1a844ead0056024421082349d2715d3))
* restore RCH buying with two-sided Uniswap pool ([7fbfbec](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/7fbfbec6ac13312b0daf9f93110852779cddec51))
* split SimpleRAG into public and Admin editions ([#123](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/123)) ([e565108](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e565108b5367141ee4363012ff9509663c0fba64))
* **studio:** reveal a team member's status when its tile is clicked ([1b3d94a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1b3d94a869022222c494086fcbbafd546e75cb80))
* upgrade SignalREACH website chat ([7dce63a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/7dce63ae5f9122a82da9ef63c87b1a44a2e89950))
* **website:** expand heuristic chat interactions ([b4b7451](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b4b745158528c9d10f613dac781142c025c65699))


### Bug Fixes

* allow RCH prepaid credit to start model access ([bb44d8e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/bb44d8e0ba414503ac5dd5cc59dbd8a51ee5721d))
* forward RCH branding through account gateway ([ae4fab5](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ae4fab57c9278018c1b7b901d929c7401fa40cba))
* guard market-priced RCH redemption on mainnet ([9cf9e21](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9cf9e21849b449df322a074fae408c093cfdad5d))
* include Jev policy in Studio Docker image ([#126](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/126)) ([0d4f101](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/0d4f10187eee5df799e91fbfc094855a754cd5a6))
* **rch:** make the deployed contract the authority on credit bounds ([dce8050](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/dce805053eb5d5447c81a11a03ce4ee3e892d8c1))
* **rch:** make the treasury redemption quote signer rotatable and bound credit on-chain ([d7f4733](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/d7f4733443fa19454ee7e4ca0de82b27cf804583))
* recover stalled team agents and deliver peer messages ([b3795b8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b3795b8ef9ddacb93c958cb41c5bca7808a8f8fc))
* restore treasury setup wallet connection after reload ([adf6ee9](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/adf6ee97e3cf3ac07e3b0c02aa3b6a414fcdb5ff))
* serve RCH branding through wallet proxy routes ([576dfe6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/576dfe6d27f56a0d69c60ca1b6673f1efafd8f75))
* support delegated wallets in RCH treasury redemption ([60f7cb7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/60f7cb7f8b04c2d090a6d15ab935408ab04326c4))
* **website:** compact demo chat controls ([6c20996](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6c20996fe92696fc310a2bc03f7b19c7109edea3))
* **website:** preserve homepage design while expanding chat ([93e95d9](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/93e95d986cb3b04f4d234a7ed4c31f8f592cbd59))
* **website:** sync improved chat scrolling ([1a58734](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1a5873481a665a4537bc2c72b1f9a2350483a191))

## [26.9.9](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.8...v26.9.9) (2026-09-26)


### Features

* add RCH commands for Studio project terminals ([fd9c439](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/fd9c439d94dff934031bce53f4795eaf210d4cd3))
* add source module size budgets ([85f02b3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/85f02b324a38b9b3656d9c262616b367b623d6fd))
* deliver RCH purchases to treasury ([860b6b6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/860b6b6b9d2c11fc4cf928022cb77760b475f21c))
* enforce relay key quotas and expiry ([27b027a](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/27b027a43b920d159d544b7d7ec4ab5f7c1d5dc9))
* integrate Studio provider and relay updates ([60c98cb](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/60c98cb2bf98063ca1ba1a4d17ecb3fc4dea3c71))
* integrate wallet accounts with team updates ([592bfb1](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/592bfb1c98bdb4f9b94f7ee1aecb5b2978bd900a))
* **rch:** add credits contracts and deployment tooling ([2ba7c3b](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2ba7c3b47213943c2bd6d4ea45c82155544a1949))
* **rch:** add wallet accounts and shared model allowance ([55104c3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/55104c30080c7c7be377dee163ad89cbcda5acb3))
* restore team guidance and local evidence engines ([6df06b8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6df06b82c032cd128cc9269d4b0dbbde775c0be9))
* share activity panel with team agents ([d84999c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/d84999c98818c775a269517a557b82358f91c8fb))
* **studio:** add Home dashboard and quick tools ([32af057](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/32af05765da9721d6fe66695f8f74b8231af2ba8))
* **studio:** add native Reach workflows and command tabs ([b06f9b2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b06f9b2b41029056fbd3b970ea93273fd9ee44bd))


### Bug Fixes

* enforce team completion and Nurse recovery in runtime ([9117a04](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9117a047c7e7807500ec45c941df4d339dc6a83b))
* keep agent activity visible when expanded ([115e283](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/115e283fc1d6a2457c968187d799f7c7fbc3fb04))
* mark macOS fsevents optional in RCH lockfile ([e786fe3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e786fe369533c5b3b3a64726befa0adc3140ddef))
* open wallet login through ngrok account API ([c3d9ee3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c3d9ee3a07b4bed3641b3e965b0dcce8a6cbc59b))
* recover bridge and team failures without false answers ([8bd812d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8bd812dd505a736365eccbe01906059080ccaa5c))
* recover Reach Studio from ngrok tunnel 503 ([602a06e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/602a06ebd2cbf096a384d17e53a12d8f1a412c9b))
* send ngrok header from wallet page ([56999a0](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/56999a0c8d8fd871d6aa624fee2a22da2d1fb087))
* **studio:** restore portable smoke and packaged engine ([537322c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/537322c4032335c0ee91118e39bf1cefaf23066a))
* **studio:** run project commands beside optional Reach CLI ([#110](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/110)) ([f351840](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f351840cce6fe261464c76e508756e61f0654e76))

## [26.9.8](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.7...v26.9.8) (2026-09-23)


### Features

* **studio:** complete agent engine through E19 ([#106](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/106)) ([8bc0c06](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8bc0c06462bf8efe54930867aaa25f92869e5722))
* **studio:** pace provider requests per endpoint and enforce global-only budget fields ([7f0381d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/7f0381d42d3e9e7e75b8c47b3251f27cf3396905))
* **studio:** show reasoning on hover ([abd9b5e](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/abd9b5e2fa5c68d3ae962619f69296ac9466b9d0))


### Bug Fixes

* **ci:** regenerate the stale plan baseline and stop it going stale again ([#107](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/107)) ([e5e5e7b](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e5e5e7bd0355cf1583e55c2990ae6150f36cf65b))
* **release:** align Studio version files and changelog ([#108](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/108)) ([6a8c48d](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6a8c48dc20b8799c2ee142c7725dc2820e356138))
* **studio:** keep thought hover card in view ([9dcd5dd](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/9dcd5dd2dee11c28ca633a6c4d914667160aa811))

## [26.9.7](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.6...v26.9.7) (2026-09-23)


### Bug Fixes

* **studio:** stop a pasted /v1/models endpoint producing a doubled version path ([#104](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/104)) ([836e0d7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/836e0d7e5b81c558e7aa5ca7d83e8a0af4fce87a))

## [26.9.6](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.5...v26.9.6) (2026-09-22)


### Features

* add composer routing and persistent model details ([2b760d2](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2b760d25d7f04a20ec964ef887fcb30729d78ef7))
* add Jev Auto routing and compact chat controls ([67cdae6](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/67cdae64f6585997969f01c69a1572b983d34f11))
* add persistent team chat and conversation follow-ups ([6fb2066](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/6fb20663b3a96ba96a1fc93b8ad52497ace70c22))
* add work-conserving Team Nurse ([b1acfae](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/b1acfae55ea7e637c1614a4564abd90acb8b99c5))
* **bridge:** stream the agent's reasoning and edits to clients ([3a480d7](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/3a480d7eab327b1283bc45426b6a9750634d17fc))
* **studio:** add agent soul and memory, cap conversations ([1b51486](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/1b51486c0d6fe6f2387ae1720e061116cbe99872))
* **studio:** add project removal and include browser engine updates ([ff56eda](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ff56eda1a9b9355684815c5fb47b6c7713e1bb0b))
* **studio:** harden agent recovery and implement improvement plan ([a0fe80c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/a0fe80c8ad033b3a3e2187a698666e674a52911d))
* **studio:** refresh team UI and consolidate app improvements ([4924b31](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/4924b31ecddd4c7a626a159bba3aecb3cf0870af))


### Bug Fixes

* show full composer suggestions on hover ([fe13911](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/fe13911cc930b7437a5e97376c9bf6c5251165a2))
* **studio:** align embedded browser bounds with app zoom ([e6cd493](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e6cd49335458d40b257f9e924f108f5b9ff67bf8))
* **studio:** center cards and unblock Links completion ([0749309](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/0749309c71379835566ffc60e1fb66ad3c0e4015))
* **studio:** collapse activity by default and bound expanded traces ([895ec32](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/895ec32b526e63622aa9f3bb44b5fea8c739041f))
* **studio:** isolate concurrent team runs by conversation ([e4d2cc3](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/e4d2cc3374734ba3f8c37dc55ebbd15424d6ef02))
* **studio:** restore free Agents scrolling beneath pinned headers ([2b74104](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/2b7410411bed2f05eb7c8de1686ac99420485279))
* **studio:** reuse team decks and recall tabs on upward scroll ([c338dfb](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/c338dfbcd7178f4b622699d1ac84f6fd96d2b45f))
* **studio:** tighten AI response spacing ([15c878c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/15c878c877f000ca73a1f342552d631afe8709b1))
* **tray:** keep the browser bridge alive and explainable ([ad30b26](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/ad30b2668deac050ca34e395790ccc56865070bf))
* **tray:** never drop the end of a browser-provider answer ([f280fdf](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/f280fdffa2c09a72085fe2f21c0e98306933dcda))
* **tray:** resume CodeGPT runs the upstream cut mid-stream ([0061b12](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/0061b128652b5178e67875130cb4de1457b444aa))

## [26.9.5](https://github.com/falabellamichael/SignalR.E.A.C.H/compare/v26.9.4...v26.9.5) (2026-09-19)


### ⚠ BREAKING CHANGES

* **relay:** require an API key by default and harden access control ([#91](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/91))

### Features

* **relay:** require an API key by default and harden access control ([#91](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/91)) ([8e077a8](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/8e077a8109f2c84875fa99ac80355da3d7667259))
* **studio:** crew roles, Links mode, output-dialect recovery and team tool protocols ([#90](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/90)) ([577dd58](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/577dd58829984492b12c19b1f9919205e554baa9))
* **studio:** multiple endpoint connections with per-connection keys ([#88](https://github.com/falabellamichael/SignalR.E.A.C.H/issues/88)) ([fce1b9c](https://github.com/falabellamichael/SignalR.E.A.C.H/commit/fce1b9c652dd8c57869a0e9b44b48120a457b0e6))

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
