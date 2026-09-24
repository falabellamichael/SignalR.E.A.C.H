# SimpleDAPP agreement example

`index.rsh` is the Reach contract. It lets Alice propose a whole number and a tolerance, then Bob submit a response. The contract checks that every input is at most 10,000, calculates the absolute difference, and tells both parties whether the response is within the tolerance. It does not transfer funds or mint tokens.

`index.mjs` is the Node frontend. Reach compiles `index.rsh` into `build/index.main.mjs`; Node runs `index.mjs`. The frontend supports a local two-account demo, separate deploy and attach sessions, named environment variables for account secrets, chain and backend checks, optional JSON event output, an optional session report, and a timeout.

## Run in REACH Studio without Docker

1. Select **SimpleDAPP** in Projects. In **Project command** mode, run `npm install` once to install the pinned Reach JavaScript library in this project.
2. In a **Project command** tab, start Ganache and leave that tab running:

   ```text
   ganache --server.host 127.0.0.1 --server.port 8545 --chain.chainId 1337 --logging.quiet
   ```

3. In a **Native Reach** tab, run `compile index.rsh`.
4. In another **Native Reach** tab, run:

   ```text
   run index.rsh -- demo --proposal 42 --tolerance 5 --response 45
   ```

   Alice proposes 42, Bob responds with 45, and the difference of 3 is accepted because the tolerance is 5. Try `--tolerance 1` to see a rejected outcome.

To test separate participants, use two Native Reach tabs. First start Alice:

```text
run index.rsh -- alice --devnet-test-account --proposal 73 --tolerance 4 --timeout-seconds 120
```

Alice writes `contract-info.json` and waits. In the second tab, start Bob:

```text
run index.rsh -- bob --devnet-test-account --response 80 --timeout-seconds 120
```

Bob checks the stored connector, chain ID, compiled backend fingerprint, and deployed contract before attaching. These commands use newly funded local Ganache accounts. For persistent accounts, set `REACH_ALICE_SECRET` or `REACH_BOB_SECRET` in the process environment, then omit `--devnet-test-account`. Never put private keys in command arguments or commit them to Git.

Pass `--json` for newline-delimited event records, `--report-file path.json` for a session report, or `--help` for every option:

```text
run index.rsh -- --help
```

The frontend defaults to `ETH-devnet` at `http://127.0.0.1:8545`. Demo and funded devnet accounts require a loopback Ganache node. Running against `ETH-live` requires an explicit `--allow-live` and an account secret from the environment; that mode sends real transactions.

The Reach [frontend guide](https://docs.reach.sh/frontend/) describes its JavaScript stdlib, and the [tutorial](https://docs.reach.sh/tut/rps/) shows the same participant, publication, commit, and callback pattern.
