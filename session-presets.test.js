'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { resolve, modes } = require('./session-presets');
const { OlanasRobinhoodSigner } = require('./olanas');
test('simple defaults derive a bounded per-call amount and fixed gas ceilings', () => {
  const p = resolve({ budget: '0.01', gasMode: 'standard' }, { decimals: 6 }, ethers);
  assert.equal(p.perCall, '0.002'); assert.equal(p.gasPerCall, '0.00001'); assert.equal(p.gasBudget, '0.0001');
  assert.equal(resolve({ budget: '0.000001', gasMode: 'fast' }, { decimals: 6 }, ethers).perCall, '0.000001');
  assert.equal(resolve({ budget: '0.01', gasMode: 'fast', gasBudget: '99' }, { decimals: 6 }, ethers).gasBudget, modes.fast.gasBudget);
  assert.throws(() => resolve({ budget: '0', gasMode: 'standard' }, { decimals: 6 }, ethers));
  assert.throws(() => resolve({ budget: '1', gasMode: 'turbo' }, { decimals: 6 }, ethers));
});
test('fast fees increase the estimate, not the transfer amount or gas cap', async () => {
  const signer = new OlanasRobinhoodSigner({ wallet: ethers.Wallet.createRandom(),
    chain: { chainId: 4663, supportedTokens: { ETH: { decimals: 18 } } },
    provider: { send: async () => '0x1237', getFeeData: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 4n }),
      estimateGas: async () => 21000n, getBalance: async () => 10n ** 18n, getTransactionCount: async () => 0 } });
  const item = { token: 'ETH', payTo: ethers.Wallet.createRandom().address, amount: '1' };
  const normal = await signer.prepare(item, '10000000', 'standard'), fast = await signer.prepare(item, '10000000', 'fast');
  assert.equal(fast.transaction.maxFeePerGas, 125n); assert.equal(fast.transaction.maxPriorityFeePerGas, 5n);
  assert.equal(fast.transaction.value, normal.transaction.value);
  await assert.rejects(signer.prepare(item, normal.gasCost.toString(), 'fast'), /approved gas limit/);
});
