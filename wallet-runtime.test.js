'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { ethers } = require('ethers');
const { saveImportedWallet } = require('./scripts/import-side-wallet');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Launch the shipped bundle with an ephemeral wallet and loopback-only RPC.
// No real keystore, RPC, launchpad, payment, or owner policy is touched.
test('packaged wallet serves matching assets, authenticates owner controls and exposes MCP', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olanas-runtime-test-'));
  const password = 'test-only-owner-password';
  const wallet = ethers.Wallet.createRandom();
  const imported = await saveImportedWallet({ privateKey: wallet.privateKey, password, directory: path.join(dir, 'imported') },
    target => fs.mkdirSync(target)); // Generated test key only; real importer uses owner-only OS permissions.
  let rpcChain = '0x1237'; // 4663
  const rpcMethods = [];
  const rpc = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const reply = item => {
      rpcMethods.push(item.method);
      const result = item.method === 'eth_chainId' ? rpcChain : item.method === 'eth_call' ? '0x' + '0'.repeat(64) : '0x0';
      return { jsonrpc: '2.0', id: item.id, result };
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(reply) : reply(payload)));
  });
  rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
  const rpcUrl = 'http://127.0.0.1:' + rpc.address().port;
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    PAYMENTS_DATA_DIR: dir, PAYMENTS_MCP_PORT: String(port), ROBINHOOD_NETWORK: 'mainnet',
    ROBINHOOD_MAINNET_RPC_URL: rpcUrl, PAYMENTS_LAUNCHPAD_URL: rpcUrl, X402_DEMO_MODE: 'false' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--env-file=' + imported.envFile, path.join(__dirname, 'dist', 'bundle.js')], env, stderr: 'pipe' });
  const client = new Client({ name: 'wallet-runtime-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'request_paid_api'));
    assert.ok(!listed.tools.some(tool => /session|withdraw|revoke/.test(tool.name)));
    const shown = await client.callTool({ name: 'show_wallet', arguments: {} });
    const { walletUrl, walletProvider } = JSON.parse(shown.content[0].text);
    assert.equal(walletProvider, 'olanas');
    const url = new URL(walletUrl), token = url.hash.slice(1);
    const headers = { authorization: 'Bearer ' + token };
    const request = (route, options = {}) => fetch(url.origin + route, { ...options, signal: AbortSignal.timeout(5000) });
    for (const [route, file] of [['/', 'wallet.html'], ['/wallet.js', 'wallet.js'], ['/wallet.css', 'wallet.css'], ['/session-presets.js', 'session-presets.js']]) {
      const res = await request(route);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(await res.text(), fs.readFileSync(path.join(__dirname, file), 'utf8'), 'Rebuild stale asset: ' + file);
    }
    assert.equal((await request('/ethers.js')).status, 200);
    assert.equal((await request('/api/state')).status, 401);
    assert.equal((await request('/api/state', { headers: { ...headers, origin: 'https://untrusted.example' } })).status, 403);
    const state = async () => (await request('/api/state', { headers })).json();
    assert.equal((await state()).address, wallet.address);
    assert.equal((await state()).walletProvider, 'olanas');
    const browserConnect = await request('/api/connect', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ethers.Wallet.createRandom().address }) });
    assert.equal(browserConnect.status, 400);
    assert.equal((await state()).address, wallet.address, 'A browser connection must not replace the imported wallet');
    assert.equal((await state()).signedTransactions, undefined);
    const autoSettings = { enabled: true, token: 'OLANAS', daily: '50', perCall: '10',
      gasDaily: '0.0001', gasPerCall: '0.00001', gasMode: 'standard' };
    const saveAuto = await request('/api/agent-payments', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(autoSettings) });
    assert.equal(saveAuto.status, 200, 'Agent limits need the private companion link but no owner password');
    assert.equal((await state()).agentPayments.enabled, true);
    assert.equal((await state()).agentPayments.limits.OLANAS.daily, '50');
    assert.equal((await request('/api/agent-payments', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(autoSettings) })).status, 401);
    const missing = await request('/api/unknown', { headers });
    assert.equal(missing.status, 404); assert.match((await missing.json()).error, /Unknown companion endpoint/);
    const balance = await request('/api/balance', { headers });
    assert.equal(balance.status, 200); assert.equal((await balance.json()).chainId, 4663);
    rpcChain = '0x1';
    const mismatch = await request('/api/balance', { headers });
    assert.equal(mismatch.status, 400); assert.match((await mismatch.json()).error, /RPC network mismatch/);
    const post = (route, body, owner = password) => request(route, { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-owner-password': owner }, body: JSON.stringify(body) });
    const input = { token: 'USDG', budget: '0.01', minutes: 60, gasMode: 'standard' };
    assert.equal((await post('/api/owner/session', input, 'incorrect')).status, 403);
    for (const gasMode of ['standard', 'fast']) {
      const enabled = await post('/api/owner/session', { ...input, gasMode });
      assert.equal(enabled.status, 200);
      const policy = await enabled.json();
      assert.equal(policy.active, true); assert.equal(policy.gasMode, gasMode);
      assert.equal((await state()).agentPayments.enabled, false, 'Timed session replaces automatic mode');
      assert.equal(policy.perCall, '2000'); assert.equal(policy.budget, '10000');
      assert.equal(policy.gasPerCall, '10000000000000');
      assert.equal((await post('/api/owner/revoke', {})).status, 200);
      assert.equal((await state()).policy.active, false);
    }
    assert.equal((await post('/api/owner/session', { ...input, perCall: '1' })).status, 400);
    const finalState = await state();
    assert.equal(finalState.intents.length, 0); assert.equal(finalState.remoteOrders.length, 0);
    assert.ok(rpcMethods.every(method => ['eth_chainId', 'eth_getBalance', 'eth_call'].includes(method)), 'Only read-only RPC calls are allowed');
  } finally {
    await client.close(); await transport.close();
    await new Promise(resolve => rpc.close(resolve));
    // Only remove this test-created directory, never the configured user wallet.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
