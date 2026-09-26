'use strict';
const isWalletToken = value => /^[a-f0-9]{64}$/.test(value) || value === 'preview';
const fragmentToken = location.hash.slice(1);
const credential = (isWalletToken(fragmentToken) ? fragmentToken : null) || sessionStorage.getItem('olanas-companion-token');
if (isWalletToken(fragmentToken)) { sessionStorage.setItem('olanas-companion-token', credential); history.replaceState(null, '', '/'); }
// Opening a new companion link in this tab can change only the fragment.
// Reload so startup consumes the new token instead of keeping the old session.
window.addEventListener('hashchange', () => { if (isWalletToken(location.hash.slice(1))) location.reload(); });
const $ = id => document.getElementById(id);
let state;
let working = false;
let sessionAction = '';
let lastState = '';
let sessionAuthorized = Boolean(credential);
let companionAvailable = false;
let activityFilter = 'all';
let agentFormDirty = false;
let agentRevisionSeen = 0;
const savedResultPreviews = new Map();
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('olanas-theme', theme);
  const button = $('theme-toggle');
  const next = theme === 'dark' ? 'light' : 'dark';
  button.setAttribute('aria-label', 'Switch to ' + next + ' mode');
  button.title = 'Switch to ' + next + ' mode';
}
function notify(message) {
  if (sessionAction) {
    $('session-feedback').hidden = false;
    $('session-feedback').textContent = message;
  }
  const notice = $('notice');
  let messageNode = notice.querySelector('.notice-message');
  if (!messageNode) {
    notice.replaceChildren();
    const label = element('span', 'STATUS', notice); label.className = 'notice-label';
    messageNode = element('span', '', notice); messageNode.className = 'notice-message';
  }
  messageNode.textContent = message;
}
async function api(route, body, owner = false) {
  if (!sessionAuthorized) throw new Error('Open the complete wallet link returned by Show wallet to authorize this tab.');
  const ownerPassword = owner ? $('owner-password').value : '';
  if (owner && !ownerPassword) throw new Error('Enter your owner password in the companion, not in agent chat.');
  let res;
  try {
    res = await fetch('/api' + route, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(45000),
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', ...(owner ? { 'x-owner-password': ownerPassword } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (_) {
    markCompanionUnavailable();
    throw new Error('Cannot reach the local companion. A timed-out action may have completed: inspect its current state before retrying. Never send a replacement payment.');
  }
  if (res.status === 401) {
    sessionAuthorized = false;
    sessionStorage.removeItem('olanas-companion-token');
    markCompanionUnavailable();
    throw new Error('This wallet link is missing or expired. Reopen the complete URL printed by the currently running companion, including its #token.');
  }
  let result;
  try { result = await res.json(); }
  catch (_) { throw new Error('The companion returned an unexpected response (HTTP ' + res.status + '). Check that the installed runtime is current.'); }
  if (!res.ok) throw new Error(result.error || 'Request failed'); return result;
}
function markCompanionUnavailable() {
  companionAvailable = false;
  $('session-headline').textContent = sessionAuthorized ? 'Companion unavailable.' : 'Wallet link required.';
  $('session-caption').textContent = 'Current spending state is unknown. Closing this page or losing connection does not revoke an active session.';
  $('policy-badge').textContent = 'State unavailable';
  $('policy-badge').className = 'pill';
  $('wallet-access').hidden = sessionAuthorized;
  $('funding-title').textContent = 'Wallet access required.';
  $('connect').hidden = true;
  $('owner-controls').hidden = true;
  $('agent-payments').hidden = true;
  $('balances').textContent = sessionAuthorized ? 'Balance unavailable' : 'Authorize this tab to view balances';
  $('address').textContent = 'Wallet address not verified';
  $('budget-remaining').textContent = 'Unknown';
  $('session-ends').textContent = 'Unknown';
  $('wallet-source').textContent = 'No separate wallet connection is needed for a terminal-imported wallet. Open its private companion link first.';
  syncDisabled();
}
function walletMessage(error, fallback) {
  if (error?.code === 4001) return 'Request cancelled in your wallet. Click Connect wallet when you are ready.';
  if (error?.code === -32002) return 'A wallet request is already open. Complete or cancel it in your wallet, then try again.';
  if (error?.code === 4100) return 'This site is not authorized in your wallet. Unlock the wallet and approve account access.';
  if (error?.code === 4900) return 'Your wallet is disconnected. Unlock or reopen the wallet extension, then try again.';
  if (error?.code === 4901) return 'Your wallet is not connected to Robinhood Chain. Approve the network switch and try again.';
  return error?.shortMessage || error?.message || fallback;
}
function isOkxProvider(provider) {
  return Boolean(provider?.request && (provider.isOkxWallet || provider.isOKXWallet || provider.isOKExWallet));
}
async function injectedWallet() {
  // OKX documents its EVM provider as window.okxwallet. Prefer it so another
  // extension cannot silently receive the connection request instead.
  if (window.okxwallet?.request) return { provider: window.okxwallet, name: 'OKX Wallet' };

  const legacyProviders = Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : [];
  const legacyOkx = legacyProviders.find(isOkxProvider);
  if (legacyOkx) return { provider: legacyOkx, name: 'OKX Wallet' };
  if (isOkxProvider(window.ethereum)) return { provider: window.ethereum, name: 'OKX Wallet' };

  // EIP-6963 lets several installed wallets announce separate providers
  // without fighting over window.ethereum.
  const announced = [];
  const receiveProvider = event => {
    const detail = event?.detail;
    if (detail?.provider?.request && !announced.some(item => item.provider === detail.provider)) announced.push(detail);
  };
  window.addEventListener('eip6963:announceProvider', receiveProvider);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise(resolve => setTimeout(resolve, 250));
  window.removeEventListener('eip6963:announceProvider', receiveProvider);
  const announcedOkx = announced.find(item => /okx/i.test([item.info?.name, item.info?.rdns].filter(Boolean).join(' ')));
  if (announcedOkx) return { provider: announcedOkx.provider, name: announcedOkx.info?.name || 'OKX Wallet' };

  if (window.ethereum?.request) return { provider: window.ethereum, name: 'browser wallet' };
  throw new Error('OKX Wallet was not detected. Open this URL in the same desktop browser where the OKX extension is installed, unlock OKX, allow it on this site, then reload the page.');
}
async function signer() {
  if (!state?.chain) throw new Error('Wallet configuration is still loading. Wait a moment, then try again.');
  const wallet = await injectedWallet();
  const injected = wallet.provider;
  const chainId = '0x' + state.chain.chainId.toString(16);
  notify('Waiting for account access in ' + wallet.name + '...');
  let accounts;
  try { accounts = await injected.request({ method: 'eth_requestAccounts' }); }
  catch (error) { throw new Error(walletMessage(error, 'Wallet connection failed.')); }
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error('No wallet account was selected. Unlock your wallet and choose an account.');
  let currentChain;
  try { currentChain = await injected.request({ method: 'eth_chainId' }); }
  catch (error) { throw new Error(walletMessage(error, 'Could not read the selected network.')); }
  if (String(currentChain).toLowerCase() !== chainId.toLowerCase()) {
    notify('Approve the switch to ' + state.chain.name + ' in your wallet...');
    try { await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
    catch (error) {
      if (error?.code !== 4902) throw new Error(walletMessage(error, 'Network switch failed.'));
      notify('Approve adding ' + state.chain.name + ' to your wallet...');
      try {
        await injected.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: state.chain.name,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [state.chain.rpcUrl], blockExplorerUrls: [state.chain.explorerUrl] }] });
      } catch (addError) { throw new Error(walletMessage(addError, 'Could not add Robinhood Chain to your wallet.')); }
      const addedChain = await injected.request({ method: 'eth_chainId' });
      if (String(addedChain).toLowerCase() !== chainId.toLowerCase()) {
        try { await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
        catch (switchError) { throw new Error(walletMessage(switchError, 'Robinhood Chain was added but not selected.')); }
      }
    }
  }
  const provider = new ethers.BrowserProvider(injected, 'any');
  if (Number((await provider.getNetwork()).chainId) !== state.chain.chainId) throw new Error('Wrong network selected');
  return provider.getSigner(accounts[0]);
}
async function run(fn) {
  if (!sessionAuthorized) { notify('Open the complete wallet link returned by Show wallet to authorize this tab.'); return; }
  if (working) return; working = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await fn(); } catch (error) { notify(error.shortMessage || error.message); }
  finally { working = false; if (sessionAuthorized) await refresh().catch(error => notify(error.message)); document.querySelectorAll('button').forEach(button => { button.disabled = !sessionAuthorized; }); syncDisabled(); }
}
function element(tag, text, parent) { const node = document.createElement(tag); node.textContent = text; if (parent) parent.append(node); return node; }
function action(text, parent, fn) { const button = element('button', text, parent); button.onclick = () => run(fn); return button; }
function syncDisabled() {
  const active = Boolean(state?.policy?.active && state.policy.expiresAt > Date.now());
  const blocked = sessionBlockers().length > 0;
  $('enable-session').textContent = sessionAction === 'enable' ? 'Enabling session…' : active ? 'Update spending session' : 'Enable spending session';
  $('revoke').textContent = sessionAction === 'revoke' ? 'Revoking session…' : 'Revoke session';
  $('session-action-help').textContent = !companionAvailable ? 'Session state is unavailable. Reconnect to check whether spending is enabled.' : state?.preview ? 'Preview only. Session controls are unavailable.' : active ? 'Spending is on. Revoke to stop new payments. Enter your owner password above to make changes.' : 'Spending is off. There is no active session to revoke. Enter your owner password above to enable spending.';
  $('wallet-link-submit').disabled = false;
  if (companionAvailable && blocked) $('session-action-help').textContent = (active ? 'Spending is on.' : 'Spending is off.') + ' An unresolved order blocks a new session. Resolve the order below using your owner password. Revoking a session or archiving a request does not cancel an order.';
  $('connect').disabled = working || !sessionAuthorized || !companionAvailable || state?.walletProvider !== 'browser';
  $('refresh').disabled = working || !sessionAuthorized || !companionAvailable;
  $('enable-session').disabled = working || !sessionAuthorized || !companionAvailable || Boolean(state?.preview) || blocked;
  $('revoke').disabled = working || !sessionAuthorized || !companionAvailable || !active || Boolean(state?.preview);
  $('agent-save').disabled = working || !sessionAuthorized || !companionAvailable || state?.walletProvider !== 'olanas' || Boolean(state?.preview);
  $('copy').disabled = working || !sessionAuthorized || !companionAvailable || !state?.address;
}
function sessionDraft() {
  const input = { token: $('session-token').value, budget: $('session-budget').value.trim(),
    perCall: $('per-call').value.trim(), minutes: Number($('session-minutes').value), gasMode: $('gas-mode').value,
    services: $('session-services').value.split(',').map(s => s.trim()).filter(Boolean),
    recipients: $('session-recipients').value.split(',').map(s => s.trim()).filter(Boolean) };
  return OlanasSessionPresets.resolve(input, state?.chain.tokens.find(t => t.symbol === input.token), ethers);
}
function updateSessionReview() {
  $('budget-token-label').textContent = $('session-token').value || 'Token';
  const fast = $('gas-mode').value === 'fast';
  $('fee-mode-help').textContent = fast ? 'Fast offers 25% more than the current network fee estimate, within the same caps. Faster confirmation is not guaranteed. The API price is unchanged.' : 'Standard uses the current network fee estimate. The API price is unchanged.';
  try {
    const p = sessionDraft();
    $('session-review').textContent = 'Up to ' + p.budget + ' ' + p.token + ' total, ' + p.perCall + ' ' + p.token + ' per API call. Gas capped at ' + p.gasPerCall + ' ETH per transaction and ' + p.gasBudget + ' ETH for the session. Higher fees stop the payment.';
  } catch (_) { $('session-review').textContent = 'Enter a positive budget to review your limits before enabling spending.'; }
}
function loadAgentForm() {
  const settings = state?.agentPayments;
  if (!settings) return;
  const token = $('agent-token').value;
  const limit = settings.limits[token] || { daily: '0', perCall: '0' };
  $('agent-enabled').checked = settings.enabled;
  $('agent-daily').value = limit.daily;
  $('agent-per-call').value = limit.perCall;
  $('agent-gas-daily').value = settings.gasDaily;
  $('agent-gas-per-call').value = settings.gasPerCall;
  $('agent-gas-mode').value = settings.gasMode;
  agentRevisionSeen = settings.revision;
  agentFormDirty = false;
  updateAgentReview();
}
function updateAgentReview() {
  $('agent-review').textContent = ($('agent-enabled').checked ? 'Agent payments on. ' : 'Agent payments off. ') +
    'Up to ' + $('agent-daily').value + ' ' + ($('agent-token').value || 'tokens') + ' per UTC day, ' +
    $('agent-per-call').value + ' per call. Gas: ' + $('agent-gas-daily').value + ' ETH per day, ' +
    $('agent-gas-per-call').value + ' ETH per call. Saving a limit never clears spending already recorded today.';
}
function updateAgentPanel() {
  const settings = state?.agentPayments;
  if (!settings) return;
  if (!$('agent-token').options.length) {
    for (const asset of state.chain.tokens) { const option = element('option', asset.symbol, $('agent-token')); option.value = asset.symbol; }
    $('agent-token').value = state.chain.tokens.some(asset => asset.symbol === 'OLANAS') ? 'OLANAS' : state.chain.tokens[0]?.symbol;
  }
  if (!agentFormDirty && agentRevisionSeen !== settings.revision) loadAgentForm();
  const token = $('agent-token').value, limit = settings.limits[token] || { daily: '0', perCall: '0' };
  $('agent-badge').textContent = settings.enabled ? 'On' : 'Off';
  $('agent-badge').className = 'pill' + (settings.enabled ? ' is-active' : '');
  $('agent-usage').textContent = 'Today: ' + (settings.spent[token] || '0') + ' / ' + limit.daily + ' ' + token +
    ' reserved or spent. Gas: ' + settings.gasSpent + ' / ' + settings.gasDaily + ' ETH. Resets ' +
    new Date(settings.resetsAt).toLocaleString() + ' (00:00 UTC).';
}
function orderState(remote) {
  const s = remote.summary || {};
  if (s.deliveryStatus === 'completed') return { label: 'Result saved', tone: 'success', bucket: 'completed' };
  if (s.deliveryStatus === 'unknown' || remote.phase === 'delivery_unknown') return { label: 'Delivery uncertain', tone: 'warning', bucket: 'attention' };
  if (remote.phase === 'reverted') return { label: 'Transaction reverted', tone: 'danger', bucket: 'attention' };
  if (s.approvalStatus === 'rejected' || remote.phase === 'cancelled') return { label: 'Rejected / not paid', tone: 'neutral', bucket: 'attention' };
  if (s.status === 'needs_owner_action' || remote.phase === 'reserved') return { label: 'Owner action needed', tone: 'warning', bucket: 'attention' };
  if (s.paymentStatus === 'confirmed') return { label: 'Paid / awaiting result', tone: 'success', bucket: 'pending' };
  if (s.paymentStatus === 'submitted' || ['signed', 'submitted'].includes(remote.phase)) return { label: 'Awaiting confirmation', tone: 'neutral', bucket: 'pending' };
  if (s.approvalStatus === 'expired' || (s.approvalStatus === 'pending' && s.quote?.expiresAt <= Date.now())) return { label: 'Quote expired / not paid', tone: 'warning', bucket: 'attention' };
  return { label: 'Not paid / awaiting authorization', tone: 'neutral', bucket: 'pending' };
}
function legacyBucket(item) {
  return item.status === 'completed' ? 'completed' : ['rejected', 'expired', 'delivery_unknown', 'reverted', 'cancelled_before_broadcast'].includes(item.status) ? 'attention' : 'pending';
}
function updateOverview() {
  const native = state.walletProvider === 'olanas', p = state.policy;
  const automatic = native && state.agentPayments?.enabled;
  const active = native && p?.active && p.expiresAt > Date.now();
  $('mode-badge').textContent = native ? 'AUTONOMOUS MODE' : 'MANUAL MODE';
  $('session-headline').textContent = !native ? 'You approve each payment.' : automatic ? 'Automatic payments on.' : active ? 'Session active.' : p?.expiresAt <= Date.now() ? 'Session expired.' : 'Agent spending is off.';
  $('session-caption').textContent = !native ? 'Your browser wallet asks before funds move.' : automatic ? 'Eligible MCP requests are paid within your daily limits, without a password prompt.' : active ? 'Eligible requests can be paid without another wallet popup.' : 'Fund the wallet and set an automatic payment limit to start.';
  $('policy-badge').textContent = active ? 'Active' : 'Inactive';
  $('policy-badge').className = 'pill' + (active ? ' is-active' : '');
  $('policy-nav').hidden = !native;
  $('mode-description').textContent = native ? 'Fund your wallet. Set a daily limit. Let your agent pay for APIs and bring back the result.' : 'Review the exact request, approve it in your wallet, and follow the payment to its saved result.';
  $('funding-network').textContent = 'Funding network: ' + state.chain.name + '. Tokens on other networks will not appear here.';
  $('budget-remaining').textContent = 'Not enabled'; $('session-ends').textContent = 'Not enabled';
  $('budget-label').textContent = automatic ? 'OLANAS LEFT TODAY' : 'REMAINING BUDGET';
  $('ends-label').textContent = automatic ? 'DAILY RESET' : 'SESSION ENDS';
  if (automatic) {
    const a = state.agentPayments, cap = a.limits.OLANAS;
    if (cap) {
      const left = ethers.parseUnits(cap.daily, 18) - ethers.parseUnits(a.spent.OLANAS || '0', 18);
      $('budget-remaining').textContent = ethers.formatUnits(left > 0n ? left : 0n, 18) + ' OLANAS';
    }
    $('session-ends').textContent = '00:00 UTC';
  } else if (native && p) {
    const decimals = state.chain.tokens.find(t => t.symbol === p.token)?.decimals;
    if (decimals !== undefined) {
      const remaining = BigInt(p.budget) > BigInt(p.spent) ? BigInt(p.budget) - BigInt(p.spent) : 0n;
      $('budget-remaining').textContent = ethers.formatUnits(remaining, decimals) + ' ' + p.token;
    }
    $('session-ends').textContent = new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const percent = BigInt(p.budget) > 0n ? Math.min(100, Number(BigInt(p.spent) * 100n / BigInt(p.budget))) : 0;
    $('budget-track').setAttribute('aria-valuenow', String(percent));
    $('budget-fill').setAttribute('style', 'width:' + percent + '%');
    $('policy-scope').textContent = 'Services: ' + (p.services || []).join(', ') + ' | Recipients: ' + (p.recipients || []).join(', ');
  }
  syncDisabled();
}
function orderLink(parent, text, url) {
  try {
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol)) return;
    const link = element('a', text, parent); link.href = target.href; link.target = '_blank'; link.rel = 'noreferrer noopener'; link.className = 'text-link';
  } catch (_) { /* Invalid URLs are not actionable. */ }
}
function archiveAction(record, parent) {
  action(record.archivedAt ? 'Restore to activity' : 'Remove from activity', parent, async () => {
    const response = await api('/activity/' + encodeURIComponent(record.id || record.requestId) + '/archive', { archived: !record.archivedAt });
    notify(response.message);
  }).className = 'secondary';
}
function sessionBlockers() {
  return state?.walletProvider === 'olanas' ? (state.remoteOrders || []).filter(r => r.phase && !['completed', 'reverted', 'cancelled', 'delivery_unknown'].includes(r.phase)) : [];
}
function renderOrder(remote, native, parent = $('requests')) {
  const s = remote.summary || {}, status = orderState(remote);
  const card = element('article', '', parent); card.className = 'request order-card';
  const heading = element('div', '', card); heading.className = 'section-heading';
  const title = element('div', '', heading);
  element('span', remote.input?.method || 'API REQUEST', title).className = 'eyebrow';
  element('h3', s.name || remote.input?.slug || remote.requestId, title);
  element('span', status.label, heading).className = 'status-badge ' + status.tone;
  const meta = element('div', '', card); meta.className = 'order-meta';
  element('strong', s.quote ? s.quote.displayAmount + ' ' + s.quote.token : 'Quote not loaded', meta);
  element('span', 'Request ID: ' + remote.requestId, meta).className = 'mono';
  const stages = element('ol', '', card); stages.className = 'order-stages'; stages.setAttribute('aria-label', 'Order progress');
  for (const [label, complete] of [['Requested', Boolean(remote.id)], ['Authorized', s.approvalStatus === 'approved'], ['Confirmed', s.paymentStatus === 'confirmed'], ['Result saved', s.deliveryStatus === 'completed']]) {
    const step = element('li', label, stages); step.className = complete ? 'done' : ''; step.setAttribute('aria-label', label + (complete ? ': complete' : ': not confirmed'));
  }
  if (s.message) element('p', s.message, card).className = 'order-message';
  if (native && remote.phase === 'reserved' && !remote.txHash) element('p', 'This approval was interrupted before a payment transaction was saved. Use Cancel interrupted approval below to check and cancel the unpaid order, then enable a new session.', card).className = 'order-message';
  if (status.label === 'Delivery uncertain') element('p', 'Payment may have completed and the API may have executed. Do not pay again. Check with the service before any retry.', card).className = 'order-message';
  if (s.result) element('p', 'Paid API result saved · HTTP ' + s.result.status + '. Select View paid API result below to read the response.' + (s.result.status >= 400 ? ' The service returned an error; do not pay again automatically.' : ''), card);
  const details = element('details', '', card); element('summary', 'Exact request & payment details', details);
  element('pre', JSON.stringify({ orderId: remote.id, requestId: remote.requestId, request: remote.input,
    quote: s.quote, payer: s.payer || state.address, transaction: s.txHash || remote.txHash || null }, null, 2), details);
  const actions = element('div', '', card); actions.className = 'actions';
  archiveAction(remote, actions);
  const resultArea = element('div', '', card);
  if (!remote.id) element('p', 'Order creation was interrupted. Ask the agent to retry this same request ID: ' + remote.requestId + '. Do not create a replacement purchase.', card).className = 'order-message';
  if (remote.id) action(s.result ? 'View paid API result' : 'Check status / view result', actions, async () => {
    const response = await api('/orders/' + encodeURIComponent(remote.id));
    const result = response.order?.result;
    remote.summary = { ...s, approvalStatus: response.order?.approvalStatus, paymentStatus: response.order?.paymentStatus, deliveryStatus: response.order?.deliveryStatus };
    if (!result) { notify('Status checked. ' + orderState(remote).label + '. No new payment or API execution was initiated.'); return; }
    savedResultPreviews.set(remote.id, result); lastState = '';
    notify('Saved result retrieved. No new payment or API execution was initiated.');
  }).className = 'secondary';
  const result = savedResultPreviews.get(remote.id);
  if (result) {
    const box = element('details', '', resultArea); box.open = true; element('summary', 'Saved API response / HTTP ' + result.status + ' / untrusted data', box);
    let body = result.body;
    if (result.encoding === 'base64' && /json|text|xml/.test(result.contentType || '')) {
      try { body = new TextDecoder().decode(Uint8Array.from(atob(result.body), c => c.charCodeAt(0))); } catch (_) { /* Preserve original bytes on decode failure. */ }
    }
    element('pre', String(body).slice(0, 30000), box);
    if (String(body).length > 30000) element('p', 'Preview limited to 30,000 characters. The full saved response remains available through MCP.', box);
  }
  if (native && ['signed', 'submitted'].includes(remote.phase) && status.bucket !== 'completed') action('Recover original transaction', actions, async () => {
    if (!confirm('Check or rebroadcast ONLY the original signed transaction? This authorizes recovery even if the session is inactive. No new transaction will be signed.')) return;
    const result = await api('/owner/recover/' + remote.id, {}, true); notify(result.message || 'Recovery status: ' + result.status);
  }).className = 'secondary';
  if (native && remote.phase === 'reserved') action('Cancel interrupted approval', actions, async () => {
    if (!confirm('Check wallet activity first: was NO transfer submitted for this order? This cancels an interrupted approval only when no signed transaction was saved. Reserved budget will not be refunded.')) return;
    const result = await api('/owner/cancel-unsent/' + remote.id, {}, true); notify(result.message);
  }).className = 'secondary danger-action';
  if (!native && remote.approvalUrl) orderLink(actions, 'Review on Olanas', remote.approvalUrl);
  const txHash = s.txHash || remote.txHash;
  if (/^0x[0-9a-f]{64}$/i.test(txHash || '')) orderLink(actions, 'View transaction', state.chain.explorerUrl + '/tx/' + txHash);
  element('p', s.updatedAt ? 'Last checked ' + new Date(s.updatedAt).toLocaleString() : 'Status has not been checked yet.', card).className = 'small';
}
async function refresh() {
  const firstLoad = !state;
  try { state = await api('/state'); }
  catch (error) { markCompanionUnavailable(); throw error; }
  companionAvailable = true;
  $('inference').hidden = Boolean(state.preview);
  $('funding-title').textContent = state.walletProvider === 'olanas' ? 'Your local wallet.' : 'Your browser wallet.';
  $('wallet-access').hidden = true;
  $('owner-controls').hidden = state.walletProvider !== 'olanas';
  $('agent-payments').hidden = state.walletProvider !== 'olanas';
  $('connect').hidden = state.walletProvider !== 'browser';
  $('address').textContent = state.address || 'No wallet connected';
  $('wallet-source').textContent = state.walletProvider === 'olanas'
    ? 'Using the local wallet configured in your terminal. No browser wallet connection is needed.'
    : 'This companion is in browser-wallet mode. To use your imported wallet, restart it with the environment file created by the import script.';
  if (firstLoad && state.walletProvider === 'olanas' && !state.preview) notify('Olanas wallet connected. Review your balance and automatic payment limits.');
  if (state.preview) notify('READ-ONLY PREVIEW / Example data. No wallet is connected and no payments can be sent.');
  for (const item of state.intents) {
    if (item.status === 'pending' && item.expiresAt <= Date.now()) item.status = 'expired';
  }
  updateOverview();
  updateAgentPanel();
  const serialized = JSON.stringify({ state, activityFilter, sessionExpired: Boolean(state.policy && state.policy.expiresAt <= Date.now()), expiredOrders: (state.remoteOrders || []).map(r => orderState(r).label) });
  if (serialized === lastState) return;
  const native = state.walletProvider === 'olanas';
  $('owner-controls').hidden = !native;
  $('connect').hidden = native;
  document.querySelector('.wallet-card .pill').textContent = native ? 'Olanas wallet' : 'Self-custody';
  document.querySelector('.requests .pill').textContent = native ? 'Autonomous / owner limits' : 'Manual approval';
  if (native) {
    if ($('notice').textContent === 'Connect a browser wallet to get started.') notify('Olanas wallet configured. Fund it on Robinhood and set automatic payment limits.');
    document.querySelector('#send button').textContent = 'Confirm owner withdrawal';
    document.querySelector('#send .small').textContent = 'Owner password required. Standard network fees with a 0.00001 ETH gas cap. This sends directly from your Olanas wallet.';
    const policy = state.policy;
    $('session-status').textContent = policy ? (policy.active && policy.expiresAt > Date.now() ? 'Active' : 'Inactive') + ' | Reserved/spent: ' +
      ethers.formatUnits(policy.spent, state.chain.tokens.find(t => t.symbol === policy.token).decimals) + ' / ' +
      ethers.formatUnits(policy.budget, state.chain.tokens.find(t => t.symbol === policy.token).decimals) + ' ' + policy.token +
      ' | Gas reserved: ' + ethers.formatEther(policy.gasSpent) + ' ETH | Expires: ' + new Date(policy.expiresAt).toLocaleString() : 'No autonomous session enabled.';
  }
  if (!$('session-token').options.length) {
    for (const asset of state.chain.tokens) { const option = element('option', asset.symbol, $('session-token')); option.value = asset.symbol; }
    if (state.chain.tokens.some(asset => asset.symbol === 'USDG')) $('session-token').value = 'USDG';
  }
  updateSessionReview();
  $('network').textContent = state.chain.name + (state.chain.networkKey === 'testnet' ? ' · TEST FUNDS' : ' · MAINNET');
  $('address').textContent = state.address || 'No wallet connected';
  $('connect').textContent = state.address ? 'Change wallet ↗' : 'Connect wallet ↗';
  $('launchpad').textContent = 'Connected launchpad: ' + state.launchpad;
  if (!$('token').options.length) for (const token of state.chain.tokens) { const option = element('option', token.symbol, $('token')); option.value = token.symbol; }
  $('requests').replaceChildren();
  const blockers = sessionBlockers();
  $('session-blockers').replaceChildren();
  $('session-blockers').hidden = !blockers.length;
  for (const remote of blockers) renderOrder(remote, true, $('session-blockers'));
  const visible = record => Boolean(record.archivedAt) === (activityFilter === 'archived');
  const orders = (state.remoteOrders || []).filter(visible), intents = state.intents.filter(visible);
  const buckets = [...orders.map(r => orderState(r).bucket), ...intents.map(legacyBucket)];
  $('activity-counts').textContent = buckets.length + ' requests / ' + buckets.filter(b => b === 'pending').length + ' in progress / ' + buckets.filter(b => b === 'attention').length + ' need attention';
  for (const remote of [...orders].reverse()) if (activityFilter === 'archived' || activityFilter === 'all' || orderState(remote).bucket === activityFilter) renderOrder(remote, native);
  if (!buckets.length) {
    const empty = element('div', '', $('requests')); empty.className = 'empty-state';
    element('h3', 'Your next request starts in chat.', empty);
    element('p', native ? 'After funding and enabling automatic payments, ask your agent to find an API and call it with a unique request ID. The payment and result will appear here.' : 'Ask your agent to find an API. Open its approval link to review and pay for the request.', empty);
  } else if (activityFilter !== 'all' && activityFilter !== 'archived' && !buckets.includes(activityFilter)) element('p', 'No requests in this view.', $('requests')).className = 'empty-state';
  for (const item of [...intents].reverse()) {
    if (activityFilter !== 'all' && activityFilter !== 'archived' && legacyBucket(item) !== activityFilter) continue;
    const card = element('article', '', $('requests')); card.className = 'request';
    element('h3', item.name + ' · ' + item.displayAmount + ' ' + item.token, card);
    element('p', item.status + ' · ' + item.method + ' /x402/' + item.slug, card);
    const recipient = element('p', 'Pay to: ' + item.payTo + '\nFrom: ' + item.payer, card); recipient.className = 'mono';
    const details = element('details', '', card); element('summary', 'Inspect exact request', details);
    element('pre', JSON.stringify({ origin: item.origin, chainId: item.chainId, method: item.method, body: item.body ?? null }, null, 2), details);
    const actions = element('div', '', card); actions.className = 'actions';
    archiveAction(item, actions);
    element('p', 'Request ID: ' + item.requestId, card).className = 'mono';
    const lastReview = item.reviewHistory?.at(-1);
    if (lastReview) element('p', 'Last wallet action: ' + lastReview.action.replaceAll('_', ' ') + ' at ' + new Date(lastReview.at).toLocaleString(), card);
    const rejectRequest = async () => {
      if (!confirm('Reject this unpaid request? Repeating its request ID will keep it rejected until you explicitly reopen it for review.')) return;
      await api('/requests/' + item.id + '/reject', {});
    };
    if (item.status === 'rejected') {
      element('p', 'This request was rejected. Reusing its ID will not create a new approval request.', card);
      if (!native && !item.txHash && !item.policyId && !item.kind) {
        action('Reopen for review', actions, async () => {
          if (!confirm('Reopen this rejected request and fetch a current quote? Payment will still require separate approval.')) return;
          await api('/requests/' + item.id + '/reopen', {});
          notify('Request reopened. Review the current price and recipient before approving. No payment has been sent.');
        });
      }
    }
    if (native && ['pending', 'expired'].includes(item.status)) {
      element('p', 'Not paid. Enable a matching session, then ask your assistant to retry the same requestId: ' + item.requestId, card);
      action('Dismiss unpaid request', actions, rejectRequest).className = 'secondary';
    }
    if (['pending', 'expired'].includes(item.status) && !native) {
      if (item.status === 'expired') {
        element('p', 'Quote expired. Refresh the quote, then review its current price and recipient before approving.', card);
        action('Refresh quote', actions, async () => {
          await api('/requests/' + item.id + '/refresh', {});
          notify('Quote refreshed. Review the price and recipient, then approve when ready. No payment has been sent.');
        });
      }
      else action('Approve payment ↗', actions, async () => {
        const account = await signer();
        if ((await account.getAddress()).toLowerCase() !== item.payer.toLowerCase()) throw new Error('Select the wallet that created this request');
        const intent = await api('/requests/' + item.id + '/begin', { expiresAt: item.expiresAt });
        notify('Confirm the exact payment in your wallet. Do not send it again if confirmation is delayed.');
        const tx = intent.asset ? await new ethers.Contract(intent.asset, ['function transfer(address,uint256) returns(bool)'], account).transfer(intent.payTo, BigInt(intent.amount))
          : await account.sendTransaction({ to: intent.payTo, value: BigInt(intent.amount) });
        localStorage.setItem('olanas-payment-' + item.id, tx.hash);
        notify('Payment submitted: ' + tx.hash + '. Checking confirmation and calling the API…');
        await api('/requests/' + item.id + '/complete', { txHash: tx.hash });
        notify('Payment checked. See the API result below.');
      });
      action('Reject', actions, rejectRequest).className = 'secondary';
    }
    if (native && ['signing', 'submitted'].includes(item.status)) {
      element('p', 'Reconcile the saved transaction only. No replacement payment will be created.', card);
      action('Owner: reconcile original payment', actions, async () => {
        if (!confirm('Check/rebroadcast the ORIGINAL signed transaction only? This can finish a previously authorized payment.')) return;
        await api('/owner/recover/' + item.id, {}, true);
        notify('Recovery checked. Inspect the status and original transaction.');
      });
    }
    if (['awaiting_wallet', 'delivery_unknown'].includes(item.status) || (!native && item.status === 'submitted')) {
      element('p', item.status === 'delivery_unknown' ? 'Delivery is uncertain. Do not pay again. Check with the service before retrying the same request.' : 'Never pay twice. If you cancelled the wallet prompt, request a new intent. If a transaction was sent, recover it below.', card);
      const hash = element('input', '', card); hash.placeholder = 'Original transaction hash (0x…)'; hash.setAttribute('aria-label', 'Original transaction hash');
      hash.value = item.txHash || localStorage.getItem('olanas-payment-' + item.id) || '';
      action(item.status === 'delivery_unknown' ? 'Retry API with SAME payment' : 'Check original payment', actions, async () => {
        if (item.status === 'delivery_unknown' && !confirm('The API might have executed already. Have you checked that retrying is safe? No new payment will be sent.')) return;
        await api('/requests/' + item.id + '/complete', { txHash: hash.value.trim() });
        notify('Original payment checked. No new payment sent.');
      });
    }
    if (item.txHash) { const link = element('a', 'View transaction ↗', card); link.href = state.chain.explorerUrl + '/tx/' + item.txHash; link.target = '_blank'; link.rel = 'noreferrer'; }
    if (item.result) { const result = element('details', '', card); element('summary', 'API response · HTTP ' + item.result.status, result); element('pre', item.result.body, result); }
  }
  lastState = serialized;
}
async function balances() {
  let data;
  try { data = await api('/balance'); }
  catch (error) { $('balances').textContent = 'Balance unavailable. Refresh to check again.'; throw error; }
  $('balances').replaceChildren();
  for (const balance of data.balances) element('div', balance.amount + ' ' + balance.token, $('balances'));
  if (!data.address) $('balances').textContent = 'Not connected';
}
$('connect').onclick = () => run(async () => { const account = await signer(); await api('/connect', { address: await account.getAddress() }); await balances(); notify('Wallet connected. Fund it on the displayed Robinhood network to pay for APIs.'); });
$('theme-toggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
setTheme(localStorage.getItem('olanas-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('refresh').onclick = () => run(balances);
$('activity-filter').onchange = () => { activityFilter = $('activity-filter').value; refresh().catch(error => notify(error.message)); };
for (const id of ['session-budget', 'per-call', 'session-token', 'gas-mode', 'session-minutes']) {
  $(id).oninput = updateSessionReview; $(id).onchange = updateSessionReview;
}
$('agent-token').onchange = loadAgentForm;
for (const id of ['agent-enabled', 'agent-daily', 'agent-per-call', 'agent-gas-daily', 'agent-gas-per-call', 'agent-gas-mode']) {
  $(id).oninput = $(id).onchange = () => { agentFormDirty = true; updateAgentReview(); };
}
$('agent-form').onsubmit = event => { event.preventDefault(); return run(async () => {
  const settings = { enabled: $('agent-enabled').checked, token: $('agent-token').value,
    daily: $('agent-daily').value.trim(), perCall: $('agent-per-call').value.trim(),
    gasDaily: $('agent-gas-daily').value.trim(), gasPerCall: $('agent-gas-per-call').value.trim(),
    gasMode: $('agent-gas-mode').value };
  if (!confirm((settings.enabled ? 'Enable or update' : 'Disable') + ' automatic agent payments? ' +
      settings.token + ': ' + settings.daily + ' per UTC day and ' + settings.perCall + ' per call. ' +
      'Gas: ' + settings.gasDaily + ' ETH per day and ' + settings.gasPerCall + ' per call. ' +
      'Anyone with this private companion link can change these limits.')) return;
  const result = await api('/agent-payments', settings);
  state.agentPayments = result;
  agentFormDirty = false;
  agentRevisionSeen = 0;
  notify(settings.enabled ? 'Automatic payment limits saved. Eligible MCP calls can pay without a password prompt.' : 'Automatic agent payments disabled.');
}); };
$('copy').onclick = () => run(async () => { if (!state.address) throw new Error('Connect your wallet first'); await navigator.clipboard.writeText(state.address); notify('Funding address copied. Use ' + state.chain.name + ' only.'); });
$('send').onsubmit = event => { event.preventDefault(); return run(async () => {
  const recipient = ethers.getAddress($('recipient').value.trim());
  if (recipient === ethers.ZeroAddress) throw new Error('Cannot send to the zero address');
  const token = state.chain.tokens.find(item => item.symbol === $('token').value);
  const amount = ethers.parseUnits($('amount').value.trim(), token.decimals);
  if (amount <= 0n) throw new Error('Enter a positive amount');
  if (state.walletProvider === 'olanas') {
    const gasLimit = OlanasSessionPresets.modes.standard.gasPerCall;
    if (!confirm('Send ' + ethers.formatUnits(amount, token.decimals) + ' ' + token.symbol + ' to ' + recipient + ' on ' + state.chain.name + '? Maximum gas: ' + gasLimit + ' ETH.')) return;
    const payload = { recipient, token: token.symbol, amount: ethers.formatUnits(amount, token.decimals), gasLimit };
    const key = 'olanas-withdraw-' + state.chain.chainId + '-' + state.address;
    const previous = JSON.parse(localStorage.getItem(key) || 'null');
    const requestId = previous?.fingerprint === JSON.stringify(payload) ? previous.requestId : crypto.randomUUID();
    localStorage.setItem(key, JSON.stringify({ fingerprint: JSON.stringify(payload), requestId }));
    const result = await api('/owner/withdraw', { ...payload, requestId }, true);
    notify('Withdrawal ' + result.status + ': ' + (result.txHash || 'not broadcast') + '. Use recovery instead of sending again.');
    return;
  }
  const account = await signer();
  if (!state.address || (await account.getAddress()).toLowerCase() !== state.address.toLowerCase()) throw new Error('Select your connected wallet');
  if (!confirm('Send ' + ethers.formatUnits(amount, token.decimals) + ' ' + token.symbol + ' to ' + recipient + ' on ' + state.chain.name + '? Network fees apply.')) return;
  const tx = token.address ? await new ethers.Contract(token.address, ['function transfer(address,uint256) returns(bool)'], account).transfer(recipient, amount)
    : await account.sendTransaction({ to: recipient, value: amount });
  notify('Transfer submitted: ' + tx.hash + '. Check your wallet for confirmation before retrying.');
}); };
async function runSession(action, fn) {
  if (working) return;
  sessionAction = action;
  try { await run(async () => {
    syncDisabled();
    if (!$('owner-password').value) throw new Error('Enter your owner password in the field above, then try again.');
    await fn();
  }); } finally { sessionAction = ''; syncDisabled(); }
}
$('session-form').onsubmit = event => { event.preventDefault(); return runSession('enable', async () => {
  if (sessionBlockers().length) throw new Error('Resolve the outstanding order shown below before enabling a new session.');
  const policy = sessionDraft();
  if (!confirm('Enable ' + policy.gasMode + ' autonomous payments on ' + state.chain.name + ' for ' + policy.minutes + ' minutes? Maximum ' + policy.budget + ' ' + policy.token + ' total; ' + policy.perCall + ' per API call. Gas: ' + policy.gasPerCall + ' ETH per transaction, ' + policy.gasBudget + ' ETH total. Services [' + policy.services.join(', ') + '], recipients [' + policy.recipients.join(', ') + ']. * means any.')) { notify('Session change cancelled. Your spending settings were not changed.'); return; }
  notify('Enabling spending session…');
  await api('/owner/session', policy, true);
  notify('Session enabled. Your assistant can now call APIs within the approved limits without per-payment wallet prompts.');
}); };
$('revoke').onclick = () => runSession('revoke', async () => { notify('Revoking spending session…'); await api('/owner/revoke', {}, true); notify('Session revoked. New autonomous payments are stopped. Already submitted transactions cannot be recalled.'); });
$('wallet-link-form').onsubmit = event => {
  event.preventDefault();
  try {
    const link = new URL($('wallet-link').value.trim());
    if (link.origin !== location.origin || link.pathname !== '/' || link.search || link.username || link.password || !/^[a-f0-9]{64}$/.test(link.hash.slice(1))) {
      throw Error('Use the complete private link from this running companion, with the same local address and port.');
    }
    sessionStorage.setItem('olanas-companion-token', link.hash.slice(1));
    $('wallet-link').value = '';
    location.reload();
  } catch (_) { $('wallet-link').value = ''; notify('That is not a valid wallet link for this local companion. Use its complete link, not your private key or wallet address.'); }
};
if (credential) {
  refresh().then(balances).catch(error => notify(error.message));
  setInterval(() => { if (!working && sessionAuthorized) refresh().catch(error => notify(error.message)); }, 5000);
} else {
  sessionAuthorized = false;
  markCompanionUnavailable();
  $('connect').disabled = true;
  notify('This tab is not authorized. Reopen the complete wallet URL printed by the companion, including its #token.');
}
