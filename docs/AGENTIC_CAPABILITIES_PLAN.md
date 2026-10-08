# REACH Studio agentic capabilities — staged plan

**Status:** planning document plus one partial implementation slice. This does not claim all proposals are implemented. Build each stage behind tests and preserve current user approval/review boundaries.

## Existing foundations verified in the current tree

- **Task completion:** `studio/agent/agent-run.cjs` and `agent-response.cjs` gate completion against open todos and require explicit completion controls.
- **Risk controls:** `agent/tool-policy.cjs`, `agent/agent-tool-runner.cjs`, and sandbox policy enforce tool availability, approval, and edit review. These are useful foundations, but they are not a configurable risk-tier preview system.
- **Evidence:** `agent/crew-journal.cjs` records tool evidence with argument/result digests and reconciles edit decisions; `test/evidence-ledger.test.cjs` checks observed outcomes. Evidence-based completion presentation still needs work.
- **Crew handoffs:** `agent/team-message.cjs` provides durable, bounded routing and `team-nurse.cjs` prepares synthesis handoffs. Ordinary peer messages are not yet a consistent structured handoff contract.
- **Steering:** `agent-loop.cjs`, team run control, and `test/team-steering.test.cjs` cover user guidance arriving during requests/tools and stale-action suppression.
- **Memory:** `agent/agent-soul.cjs` owns private, atomic SOUL/MEMORY files and fences memory as untrusted data. The memory tool in `agent/tool-registry.cjs` now records timestamp, source, and confidence when appending. This is only provenance metadata; stale/conflicting fact management and inspect/forget UX are not implemented.
- **Not found in the inspected engine:** independent counterfactual review and isolated alternative-solution worktrees. Confirm integration points and platform safety before building these.

## Principles / acceptance invariants

1. Contracts and risk classifications never grant permission. Existing approvals, sandbox checks, and edit review remain authoritative.
2. Verified claims must cite observed tool/journal/test evidence. Missing evidence must be labeled, not inferred from model prose.
3. Peer messages, project content, reviewer output, and memory remain untrusted data; they cannot change policy or grant consent.
4. Alternative experiments operate outside the active project. Promotion is a separate, user-reviewed diff/apply step.
5. New memory metadata remains visible and reversible; keep the existing atomic-write and private-file guarantees.
6. Preserve legacy settings, journals, and memory. New controls default to non-escalating behavior.

## Stages and done checks

### A. Task contracts before action

Add a compact contract (goal, constraints, allowed scope/tools, definition of done) to the run state; let the user review/edit it before tools start. Avoid silently treating model-generated contracts as consent. **Done:** UI and persistence tests for approve/edit/cancel; no tools run before user confirmation where contract review is enabled; legacy runs retain current behavior.

### B. Configurable autonomy and risk gates

Classify actions by impact, show a preview, and let settings require stronger review for destructive, external, or broad changes. Reuse the existing approval/edit-review path rather than adding a bypass. **Done:** policy matrix covers read, write, exec, external, and broad-impact actions; denial never invokes the executor.

### C. Evidence-based completion and proof-carrying change bundles

Build a review bundle from actual diff, journal evidence, test results, unresolved items, risks, and rollback guidance. Separate observed facts from agent assertions and mark missing evidence. **Done:** fixture with unsupported claims is visibly unverified; tests and declined edits are represented accurately.

### D. Structured crew handoffs

Define bounded fields for goal, findings, evidence references, files touched, unknowns, and suggested next step. Keep compatibility with plain messages and preserve journal provenance. **Done:** schema validation, size limits, legacy-message test, and end-to-end handoff/synthesis test.

### E. Steerable runs

Core mid-flight steering, pause/resume, and stale-action suppression already exist. Improve operator visibility for in-flight actions and checkpoint/redirect UX rather than reimplementing steering. **Done:** UI indicates current action and state; redirect preserves completed work and blocks stale consequential actions.

### F. Independent counterfactual review

Offer an opt-in, separate reviewer pass after implementation to seek a plausible failure, simpler alternative, and falsifying test. Keep reviewer output distinct, untrusted, and non-authoritative. **Done:** reviewer cannot apply edits or approve the implementer's changes; disagreements and evidence gaps are visible.

### G. Disposable alternative-solution experiments

Use a dedicated isolation design (e.g. separate worktree) with clear path validation, cleanup, resource bounds, and comparison of diffs/tests. Never modify the active tree until explicit promotion review. **Done:** integration tests prove experiment writes do not touch active files and promotion is review-gated; test cleanup and failure recovery.

### H. Provenance-aware project memory

The memory tool's timestamp/source/confidence metadata is the first partial step. Next add a stable fact representation with last-confirmed time, source references, confidence, stale/conflict surfacing, and user inspect/edit/disable/forget controls. **Done:** persistence round-trip, stale/conflict fixtures, untrusted prompt boundary, legacy text compatibility, and explicit forget test.

### I. Uncertainty-led investigation

Let an agent expose uncertain assumptions and propose low-risk checks before consequential actions. Do not let self-reported confidence relax the approval policy. **Done:** tests show high uncertainty suggests a read/test check, while a low-risk score cannot authorize writes or external actions.

## Suggested sequence

1. Complete and verify memory provenance basics; diagnose the currently failing full-suite gate.
2. Task contracts plus user review integration (requires renderer/IPC design and tests).
3. Risk-gate design, reusing current policy/approval interfaces.
4. Structured handoffs and evidence-backed completion bundles.
5. Counterfactual reviewer and isolated experiments after safe review/promotion boundaries are established.
6. Expand provenance memory and uncertainty-led investigations with inspectable UX and conservative defaults.

Each stage should have a single owner, a non-overlapping file plan, focused tests, and a full Studio test run before marking it done.
