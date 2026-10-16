// Operator-owned SSH forwards. Customers cannot supply a destination URL or
// substitute another model behind these exact selectors.
const ROUTES = Object.freeze({
  'google/gemma-4-12B-it-qat-q4_0-unquantized': 18001,
  'ornith-ai/Ornith-1.5-9B': 18002,
  'ibm-granite/granite-4.2-3b-fp8': 18003,
  'openbmb/MiniCPM5-2B': 18004,
});

export function gpuBridge(bridge) {
  if (!bridge || bridge.kind !== 'gpu' || !Object.hasOwn(ROUTES, bridge.model)
    || Object.keys(bridge).some(key => !['kind', 'model'].includes(key))) return null;
  return { url: `http://127.0.0.1:${ROUTES[bridge.model]}/v1/chat/completions`,
    maxOutputTokens: 4096, defaultOutputTokens: 1024 };
}

export const requestCapabilities = model => gpuBridge(model?.bridge)
  ? { outputTokenLimit: true, jsonSchema: true } : { outputTokenLimit: false };
