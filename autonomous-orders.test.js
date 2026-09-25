'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createClient } = require('@libsql/client');
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.VAULT_MASTER_SECRET = 'autonomous-tests-only-not-production';
const path = require('node:path');
const launchpadSource = process.env.OLANAS_LAUNCHPAD_SOURCE
  ? path.resolve(process.env.OLANAS_LAUNCHPAD_SOURCE) : path.join(__dirname, '.main-worktree');
const { OrderEngine } = require(path.join(launchpadSource, 'src/server/orders/engine'));
const { ROBINHOOD_CHAIN_CONFIG: chain } = require(path.join(launchpadSource, 'src/server/config/chain'));
const { OrdersClient } = require('./orders-client');
const { AutonomousOrders } = require('./autonomous-orders');
const agentPayments = require('./agent-payments');

function fixture(t) {
  const db = createClient({ url: 'file::memory:' }); t.after(() => db.close());
  const key = ethers.Wallet.createRandom(), recipient = ethers.Wallet.createRandom().address;
  const service = { slug: 'pitch', serviceId: 'svc_pitch', name: 'Pitch', price: '0.002', currency: 'USDG',
    chainId: chain.chainId, status: 'live', allowedMethods: ['POST'], payoutAddress: recipient, endpointUrl: 'https://service.example/score' };
  const f = { signs: 0, broadcasts: [], executions: 0, confirmed: true, failBroadcast: false, saves: [], service };
  const engine = f.engine = new OrderEngine({ services: { init: async () => db, getBySlug: async () => service,
    settlePayment: async proof => ({ txHash: proof.txHash }) },
    verify: async proof => ({ ...proof, valid: f.confirmed, error: 'Waiting for confirmation' }),
    proxy: async () => { f.executions++; if (f.failDelivery) throw Error('upstream timeout'); return { status: 200, headers: {}, body: Buffer.from('{"score":88}') }; } });
  const wallet = f.wallet = { chain, baseUrl: 'https://launchpad.example', state: { intents: [] },
    save() { f.saves.push(structuredClone(this.state)); }, get(id) { return this.state.intents.find(i => i.id === id); },
    fetch: async (url, options) => {
      const [id, action] = new URL(url).pathname.slice('/api/orders'.length).split('/').filter(Boolean);
      const body = options.body ? JSON.parse(options.body) : null, token = options.headers.authorization.slice(7);
      let result;
      if (!id) result = await engine.create({ ...body, accessToken: token });
      else if (!action) result = await engine.get(id, token);
      else if (action === 'approve') { result = await engine.approve(id, token, body); if (f.approvalTimeout) throw Error('approval response lost'); }
      else if (action === 'payment') result = await engine.submit(id, token, body.txHash);
      else if (action === 'reconcile') result = await engine.reconcile(id, token);
      else if (action === 'cancellation-message') result = await engine.cancellation(id, token);
      else if (action === 'cancel-approval') result = await engine.cancelApproval(id, token, body);
      else result = await engine.review(id, token, action);
      return new Response(JSON.stringify(result));
    } };
  const signer = f.signer = { address: key.address,
    prepare: async () => { if (f.onPrepare) f.onPrepare(); return { transaction: { nonce: 7 }, gasCost: 10n }; },
    signMessage: message => key.signMessage(message),
    sign: async () => { f.signs++; if (f.onSign) f.onSign(); return { hash: '0x' + 'ab'.repeat(32), raw: 'original-raw' }; },
    broadcast: async raw => { const saved = f.saves.at(-1).remoteOrders[0].autonomous; assert.equal(saved.raw, raw); assert.ok(saved.txHash); f.broadcasts.push(raw); if (f.failBroadcast) throw Error('RPC timeout'); },
    receipt: async () => f.confirmed && f.broadcasts.length ? { status: f.reverted ? 0 : 1 } : null };
  const client = f.client = new OrdersClient(wallet);
  f.auto = new AutonomousOrders(wallet, signer, client, { confirmationWaitMs: 0 });
  f.policy = { token: 'USDG', perCall: '0.002', budget: '0.006', gasPerCall: '0.001', gasBudget: '0.01', minutes: 60,
    services: ['pitch'], recipients: [recipient] };
  f.auto.enable(f.policy);
  f.input = { slug: 'pitch', method: 'POST', body: { pitch: 'example' }, requestId: 'auto-pitch-001' };
  return f;
}
test('autonomous order: real order approval signature, result, concurrent retries pay and execute once', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.auto.execute(f.input), f.auto.execute(f.input)]);
  assert.ok(results.every(r => r.status === 'completed'));
  assert.equal(f.signs, 1); assert.equal(f.broadcasts.length, 1); assert.equal(f.executions, 1);
  assert.equal(Buffer.from(results[0].order.result.body, 'base64').toString(), '{"score":88}');
  assert.equal(f.wallet.state.policy.spent, ethers.parseUnits('0.002', chain.supportedTokens.USDG.decimals).toString());
  await assert.rejects(f.auto.execute({ ...f.input, body: {} }), /different input/);
});
test('no session, allowlist, price and gas violations require owner without signing', async t => {
  for (const mutate of [f => f.auto.revoke(), f => f.wallet.state.policy.services = ['other'],
    f => f.wallet.state.policy.recipients = [], f => f.service.price = '0.003', f => f.wallet.state.policy.gasBudget = '1']) {
    const f = fixture(t); mutate(f);
    assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action'); assert.equal(f.signs, 0); assert.equal(f.broadcasts.length, 0);
  }
});
test('expired unpaid order refreshes within policy; rejected order stays rejected', async t => {
  const f = fixture(t); await f.client.request(f.input);
  const record = f.client.find(f.input.requestId);
  const raw = await f.engine.load(record.id, record.accessToken); raw.quote.expiresAt = 0; await f.engine.save(raw);
  const result = await f.auto.execute(f.input); assert.equal(result.status, 'completed'); assert.equal(result.order.quote.version, 2);
  const g = fixture(t); await g.client.request(g.input); const r = g.client.find(g.input.requestId);
  await g.engine.review(r.id, r.accessToken, 'reject');
  assert.equal((await g.auto.execute(g.input)).status, 'needs_owner_action'); assert.equal(g.signs, 0);
});
test('revocation during preparation or signing prevents broadcasting', async t => {
  for (const hook of ['onPrepare', 'onSign']) {
    const f = fixture(t); f[hook] = () => f.auto.revoke();
    assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action'); assert.equal(f.broadcasts.length, 0);
  }
});
test('timeout/restart checks original hash; owner recovery only rebroadcasts identical bytes', async t => {
  const f = fixture(t); f.confirmed = false; f.failBroadcast = true;
  const result = await f.auto.execute(f.input); assert.equal(result.status, 'pending');
  const spent = f.wallet.state.policy.spent;
  f.auto = new AutonomousOrders(f.wallet, f.signer, f.client, { confirmationWaitMs: 0 });
  assert.equal(f.wallet.state.policy.active, false);
  await f.auto.check(result.id); assert.equal(f.broadcasts.length, 1);
  assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action'); assert.equal(f.signs, 1);
  await f.auto.recover(result.id); assert.deepEqual(f.broadcasts, ['original-raw', 'original-raw']);
  f.confirmed = true;
  assert.equal((await f.auto.check(result.id)).status, 'completed'); assert.equal(f.wallet.state.policy.spent, spent); assert.equal(f.executions, 1);
});
test('lost approval response reserves budget and never signs or starts another purchase', async t => {
  const f = fixture(t); f.approvalTimeout = true;
  assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action');
  f.approvalTimeout = false;
  assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action');
  assert.equal((await f.auto.execute({ ...f.input, requestId: 'other-request-001' })).status, 'needs_owner_action');
  assert.throws(() => f.auto.enable(f.policy), /outstanding/);
  await assert.rejects(f.auto.withdraw({}), /outstanding/);
  assert.equal(f.signs, 0);
  const record = f.client.find(f.input.requestId), spent = f.wallet.state.policy.spent;
  await f.auto.cancelUnsent(record.id);
  assert.equal(f.wallet.state.policy.spent, spent);
  assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action');
  f.auto.enable(f.policy); // Owner may now start a new bounded session.
});

test('approval connection failure remains actionable across polling and restart without signing', async t => {
  const f = fixture(t), originalFetch = f.wallet.fetch;
  f.wallet.fetch = async (url, options) => {
    if (url.endsWith('/approve')) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return originalFetch(url, options);
  };
  const result = await f.auto.execute(f.input);
  assert.equal(result.status, 'needs_owner_action');
  assert.match(result.message, /\/approve.*ECONNRESET/);
  const spent = f.wallet.state.policy.spent;
  f.wallet.fetch = originalFetch;
  f.auto = new AutonomousOrders(f.wallet, f.signer, f.client, { confirmationWaitMs: 0 });
  for (const response of [await f.auto.check(result.id), await f.auto.execute(f.input)]) {
    assert.equal(response.status, 'needs_owner_action');
    assert.match(response.message, /Approval request was interrupted/);
    assert.match(response.message, /ECONNRESET/);
    assert.doesNotMatch(response.message, /Saved approval changed/);
    assert.equal(response.order.approvalStatus, 'pending');
  }
  assert.equal(f.signs, 0); assert.equal(f.broadcasts.length, 0);
  assert.equal(f.wallet.state.policy.spent, spent);
});
test('delivery ambiguity is preserved; no automatic replay or second charge', async t => {
  const f = fixture(t); f.failDelivery = true;
  const result = await f.auto.execute(f.input); assert.equal(result.status, 'delivery_unknown');
  await f.auto.execute(f.input); await f.auto.check(result.id);
  assert.equal(f.executions, 1); assert.equal(f.signs, 1); assert.equal(f.broadcasts.length, 1);
});
test('reverted payment never gets replaced', async t => {
  const f = fixture(t); f.reverted = true;
  assert.equal((await f.auto.execute(f.input)).status, 'reverted');
  await f.auto.execute(f.input); assert.equal(f.signs, 1); assert.equal(f.executions, 0);
});
test('total principal budget remains consumed across completed purchases', async t => {
  const f = fixture(t); f.wallet.state.policy.budget = f.wallet.state.policy.perCall;
  assert.equal((await f.auto.execute(f.input)).status, 'completed');
  const result = await f.auto.execute({ ...f.input, requestId: 'second-purchase-001' });
  assert.equal(result.status, 'needs_owner_action'); assert.match(result.message, /remaining session budget/);
  assert.equal(f.signs, 1);
});
test('tampered request and quote are refused before approval or transfer', async t => {
  for (const mutate of [o => o.body = { changed: true }, o => o.quote.asset = ethers.ZeroAddress,
    o => o.quote.chainId = 1, o => o.quote.amount = '1', o => o.quote.recipient = ethers.Wallet.createRandom().address]) {
    const f = fixture(t); await f.client.request(f.input); const record = f.client.find(f.input.requestId);
    const order = await f.engine.load(record.id, record.accessToken); mutate(order); await f.engine.save(order);
    assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action'); assert.equal(f.signs, 0);
  }
});
test('owner cancellation cannot erase a saved signed transaction', async t => {
  const f = fixture(t); f.confirmed = false;
  const result = await f.auto.execute(f.input);
  await assert.rejects(f.auto.cancelUnsent(result.id), /no saved signed transaction/);
  assert.equal(f.wallet.state.remoteOrders[0].autonomous.phase, 'submitted');
});
test('pending nonce blocks a different request and owner withdrawal', async t => {
  const f = fixture(t); f.confirmed = false;
  await f.auto.execute(f.input);
  assert.equal((await f.auto.execute({ ...f.input, requestId: 'another-request-002' })).status, 'needs_owner_action');
  await assert.rejects(f.auto.withdraw({}), /outstanding/);
  assert.equal(f.signs, 1);
});
test('restart after completed delivery retrieves result without enabling signing', async t => {
  const f = fixture(t); const result = await f.auto.execute(f.input);
  f.auto = new AutonomousOrders(f.wallet, f.signer, f.client, { confirmationWaitMs: 0 });
  assert.equal((await f.auto.check(result.id)).status, 'completed');
  assert.equal((await f.auto.execute(f.input)).status, 'completed');
  assert.equal(f.signs, 1); assert.equal(f.executions, 1);
});
test('wallet preflight failure is owner-actionable and leaves budgets untouched', async t => {
  const f = fixture(t); f.signer.prepare = async () => { throw Error('Insufficient token balance'); };
  const result = await f.auto.execute(f.input);
  assert.equal(result.status, 'needs_owner_action'); assert.match(result.message, /Insufficient token balance/);
  assert.equal(f.wallet.state.policy.spent, '0'); assert.equal(f.signs, 0);
});
test('passwordless daily limits pay once per request and survive restart and edits', async t => {
  const f = fixture(t);
  const settings = { enabled: true, token: 'USDG', daily: '0.004', perCall: '0.002',
    gasDaily: '0.001', gasPerCall: '0.0001', gasMode: 'standard' };
  f.auto.configureAgentPayments(settings);
  assert.equal(f.wallet.state.policy.active, false, 'Timed session must not run alongside agent payments');
  assert.equal((await f.auto.execute(f.input)).status, 'completed');
  assert.equal((await f.auto.execute(f.input)).status, 'completed');
  assert.equal(f.signs, 1, 'Same request ID must not pay twice');
  assert.equal((await f.auto.execute({ ...f.input, requestId: 'auto-pitch-002' })).status, 'completed');
  assert.equal(f.wallet.state.agentPayments.spent.USDG, '4000');
  f.auto = new AutonomousOrders(f.wallet, f.signer, f.client, { confirmationWaitMs: 0 });
  assert.equal(f.wallet.state.agentPayments.enabled, true);
  const blocked = await f.auto.execute({ ...f.input, requestId: 'auto-pitch-003' });
  assert.equal(blocked.status, 'needs_owner_action'); assert.match(blocked.message, /daily limit/);
  assert.equal(f.signs, 2);
  f.auto.configureAgentPayments({ ...settings, daily: '0.006' });
  assert.equal(f.wallet.state.agentPayments.spent.USDG, '4000', 'Editing must not erase prior spending');
  assert.equal((await f.auto.execute({ ...f.input, requestId: 'auto-pitch-003' })).status, 'completed');
  assert.equal(f.wallet.state.agentPayments.spent.USDG, '6000');
});
test('automatic limits reject invalid caps and changes before signing prevent broadcast', async t => {
  const f = fixture(t);
  const settings = { enabled: true, token: 'USDG', daily: '0.004', perCall: '0.002',
    gasDaily: '0.001', gasPerCall: '0.0001', gasMode: 'standard' };
  assert.throws(() => f.auto.configureAgentPayments({ ...settings, perCall: '0.005' }), /per-call limit/i);
  assert.throws(() => f.auto.configureAgentPayments({ ...settings, gasPerCall: '0.002' }), /gas limit/i);
  f.auto.configureAgentPayments(settings);
  f.signer.prepare = async () => {
    f.auto.configureAgentPayments({ ...settings, enabled: false });
    return { transaction: { nonce: 7 }, gasCost: 10n };
  };
  assert.equal((await f.auto.execute(f.input)).status, 'needs_owner_action');
  assert.equal(f.signs, 0); assert.equal(f.broadcasts.length, 0);
});
test('UTC daily rollover resets counters while preserving configured limits', async t => {
  const f = fixture(t);
  f.auto.configureAgentPayments({ enabled: true, token: 'USDG', daily: '0.004', perCall: '0.002',
    gasDaily: '0.001', gasPerCall: '0.0001', gasMode: 'standard' });
  assert.equal((await f.auto.execute(f.input)).status, 'completed');
  const before = f.wallet.state.agentPayments;
  agentPayments.rollDay(f.wallet, Date.parse(before.day + 'T00:00:00Z') + 86400000);
  assert.equal(f.wallet.state.agentPayments.spent.USDG, undefined);
  assert.equal(f.wallet.state.agentPayments.gasSpent, '0');
  assert.equal(f.wallet.state.agentPayments.limits.USDG.daily, '0.004');
});
