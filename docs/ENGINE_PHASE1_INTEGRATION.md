# Phase 1 engines in Studio and VS Code

The Teams pass created `reach_studio/` Python prototypes in the SimpleRAG checkout.
Those remain standalone reference implementations. REACH Studio and the extension
run the shared Node implementation in `vscode/engine-core.js`; neither installation
requires Python. Studio's builder copies that exact source into
`resources/engine-core.cjs`, loaded through `studio/agent/engines.cjs`.

## Live integration

| Capability | Studio | VS Code extension |
| --- | --- | --- |
| Versioned observations | Tool dispatcher records real results and observation IDs | Host records tool/edit results, including IDE bridge failures |
| Evidence ledger | Agent/Team completions become unverified claims | Structured agent completions become unverified claims |
| Write gate | Agent writes, accepted proposals, editor saves and refactor transactions | Agent edit cards and patch tools, preserving native editor Undo |
| Receipts | Exact disk byte hashes, including text BOMs | Buffer hashes with explicit `editor` or `disk` storage status |
| Review scoring | Edit-card details and refactor chunk metadata | Native review diff title |
| Secret hygiene | Shared redaction before engine evidence persistence | Same implementation and rules |

Engines are local deterministic code and make no model calls. They do not add
engine reports to every prompt. Existing Jev routing and Nurse delivery are
separate from these engines and keep their existing settings and request costs.

## Inspect activity

- Studio: Settings → Budgeting → Local engines → Refresh engine report.
- VS Code: run **REACH: Engine Report** from the command palette.
- Studio ledger: `engine-ledger.jsonl` under Electron's user data directory.
- Extension ledger: `engine-ledger.jsonl` under the extension's global storage.

Records retain redacted claim excerpts, hashes and metadata, not raw tool arguments
or tool-result bodies. The report includes the last 50 records; memory retains up
to 1,000 records and the log rotates at 4 MiB. Persistence failure is visible in
the report and does not silently claim durable evidence.

## Write and review behavior

Protected paths include credentials, `.env*`, key/certificate files, `.git`,
migrations, release metadata, packaging and database directories, and the build
and dependency files specified by the prototype contract. Edit those manually
outside the agent write flow. Paths are checked against the real project root,
including symlink/junction escapes. Refactor plans validate all targets before
any write, and retain the existing transactional rollback.

Accepting a Studio proposal verifies its original disk hash. A stale proposal,
including a legacy pending proposal without a snapshot, requires refresh. This
prevents accepting an old card from overwriting newer work. Single-file writes
use a sibling temporary file and atomic replacement while retaining encoding.
VS Code keeps unsaved documents unsaved and distinguishes buffer receipts from
saved-file receipts. Receipt hashes describe the observed result, not a promise
that a save hook preserved the proposed text unchanged.

## Limits

- This integrates the implemented Phase 1 capabilities: E1, E4, P1, P2 and P5.
  The remaining roadmap engines are not implemented by this integration.
- Review scores are heuristics; unflagged does not mean proven safe. The native
  JavaScript diff/refactor selection remains in use; Python AST chunking is not
  invoked by either app.
- Claims remain unverified by default. The core supports explicit corroboration
  with two distinct successful tools in the same scope; the report UI is read-only.
- Shell commands, arbitrary extension commands and external tools retain host
  approval/sandbox rules. The file write gate is not an operating-system sandbox.
- Existing conversations, provider configuration and pending edit payloads keep
  their existing storage format. Engine-log redaction is not a retroactive scrub
  of all chat history or configuration files.
- Receipts do not replace backups or create persistent cross-session Undo.

## Verification

`npm test --prefix studio` includes `studio/test/engines.test.cjs` (real tool
dispatch, protected writes, stale review, UTF-16 receipts, refactor containment,
redaction and evidence independence). `npm test --prefix vscode` includes actual
host-handler tests for protected edits, dirty buffers and the report command.
`studio/test/team-conversation-ui.cjs` runs the real main/preload/renderer against
a local fake provider and verifies the report, receipts, protected writes and
Team completion claims alongside Jev/Nurse/queue fixtures.
