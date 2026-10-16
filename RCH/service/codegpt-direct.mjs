// The host holds the CodeGPT sign-in. Customers cannot provide URLs, credentials,
// agent identifiers or a fallback destination in subscription configuration.
export function codegptDirect(bridge) {
  return bridge?.kind === 'codegpt-direct' && typeof bridge.model === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(bridge.model)
    && !/^codegpt-(?:eco|agent)(?:-|$)/.test(bridge.model)
    && Object.keys(bridge).every(key => ['kind', 'model'].includes(key))
    ? { url: 'http://127.0.0.1:21304/v1/chat/completions' } : null;
}
