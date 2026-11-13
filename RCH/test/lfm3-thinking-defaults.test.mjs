import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuBridge } from '../service/gpu-bridge.mjs';

test('VL subscription requests enable thinking; Omni remains non-reasoning', () => {
  for (const [model, port] of [['LiquidAI/LFM3-Omni-2B', 18006], ['LiquidAI/LFM3-VL-2B', 18005]]) {
    const route = gpuBridge({ kind: 'gpu', model });
    assert.equal(route.generation.chat_template_kwargs.enable_thinking, model === 'LiquidAI/LFM3-VL-2B');
    assert.equal(route.url, `http://127.0.0.1:${port}/v1/chat/completions`);
  }
});

test('other subscription models retain their thinking defaults', () => {
  const route = gpuBridge({ kind: 'gpu', model: 'openbmb/MiniCPM5-2B' });
  assert.equal(route.generation.chat_template_kwargs.enable_thinking, true);
});
