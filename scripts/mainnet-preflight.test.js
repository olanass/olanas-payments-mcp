'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkConfig, checkDeployment } = require('./mainnet-preflight');
test('mainnet preflight refuses manual, testnet, demo and missing wallet configuration', () => {
  const env = { PAYMENTS_WALLET_PROVIDER: 'olanas', ROBINHOOD_NETWORK: 'mainnet', PAYMENTS_LAUNCHPAD_URL: 'https://olanas.xyz',
    OLANAS_ACCOUNT_ADDRESS: '0x' + '11'.repeat(20), OLANAS_KEYSTORE_FILE: 'test-only', PAYMENTS_OWNER_PASSWORD: 'test-only-password' };
  assert.doesNotThrow(() => checkConfig(env, () => true));
  for (const change of [{ PAYMENTS_WALLET_PROVIDER: 'browser' }, { ROBINHOOD_NETWORK: 'testnet' }, { X402_DEMO_MODE: 'true' },
    { PAYMENTS_LAUNCHPAD_URL: 'https://example.com' }, { OLANAS_ACCOUNT_ADDRESS: '' }, { PAYMENTS_OWNER_PASSWORD: '' }]) {
    assert.throws(() => checkConfig({ ...env, ...change }, () => true));
  }
  assert.throws(() => checkConfig(env, () => false), /keystore/);
});
test('mainnet preflight validates live backend, canonical asset and payable service', () => {
  const version = { purchaseFlow: 'durable-orders-v1' };
  const network = { chainId: 4663, testnet: false, tokens: [{ symbol: 'USDG', decimals: 6, address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' }] };
  const service = { slug: 'startup-pitch-scorer', chainId: 4663, status: 'live', currency: 'USDG', price: '0.002', allowedMethods: ['POST'], payoutAddress: '0x' + '22'.repeat(20) };
  assert.doesNotThrow(() => checkDeployment(version, network, service));
  assert.throws(() => checkDeployment({}, network, service), /backend/);
  assert.throws(() => checkDeployment(version, { ...network, chainId: 46630 }, service), /mainnet/);
  assert.throws(() => checkDeployment(version, { ...network, tokens: [] }, service), /USDG/);
  for (const change of [{ status: 'paused' }, { chainId: 46630 }, { currency: 'ETH' }, { allowedMethods: ['GET'] }, { price: '0' }, { payoutAddress: '' }]) {
    assert.throws(() => checkDeployment(version, network, { ...service, ...change }));
  }
});
