# MiniCPM host tool loop guard

The relay checks `gpu/minicpm5-2b` requests before cache lookup, context
compression, or another GPU generation. It uses original tool history after the
latest user message, without shared state or changes to the client's history.

Defaults in the host's `request` settings:

```json
{
  "minicpm_loop_guard": true,
  "minicpm_no_progress_rounds": 3,
  "minicpm_max_tool_rounds": 12
}
```

A round is an assistant tool-call batch followed by all its matching tool
results. Parallel calls count as one round. An incomplete batch does not count.
Three consecutive completed rounds without a new outcome stop the turn. A
new outcome resets this counter. Twelve completed rounds stop the turn even if
the output keeps changing. A new user message starts a fresh budget.

An outcome includes the tool name, canonical arguments, and canonical result.
Raycast's `__raycast_tool_call_description` is display metadata and is ignored.
Known Raycast GitHub issues, pull-request and repository searches, and tools
explicitly annotated `readOnlyHint: true`, compare names and results even when
query arguments change. Other tools retain their arguments in the comparison:
different writes returning the same success text remain distinct operations.
JSON formatting and key order do not count as progress. Timestamp changes do
count; the round budget bounds loops that keep changing such output.

For ordinary clients, the host returns a complete HTTP 200 OpenAI-compatible
assistant response with `finish_reason: stop`, no tool calls, and an explanation
that the host stopped the loop. Both JSON and SSE are supported. The response
header is `X-Reach-Loop-Guard: no_progress` or `round_limit`; logs record only
the model, reason and counts. `usage_source: host` identifies the message;
no provider usage is fabricated and no GPU generation occurs.
Provider-metered requests instead receive HTTP 409 with code
`tool_loop_detected`, preserving the requirement for real provider counters.

The guard does not undo completed actions, stop a tool already running in the
client, or detect an endless generation inside a single GPU request. It stops
the next request after the recorded tool history reaches a threshold. Requests
without tools or with `tool_choice: none` can still obtain a final text answer.
Other models keep their existing behavior. Operators can raise the round budget
for longer workflows or disable the guard explicitly in host settings.

Validation: run `python -m unittest tests.test_reachd_loop_guard
tests.test_reachd_settings_modules`. A client smoke test can replay four completed
identical tool rounds and verify a terminal response with the loop-guard header.
