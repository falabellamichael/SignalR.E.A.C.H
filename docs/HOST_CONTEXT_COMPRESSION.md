# Host context compression

The Python relay prepares oversized requests to the resident GPU chat models
before forwarding them. Normal small requests, signed-in browser routes, direct
providers, and `provider-v1` metered requests retain their existing contracts.

The host counts the fully rendered messages and tool definitions through that
model's private native `/tokenize` endpoint for vLLM, or
`/v1/chat/completions/input_tokens` for llama.cpp. The latter includes rendered
tools and processed media; `/props` supplies the active per-chat slot limit.
The host validates the model alias before trusting that limit.
It uses the smaller of the configured
window and the running server's window, reserves 4,096 answer tokens by default,
and honors a larger explicit client output budget without imposing a new output
cap.

Small text inputs up to 16 KiB bypass native counting when the output reserve is
at most 32K and the configured window has enough headroom. Larger inputs and
reservations use the live native limit, including during a rollback to 64K.

When the request does not fit, compression proceeds in this order:

1. Remove nested JSON Schema documentation annotations from tool parameters.
   Function names, function descriptions, properties, required fields, types,
   enum/default/const values, references, and validation constraints remain.
   Every tool stays available. This stage needs no model generation.
2. Summarize older conversation records using the same selected private model,
   with tools and thinking disabled for the summary request. Preserve system and
   developer instructions, the first user goal, the latest user turn, and
   pending or cross-boundary tool-call/result pairs.
3. If necessary, summarize large tool-result text while retaining its original
   call ID, name, envelope, and exact assistant call arguments.
4. Count the final request again. If protected instructions and current input
   still cannot fit, return `context_length_exceeded` instead of silently cutting
   user input or sending an oversized request.

Summaries are lossy reference notes and can omit details. They never become new
system instructions, grant permission, or execute tools. Hierarchical summaries
keep each summary request within the native context window. In-memory summary
caching is scoped to the authenticated caller, expires after ten minutes, and
holds at most 32 entries. No summary cache is written to disk.

Compression changes only the forwarded request. The client keeps its original
chat history and tool results. Successful compression is recorded as token
counts and stage flags in the host log, with
`X-Reach-Context` and before/after token counts in the response headers. Message
contents and summaries are not added to logs by this feature.

Operator settings are `request.context_compression` (default `true`) and
`request.context_reserve_tokens` (default `4096`). Existing transport, access,
concurrency, and request-size limits still apply. Token usage reported for the
final answer remains the final generation's native usage; summary generations
are additional local GPU work.

Validation: run `python -m unittest tests.test_reachd_context_compression` and
replay a tool-heavy request through the relay. Check the compression headers,
native token counts, structured tool calls, and normal streamed answer. A
compression check does not execute any tool requested by the model.
