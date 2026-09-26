'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrdersClient, serviceResponse } = require('./orders-client');
function fixture() {
  const calls = [], saved = [];
  const wallet = { baseUrl: 'https://example.test', state: { intents: [] },
    save() { saved.push(JSON.parse(JSON.stringify(this.state))); }, get(id) { return this.state.intents.find(i => i.id === id); },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: 'ord_test', quote: { name: 'Scorer' }, approvalStatus: 'pending', paymentStatus: 'unpaid', deliveryStatus: 'not_started' })); } };
  return { wallet, client: new OrdersClient(wallet), calls, saved, input: { slug: 'pitch', requestId: 'demo-pitch-001', method: 'POST', body: { name: 'Example' } } };
}

for (const service of [
  {slug:'olanas-onchain-explainer',path:'/',body:{transactionHash:'0x'+'ab'.repeat(32),chainId:4663}},
  {slug:'startup-pitch-scorer',path:'/api/score',body:{name:'Olanas',pitch:'A marketplace where agents discover and pay for APIs.'}}
]) test(service.slug+' retains its fixed-price gateway request contract',async()=>{
  const f=fixture();
  await f.client.request({slug:service.slug,requestId:'service-contract-001',method:'POST',path:service.path,body:service.body});
  const request=JSON.parse(f.calls[0].options.body);
  assert.equal(request.slug,service.slug);
  assert.equal(request.method,'POST');
  assert.equal(request.path,service.path);
  assert.deepEqual(request.body,service.body);
  assert.ok(f.calls[0].url.startsWith('https://example.test/api/orders'));
});
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

test('paid JSON is visible in MCP output without executing the service again', async () => {
  const f = fixture();
  await f.client.request(f.input);
  const payload = { explanation: 'Transfer observed', amount: '10000000000000000000' };
  f.wallet.fetch = async (url, options) => {
    f.calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'ord_test', quote: { name: 'Explainer' },
      approvalStatus: 'approved', paymentStatus: 'confirmed', deliveryStatus: 'completed',
      result: { status: 200, contentType: 'application/json; charset=utf-8', encoding: 'base64',
        body: Buffer.from(JSON.stringify(payload)).toString('base64') } }));
  };
  const output = await f.client.status('ord_test');
  assert.deepEqual(output.serviceResponse, { status: 200, contentType: 'application/json; charset=utf-8', json: payload });
  assert.equal(f.calls.at(-1).options.method, 'GET');
  assert.equal(f.calls.length, 2);
});

test('malformed or oversized saved data is not represented as decoded JSON', () => {
  assert.deepEqual(serviceResponse({ status: 200, contentType: 'application/json', encoding: 'base64', body: 'not-base64!' }),
    { status: 200, contentType: 'application/json' });
  assert.deepEqual(serviceResponse({ status: 200, contentType: 'application/json', encoding: 'base64', body: 'A'.repeat(350001) }),
    { status: 200, contentType: 'application/json' });
});
