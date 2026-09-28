# RCH token branding

The token uses the existing orange-background SignalRAG/SimpleRAG artwork, copied unchanged from `assets/branding/simple-rag/simplerag-icon-on-orange.png` in the RAG project with the owner's approval.

- `rch-logo.png`: original 1024 × 1024 PNG; SHA-256 is recorded by Git content history.
- `tokenlist.json`: Ethereum-mainnet RCH metadata in the Uniswap Token Lists format.
- `index.html` and `add-token.js`: public `/wallet/rch` page with an explicitly requested MetaMask token-display import. It never requests a spending approval or sends a transaction.

Public logo: https://raw.githubusercontent.com/falabellamichael/SignalR.E.A.C.H/main/RCH/branding/rch-logo.png

Public token list: https://raw.githubusercontent.com/falabellamichael/SignalR.E.A.C.H/main/RCH/branding/tokenlist.json

Uniswap's global token icons are sourced from CoinGecko. Publishing this token list and using `wallet_watchAsset` does not register the token with CoinGecko, update every user's wallet, or remove security warnings. The CoinGecko listing/update submission remains a separate step. See https://support.uniswap.org/hc/en-us/articles/29883356032525-How-do-I-change-my-token-s-logo-or-information-on-Uniswap-interfaces.
