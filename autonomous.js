'use strict';
const crypto = require('node:crypto');
const { ethers } = require('ethers');

// Policies are owned by the human companion, never writable through MCP tools.
// These are application-enforced limits, not claims of on-chain/CDP enforcement.
class AutonomousPayments {
  constructor(wallet, signer) {
    this.wallet = wallet; this.signer = signer; this.tail = Promise.resolve();
    // Restart never silently re-enables signing or resets an active budget.
    if (wallet.state.policy) wallet.state.policy.active = false;
    wallet.save();
  }
  exclusive(fn) {
    const work = this.tail.then(fn, fn); this.tail = work.catch(() => {}); return work;
  }
  enable(input) {
    const asset = this.wallet.chain.supportedTokens[input.token];
    if (!asset) throw new Error('Choose a supported token');
    const positive = (value, decimals) => {
      if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw new Error('Limits must be positive decimal strings');
      const units = ethers.parseUnits(value, decimals); if (units <= 0n) throw new Error('Limits must be positive'); return units.toString();
    };
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) throw new Error('Session duration must be 1-1440 minutes');
    if (this.wallet.state.intents.some(item => ['signing', 'submitted', 'awaiting_wallet'].includes(item.status))) throw new Error('Resolve outstanding payments before starting a new session');
    const perCall = positive(input.perCall, asset.decimals), budget = positive(input.budget, asset.decimals);
    if (BigInt(perCall) > BigInt(budget)) throw new Error('Per-call limit exceeds session budget');
    const gasPerCall = positive(input.gasPerCall, 18), gasBudget = positive(input.gasBudget, 18);
    if (BigInt(gasPerCall) > BigInt(gasBudget)) throw new Error('Gas per-call limit exceeds gas budget');
    this.wallet.state.policy = { id: crypto.randomUUID(), active: true, payer: this.signer.address, chainId: this.wallet.chain.chainId,
      origin: this.wallet.baseUrl, token: input.token, perCall, budget, spent: '0',
      gasPerCall, gasBudget, gasSpent: '0', expiresAt: Date.now() + input.minutes * 60000 };
    this.wallet.save(); return this.wallet.state.policy;
  }
  revoke() { if (this.wallet.state.policy) this.wallet.state.policy.active = false; this.wallet.save(); }
  authorize(item) {
    const p = this.wallet.state.policy;
    if (!p?.active || p.expiresAt <= Date.now()) throw new Error('Enable an unexpired autonomous session in the owner companion');
    if (p.payer !== item.payer || p.payer !== this.signer.address || p.chainId !== item.chainId || p.origin !== item.origin) throw new Error('Payment does not match session wallet/network/origin');
    if (item.token !== p.token) throw new Error('Token is not approved');
    if (item.expiresAt < Date.now()) throw new Error('Quote expired');
    if (BigInt(item.amount) > BigInt(p.perCall)) throw new Error('Payment exceeds per-call limit');
    if (BigInt(p.spent) + BigInt(item.amount) > BigInt(p.budget)) throw new Error('Payment exceeds remaining session budget');
    return p;
  }
  async execute(input) {
    return this.exclusive(async () => {
      const item = await this.wallet.request(input);
      if (item.status === 'completed' || item.status === 'delivery_unknown') return item;
      if (item.status === 'submitted') {
        // Only inspect the saved transaction. Never create a replacement payment.
        const receipt = await this.signer.receipt(item.txHash);
        if (!receipt) return item;
        if (receipt.status !== 1) { item.status = 'reverted'; this.wallet.save(); return item; }
        return this.wallet.complete(item.id, item.txHash);
      }
      if (item.status !== 'pending') throw new Error('Payment needs owner recovery; no new transaction was sent');
      if (this.wallet.state.intents.some(other => other.id !== item.id && ['signing', 'submitted', 'awaiting_wallet'].includes(other.status))) throw new Error('Another payment is unresolved; reconcile it first');
      const policy = this.authorize(item);
      const prepared = await this.signer.prepare(item, policy.gasPerCall);
      if (this.authorize(item).id !== policy.id) throw new Error('Session changed while preparing payment');
      if (BigInt(policy.gasSpent) + prepared.gasCost > BigInt(policy.gasBudget)) throw new Error('Payment exceeds remaining gas budget');
      // Reserve both principal and maximum gas before any signing. Never refund
      // ambiguous reservations automatically, including after process restart.
      policy.spent = (BigInt(policy.spent) + BigInt(item.amount)).toString();
      policy.gasSpent = (BigInt(policy.gasSpent) + prepared.gasCost).toString();
      item.policyId = policy.id; item.status = 'signing'; this.wallet.save();
      const signed = await this.signer.sign(prepared.transaction);
      // Revocation during network/signing calls prevents subsequent broadcasting.
      if (!policy.active || policy.expiresAt <= Date.now() || this.wallet.state.policy.id !== policy.id) {
        item.status = 'cancelled_before_broadcast'; this.wallet.save(); throw new Error('Session revoked or expired before broadcast');
      }
      item.txHash = signed.hash; item.status = 'submitted';
      this.wallet.state.signedTransactions ||= {};
      this.wallet.state.signedTransactions[signed.hash] = signed.raw;
      this.wallet.save();
      // Persist the deterministic hash BEFORE network submission. If submission
      // times out, recovery polls this hash and never signs a second transaction.
      try { await this.signer.broadcast(signed.raw); }
      catch (_) { return item; }
      const receipt = await this.signer.receipt(item.txHash);
      if (!receipt) return item;
      if (receipt.status !== 1) { item.status = 'reverted'; this.wallet.save(); return item; }
      return this.wallet.complete(item.id, item.txHash);
    });
  }
  async recover(id) {
    return this.exclusive(async () => {
      const item = this.wallet.get(id);
      if (item.status === 'signing') {
        // No broadcast is possible before submitted+hash are journaled.
        item.status = 'cancelled_before_broadcast'; this.wallet.save(); return item;
      }
      if (item.status !== 'submitted' || !item.txHash) throw new Error('Only submitted transactions can be reconciled here');
      let receipt = await this.signer.receipt(item.txHash);
      if (!receipt) {
        const raw = this.wallet.state.signedTransactions?.[item.txHash];
        if (!raw) throw new Error('Original signed transaction unavailable; inspect the saved transaction hash');
        try { await this.signer.broadcast(raw); } catch (_) { /* May already be in mempool. */ }
        receipt = await this.signer.receipt(item.txHash);
      }
      if (!receipt) return item;
      if (receipt.status !== 1) { item.status = 'reverted'; this.wallet.save(); return item; }
      if (item.kind === 'withdrawal') { item.status = 'completed'; this.wallet.save(); return item; }
      return this.wallet.complete(item.id, item.txHash);
    });
  }
  async check(id) {
    return this.exclusive(async () => {
      const item = this.wallet.get(id);
      if (item.status !== 'submitted' || !item.txHash) return item;
      const receipt = await this.signer.receipt(item.txHash);
      if (!receipt) return item;
      if (receipt.status !== 1) { item.status = 'reverted'; this.wallet.save(); return item; }
      if (item.kind === 'withdrawal') { item.status = 'completed'; this.wallet.save(); return item; }
      return this.wallet.complete(item.id, item.txHash);
    });
  }
  async withdraw({ requestId, recipient, token, amount, gasLimit }) {
    return this.exclusive(async () => {
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId || '')) throw new Error('Unique withdrawal requestId required');
      const payTo = ethers.getAddress(recipient);
      const asset = this.wallet.chain.supportedTokens[token];
      if (!asset) throw new Error('Unsupported token');
      const units = ethers.parseUnits(String(amount), asset.decimals);
      const maximumGas = ethers.parseEther(String(gasLimit));
      if (units <= 0n || maximumGas <= 0n || payTo === ethers.ZeroAddress) throw new Error('Invalid amount, gas limit or recipient');
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ payTo, token, amount: units.toString(), gasLimit: maximumGas.toString() })).digest('hex');
      const existing = this.wallet.state.intents.find(item => item.requestId === requestId);
      if (existing) {
        if (existing.kind !== 'withdrawal' || existing.fingerprint !== fingerprint) throw new Error('Withdrawal requestId already used with different input');
        return existing;
      }
      if (this.wallet.state.intents.some(item => ['signing', 'submitted', 'awaiting_wallet'].includes(item.status))) throw new Error('Reconcile outstanding payments before withdrawing');
      const item = { id: crypto.randomUUID(), requestId, fingerprint, kind: 'withdrawal', name: 'Owner withdrawal',
        payer: this.signer.address, payTo, token, amount: units.toString(), displayAmount: ethers.formatUnits(units, asset.decimals),
        chainId: this.wallet.chain.chainId, origin: this.wallet.baseUrl, createdAt: Date.now(), status: 'signing' };
      const prepared = await this.signer.prepare(item, maximumGas.toString());
      this.wallet.state.intents.push(item); this.wallet.save();
      const signed = await this.signer.sign(prepared.transaction);
      item.txHash = signed.hash; item.status = 'submitted';
      this.wallet.state.signedTransactions ||= {};
      this.wallet.state.signedTransactions[signed.hash] = signed.raw; this.wallet.save();
      try { await this.signer.broadcast(signed.raw); } catch (_) { return item; }
      const receipt = await this.signer.receipt(item.txHash);
      if (receipt) { item.status = receipt.status === 1 ? 'completed' : 'reverted'; this.wallet.save(); }
      return item;
    });
  }
}

function ownerGuard(password) {
  if (typeof password !== 'string' || password.length < 16) throw new Error('PAYMENTS_OWNER_PASSWORD must contain at least 16 characters');
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const expected = digest(password); let failures = 0; let blockedUntil = 0;
  return (req, res, next) => {
    if (Date.now() < blockedUntil) return res.status(429).json({ error: 'Too many owner authentication attempts; wait one minute' });
    const supplied = req.get('x-owner-password') || '';
    if (!crypto.timingSafeEqual(expected, digest(supplied))) {
      failures++; if (failures >= 5) { blockedUntil = Date.now() + 60000; failures = 0; }
      return res.status(403).json({ error: 'Owner password required; this operation is not available to the agent' });
    }
    failures = 0; next();
  };
}
module.exports = { AutonomousPayments, ownerGuard };
