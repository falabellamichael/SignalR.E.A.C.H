// Operator-owned SSH forwards. Customers cannot supply a destination URL or
// substitute another model behind these exact selectors.
const ROUTES = Object.freeze({
  'vllm-sr/d3-nano': 18031,
  'Qwen3.8-27B': 18091,
  'Qwen/Qwen3.6-35B-A3B-FP8': 18000,
  'google/gemma-4-12B-it-qat-q4_0-unquantized': 18001,
  'ornith-ai/Ornith-1.5-9B': 18002,
  'ibm-granite/granite-4.2-3b-fp8': 18003,
  'openbmb/MiniCPM5-2B': 18004,
  'LiquidAI/LFM3-Omni-2B': 18006,
  'LiquidAI/LFM3-VL-2B': 18005,
  'LiquidAI/d1-3B': 18030,
});

const HOSTED_MODELS = Object.freeze({
  'd3-nano': 'vllm-sr/d3-nano',
  'qwen3.8-27b': 'Qwen3.8-27B',
  'qwen3.6-35b-a3b-fp8': 'Qwen/Qwen3.6-35B-A3B-FP8',
  'gemma-4-12b-qat': 'google/gemma-4-12B-it-qat-q4_0-unquantized',
  'ornith-1.5-9b': 'ornith-ai/Ornith-1.5-9B',
  'minicpm5-2b': 'openbmb/MiniCPM5-2B',
  'lfm3-omni-2b': 'LiquidAI/LFM3-Omni-2B',
  'lfm3-vl-2b': 'LiquidAI/LFM3-VL-2B',
  'd1-3b': 'LiquidAI/d1-3B',
});

// Subscription and API access use the deployed GPU catalog. Retain old private
// provider configuration for local Login Providers without publishing it here.
export function hostedGpuModel(model) {
  if (!model || typeof model.id !== 'string' || /^(?:codegpt(?:-|$)|(?:chatgpt|copilot|gemini)-chat$)/i.test(model.id)) return false;
  const target = model.access === 'requests' ? model.bridge?.model : model.upstreamModel ?? model.id;
  return Object.values(HOSTED_MODELS).includes(target)
    ? model.access !== 'requests' || !!gpuBridge(model.bridge)
    : model.access !== 'requests' && Object.hasOwn(HOSTED_MODELS, target);
}

export function gpuBridge(bridge) {
  if (!bridge || bridge.kind !== 'gpu' || !Object.hasOwn(ROUTES, bridge.model)
    || Object.keys(bridge).some(key => !['kind', 'model'].includes(key))) return null;
  if (bridge.model === 'vllm-sr/d3-nano') return { url: 'http://127.0.0.1:18031/v1/systemone', generation: {}, decision: true };
  if (bridge.model === 'LiquidAI/d1-3B') return { url: 'http://127.0.0.1:18030/v1/decisions', generation: {}, decision: true };
  const generation = bridge.model === 'Qwen3.8-27B'
    ? { chat_template_kwargs: { enable_thinking: true } }
    : bridge.model === 'Qwen/Qwen3.6-35B-A3B-FP8'
    ? { chat_template_kwargs: { enable_thinking: false } }
    : bridge.model === 'ornith-ai/Ornith-1.5-9B'
    ? { chat_template_kwargs: { enable_thinking: true }, temperature: 0.6, top_p: 0.95, top_k: 20 }
    : bridge.model === 'openbmb/MiniCPM5-2B'
    ? { chat_template_kwargs: { enable_thinking: true }, temperature: 1.0, top_p: 0.95, min_p: 0.0 }
    // 18005 serves LFM3-VL-2B and 18006 serves the INT4 Omni build; both are
    // vLLM and default to direct answers so output is available to document clients.
    : bridge.model === 'LiquidAI/LFM3-Omni-2B' || bridge.model === 'LiquidAI/LFM3-VL-2B'
    ? { chat_template_kwargs: { enable_thinking: bridge.model === 'LiquidAI/LFM3-VL-2B' }, temperature: 0.1, top_k: 50, repetition_penalty: 1.1 }
    // Preserve Gemma's enabled native reasoning for ordinary and Agent requests.
    : { chat_template_kwargs: { enable_thinking: bridge.model === 'google/gemma-4-12B-it-qat-q4_0-unquantized' }, temperature: 1.0, top_p: 0.95, top_k: 64 };
  return { url: `http://127.0.0.1:${ROUTES[bridge.model]}/v1/chat/completions`, generation };
}

export const requestCapabilities = model => gpuBridge(model?.bridge)?.decision
  ? { chat: false, decisions: true, endpoint: '/v1/decisions', precision: model.bridge.model === 'vllm-sr/d3-nano' ? 'BF16' : 'FP8' }
  : gpuBridge(model?.bridge)
  ? { outputTokenLimit: true, automaticOutput: model.maxOutputTokens === undefined,
    jsonSchema: model.bridge.model === 'openbmb/MiniCPM5-2B',
    ...(model.bridge.model === 'Qwen3.8-27B' ? { context_window: 100000 } : {}) } : { outputTokenLimit: false };
