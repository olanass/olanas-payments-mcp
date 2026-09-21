'use strict';

// Archive only the activity entry. Retain the journal and request identity so
// retries, reconciliation and spending limits keep their original semantics.
function setRequestArchived(wallet, id, archived = true) {
  const record = (wallet.state.remoteOrders || []).find(r => r.id === id || r.requestId === id)
    || wallet.state.intents.find(r => r.id === id || r.requestId === id);
  if (!record) throw new Error('Unknown payment request');
  if (archived) record.archivedAt ||= Date.now();
  else delete record.archivedAt;
  wallet.save();
  return { id: record.id || record.requestId, requestId: record.requestId, archived: Boolean(record.archivedAt),
    message: archived ? 'Removed from activity. This does not cancel an order or payment; its record is retained to prevent duplicate payments.' : 'Restored to activity.' };
}

module.exports = { setRequestArchived };
