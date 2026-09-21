'use strict';
const crypto = require('node:crypto');

// Manual purchases are owned by the launchpad order engine. The companion only
// journals access credentials; it never reconstructs prices or signs payments.
class OrdersClient {
  constructor(wallet) { this.wallet = wallet; this.inflight = new Set(); }
  find(id) { return (this.wallet.state.remoteOrders || []).find(item => item.id === id || item.requestId === id); }
  async call(record, suffix = '', body) {
    if (record.origin !== this.wallet.baseUrl) throw new Error('Order belongs to another launchpad');
    let response;
    try { response = await this.wallet.fetch(record.origin + '/api/orders' + (record.id ? '/' + record.id : '') + suffix, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(35000),
      headers: { authorization: 'Bearer ' + record.accessToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }); } catch (error) {
      // Report the operation and a safe transport code, never request headers,
      // signed approval payloads, or arbitrary network error contents.
      const code = error.cause?.code || error.code || error.name;
      const detail = typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? ' (' + code + ')' : '';
      throw new Error('Order API ' + (suffix || (record.id ? '/status' : '/create')) + ' network request failed' + detail + '. Inspect the same order before retrying; no replacement payment.', { cause: error });
    }
    if (!response.ok) throw new Error(response.status === 404 ? 'The launchpad order API is unavailable or this order cannot be accessed. Check the website deployment and original transaction before retrying. Never create a replacement payment.' : 'Order API returned HTTP ' + response.status + '. Retry only with the same requestId.');
    return response.json();
  }
  output(record, order) {
    this.remember(record, order);
    return { order, id: record.id, requestId: record.requestId,
      approvalUrl: record.origin + '/orders/' + record.id + '#' + record.accessToken,
      instruction: 'Open approvalUrl for human wallet approval. Reuse this order. No local payment is pending. Read status after approval; never create a replacement payment.' };
  }
  remember(record, order, status, message) {
    // Read-only UI polling must not erase a local preflight/recovery warning.
    const previous = record.summary;
    if (status === undefined && previous?.status === 'needs_owner_action' &&
        previous.approvalStatus === order.approvalStatus && previous.paymentStatus === order.paymentStatus && previous.deliveryStatus === order.deliveryStatus) {
      status = previous.status; message = previous.message;
    }
    record.summary = { name: order.quote.name, quote: order.quote, approvalStatus: order.approvalStatus,
      paymentStatus: order.paymentStatus, deliveryStatus: order.deliveryStatus, txHash: order.txHash,
      payer: order.payer, updatedAt: Date.now(), status, message,
      result: order.result ? { status: order.result.status, contentType: order.result.contentType } : null };
    this.wallet.save();
  }
  async request({ slug, method = 'POST', path = '', body = null, requestId }) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId || '')) throw new Error('A unique requestId of 8-80 characters is required');
    // Preserve old decisions and unresolved transactions; never reinterpret an
    // old local request as authority to make a second purchase on the website.
    const legacy = this.wallet.state.intents.find(item => item.requestId === requestId);
    if (legacy) {
      if (legacy.slug && (path || legacy.slug !== slug || legacy.method !== method || JSON.stringify(legacy.body ?? null) !== JSON.stringify(body))) throw new Error('requestId already used with different input');
      return { ...this.wallet.get(legacy.id), instruction: 'This is a legacy local request. Resolve it in the original companion. A new website purchase requires an explicit new requestId; do not create one automatically.' };
    }
    // Keep fingerprints for pre-path journals compatible.
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ slug, method, body, ...(path ? { path } : {}) })).digest('hex');
    let record = this.find(requestId);
    if (record && record.fingerprint !== fingerprint) throw new Error('requestId already used with different input');
    if (this.inflight.has(requestId)) throw new Error('Request creation in progress. Check the same requestId.');
    this.inflight.add(requestId);
    try {
      if (!record) {
        record = { requestId, fingerprint, origin: this.wallet.baseUrl, accessToken: crypto.randomBytes(32).toString('hex'), input: { slug, method, path, body, requestId } };
        this.wallet.state.remoteOrders ||= []; this.wallet.state.remoteOrders.push(record); this.wallet.save();
      }
      const order = record.id ? await this.call(record) : await this.call(record, '', record.input);
      record.id = order.id;
      this.wallet.save(); return this.output(record, order);
    } finally { this.inflight.delete(requestId); }
  }
  async status(id, reconcile = false) {
    const record = this.find(id);
    if (!record) return this.wallet.get(id);
    if (!record.id) return this.request(record.input);
    const order = await this.call(record, reconcile ? '/reconcile' : '', reconcile ? {} : undefined);
    return this.output(record, order);
  }
}
module.exports = { OrdersClient };
