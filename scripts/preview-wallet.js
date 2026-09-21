'use strict';
// Isolated UI fixtures. No wallet, keystore, journal, signer or RPC is loaded.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.WALLET_PREVIEW_PORT || 4783);
const now = Date.now(), manual = process.argv.includes('--manual');
const testnet = process.argv.includes('--testnet');
const chainId = testnet ? 46630 : 4663;
const address = '0x' + '11'.repeat(20), recipient = '0x' + '22'.repeat(20);
const quote = { name: 'Startup Pitch Scorer (example)', chainId, token: 'USDG', decimals: 6,
  amount: '2000', displayAmount: '0.002', recipient, expiresAt: now + 300000 };
function record(id, approvalStatus, paymentStatus, deliveryStatus, phase, message) {
  return { id, requestId: 'preview-' + id, phase, input: { slug: 'startup-pitch-scorer', method: 'POST', body: { name: 'Example', pitch: 'A sample request for UI preview.' } },
    summary: { name: quote.name, quote, approvalStatus, paymentStatus, deliveryStatus, payer: address,
      updatedAt: now, message, ...(phase === 'reserved' ? { status: 'needs_owner_action' } : {}),
      result: deliveryStatus === 'completed' ? { status: 200, contentType: 'application/json' } : null } };
}
const records = [record('order-001', 'approved', 'confirmed', 'completed', 'completed'),
  record('order-002', 'approved', 'submitted', 'not_started', 'submitted'),
  record('order-003', 'approved', 'unpaid', 'not_started', 'reserved', 'Approval interrupted. Owner review required; no transaction was saved.')];
const state = { preview: true, walletProvider: manual ? 'browser' : 'olanas', address,
  chain: { name: 'Robinhood Chain' + (testnet ? ' Testnet' : '') + ' (preview)', chainId, networkKey: testnet ? 'testnet' : 'mainnet', tokens: [{ symbol: 'USDG', decimals: 6 }, { symbol: 'ETH', decimals: 18 }] },
  launchpad: 'Preview only - no launchpad connection', intents: [], remoteOrders: records,
  policy: manual ? null : { active: true, expiresAt: now + 3600000, token: 'USDG', perCall: '2000', budget: '10000', spent: '6000',
    gasSpent: '3000000000000', gasBudget: '10000000000000', services: ['startup-pitch-scorer'], recipients: [recipient] } };
const assets = { '/': ['wallet.html', 'text/html'], '/wallet.js': ['wallet.js', 'text/javascript'], '/session-presets.js': ['session-presets.js', 'text/javascript'], '/wallet.css': ['wallet.css', 'text/css'], '/ethers.js': ['dist/ethers.js', 'text/javascript'] };
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const url = new URL(req.url, 'http://127.0.0.1:' + port);
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') return json(403, { error: 'Read-only preview. No payments, transfers or policy changes are available.' });
  if (url.pathname === '/api/state') return json(200, state);
  if (url.pathname === '/api/balance') return json(200, { address, balances: [{ token: 'USDG', amount: '0.050' }, { token: 'ETH', amount: '0.001' }] });
  if (url.pathname.startsWith('/api/orders/')) {
    const record = records.find(r => r.id === url.pathname.split('/').at(-1));
    if (!record) return json(404, { error: 'Unknown preview order' });
    return json(200, { order: { ...record.summary, result: record.summary.result ? { ...record.summary.result, encoding: 'base64',
      body: Buffer.from(JSON.stringify({ preview: true, score: 88, note: 'Example saved response. No service was called.' }, null, 2)).toString('base64') } : null } });
  }
  const asset = assets[url.pathname];
  if (!asset) return json(404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': asset[1] }); fs.createReadStream(path.join(root, asset[0])).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log('Read-only wallet preview: http://127.0.0.1:' + port + '/#preview'));
