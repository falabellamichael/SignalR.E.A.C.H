# REACH Credits (RCH)

RCH is an Ethereum ERC-20 currency with an open ETH purchase contract. The initial sale targets **$0.01 per RCH**, using an ETH/USD oracle. **1,000 RCH costs approximately $10 plus gas.** The implemented redemption conversion is **1 RCH to 1,000,000 AI usage tokens**. Live deployment, actual subscription limits, automated subscription checkout, and public liquidity pools are later work.

Studio wallet sign-in links a verified customer wallet to an account and an operator-provisioned subscription. **CodeGPT and qualified free endpoint models share one plan allowance.** Redemption burns RCH and credits the account once after verified finality; model calls then consume that ledger. CodeGPT currently lacks reliable usage records and remains unavailable for paid metering. Live redemption is disabled until deployment. See [Studio access, accounting, and host setup](../docs/RCH_STUDIO_ACCESS.md).

The contracts are implemented, tested locally, and deployed to Ethereum Mainnet. They have not been independently audited. This directory uses Solidity and Node.js through REACH Studio's **Project command** runner.

The deployed RCH token is `0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792`; its sale is `0x0aE51b14eBa99C472a40F798296B3EAa2be2947B`. Deployment transaction: `0xad758e98c78c1ccdeb33e1d23118bd30a9fa1560e685cfd93ad3c89e770028ad` (block 26051181). The simple terminal commands pin the runtime hashes in `terminal/mainnet.json` and check live state before preparing operations. Use `rch status` for current pause and ownership state.

## Run locally without Docker

Select this `RCH` directory as the project, choose **Project command**, then run each command separately:

```text
npm ci --ignore-scripts
npm run compile
npm test
npm run demo
npm run demo:purchase
```

Node.js 22.13 or newer is required. `demo` creates an ephemeral Ethereum chain inside the process, deploys RCH and its sale, purchases 1,000 RCH for 0.004 test ETH at a mock $2,500/ETH quote, mints an authorized reward, transfers RCH, delivers the sale proceeds, and closes the sale. It needs no wallet, RPC endpoint, Docker, or running Ganache server. The chain disappears when the command exits. Ganache's native-module fallback notices on Apple Silicon do not prevent these tests from running.

`demo:purchase` runs a focused, no-cost 0.001 test ETH purchase on the same ephemeral chain. One local account deploys, administers, and buys; a separate local treasury receives the ETH. Pass `-- --treasury PUBLIC_ADDRESS` to test delivery to a particular public wallet address. It prints transaction hashes and verifies that the buyer received RCH, the treasury gained 0.001 test ETH, and the sale retained no ETH. Its accounts and funds do not exist on mainnet.

## Currency and issuance

- Name **REACH Credits**, symbol **RCH**, decimals **18**, initial supply **zero**.
- No preset supply cap. Authorized issuance can continue; total supply is finite and visible at every point in time.
- Paid issuance requires `SALE_MINTER_ROLE`. The initial sale receives it atomically at deployment.
- Rewards require both `REWARD_MINTER_ROLE` and an explicit remaining allowance. A grant of 25 RCH allows at most 25 RCH of new rewards until replenished. Amounts use 18-decimal base units.
- Every reward has a unique, nonzero `bytes32` reference. Reusing it fails, even across different reward operators. Use an opaque ID, never customer information. A failed mint consumes neither its ID nor its allowance.
- Revoking or renouncing a reward role clears its allowance. Regranting the role starts with zero allowance.
- The token administrator may pause new issuance while existing transfers and approvals continue.
- `totalPurchased` and `totalRewarded` provide separate issuance totals. No transfer tax or automatic rebasing is implemented. `redeem(amount, redemptionId)` burns the caller's RCH for usage; redemption starts paused and is independent of issuance pause. `totalRedeemed` and `totalUsageTokensRedeemed` track confirmed contract redemptions. Subscription accounting lives in the hosted service.

RCH is minted under these rules. Ethereum mining does not create it. The administrator controls roles and budgets and can authorize other sale contracts; the system therefore trusts that administrator. Reward allowances constrain reward operators, not a malicious administrator. The two-day administrator transfer delay applies to changing the default administrator; role grants and budget changes are immediate. The administrator receives no minter role automatically.

## Purchase behavior

The sale starts **paused**. The configured administrator must call `unpause()` to open it. The feed must identify itself as `ETH / USD`, report eight decimals, and return a positive, complete, current round inside the configured price bounds. The feed's description is a configuration check, not proof of authenticity: verify its address and network against the feed provider's official registry.

The minimum payment is **0.001 ETH**, plus network gas. The contract computes output using full-precision integer arithmetic and rounds down. Buyers supply a nonzero minimum RCH amount and a deadline. ETH, treasury delivery, and minted RCH either settle together or the transaction reverts. Each purchase sends its ETH directly to the immutable treasury; failed delivery rolls back the purchase. Anyone may call `withdrawProceeds()` to deliver ETH that reaches the sale outside a purchase. Treasury callbacks cannot withdraw twice.

The administrator can pause purchases or permanently close this sale. Closing it does not freeze RCH or stop independently authorized rewards. It also does not prevent the token administrator from authorizing a replacement sale. Opening an uncapped sale at $0.01 can constrain a later market price through arbitrage; the sale target never guarantees a resale price.

The administrator uses a two-step ownership transfer for the sale. Ownership renunciation is disabled so a paused sale cannot accidentally lose its administrator. Oracle address, freshness limit, bounds, and treasury are immutable. If they must change, deploy a replacement `ReachCreditsSale` for the existing token, grant its sale role, revoke the old role, and close the old sale. The treasury must be able to receive native ETH; a permanently rejecting treasury needs its own receiving behavior repaired.

## Encrypted local wallet on macOS

From this `RCH` project directory:

```text
npm run rch -- wallet-create --wallet primary
npm run rch -- wallet-info --wallet primary
npm run rch -- wallet-check --wallet primary
```

Creation generates a new Ethereum account with the operating system's cryptographic randomness, encrypts its single-account private key as a standard Ethereum V3 JSON keystore, and saves a separate randomly generated 256-bit unlock password in macOS Keychain. It uses the installed [ethers wallet implementation](https://docs.ethers.org/v6/api/wallet/). There is no separately retained seed phrase. You can replace the initial generated password with your own using the hidden Terminal prompt below. No RPC endpoint, ETH, or blockchain transaction is needed to create or check the wallet.

The encrypted file is stored at `~/Library/Application Support/REACH Credits/wallets/primary/wallet.json`, outside the repository. Directories use mode 700 and files use mode 600. The matching Keychain service is **REACH Credits CLI**, with the public wallet address as its account. Private keys and passwords are never included in CLI output, command arguments, repository files, or environment variables. The password crosses a local subprocess pipe in memory; this is a software wallet, not hardware isolation. Other programs running as the same macOS user may be able to use an unlocked Keychain through Apple's `security` utility. No per-signature confirmation is enforced by this storage layer.

`wallet-info` reads only the public address in the keystore. `wallet-check` unlocks the encrypted file, verifies the recovered address, and signs and verifies an offline diagnostic message. It does not send that signature or a transaction. Creation refuses to overwrite an existing wallet directory, even after an incomplete attempt. If creation fails, preserve its files and inspect the matching Keychain item before retrying recovery.

### Choose your password and verify recovery

Run this in **macOS Terminal**, not the Projects command log, so password input can be hidden:

```text
npm run rch -- wallet-password --wallet primary --out /path/to/new-backup.json
```

Choose a passphrase of at least 12 characters using English letters, numbers, spaces, or punctuation (maximum 256 characters). Enter it twice. The current password is read privately from Keychain. The same private key is re-encrypted, so the public address stays the same. A fresh Keychain item is verified before the active file is replaced atomically. The previous encrypted file and its matching Keychain item are retained for recovery if interrupted. Existing backup output paths are never overwritten. If `--out` is omitted, copy the new active `wallet.json` yourself.

Prove your backup is usable without the original Keychain:

```text
npm run rch -- wallet-verify-backup --file /path/to/new-backup.json --address YOUR_PUBLIC_ADDRESS
```

Enter the backup password privately. This reads only the supplied file and performs an offline signing check; it never uses Keychain or sends anything. Preserve the file and password separately before erasing this computer.

On a fresh Mac with the RCH CLI installed:

```text
npm run rch -- wallet-import --wallet primary --file /path/to/new-backup.json
```

Enter the backup password. Import verifies the account and creates a new local Keychain entry; it refuses to replace an existing wallet. Use another wallet name if needed. The encrypted JSON file and its password also work with [MetaMask Extension's JSON import](https://support.metamask.io/start/use-an-existing-wallet#how-can-i-import-my-private-key-using-a-json-file), without installing the RCH CLI. This JSON flow is available in the extension, not the mobile app.

Changing a file password does not revoke older backups. Every prior encrypted copy remains usable with its matching old password. Git history can retain earlier encrypted versions; passwords must remain separate from any backup repository.

**Back up before funding.** Copy the current `wallet.json` to an offline backup device. If you need to inspect the saved password in **Keychain Access**, use the exact `keychainAccount` shown by `wallet-info`, then **Show password** after authenticating to your Mac. Password changes retain older Keychain entries, so select the current one. Record that password securely and separately from the encrypted file. Both are required to restore the account; keeping them only on this Mac is not an independent backup. Per-wallet instructions are saved beside the keystore in `BACKUP.md`. Do not send the password, seed phrase, or private key through chat.

To use this account as a deployment signer, set the configuration's public `deployer` address to the address from `wallet-info`, then add `--wallet primary` to the existing `deploy` command. This replaces `RCH_DEPLOYER_KEY`; supplying both is rejected. Deployment still requires `--broadcast`, chain confirmation, a fresh plan, a matching signer, and the configured fee ceiling. Wallet creation does not assign administrator or treasury roles; those public addresses remain explicit deployment choices. Use a separate wallet name for testnet experiments. RCH has not been deployed just because a wallet exists.

## Simple Projects terminal commands

The deployed Ethereum Mainnet token can be used from Studio's **Project command**
mode, including the Home mini terminal. Install this checkout's dependencies and
command once from the repository root:

```text
npm --prefix RCH ci
npm --prefix RCH run install:cli
rch browser opera
rch connect
rch status
rch balance
rch quote 0.0005
rch buy 0.0005
```

`rch open-sale` prepares the owner's activation; an already-open sale is reported
without a new transaction. `rch tx 0xHASH` reports confirmed, failed, or
pending/unknown receipt status and actual gas when available. `rch wallet 0xADDRESS`
selects an address for public balance checks without connecting a wallet.
`rch ui` opens the complete management page. `rch help` lists options.

The values in `quote` and `buy` are ETH purchase amounts, with gas additional.
`--max-fee 0.0002` is the default maximum gas allowance per operation. The CLI
checks bytecode against the verified mainnet runtime hashes, sale state, balances,
oracle quotes, and gas. `--rpc` or `RCH_RPC_URL` can select another HTTPS Ethereum
RPC. `--no-open` prints the approval URL without launching a browser.

`buy` and `open-sale` never sign or broadcast through the CLI: they open a local
MetaMask review page. Connecting generates a fresh quote for the requested action;
the user must review and confirm it in MetaMask. Keep the command running while
reviewing. A session expires after 15 minutes. Stop does not cancel an on-chain
transaction. Pending attempts block repeats; public transaction records survive
process restarts outside the repository. The wallet's password and private key
are never requested or imported by these commands. AI redemption remains a
separate service feature.

The executable uses the current Node installation and this checkout's files. Run
the installer again after moving the repository or replacing that Node installation.
Without installation, use `npm run rch -- help` at the repository root, or
`npm --prefix RCH run terminal -- help`. The existing administrative
`npm --prefix RCH run rch -- ...` commands below remain available.

## Deployment workflow

`ReachCreditsLaunch` is the RCH token and creates its initial sale inside its constructor. One transaction deploys both and assigns the sale's mint role. The configured administrator owns both administrative surfaces immediately. The deployment signer receives no temporary administrator privilege. No reward operator is enabled, and the initial sale stays paused.

1. Copy `config/example.json` to a local configuration and replace all address placeholders. Set the intended network, administrator, payable treasury, deployer, verified ETH/USD feed, acceptable oracle age, explicit price bounds, and maximum deployment fee. The example bounds and age are illustrative; choose them from the actual feed's heartbeat and your operating limits.
2. Set `RCH_RPC_URL` in the process environment. Use the correct network's feed address from the [official registry](https://docs.chain.link/data-feeds/price-feeds/addresses). The tool supports Ethereum mainnet (1), Sepolia (11155111), and loopback local chains (1337 or 31337). L2 deployments need additional oracle outage handling and are not supported by this workflow.
3. Create a `deployments` directory, then prepare an unsigned plan:

   ```text
   npm run rch -- prepare --config config/my-sepolia.json --out deployments/sepolia-plan.json
   ```

   This checks network, oracle, nonce, deployment estimate, and fee budget. Review the addresses, source hash, unsigned transaction, and maximum ETH fee in the plan. It never reads a signing key or sends a transaction. `artifacts/build-info.json` contains the exact standard JSON compiler input including dependencies for reproducibility and explorer verification.

4. To deploy a reviewed Sepolia plan, provide `RCH_DEPLOYER_KEY` through the local environment, or use `--wallet NAME` with a locally created test wallet, and run:

   ```text
   npm run rch -- deploy --plan deployments/sepolia-plan.json --out deployments/sepolia-deployment.json --broadcast --confirm-chain 11155111
   ```

   This command sends a transaction. Use a separate test wallet. Never include a key in command arguments, commit it, or paste it into chat. Plans expire after 15 minutes. The signing account, chain, source, and nonce must still match; fees are refreshed within the configured budget. The script reconstructs deployment data from the current verified build rather than signing transaction data from a plan file. A record with the signed transaction hash is saved before sending. An existing output path stops a second broadcast.

5. Verify a deployment or recover from an uncertain RPC response:

   ```text
   npm run rch -- verify --manifest deployments/sepolia-deployment.json
   ```

   Verification checks the receipt, deployed runtime code, token/sale connection, and immutable settings. It reports current ownership, supply, mint authority, and pause state. The initial deployment also verifies zero supply and the configured administrator. Verification is a current chain snapshot, not a finality guarantee. Preserve the deployment record and resolve its transaction hash before deploying again.

6. After checking the deployment, the sale owner can call `unpause()` using its wallet or multisig. The token administrator can separately grant `REWARD_MINTER_ROLE` and set a reward allowance. The two admin addresses initially match but use independent transfer procedures.
7. Generate a purchase quote and unsigned transaction for a buyer's wallet:

   ```text
   npm run rch -- quote --manifest deployments/sepolia-deployment.json --eth 0.001 --slippage-bps 50
   ```

   This verifies deployed code and active sale state, then returns the ETH value, RCH quote, 0.5% minimum-output tolerance, and ten-minute deadline. It does not sign or send a purchase. Payments below 0.001 ETH are rejected; gas is additional. Prices and the configured oracle bounds may change what the next quote permits.

Mainnet uses chain ID 1. The existing deployment above was checked against the compiled runtime and constructor settings; this is not an independent security audit. New deployments should be rehearsed on testnet and reviewed independently. Do not promise funded AI usage solely because an RCH transfer succeeded: the hosted redemption system must be configured for the reviewed deployment and verify a matching burn before crediting usage exactly once. The $0.01 sale target is not evidence that serving a million model tokens costs $0.01.

### Local MetaMask launch review on Windows

For a reviewed Ethereum mainnet configuration, prepare `private/mainnet-plan.json` with the `prepare` command above, using chain ID 1 and a current HTTPS mainnet RPC in `RCH_RPC_URL`. The plan and compiled artifacts must match the current source. The plan expires after 15 minutes for deployment, so prepare a new one after funding and immediately before signing. Preserve an earlier plan and any transaction record when a request's result is uncertain; never overwrite a record to retry a deployment.

Run `npm run launch-ui` from this directory with the same `RCH_RPC_URL`, then open `http://127.0.0.1:8765/` in Edge with MetaMask. The server binds only to loopback and serves the reviewed plan, compiled artifacts, and launch page. It does not access the encrypted wallet backup or sign transactions. The page checks the connected mainnet account, reconstructs deployment data from the compiled artifact, verifies the feed and nonce, and asks MetaMask to approve each transaction. The reviewed deployment payer may differ from the treasury; the administrator must be one of those two accounts. It saves the returned deployment hash in ignored `deployments/mainnet-deployment.json`; run `npm run rch -- verify --manifest deployments/mainnet-deployment.json` to inspect the deployment independently. Opening the sale requires a separate MetaMask transaction from the administrator after the deployment is finalized and its runtime matches the reviewed build. The deployment payer can then request a live 0.001 ETH quote and approve the purchase in MetaMask. Network gas is additional for every transaction.

## Verification coverage

Tests exercise atomic deployment, absence of deployer privileges, role restrictions, reward budgets and replay protection, issuance pause, ERC-20 transfers and allowances, quote arithmetic and rounding, invalid oracle rounds, buyer protections, payment rollback, treasury rejection/reentry, ownership transfer, irreversible sale closure, and delayed token administrator transfer. Wallet tests exercise encrypted recovery, offline signing, secret-free output, restrictive permissions, incorrect passwords, address tampering, symlink rejection, overwrite prevention, password changes with preserved old recovery data, failed-update recovery, hidden input, and restoring a portable backup with an empty Keychain. Tool tests exercise deterministic builds, mismatched chains and signers, changed nonces, fee ceilings, output collision, deployed-code verification, unsigned purchase execution, and RPC uncertainty recovery.

Production compilation excludes mocks and saves ABI, creation/runtime bytecode, immutable references, metadata, compiler version, source hash, and all compiler input sources. Solidity and OpenZeppelin versions are pinned in the lockfile. Generated artifacts, deployment records, and environment files are ignored by Git.

References: [OpenZeppelin access control](https://docs.openzeppelin.com/contracts/5.x/access-control), [Chainlink feed selection](https://docs.chain.link/data-feeds/selecting-data-feeds), [Chainlink API](https://docs.chain.link/data-feeds/api-reference), [Ethereum networks](https://ethereum.org/developers/docs/networks/).
