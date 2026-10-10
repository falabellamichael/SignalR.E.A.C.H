import assert from 'node:assert/strict';
import test from 'node:test';
import { currentEip1559Fees } from '../terminal/public/fees.mjs';

test('uses recent fee-history rewards without calling eth_maxPriorityFeePerGas', async () => {
  const calls = [];
  const provider = {
    getBlock: async () => ({ baseFeePerGas: 30_000_000_000n }),
    send: async (method, params) => {
      calls.push(method);
      assert.deepEqual(params, ['0x5', 'latest', [50]]);
      return { reward: [['0x3b9aca00'], ['0x77359400'], ['0x12a05f200']] };
    },
  };

  assert.deepEqual(await currentEip1559Fees(provider), {
    baseFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    maxFeePerGas: 62_000_000_000n,
  });
  assert.deepEqual(calls, ['eth_feeHistory']);
});

test('falls back to eth_gasPrice when the wallet RPC does not implement fee history', async () => {
  const calls = [];
  const provider = {
    getBlock: async () => ({ baseFeePerGas: 30_000_000_000n }),
    send: async (method) => {
      calls.push(method);
      if (method === 'eth_feeHistory') throw new Error('method not found');
      if (method === 'eth_gasPrice') return '0x773594000';
      throw new Error(`Unexpected RPC method: ${method}`);
    },
  };

  assert.deepEqual(await currentEip1559Fees(provider), {
    baseFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    maxFeePerGas: 62_000_000_000n,
  });
  assert.deepEqual(calls, ['eth_feeHistory', 'eth_gasPrice']);
});

test('stops when neither supported fee source is available', async () => {
  const provider = {
    getBlock: async () => ({ baseFeePerGas: 30_000_000_000n }),
    send: async () => { throw new Error('method not found'); },
  };
  await assert.rejects(currentEip1559Fees(provider), /neither eth_feeHistory nor eth_gasPrice/);
});
