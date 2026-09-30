# Subscription model catalogue

The account service supports direct, host-authenticated API routes as well as the existing relay protocol. Direct routes call the configured provider at a fixed HTTPS destination, preserve provider usage, and use the same USD reservations, immutable rate snapshots, idempotency, and settlement as existing paid requests. Provider keys are never sent to a customer.

`RCH/config/subscription-models.example.json` contains the 18 requested aliases, with the ordinary `gpt-4o-mini` duplicate omitted. The existing `rch-gpt-4o-mini` customer ID remains compatible. Eight routes are configured for metered access; ten remain disabled pending provider access or an exact API identity. Copy a route only after a successful completion and verified-usage check against the operator's own API connection.

| Customer model | Direct API | Qualification |
| --- | --- | --- |
| `rch-gpt-4o-mini` | OpenAI `gpt-4o-mini` | Enabled; existing ID preserved |
| `gpt-4o` | OpenAI `gpt-4o` | Enabled |
| `gpt-5` | OpenAI `gpt-5` | Enabled |
| `gpt-5.6-luna` | OpenAI `gpt-5.6-luna` | Enabled |
| `gemini-3.7-flash` | Google `gemini-3.7-flash` | Enabled; provider availability can fluctuate |
| `gemini-3.8-flash` | Google `gemini-3.8-flash` | Enabled; provider availability can fluctuate |
| `glm-5.2` | Alibaba Singapore `glm-5.2` | Enabled |
| `deepseek-v4.1-flash` | Alibaba Singapore `deepseek-v4.1-flash` | Enabled; daily tariff applies |
| `MiniMax-M3` | OpenCode `minimax-m3` | Disabled; provider returned payment required |
| `claude-sonnet-4.6` | OpenCode `claude-sonnet-4-6` | Disabled; provider credit and native Messages adapter required |
| `claude-opus-4.6` | OpenCode `claude-opus-4-6` | Disabled; provider credit and native Messages adapter required |
| `claude-opus-4.6-fast` | No separate qualified API route | Disabled |
| `gemini-2.5-flash` | Google `gemini-2.5-flash` | Disabled; connected account returned not found |
| `ox-alpha`, `space-bunny-alpha` | Exact API identity and tariff unverified | Disabled |
| `copilot-chat`, `chatgpt-chat`, `gemini-chat` | Browser service names; no exact API model selected | Disabled |

The sample's qualification state reflects checks on September 30, 2026; a model-list entry alone is insufficient. API credit purchases, automatic top-ups, new subscriptions, and customer plan grants are separate operator actions.

## Credentials and deployment

A model declares its private provider authority by environment variable name:

```json
"providerApi": {
  "provider": "openai",
  "keyEnv": "REACH_PROVIDER_OPENAI_KEY"
}
```

Supported drivers are `openai`, `gemini`, `opencode`, and `alibaba`. Their destinations are fixed in the gateway. Alibaba uses the standard Singapore API, and OpenCode's driver supports Chat Completions models; native Anthropic Messages models require a different adapter.

The host launcher accepts an optional fifth credential-file argument:

```text
node accounts-host.mjs CONFIG UPSTREAM_KEY SUPABASE_KEY QUOTE_SIGNER_KEY PROVIDER_KEYS_JSON
```

The private provider JSON maps only declared variable names to their operator API keys. Use empty arguments for unused intermediate optional files. The launcher loads the values temporarily, restores the process environment on success or failure, and rejects undeclared variables or collisions with relay, Supabase, and quote-signing authorities. Keep the file private and outside the repository.

Back up the account config, launcher, and changed service files before deployment. Preserve all config outside `models`, stop only the accounts task after checking for active reservations, install the matched source/config, restart that task, and verify the public catalogue plus an existing funded account's permitted models. No Supabase migration, RLS change, balance update, or plan grant is needed to extend the current USD-credit catalogue.

## Billing and limits

Actual provider counts determine settlement; estimates and invalid final stream usage fail closed. Direct Google responses report thinking in total tokens while excluding it from visible completion tokens. The adapter includes that provider-reported difference in billable output and records it as a reasoning subset. It never estimates tokens from text length. Other drivers retain strict OpenAI arithmetic. See [Google token accounting](https://ai.google.dev/gemini-api/docs/tokens) and [Google's compatible API](https://ai.google.dev/gemini-api/docs/openai).

Only text messages and ordinary function tools are supported. Hosted search, grounding, code execution, media, and other separately charged tools are rejected before reservation. GPT-5 routes use `max_completion_tokens` and reject unsupported sampling changes before dispatch.

New routes use a 64,000-token input ceiling, a 32,000-byte input limit, and at most 4,096 output tokens. The existing mini keeps its original limits. Credit reservations hold the full input ceiling plus requested output before generation; unused held credit is released after measured settlement. This can require more available credit than the eventual small request costs. A failed or ambiguous dispatched call stays reserved for operator reconciliation under the existing policy; it is not automatically retried.

Rates are integer USD microdollars per million provider tokens. OpenAI rates come from the exact model pages for [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o), [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini), [GPT-5](https://developers.openai.com/api/docs/models/gpt-5), and [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Google's published Gemini 3.7/3.8 introductory rates change on January 1, 2027. `pricingAfter` selects the published replacement rates at that UTC boundary. Alibaba DeepSeek's `pricingDaily` selects its discounted tariff from 14:00 to 24:00 UTC (22:00 to 08:00 UTC+8). Each reservation snapshots its selected rates, so an outstanding request retains its agreed price across a boundary. The current route caps remain below higher context-price tiers. Sources: [Google pricing](https://ai.google.dev/gemini-api/docs/pricing), [Alibaba pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing), and [Alibaba's model-specific cache tariffs](https://www.alibabacloud.com/help/en/model-studio/context-cache).
