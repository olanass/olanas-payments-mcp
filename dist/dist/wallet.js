'use strict';
const credential = location.hash.slice(1) || sessionStorage.getItem('olanas-companion-token');
if (location.hash) { sessionStorage.setItem('olanas-companion-token', credential); history.replaceState(null, '', '/'); }
const $ = id => document.getElementById(id);
let state;
let working = false;
let lastState = '';
function notify(message) { $('notice').textContent = message; }
async function api(route, body, owner = false) {
  const ownerPassword = owner ? $('owner-password').value : '';
  if (owner && !ownerPassword) throw new Error('Enter your owner password in the companion, not in agent chat.');
  const res = await fetch('/api' + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', ...(owner ? { 'x-owner-password': ownerPassword } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) throw new Error('Open the wallet link from your MCP client or terminal to authorize this session.');
  const result = await res.json(); if (!res.ok) throw new Error(result.error || 'Request failed'); return result;
}
async function signer() {
  if (!window.ethereum) throw new Error('Install or enable an EVM browser wallet, then reload. No private key is needed here.');
  const chainId = '0x' + state.chain.chainId.toString(16);
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
  catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: state.chain.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [state.chain.rpcUrl], blockExplorerUrls: [state.chain.explorerUrl] }] });
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
  await window.ethereum.request({ method: 'eth_requestAccounts' });
  const provider = new ethers.BrowserProvider(window.ethereum);
  if (Number((await provider.getNetwork()).chainId) !== state.chain.chainId) throw new Error('Wrong network selected');
  return provider.getSigner();
}
async function run(fn) {
  if (working) return; working = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await fn(); } catch (error) { notify(error.shortMessage || error.message); }
  finally { working = false; await refresh().catch(error => notify(error.message)); document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
function element(tag, text, parent) { const node = document.createElement(tag); node.textContent = text; if (parent) parent.append(node); return node; }
function action(text, parent, fn) { const button = element('button', text, parent); button.onclick = () => run(fn); return button; }
async function refresh() {
  state = await api('/state');
  const serialized = JSON.stringify({ state, sessionExpired: Boolean(state.policy && state.policy.expiresAt <= Date.now()) });
  if (serialized === lastState) return;
  lastState = serialized;
  const native = state.walletProvider === 'olanas';
  $('owner-controls').hidden = !native;
  $('connect').hidden = native;
  document.querySelector('.balance .pill').textContent = native ? 'Olanas wallet' : 'Self-custody';
  document.querySelector('.requests .pill').textContent = native ? 'Autonomous / owner limits' : 'Manual approval';
  if (native) {
    if ($('notice').textContent === 'Connect a browser wallet to get started.') notify('Olanas wallet configured. Fund it on Robinhood and enable a bounded session in owner controls.');
    document.querySelector('.intro p').textContent = 'Fund your Olanas wallet on Robinhood. Set a budget once; your assistant can pay any API on the connected launchpad automatically.';
    document.querySelector('#send button').textContent = 'Confirm owner withdrawal';
    document.querySelector('#send .small').textContent = 'Owner password required. Maximum gas comes from the ETH per-call gas field above. This sends directly from your Olanas wallet.';
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
  $('network').textContent = state.chain.name + (state.chain.networkKey === 'testnet' ? ' · TEST FUNDS' : ' · MAINNET');
  $('address').textContent = state.address || 'No wallet connected';
  $('connect').textContent = state.address ? 'Change wallet ↗' : 'Connect wallet ↗';
  $('launchpad').textContent = 'Connected launchpad: ' + state.launchpad;
  if (!$('token').options.length) for (const token of state.chain.tokens) { const option = element('option', token.symbol, $('token')); option.value = token.symbol; }
  $('requests').replaceChildren();
  if (!state.intents.length) element('p', 'No requests yet. Ask your connected assistant to search for an API.', $('requests'));
  for (const item of [...state.intents].reverse()) {
    const card = element('article', '', $('requests')); card.className = 'request';
    element('h3', item.name + ' · ' + item.displayAmount + ' ' + item.token, card);
    element('p', item.status + ' · ' + item.method + ' /x402/' + item.slug, card);
    const recipient = element('p', 'Pay to: ' + item.payTo + '\nFrom: ' + item.payer, card); recipient.className = 'mono';
    const details = element('details', '', card); element('summary', 'Inspect exact request', details);
    element('pre', JSON.stringify({ origin: item.origin, chainId: item.chainId, method: item.method, body: item.body ?? null }, null, 2), details);
    const actions = element('div', '', card); actions.className = 'actions';
    if (cdp && item.status === 'pending') {
      element('p', 'Not paid. Enable a matching session, then ask Claude to retry the same requestId: ' + item.requestId, card);
      action('Dismiss unpaid request', actions, () => api('/requests/' + item.id + '/reject', {})).className = 'secondary';
    }
    if (item.status === 'pending' && !cdp) {
      if (item.expiresAt < Date.now()) element('p', 'Quote expired. Ask the agent for a new request.', card);
      else action('Approve payment ↗', actions, async () => {
        const account = await signer();
        if ((await account.getAddress()).toLowerCase() !== item.payer.toLowerCase()) throw new Error('Select the wallet that created this request');
        const intent = await api('/requests/' + item.id + '/begin', {});
        notify('Confirm the exact payment in your wallet. Do not send it again if confirmation is delayed.');
        const tx = intent.asset ? await new ethers.Contract(intent.asset, ['function transfer(address,uint256) returns(bool)'], account).transfer(intent.payTo, BigInt(intent.amount))
          : await account.sendTransaction({ to: intent.payTo, value: BigInt(intent.amount) });
        localStorage.setItem('olanas-payment-' + item.id, tx.hash);
        notify('Payment submitted: ' + tx.hash + '. Checking confirmation and calling the API…');
        await api('/requests/' + item.id + '/complete', { txHash: tx.hash });
        notify('Payment checked. See the API result below.');
      });
      action('Reject', actions, () => api('/requests/' + item.id + '/reject', {})).className = 'secondary';
    }
    if (cdp && ['signing', 'submitted'].includes(item.status)) {
      element('p', 'Reconcile the saved transaction only. No replacement payment will be created.', card);
      action('Owner: reconcile original payment', actions, async () => {
        if (!confirm('Check/rebroadcast the ORIGINAL signed transaction only? This can finish a previously authorized payment.')) return;
        await api('/owner/recover/' + item.id, {}, true);
        notify('Recovery checked. Inspect the status and original transaction.');
      });
    }
    if (['awaiting_wallet', 'delivery_unknown'].includes(item.status) || (!cdp && item.status === 'submitted')) {
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
}
async function balances() {
  const data = await api('/balance');
  $('balances').replaceChildren();
  for (const balance of data.balances) element('div', balance.amount + ' ' + balance.token, $('balances'));
  if (!data.address) $('balances').textContent = 'Not connected';
}
$('connect').onclick = () => run(async () => { const account = await signer(); await api('/connect', { address: await account.getAddress() }); await balances(); notify('Wallet connected. Fund it on the displayed Robinhood network to pay for APIs.'); });
$('refresh').onclick = () => run(balances);
$('copy').onclick = () => run(async () => { if (!state.address) throw new Error('Connect your wallet first'); await navigator.clipboard.writeText(state.address); notify('Funding address copied. Use ' + state.chain.name + ' only.'); });
$('send').onsubmit = event => { event.preventDefault(); run(async () => {
  const recipient = ethers.getAddress($('recipient').value.trim());
  if (recipient === ethers.ZeroAddress) throw new Error('Cannot send to the zero address');
  const token = state.chain.tokens.find(item => item.symbol === $('token').value);
  const amount = ethers.parseUnits($('amount').value.trim(), token.decimals);
  if (amount <= 0n) throw new Error('Enter a positive amount');
  if (state.walletProvider === 'olanas') {
    const gasLimit = $('gas-per-call').value.trim();
    if (!gasLimit || ethers.parseEther(gasLimit) <= 0n) throw new Error('Set a positive maximum ETH gas amount in owner controls first');
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
$('session-form').onsubmit = event => { event.preventDefault(); run(async () => {
  const policy = { token: $('session-token').value, perCall: $('per-call').value.trim(), budget: $('session-budget').value.trim(),
    gasPerCall: $('gas-per-call').value.trim(), gasBudget: $('gas-budget').value.trim(), minutes: Number($('session-minutes').value) };
  if (!confirm('Allow autonomous payments to any service on the connected Olanas launchpad for ' + policy.minutes + ' minutes, up to ' + policy.budget + ' ' + policy.token + ' plus ' + policy.gasBudget + ' ETH gas?')) return;
  await api('/owner/session', policy, true);
  notify('Session enabled. Claude can now call any API on the connected launchpad without per-payment wallet prompts.');
}); };
$('revoke').onclick = () => run(async () => { await api('/owner/revoke', {}, true); notify('Session revoked. Already submitted transactions cannot be recalled.'); });
refresh().then(balances).catch(error => notify(error.message));
setInterval(() => { if (!working) refresh().catch(error => notify(error.message)); }, 5000);
