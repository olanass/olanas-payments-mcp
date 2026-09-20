'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

async function readBounded(response, limit, truncate = false) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - bytes;
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += value.length;
      if (bytes > limit) {
        await reader.cancel();
        if (!truncate) throw new Error('Launchpad response too large');
        return Buffer.concat(chunks).toString('utf8') + '\n[Response truncated]';
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

// No wallet private keys are stored here. Browser wallets or CDP handle signing.
class PaymentsWallet {
  constructor({ chain, baseUrl, file, fetchImpl = fetch, verify }) {
    this.chain = chain;
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
      throw new Error('Launchpad must be an HTTPS origin (HTTP loopback allowed for development)');
    }
    this.baseUrl = url.origin;
    this.file = file;
    this.fetch = fetchImpl;
    this.verify = verify;
    this.state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { address: null, intents: [] };
    this.busy = new Set();
    this.save();
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  connect(address) { this.state.address = ethers.getAddress(address); this.save(); }
  get(id) {
    const intent = this.state.intents.find(item => item.id === id);
    if (!intent) throw new Error('Unknown payment request');
    return intent;
  }
  async json(route) {
    const response = await this.fetch(this.baseUrl + route, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Launchpad returned HTTP ' + response.status);
    const text = await readBounded(response, 1000000);
    return JSON.parse(text);
  }
  async discover(query = '') { return this.json('/api/services?status=live&limit=20&search=' + encodeURIComponent(query)); }
  async request({ slug, method = 'POST', body, requestId }) {
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new Error('Invalid service slug');
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId || '')) throw new Error('A unique requestId of 8-80 characters is required');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported method');
    if (body != null && method === 'GET') throw new Error('GET cannot have a body');
    if (JSON.stringify(body ?? null).length > 16000) throw new Error('Request body exceeds 16 KB');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ slug, method, body })).digest('hex');
    const old = this.state.intents.find(item => item.requestId === requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('requestId already used with different input');
      return old;
    }
    if (this.busy.has(requestId)) throw new Error('Request creation in progress');
    if (!this.state.address) throw new Error('Connect your wallet in the companion first');
    if (this.state.intents.filter(item => item.status === 'pending').length >= 20) throw new Error('Review pending requests first');
    this.busy.add(requestId);
    try {
      const { service } = await this.json('/api/services/' + slug);
      if (!service || service.status !== 'live' || service.chainId !== this.chain.chainId) throw new Error('Service is unavailable or on another chain');
      if (!service.allowedMethods.includes(method)) throw new Error('Method not supported by service');
      const token = this.chain.supportedTokens[service.currency];
      if (!token) throw new Error('Token is not supported on this Robinhood network');
      const amount = ethers.parseUnits(String(service.price), token.decimals);
      if (amount <= 0n) throw new Error('Invalid price');
      const intent = {
        id: crypto.randomUUID(), requestId, fingerprint, slug, method, body,
        origin: this.baseUrl, chainId: this.chain.chainId, payer: this.state.address,
        name: String(service.name).slice(0, 120), token: token.symbol,
        asset: token.address, decimals: token.decimals, amount: amount.toString(),
        displayAmount: ethers.formatUnits(amount, token.decimals), payTo: ethers.getAddress(service.payoutAddress),
        status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 300000
      };
      this.state.intents.push(intent); this.save(); return intent;
    } finally { this.busy.delete(requestId); }
  }
  begin(id) {
    const item = this.get(id);
    if (item.origin !== this.baseUrl || item.chainId !== this.chain.chainId) throw new Error('Request belongs to another network or launchpad');
    if (item.status !== 'pending' || item.expiresAt < Date.now()) throw new Error('Request expired or already reviewed');
    item.status = 'awaiting_wallet'; this.save(); return item;
  }
  reject(id) {
    const item = this.get(id);
    if (item.status !== 'pending') throw new Error('Only unreviewed requests can be rejected');
    item.status = 'rejected'; this.save(); return item;
  }
  async complete(id, txHash) {
    const item = this.get(id);
    if (item.origin !== this.baseUrl || item.chainId !== this.chain.chainId) throw new Error('Network or launchpad changed');
    if (item.status === 'completed') return item;
    if (!['awaiting_wallet', 'submitted', 'delivery_unknown'].includes(item.status)) throw new Error('Request must be reviewed in wallet');
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('Invalid transaction hash');
    if (item.txHash && item.txHash.toLowerCase() !== txHash.toLowerCase()) throw new Error('Use the original transaction; never pay twice');
    if (this.state.intents.some(other => other.id !== id && other.txHash?.toLowerCase() === txHash.toLowerCase())) throw new Error('Transaction already assigned to another request');
    if (this.busy.has(id)) throw new Error('Payment is already processing');
    this.busy.add(id);
    try {
      item.txHash = txHash; item.status = 'submitted'; this.save();
      const proof = { scheme: 'onchain-tx', payer: item.payer, txHash };
      const checked = await this.verify(proof, { token: item.token, price: item.displayAmount, recipient: item.payTo, resource: '/x402/' + item.slug });
      if (!checked.valid) throw new Error(checked.error || 'Transaction not confirmed');
      // Save before sending: after a timeout never automatically repeat a side-effecting API call.
      item.status = 'delivery_unknown'; this.save();
      const response = await this.fetch(this.baseUrl + '/x402/' + item.slug, {
        method: item.method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64') },
        body: item.body == null ? undefined : JSON.stringify(item.body)
      });
      item.result = { status: response.status, body: await readBounded(response, 100000, true), receipt: response.headers.get('payment-response') };
      item.status = 'completed'; this.save(); return item;
    } finally { this.busy.delete(id); }
  }
}
module.exports = { PaymentsWallet };
