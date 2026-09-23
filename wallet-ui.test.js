'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Run the actual client startup against the IDs/classes in the shipped HTML.
// Requests and wallet extensions are mocked; no funds or real accounts are used.
function client(mode, { credential = 'test-token', status = 200, intents = [], remoteOrders = [], policy = null,
  agentPayments = null, orderResult = null, tokens = [{ symbol: 'USDG', decimals: 6 }] } = {}) {
  const html = fs.readFileSync('wallet.html', 'utf8');
  const nodes = new Map();
  function node() {
    return { textContent: '', value: '', options: [], dataset: {}, disabled: false,
      setAttribute() {}, replaceChildren() { this.options = []; }, append(child) { this.options.push(child); },
      querySelector() { return this.message ||= node(); } };
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], node());
  for (const match of html.matchAll(/<input\b[^>]*id="([^"]+)"[^>]*>/g)) nodes.get(match[1]).value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)];
    nodes.get(match[1]).value = (options.find(m => m[0].includes('selected')) || options[0])?.[1] || '';
  }
  const selected = new Map();
  const document = {
    documentElement: node(), getElementById: id => nodes.get(id) || null,
    createElement: node, querySelectorAll: () => [],
    querySelector(selector) {
      // Validate the parent exists in the real HTML before returning its child.
      const parent = selector.split(/[ >]/)[0];
      const exists = parent[0] === '#' ? nodes.has(parent.slice(1)) :
        [...html.matchAll(/class="([^"]+)"/g)].some(m => m[1].split(' ').includes(parent.slice(1)));
      if (!exists) return null;
      if (!selected.has(selector)) selected.set(selector, node());
      return selected.get(selector);
    }
  };
  const events = {};
  const requests = [];
  const apiCalls = [];
  let offline = false;
  const storage = new Map(credential ? [['olanas-companion-token', credential]] : []);
  const sessionStorage = { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  const state = { walletProvider: mode, address: null, chain: { name: 'Test chain', chainId: 4663,
    tokens }, intents, remoteOrders, policy, agentPayments, launchpad: 'https://example.test' };
  let now = Date.now();
  let reloads = 0;
  let poll;
  const context = vm.createContext({ document, sessionStorage, localStorage: sessionStorage,
    Date: class extends Date { static now() { return now; } },
    location: { hash: '', origin: 'http://127.0.0.1:4782', reload() { reloads++; } }, history: { replaceState() {} },
    window: { addEventListener: (type, fn) => { events[type] = fn; } },
    URL, TextDecoder, Uint8Array, atob, AbortSignal,
    ethers: require('ethers').ethers,
    OlanasSessionPresets: require('./session-presets'),
    matchMedia: () => ({ matches: false }), setInterval: fn => { poll = fn; },
    fetch: async (url, options) => { requests.push(url); apiCalls.push({ url, options }); if (offline) throw Error('offline');
      if (url === '/api/agent-payments') {
        const input = JSON.parse(options.body); state.agentPayments = { ...state.agentPayments, enabled: input.enabled,
          revision: state.agentPayments.revision + 1, gasDaily: input.gasDaily, gasPerCall: input.gasPerCall,
          gasMode: input.gasMode, limits: { ...state.agentPayments.limits, [input.token]: { daily: input.daily, perCall: input.perCall } } };
      }
      return { status, ok: status === 200,
        json: async () => url === '/api/state' ? structuredClone(state) : url === '/api/agent-payments' ? structuredClone(state.agentPayments) : url.startsWith('/api/orders/') ? orderResult : { address: null, balances: [] } }; }
  });
  vm.runInContext(fs.readFileSync('wallet.js', 'utf8'), context);
  return { context, nodes, requests, apiCalls, events, state, setOffline: value => { offline = value; }, advance: ms => { now += ms; }, get reloads() { return reloads; }, poll: () => poll?.() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('archived interrupted orders expose recovery beside session controls and block enabling', async () => {
  const app = client('olanas', { remoteOrders: [{ id: 'ord_blocked', requestId: 'blocked-request', archivedAt: 123,
    phase: 'reserved', summary: { approvalStatus: 'pending', paymentStatus: 'unpaid' } }] });
  await settle();
  assert.equal(app.nodes.get('enable-session').disabled, true);
  assert.equal(app.nodes.get('revoke').disabled, true);
  assert.match(app.nodes.get('session-action-help').textContent, /archiving a request does not cancel/);
  assert.equal(app.nodes.get('session-blockers').hidden, false);
  assert.ok(descendants(app.nodes.get('session-blockers')).some(n => n.textContent === 'Cancel interrupted approval'));
  await app.nodes.get('session-form').onsubmit({ preventDefault() {} });
  assert.ok(!app.requests.includes('/api/owner/session'));
  app.state.remoteOrders[0].phase = 'cancelled'; app.poll(); await settle();
  assert.equal(app.nodes.get('enable-session').disabled, false);
  assert.equal(app.nodes.get('session-blockers').hidden, true);
  assert.ok(!app.requests.some(p => /cancel-unsent|recover/.test(p)));
});

test('archived signed orders expose original transaction recovery and keep revocation available', async () => {
  const app = client('olanas', { policy: { active: true, expiresAt: Date.now() + 60000, token: 'USDG', budget: '6000', spent: '2000', gasSpent: '10' },
    remoteOrders: [{ id: 'ord_signed', phase: 'submitted', archivedAt: 123 }] });
  await settle();
  assert.equal(app.nodes.get('enable-session').disabled, true);
  assert.equal(app.nodes.get('revoke').disabled, false);
  assert.ok(descendants(app.nodes.get('session-blockers')).some(n => n.textContent === 'Recover original transaction'));
  assert.ok(!descendants(app.nodes.get('session-blockers')).some(n => n.textContent === 'Cancel interrupted approval'));
});
test('reopening a rejected request requires confirmation and never starts payment', async () => {
  const app = client('browser', { intents: [{ id: 'rejected-id', requestId: 'demo-request-001', status: 'rejected',
    name: 'Scorer', displayAmount: '0.002', token: 'USDG', method: 'POST', slug: 'scorer' }] });
  await settle();
  const buttons = app.nodes.get('requests').options[0].options.find(n => n.className === 'actions').options;
  const reopen = buttons.find(n => n.textContent === 'Reopen for review');
  assert.ok(reopen);
  assert.ok(!buttons.some(n => n.textContent.startsWith('Approve')));
  app.context.confirm = () => false;
  await reopen.onclick();
  assert.ok(!app.requests.includes('/api/requests/rejected-id/reopen'));
  app.context.confirm = () => true;
  await reopen.onclick();
  assert.ok(app.requests.includes('/api/requests/rejected-id/reopen'));
  assert.ok(!app.requests.some(url => /\/(begin|complete)$/.test(url)));
});
test('cancelling rejection leaves the request untouched', async () => {
  const app = client('browser', { intents: [{ id: 'pending-id', status: 'pending', expiresAt: Date.now() + 300000 }] });
  await settle();
  const buttons = app.nodes.get('requests').options[0].options.find(n => n.className === 'actions').options;
  app.context.confirm = () => false;
  await buttons.find(n => n.textContent === 'Reject').onclick();
  assert.ok(!app.requests.includes('/api/requests/pending-id/reject'));
});
test('unchanged server data still expires on screen and refresh never starts payment', async () => {
  const app = client('browser', { intents: [{ id: 'test-id', status: 'pending', expiresAt: Date.now() + 300000,
    name: 'Scorer', displayAmount: '0.002', token: 'USDG', method: 'POST', slug: 'scorer' }] });
  await settle();
  const buttons = () => app.nodes.get('requests').options[0].options.find(n => n.className === 'actions').options;
  assert.ok(buttons().some(n => n.textContent.startsWith('Approve payment')));
  app.advance(300001); app.poll(); await settle();
  assert.ok(!buttons().some(n => n.textContent.startsWith('Approve payment')));
  await buttons().find(n => n.textContent === 'Refresh quote').onclick();
  assert.ok(app.requests.includes('/api/requests/test-id/refresh'));
  assert.ok(!app.requests.some(url => /\/(begin|complete)$/.test(url)));
});
for (const mode of ['browser', 'olanas']) {
  test(mode + ' startup renders the redesigned wallet and fetches balances', async () => {
    const app = client(mode);
    await settle();
    assert.equal(app.nodes.get('network').textContent, 'Test chain · MAINNET');
    assert.equal(app.nodes.get('address').textContent, 'No wallet connected');
    assert.equal(app.nodes.get('connect').hidden, mode === 'olanas');
    assert.deepEqual(app.requests, ['/api/state', '/api/balance']);
    assert.equal(app.nodes.get('token').options.length, 1);
  });
}
test('automatic payment limit is editable in the UI without an owner password', async () => {
  const settings = { enabled: false, revision: 1, day: '2026-09-23',
    limits: { USDG: { daily: '0', perCall: '0' }, OLANAS: { daily: '50', perCall: '10' } },
    spent: { USDG: '0', OLANAS: '0' }, gasDaily: '0.0001', gasPerCall: '0.00001',
    gasSpent: '0', gasMode: 'standard', resetsAt: '2026-09-24T00:00:00.000Z' };
  const app = client('olanas', { agentPayments: settings,
    tokens: [{ symbol: 'USDG', decimals: 6 }, { symbol: 'OLANAS', decimals: 18 }] });
  await settle();
  assert.equal(app.nodes.get('agent-payments').hidden, false);
  assert.equal(app.nodes.get('agent-token').value, 'OLANAS');
  assert.equal(app.nodes.get('agent-daily').value, '50');
  app.nodes.get('agent-enabled').checked = true;
  app.nodes.get('agent-daily').value = '75';
  app.nodes.get('agent-daily').oninput();
  app.context.confirm = () => true;
  await app.nodes.get('agent-form').onsubmit({ preventDefault() {} });
  const saved = app.apiCalls.find(call => call.url === '/api/agent-payments');
  assert.ok(saved);
  assert.equal(saved.options.headers['x-owner-password'], undefined);
  assert.equal(JSON.parse(saved.options.body).daily, '75');
  assert.equal(app.nodes.get('agent-badge').textContent, 'On');
});
test('a fresh link in the same tab reloads to consume its token', () => {
  const app = client('browser', { credential: null });
  assert.deepEqual(app.requests, []);
  app.context.location.hash = '#' + 'a'.repeat(64);
  app.events.hashchange();
  assert.equal(app.reloads, 1);
});
test('section links never replace wallet authorization or reload the app', () => {
  const app = client('olanas');
  for (const section of ['funding', 'owner-controls', 'activity']) {
    app.context.location.hash = '#' + section; app.events.hashchange();
  }
  assert.equal(app.reloads, 0);
  assert.equal(app.context.sessionStorage.getItem('olanas-companion-token'), 'test-token');
});
test('bare URL shows local-wallet access, not a browser connection or loading balance', () => {
  const app = client('olanas', { credential: null });
  assert.equal(app.nodes.get('wallet-access').hidden, false);
  assert.equal(app.nodes.get('connect').hidden, true);
  assert.equal(app.nodes.get('refresh').disabled, true);
  assert.match(app.nodes.get('balances').textContent, /Authorize this tab/);
  assert.deepEqual(app.requests, []);
  const token = 'b'.repeat(64);
  app.nodes.get('wallet-link').value = 'http://127.0.0.1:4782/#' + token;
  app.nodes.get('wallet-link-form').onsubmit({ preventDefault() {} });
  assert.equal(app.context.sessionStorage.getItem('olanas-companion-token'), token);
  assert.equal(app.nodes.get('wallet-link').value, '');
  assert.equal(app.reloads, 1);
});
test('wallet-link entry refuses other origins, ports and wallet keys', () => {
  const app = client('olanas', { credential: null });
  for (const value of ['https://example.com/#' + 'a'.repeat(64), 'http://127.0.0.1:4783/#' + 'a'.repeat(64), '0x' + 'a'.repeat(64)]) {
    app.nodes.get('wallet-link').value = value;
    app.nodes.get('wallet-link-form').onsubmit({ preventDefault() {} });
    assert.equal(app.nodes.get('wallet-link').value, '');
  }
  assert.equal(app.reloads, 0); assert.deepEqual(app.requests, []);
  assert.equal(app.context.sessionStorage.getItem('olanas-companion-token'), undefined);
});
test('unauthorized sessions stop polling and cannot start wallet actions', async () => {
  const app = client('browser', { status: 401 });
  await settle();
  app.poll();
  await app.nodes.get('connect').onclick();
  await settle();
  assert.deepEqual(app.requests, ['/api/state']);
  assert.equal(app.context.sessionStorage.getItem('olanas-companion-token'), undefined);
});
const descendants = node => [node, ...(node.options || []).flatMap(descendants)];
const remote = (phase = 'completed', deliveryStatus = 'completed') => ({ id: 'ord_example', requestId: 'request-example-001', phase,
  input: { slug: 'pitch', method: 'POST', body: { pitch: 'Example' } },
  summary: { name: 'Pitch scorer', approvalStatus: 'approved', paymentStatus: 'confirmed', deliveryStatus,
    quote: { displayAmount: '0.002', token: 'USDG' } } });
test('active session shows remaining budget; expired session cannot appear active', async () => {
  const app = client('olanas', { policy: { active: true, expiresAt: Date.now() + 10000, token: 'USDG',
    budget: '6000', spent: '2000', gasSpent: '10', services: ['pitch'], recipients: ['*'] } });
  await settle();
  assert.equal(app.nodes.get('session-headline').textContent, 'Session active.');
  assert.equal(app.nodes.get('budget-remaining').textContent, '0.004 USDG');
  app.advance(11000); app.poll(); await settle();
  assert.equal(app.nodes.get('session-headline').textContent, 'Session expired.');
  assert.equal(app.nodes.get('policy-badge').textContent, 'Inactive');
});
test('completed remote requests have no recovery button or false empty state', async () => {
  const app = client('olanas', { remoteOrders: [remote()] }); await settle();
  const text = descendants(app.nodes.get('requests')).map(n => n.textContent).join('\n');
  assert.match(text, /Result saved/); assert.match(text, /0.002 USDG/);
  assert.doesNotMatch(text, /Recover original|Cancel interrupted|next request starts/);
});
test('result retrieval is read-only, stays visible after refresh, and uses text nodes', async () => {
  const untrusted = '<script>alert(1)</script>';
  const app = client('olanas', { remoteOrders: [remote()], orderResult: { order: { ...remote().summary,
    result: { status: 200, encoding: 'base64', contentType: 'text/plain', body: Buffer.from(untrusted).toString('base64') } } } });
  await settle();
  await descendants(app.nodes.get('requests')).find(n => n.textContent === 'Check status / view result').onclick();
  assert.ok(app.requests.includes('/api/orders/ord_example'));
  assert.ok(!app.requests.some(p => /owner|payment|reconcile/.test(p)));
  assert.ok(descendants(app.nodes.get('requests')).some(n => n.textContent === untrusted));
});
test('attention filter and unknown-delivery warning preserve safe actions', async () => {
  const app = client('olanas', { remoteOrders: [remote(), { ...remote('delivery_unknown', 'unknown'), id: 'ord_unknown' }] });
  await settle();
  app.nodes.get('activity-filter').value = 'attention'; app.nodes.get('activity-filter').onchange(); await settle();
  const text = descendants(app.nodes.get('requests')).map(n => n.textContent).join('\n');
  assert.match(text, /Do not pay again/); assert.doesNotMatch(text, /Recover original transaction/);
  assert.equal(app.nodes.get('requests').options.length, 1);
});
test('simple form defaults produce the intended Standard and Fast owner policies', async () => {
  for (const mode of ['standard', 'fast']) {
    const app = client('olanas'); await settle();
    app.nodes.get('gas-mode').value = mode;
    app.nodes.get('owner-password').value = 'fake-owner-password-for-tests';
    app.context.confirm = message => { assert.match(message, /0.002 per API call/); assert.match(message, /0.0001 ETH total/); return true; };
    await app.nodes.get('session-form').onsubmit({ preventDefault() {} });
    const request = app.apiCalls.find(c => c.url === '/api/owner/session'); assert.ok(request);
    const body = JSON.parse(request.options.body);
    assert.equal(body.budget, '0.01'); assert.equal(body.perCall, '0.002'); assert.equal(body.minutes, 60); assert.equal(body.gasMode, mode);
    assert.equal(body.gasBudget, '0.0001'); assert.deepEqual(body.services, ['*']);
    assert.equal(request.options.headers['x-owner-password'], 'fake-owner-password-for-tests');
    assert.ok(!request.options.body.includes('password'));
  }
});
test('cancelled session approval, missing owner password and invalid caps cannot enable spending', async () => {
  const app = client('olanas'); await settle();
  app.context.confirm = () => false;
  await app.nodes.get('session-form').onsubmit({ preventDefault() {} });
  app.context.confirm = () => true;
  await app.nodes.get('session-form').onsubmit({ preventDefault() {} });
  app.nodes.get('owner-password').value = 'fake-owner-password';
  app.nodes.get('per-call').value = '99';
  await app.nodes.get('session-form').onsubmit({ preventDefault() {} });
  assert.ok(!app.requests.includes('/api/owner/session'));
});
test('failed polling marks state unavailable, then recovers without losing form edits', async () => {
  const app = client('olanas'); await settle();
  app.nodes.get('session-budget').value = '0.05';
  app.setOffline(true); app.poll(); await settle();
  assert.equal(app.nodes.get('session-headline').textContent, 'Companion unavailable.');
  assert.equal(app.nodes.get('enable-session').disabled, true);
  assert.match(app.nodes.get('session-caption').textContent, /does not revoke/);
  app.setOffline(false); app.poll(); await settle();
  assert.equal(app.nodes.get('session-headline').textContent, 'Agent spending is off.');
  assert.equal(app.nodes.get('session-budget').value, '0.05');
  assert.equal(app.nodes.get('enable-session').disabled, false);
});

test('archived requests leave normal activity and can be restored without payment calls', async () => {
  const app = client('olanas', { remoteOrders: [remote(), { ...remote(), id: 'ord_archived', archivedAt: 123 }] });
  await settle();
  assert.equal(app.nodes.get('requests').options.length, 1);
  const remove = descendants(app.nodes.get('requests')).find(n => n.textContent === 'Remove from activity');
  await remove.onclick();
  assert.equal(JSON.parse(app.apiCalls.find(c => c.url.endsWith('/archive')).options.body).archived, true);
  app.nodes.get('activity-filter').value = 'archived';
  app.nodes.get('activity-filter').onchange(); await settle();
  assert.equal(app.nodes.get('requests').options.length, 1);
  const restore = descendants(app.nodes.get('requests')).find(n => n.textContent === 'Restore to activity');
  await restore.onclick();
  const call = app.apiCalls.find(c => c.url === '/api/activity/ord_archived/archive');
  assert.equal(JSON.parse(call.options.body).archived, false);
  assert.ok(!app.requests.some(p => /owner|reconcile|begin|complete/.test(p)));
});
