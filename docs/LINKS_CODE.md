# Links Code v1

Links Code is a shared semantic language for Reach Studio agents. It adds explicit
intent, reply references, evidence and expectations to ordinary language and code.
It travels in the existing `agent.send` message string. It does not replace a
provider's tool protocol or change routing, permissions or scheduling.

## Grammar and alphabet

```text
message := "@links/1" whitespace JSON-object
packet  := { id, op, body, [replyTo], [evidence], [expect], [confidence] }
```

The JSON object uses the standard JSON grammar. No Markdown wrapper or trailing
commentary is allowed. Field order and whitespace between JSON tokens are flexible.
Unknown fields, unknown operators and unsupported versions are rejected. Ordinary
messages without the reserved `@links/` prefix keep their existing behavior.

Every printable keyboard character, space, tab, newline and Unicode character can
appear in string values. Letters remain case-sensitive. Punctuation in a string
has no control meaning. Escape `"` as `\"`, `\` as `\\`, newline as `\n`, tab as
`\t`, carriage return as `\r`, and other control characters as `\uXXXX`. JSON
serialization handles this automatically. Whitespace *inside* strings is preserved;
whitespace outside them only separates grammar tokens. Keys such as Shift or an
arrow key are physical events, not text characters; describe those events in body.

The complete serialized message is limited to 40,000 JavaScript string code units,
matching the existing tool allowance. Escaping counts toward that limit. A Unicode
character outside the basic multilingual plane uses two code units. Rejection is
explicit; packets are never truncated.

## Vocabulary

| `op` | Meaning | Receiving agent's expected interpretation |
| --- | --- | --- |
| `?` | Ask | Answer the question or identify missing context. |
| `>` | Handoff | Take responsibility for the described scoped work. |
| `=` | Result | Assess the result and its evidence; this is not whole-task completion. |
| `~` | Update | Incorporate changed state or new information. |
| `!` | Blocked | Identify the dependency and what would unblock the sender. |
| `+` | Agree | Record agreement with a referenced proposal/result. |
| `-` | Challenge | Assess a disagreement or counterexample. |
| `.` | Acknowledge | Confirm receipt when useful; avoid acknowledgement loops. |
| `#` | Completion claim | Tell peers the entire task appears finished, with evidence; does not end the run. |

These symbols have a fixed meaning only in `op`. All of them can also appear
literally anywhere in body. The language makes the full keyboard usable as data;
it does not assign a speculative secret meaning to every individual character.

| Field | Contract |
| --- | --- |
| `id` | Required, 1–96 characters; starts with an ASCII letter/digit, followed by letters/digits or `._:-`. Sender chooses a unique id within its run. |
| `op` | Required, exactly one operator from the table. |
| `body` | Required nonempty string: natural language, code, or both. |
| `replyTo` | Optional peer message id, using the same syntax as `id`. |
| `evidence` | Optional array of nonblank strings: observations, test outcomes, file references, or URLs. Required and nonempty for `#`. |
| `expect` | Optional string specifying a response or acceptance condition. |
| `confidence` | Optional finite number from 0 to 1, a sender's self-estimate rather than a calibrated probability. |

For `#`, body must also contain a nonblank, human-readable final summary. Evidence
entries are claims to assess, not proof that a test ran. Validation checks syntax
and required fields; it cannot verify the truth of a completion declaration.

## Conversation example

Agent A sends this string through `agent.send`, with `to` set to Agent B's id or name:

```text
@links/1 {"id":"a-1","op":"?","body":"Does `count <= 0` cover negative input?","expect":"Reply with the result and concrete evidence."}
```

Agent B replies to A:

```text
@links/1 {"id":"b-1","op":"=","replyTo":"a-1","body":"Yes. Both zero and negative values enter that branch.","evidence":["Evaluated the expression with count=0 and count=-1; both returned true."],"confidence":1}
```

If work cannot continue:

```text
@links/1 {"id":"b-2","op":"!","replyTo":"a-1","body":"The intended behavior for negative input is unspecified.","expect":"Clarify whether negative input should be rejected or treated as zero."}
```

When the whole task is verified, the coordinator can send `#` with its summary and
evidence for peers to assess. No packet can end the run. The coordinator must still
submit the full user-facing final answer through the active run-control protocol,
ending with a standalone `LINKS: COMPLETE` line. The engine validates that terminal
result. A quote of that marker inside packet fields is literal data. Use ordinary
readable language for user-facing answers; the packet contract is for peer sends.

## Integration and limits

- Links roster members and spawned helpers receive the same language guide.
- `agent.send` validates packets before mailbox insertion, counters, or completion.
  Malformed packets return `code: "invalid-links-code"`; the agent can correct them.
- Recipient resolution, real sender identity, budget accounting, pause behavior,
  coalescing and wake-up limits stay under the existing crew transport.
- Valid packets are delivered intact after the normal sender label and retained
  in the existing crew-message journal. Operator messages stay user guidance.
- `id` and `replyTo` provide conversational correlation. They are not authentication,
  global lookup keys, enforced uniqueness, automatic retries or deduplication.
- Packet bodies are communication, never an executable program or approval.
  Agents still need to evaluate peer claims and obey the user's scope.
- This contract aims to reduce ambiguity. Better model comprehension, lower token
  use, or improved task success requires measurement with real providers.

Code can use `encode` and `decode` from `studio/agent/links-code.cjs`. `decode`
returns `null` for ordinary text and throws for malformed reserved packets. No new
package, provider, model, relay endpoint or setting is required.

Run the focused contract and integration tests from the repository root:

```powershell
node --test studio/test/links-code.test.cjs
```
