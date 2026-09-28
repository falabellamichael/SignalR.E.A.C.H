# Treasury redemption deployment review

From `RCH`, compile and start the loopback helper with the quote signer's public address:

```powershell
npm run compile
node scripts/treasury-deployment-ui.mjs --quote-signer 0xPUBLIC_ADDRESS --readiness-file C:\absolute\private\treasury-redemption-ready.json
```

Open the printed URL in the browser containing MetaMask. Connect Account 1 (`0xDa68602c9d65337C75BF0593972d9731895592e3`), then use **Review deployment in MetaMask**. The helper creates no signature and never receives a private key. The contract starts paused and uses the fixed RCH token and receiving treasury (`0x5b7a910cDF232543aCB7653D71d6B92f01d342C7`).

**Check current status** verifies the transaction envelope, receipt, compiled runtime, immutable values, and owner. The verified deployment and artifact are saved in ignored `deployments/mainnet-treasury-redemption.json`. A saved transaction blocks another deployment; its hash can also be restored with **Verify deployment receipt**.

After the account backend is configured for the actual deployed address and its credit flow has passed validation, the operator may write the private readiness file:

```json
{
  "backendReady": true,
  "chainId": 1,
  "contractAddress": "0xACTUAL_DEPLOYED_ADDRESS",
  "token": "0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792",
  "treasury": "0x5b7a910cDF232543aCB7653D71d6B92f01d342C7",
  "quoteSigner": "0xPUBLIC_QUOTE_SIGNER",
  "checkedAt": "CURRENT_ISO_TIMESTAMP"
}
```

The file must match the exact deployment and be at most one hour old. Refresh the page to enable the separate **Review activation in MetaMask** button. Activation always requires another explicit wallet review. The HTTP server never broadcasts or signs transactions.

For an EIP-7702 delegated owner, activation uses `wallet_sendCalls` only when the wallet reports existing atomic-call support. MetaMask estimates the complete wallet operation and displays its fee; the helper's direct-call estimate is not a fee cap for the wallet operation. The helper persists the call ID before requesting review and checks `wallet_getCallsStatus` afterward. A wallet call ID is not an Ethereum transaction hash. The helper records activation only after independently verifying the successful activation event and the adapter's current unpaused state. An uncertain wallet result never triggers an automatic second request.

Run focused protection tests with `node --test test/treasury-deployment-ui.test.mjs`.
