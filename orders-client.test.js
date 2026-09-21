'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrdersClient } = require('./orders-client');
function fixture() {
  const calls = [], saved = [];
  const wallet = { baseUrl: 'https://example.test', state: { intents: [] },
    save() { saved.push(JSON.parse(JSON.stringify(this.state))); }, get(id) { return this.state.intents.find(i => i.id === id); },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: 'ord_test', quote: { name: 'Scorer' }, approvalStatus: 'pending', paymentStatus: 'unpaid', deliveryStatus: 'not_started' })); } };
  return { wallet, client: new OrdersClient(wallet), calls, saved, input: { slug: 'pitch', requestId: 'demo-pitch-001', method: 'POST', body: { name: 'Example' } } };
}
test('website order credentials are persisted before creation and repeated requests only read', async () => {
  const f = fixture(); const response = await f.client.request(f.input);
  assert.equal(f.saved[0].remoteOrders[0].id, undefined);
  assert.match(f.saved[0].remoteOrders[0].accessToken, /^[a-f0-9]{64}$/);
  assert.ok(response.approvalUrl.startsWith('https://example.test/orders/ord_test#'));
  await f.client.request(f.input);
  assert.deepEqual(f.calls.map(c => c.options.method), ['POST', 'GET']);
  await assert.rejects(f.client.request({ ...f.input, body: {} }), /different input/);
});
test('timeout and process restart reuse the saved creation identity', async () => {
  const f = fixture(); const fetch = f.wallet.fetch;
  f.wallet.fetch = async () => { throw Error('timeout'); };
  await assert.rejects(f.client.request(f.input), /\/create network request failed/);
  const accessToken = f.wallet.state.remoteOrders[0].accessToken;
  f.wallet.fetch = fetch;
  const restarted = new OrdersClient(f.wallet);
  await restarted.request(f.input);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer ' + accessToken);
  assert.equal(JSON.parse(f.calls[0].options.body).requestId, f.input.requestId);
  assert.equal(f.wallet.state.remoteOrders.length, 1);
});

test('transport errors identify the operation and safe cause without leaking credentials', async () => {
  const f = fixture(); await f.client.request(f.input);
  f.wallet.fetch = async () => { throw new TypeError('secret payload', { cause: Object.assign(new Error('secret URL'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); };
  await assert.rejects(f.client.call(f.client.find(f.input.requestId), '/approve', {}), error => {
    assert.match(error.message, /\/approve network request failed \(UND_ERR_CONNECT_TIMEOUT\)/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});
test('legacy rejected or submitted requests never silently become new website purchases', async () => {
  for (const status of ['rejected', 'submitted']) {
    const f = fixture(); f.wallet.state.intents.push({ id: 'legacy', requestId: f.input.requestId, status });
    const output = await f.client.request(f.input);
    assert.equal(output.status, status); assert.equal(f.calls.length, 0);
  }
});
test('network or origin change cannot redirect credentials or payments', async () => {
  const f = fixture(); await f.client.request(f.input); f.wallet.baseUrl = 'https://other.example';
  await assert.rejects(f.client.status('ord_test'), /another launchpad/);
  assert.equal(f.calls.length, 1);
});
test('read-only status checks preserve a local owner-action warning', async () => {
  const f = fixture(); const response = await f.client.request(f.input);
  const record = f.client.find(f.input.requestId);
  f.client.remember(record, response.order, 'needs_owner_action', 'Insufficient token balance');
  await f.client.status(record.id);
  assert.equal(record.summary.status, 'needs_owner_action'); assert.equal(record.summary.message, 'Insufficient token balance');
});
