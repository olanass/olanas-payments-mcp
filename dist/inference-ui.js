'use strict';
// Uses the existing private companion session and wallet; no second MCP or key entry.
let inferenceConfig;
const nativeInference = () => state?.walletProvider === 'olanas';
const inferenceOwner = (route,body) => api('/inference'+route,body,nativeInference());
const depositStorageKey = () => 'olanas-orbio-deposit-'+state.chain.chainId+'-'+state.address?.toLowerCase();
async function inferenceRefresh() {
  if (!sessionAuthorized || !state || state.preview) return;
  const view=await api('/inference');
  const p=view.policy;
  $('inference-status').textContent=(view.registered?'Connected: '+view.payer:'Not connected to Orbio.')+
    (p ? ' Spending '+(p.active?'enabled':'stopped')+'. Charged '+ethers.formatUnits(p.spentMicros,6)+' USDG; reserved '+ethers.formatUnits(p.heldMicros,6)+' USDG.' : ' Spending is off.');
  const saved=JSON.parse(localStorage.getItem(depositStorageKey()) || 'null');
  if (saved?.txHash && !$('inference-hash').value) $('inference-hash').value=saved.txHash;
}
async function reviewedConfig() {
  inferenceConfig=await api('/inference/config');
  return inferenceConfig;
}
$('inference-connect').onclick=()=>run(async()=>{
  const c=await reviewedConfig();
  if(!confirm('Connect '+state.address+' to Orbio at '+c.origin+'? Prepaid receiver: '+c.receiver+'. Network: '+c.network+'. Registration signs a message and does not transfer funds.'))return;
  if(nativeInference())await inferenceOwner('/register',{receiver:c.receiver});
  else {
    const account=await signer();
    if((await account.getAddress()).toLowerCase()!==state.address?.toLowerCase())throw Error('Select your connected Olanas wallet');
    const authorization=await inferenceOwner('/prepare',{receiver:c.receiver});
    await inferenceOwner('/register',{signature:await account.signMessage(authorization.message)});
  }
  await inferenceRefresh(); notify('Orbio connected. Add prepaid USDG and enable an inference budget here.');
});
$('inference-balance').onclick=()=>run(async()=>{
  const b=await api('/inference/balance');
  notify('Orbio prepaid: '+ethers.formatUnits(b.availableMicros,6)+' USDG available; '+ethers.formatUnits(b.reservedMicros,6)+' reserved.');
});
$('inference-fund-form').onsubmit=event=>{event.preventDefault();return run(async()=>{
  const c=await reviewedConfig(), amount=$('inference-amount').value.trim(), units=ethers.parseUnits(amount,6);
  if(units<=0n)throw Error('Enter a positive deposit amount');
  const view=await api('/inference');
  if(!view.registered || view.payer!==state.address?.toLowerCase())throw Error('Connect this wallet to Orbio before depositing');
  const key=depositStorageKey();
  let saved=JSON.parse(localStorage.getItem(key) || 'null');
  if(saved?.txHash) {$('inference-hash').value=saved.txHash;throw Error('Check the original deposit below before making another transfer');}
  if(saved && !nativeInference())throw Error('The previous wallet transfer is uncertain. Find its hash in your wallet and check it below; do not send again.');
  if(saved && (saved.amount!==amount || saved.receiver!==c.receiver))throw Error('Resolve the previous deposit before changing the amount');
  const gasLimit=OlanasSessionPresets.modes.standard.gasPerCall;
  if(!confirm('Deposit '+amount+' USDG from '+state.address+' to '+c.receiver+' on '+c.network+'? '+(nativeInference()?'Maximum gas: '+gasLimit+' ETH. ':'Network fees apply. ')+'This purchases prepaid credit; refunds are manual.'))return;
  saved ||= {requestId:crypto.randomUUID(),amount,receiver:c.receiver};
  localStorage.setItem(key,JSON.stringify(saved));
  if(nativeInference()) {
    const result=await inferenceOwner('/fund',{...saved,gasLimit});
    if(!result.txHash)throw Error('Deposit '+result.status+'. Use owner recovery for the original transfer; do not create another.');
    saved.txHash=result.txHash;
  } else {
    try {
      const account=await signer();
      if((await account.getAddress()).toLowerCase()!==state.address?.toLowerCase())throw Error('Select the connected wallet');
      const tx=await new ethers.Contract(c.token,['function transfer(address,uint256) returns(bool)'],account).transfer(c.receiver,units);
      saved.txHash=tx.hash;
    } catch(error) {
      if(error.code===4001 || error.code==='ACTION_REJECTED')localStorage.removeItem(key);
      throw error;
    }
  }
  localStorage.setItem(key,JSON.stringify(saved)); $('inference-hash').value=saved.txHash;
  notify('Deposit submitted: '+saved.txHash+'. Use Check original deposit until it is finalized; do not send again.');
});};
$('inference-credit-form').onsubmit=event=>{event.preventDefault();return run(async()=>{
  const txHash=$('inference-hash').value.trim();
  await inferenceOwner('/deposits',{txHash});
  const key=depositStorageKey(), saved=JSON.parse(localStorage.getItem(key) || 'null');
  if(saved && (!saved.txHash || saved.txHash.toLowerCase()===txHash.toLowerCase()))localStorage.removeItem(key);
  notify('Original deposit credited. Check your prepaid balance.');
});};
$('inference-session-form').onsubmit=event=>{event.preventDefault();return run(async()=>{
  const settings={perCall:$('inference-per-call').value.trim(),budget:$('inference-budget').value.trim(),minutes:Number($('inference-minutes').value)};
  if(!confirm('Allow Orbio inference to spend up to '+settings.perCall+' USDG per call and '+settings.budget+' USDG total for '+settings.minutes+' minutes?'))return;
  await inferenceOwner('/session',settings); await inferenceRefresh(); notify('Orbio inference spending enabled. Your connected assistant can now use_ai_model.');
});};
$('inference-revoke').onclick=()=>run(async()=>{await inferenceOwner('/revoke',{});await inferenceRefresh();notify('New Orbio inference spending stopped. Already started calls may still complete and be charged.');});
setInterval(()=>{if(!working)inferenceRefresh().catch(()=>{});},5000);
