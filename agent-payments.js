'use strict';
const crypto = require('node:crypto');
const { ethers } = require('ethers');

const utcDay = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
const decimal = (value, decimals, label) => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(label + ' must be a non-negative decimal amount');
  try { return ethers.parseUnits(value, decimals); }
  catch (_) { throw new Error(label + ' has too many decimal places'); }
};

function ensure(wallet) {
  if (!wallet.state.agentPayments) {
    const limits = {};
    for (const token of Object.keys(wallet.chain.supportedTokens)) limits[token] = token === 'OLANAS'
      ? { daily: '50', perCall: '10' } : { daily: '0', perCall: '0' };
    wallet.state.agentPayments = { id: crypto.randomUUID(), revision: 1, enabled: false,
      limits, gasDaily: '0.0001', gasPerCall: '0.00001', gasMode: 'standard',
      day: utcDay(), spent: {}, gasSpent: '0' };
    wallet.save();
  }
  return wallet.state.agentPayments;
}

function rollDay(wallet, time = Date.now()) {
  const settings = ensure(wallet), day = utcDay(time);
  if (settings.day !== day) {
    settings.day = day;
    settings.spent = {};
    settings.gasSpent = '0';
    wallet.save();
  }
  return settings;
}

function view(wallet) {
  const settings = rollDay(wallet);
  const spent = {};
  for (const [token, asset] of Object.entries(wallet.chain.supportedTokens)) {
    spent[token] = ethers.formatUnits(BigInt(settings.spent[token] || '0'), asset.decimals);
  }
  return { enabled: settings.enabled, revision: settings.revision, day: settings.day,
    limits: settings.limits, spent, gasDaily: settings.gasDaily, gasPerCall: settings.gasPerCall,
    gasSpent: ethers.formatEther(BigInt(settings.gasSpent)), gasMode: settings.gasMode,
    resetsAt: new Date(Date.parse(settings.day + 'T00:00:00Z') + 86400000).toISOString() };
}

function update(wallet, input) {
  if (!input || Array.isArray(input) || typeof input !== 'object' ||
      Object.keys(input).some(key => !['enabled', 'token', 'daily', 'perCall', 'gasDaily', 'gasPerCall', 'gasMode'].includes(key))) throw new Error('Invalid agent payment settings');
  if (typeof input.enabled !== 'boolean') throw new Error('Choose whether automatic payments are enabled');
  const asset = wallet.chain.supportedTokens[input.token];
  if (!asset) throw new Error('Choose a supported payment token');
  const daily = decimal(input.daily, asset.decimals, 'Daily payment limit');
  const perCall = decimal(input.perCall, asset.decimals, 'Per-call payment limit');
  if (perCall > daily) throw new Error('Per-call limit cannot exceed the daily limit');
  const gasDaily = decimal(input.gasDaily, 18, 'Daily gas limit');
  const gasPerCall = decimal(input.gasPerCall, 18, 'Per-call gas limit');
  if (gasPerCall > gasDaily) throw new Error('Per-call gas limit cannot exceed the daily gas limit');
  if (!['standard', 'fast'].includes(input.gasMode)) throw new Error('Choose Standard or Fast fees');
  const settings = rollDay(wallet);
  const limits = { ...settings.limits, [input.token]: { daily: input.daily, perCall: input.perCall } };
  if (input.enabled && (!Object.entries(limits).some(([token, cap]) => decimal(cap.daily, wallet.chain.supportedTokens[token].decimals, 'Daily payment limit') > 0n) || gasDaily === 0n || gasPerCall === 0n)) {
    throw new Error('Set a positive token limit and gas limits before enabling automatic payments');
  }
  settings.limits = limits;
  settings.enabled = input.enabled;
  settings.gasDaily = input.gasDaily;
  settings.gasPerCall = input.gasPerCall;
  settings.gasMode = input.gasMode;
  settings.revision++;
  wallet.save();
  return view(wallet);
}

function policyFor(wallet, item, signer) {
  const settings = rollDay(wallet);
  if (!settings.enabled) return null;
  const asset = wallet.chain.supportedTokens[item.token];
  const limit = settings.limits[item.token];
  if (!asset || !limit) throw new Error('No automatic payment limit is set for this token');
  if (item.payer !== signer.address || item.chainId !== wallet.chain.chainId || item.origin !== wallet.baseUrl) throw new Error('Payment does not match the agent wallet, network, or launchpad');
  if (item.expiresAt <= Date.now()) throw new Error('Quote expired');
  const perCall = decimal(limit.perCall, asset.decimals, 'Per-call payment limit');
  const budget = decimal(limit.daily, asset.decimals, 'Daily payment limit');
  const spent = BigInt(settings.spent[item.token] || '0');
  if (!perCall || !budget) throw new Error('No automatic payment limit is set for this token');
  if (BigInt(item.amount) > perCall) throw new Error('Payment exceeds the per-call limit');
  if (spent + BigInt(item.amount) > budget) throw new Error('Payment exceeds the remaining daily limit');
  return { id: 'agent:' + settings.id + ':' + settings.revision + ':' + settings.day, agent: true,
    token: item.token, perCall: perCall.toString(), budget: budget.toString(), spent: spent.toString(),
    gasPerCall: decimal(settings.gasPerCall, 18, 'Per-call gas limit').toString(),
    gasBudget: decimal(settings.gasDaily, 18, 'Daily gas limit').toString(), gasSpent: settings.gasSpent,
    gasMode: settings.gasMode, day: settings.day };
}

module.exports = { ensure, rollDay, view, update, policyFor };
