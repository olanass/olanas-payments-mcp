'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setRequestArchived } = require('./activity');
const { OrdersClient } = require('./orders-client');

test('archive survives reload and retains identity, credentials and payment recovery', async () => {
  let saved;
  const record = { id: 'ord_test', requestId: 'request-test', accessToken: 'original-token',
    autonomous: { phase: 'submitted', txHash: 'original-transaction' } };
  const wallet = { state: { intents: [], remoteOrders: [record], policy: { spent: '2000' } },
    save() { saved = JSON.stringify(this.state); } };
  const before = JSON.parse(JSON.stringify(wallet.state));
  assert.equal(setRequestArchived(wallet, record.requestId).archived, true);
  const archivedAt = record.archivedAt;
  setRequestArchived(wallet, record.id);
  assert.equal(record.archivedAt, archivedAt);
  wallet.state = JSON.parse(saved);
  assert.equal(new OrdersClient(wallet).find(record.requestId).accessToken, 'original-token');
  setRequestArchived(wallet, record.id, false);
  assert.deepEqual(wallet.state, before);
});

test('legacy archive and restore preserve rejected decisions and unknown IDs do not write', () => {
  let writes = 0;
  const record = { id: 'legacy-id', requestId: 'legacy-request', status: 'rejected' };
  const wallet = { state: { intents: [record] }, save() { writes++; } };
  setRequestArchived(wallet, record.id);
  assert.equal(record.status, 'rejected');
  setRequestArchived(wallet, record.requestId, false);
  assert.equal(record.archivedAt, undefined);
  assert.throws(() => setRequestArchived(wallet, 'missing'), /Unknown payment request/);
  assert.equal(writes, 2);
});
