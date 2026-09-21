'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PaymentsWallet } = require('./core');

function fixture() {
  const service = { name: 'Scorer', status: 'live', chainId: 4663, allowedMethods: ['POST'], currency: 'USDG',
    price: '0.002', payoutAddress: '0x2222222222222222222222222222222222222222' };
  let calls = 0;
  const wallet = new PaymentsWallet({ chain: { chainId: 4663, supportedTokens: {
    USDG: { symbol: 'USDG', decimals: 6, address: '0x3333333333333333333333333333333333333333' }
  } }, baseUrl: 'https://example.test', fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ service }));
  } });
  wallet.connect('0x1111111111111111111111111111111111111111');
  const input = { slug: 'scorer', requestId: 'demo-request-001', method: 'POST', body: { pitch: 'Example' } };
  return { wallet, service, input, calls: () => calls };
}

test('reusing an expired request ID reports expiry without renewing or calling the API', async () => {
  const f = fixture();
  const item = await f.wallet.request(f.input);
  item.expiresAt = Date.now() - 1;
  const expiry = item.expiresAt;
  assert.equal((await f.wallet.request(f.input)).status, 'expired');
  assert.equal(item.expiresAt, expiry);
  assert.equal(f.calls(), 1);
  assert.equal(f.wallet.state.intents.length, 1);
  assert.throws(() => f.wallet.begin(item.id), /expired/);
  await assert.rejects(f.wallet.request({ ...f.input, body: {} }), /different input/);
});

test('explicit refresh updates current terms in place and still requires approval', async () => {
  const f = fixture();
  const item = await f.wallet.request(f.input);
  const id = item.id;
  item.expiresAt = Date.now() - 1;
  f.service.price = '0.003';
  f.service.payoutAddress = '0x4444444444444444444444444444444444444444';
  await f.wallet.refreshQuote(id);
  assert.equal(item.id, id);
  assert.equal(item.requestId, f.input.requestId);
  assert.equal(item.displayAmount, '0.003');
  assert.equal(item.payTo, f.service.payoutAddress);
  assert.equal(item.status, 'pending');
  assert.ok(item.expiresAt > Date.now());
  assert.equal(item.txHash, undefined);
  assert.equal(f.wallet.state.intents.length, 1);
  assert.equal(f.wallet.begin(id).status, 'awaiting_wallet');
  await assert.rejects(f.wallet.refreshQuote(id), /Only expired/);
});

test('refresh cannot revive rejected requests or requests with payment evidence', async () => {
  for (const status of ['rejected', 'awaiting_wallet', 'signing', 'submitted', 'delivery_unknown', 'completed']) {
    const f = fixture(); const item = await f.wallet.request(f.input);
    item.status = status; item.expiresAt = 0;
    await assert.rejects(f.wallet.refreshQuote(item.id), /Only expired/);
  }
  const f = fixture(); const item = await f.wallet.request(f.input);
  item.expiresAt = 0; item.txHash = '0xabc';
  await assert.rejects(f.wallet.refreshQuote(item.id), /Only expired/);
});

test('rejection during refresh wins and parallel refresh is blocked', async () => {
  const f = fixture(); const item = await f.wallet.request(f.input);
  item.expiresAt = 0;
  let release;
  f.wallet.fetch = () => new Promise(resolve => { release = resolve; });
  const refreshing = f.wallet.refreshQuote(item.id);
  await assert.rejects(f.wallet.refreshQuote(item.id), /in progress/);
  f.wallet.reject(item.id);
  release(new Response(JSON.stringify({ service: f.service })));
  await assert.rejects(refreshing, /Only expired/);
  assert.equal(item.status, 'rejected');
});

test('unavailable service leaves an expired request unpaid', async () => {
  const f = fixture(); const item = await f.wallet.request(f.input);
  item.expiresAt = 0; f.service.status = 'offline';
  await assert.rejects(f.wallet.refreshQuote(item.id), /unavailable/);
  assert.equal(item.status, 'expired');
  assert.equal(item.txHash, undefined);
});

test('a rejected ID stays rejected until explicit reopening, with review history preserved', async () => {
  const f = fixture(); const item = await f.wallet.request(f.input);
  f.wallet.reject(item.id);
  assert.equal((await f.wallet.request(f.input)).status, 'rejected');
  assert.equal(f.calls(), 1);
  f.service.price = '0.004';
  await f.wallet.refreshQuote(item.id, { reopen: true });
  assert.equal(item.status, 'pending');
  assert.equal(item.displayAmount, '0.004');
  assert.equal(item.txHash, undefined);
  assert.deepEqual(item.reviewHistory.map(event => event.action), ['rejected', 'reopened']);
  assert.equal(f.wallet.state.intents.length, 1);
  assert.equal((await f.wallet.request(f.input)).id, item.id);
});

test('explicit reopening cannot bypass payment evidence or a different wallet', async () => {
  for (const change of [item => { item.txHash = '0xabc'; }, item => { item.policyId = 'session'; },
    item => { item.status = 'completed'; }, item => { item.payer = '0x5555555555555555555555555555555555555555'; }]) {
    const f = fixture(); const item = await f.wallet.request(f.input);
    f.wallet.reject(item.id); change(item);
    await assert.rejects(f.wallet.refreshQuote(item.id, { reopen: true }));
    assert.equal(f.calls(), 1);
  }
});
