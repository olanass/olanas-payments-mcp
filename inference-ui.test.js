'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {ethers}=require('ethers');
const payer='0x'+'11'.repeat(20),receiver='0x'+'22'.repeat(20),txHash='0x'+'aa'.repeat(32);
function fixture(){
  const nodes=new Map(), storage=new Map(), calls=[];
  for(const m of fs.readFileSync('wallet.html','utf8').matchAll(/id="([^"]+)"/g))nodes.set(m[1],{value:'',textContent:''});
  nodes.get('inference-amount').value='1';
  const config={origin:'https://orbio.test',receiver,network:'eip155:4663',token:'0x'+'33'.repeat(20)};
  const f={nodes,calls,confirm:true,creditFails:true,unknownTransfer:false};
  const context=vm.createContext({$:id=>nodes.get(id),state:{walletProvider:'olanas',address:payer,chain:{chainId:4663}},sessionAuthorized:true,
    localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    confirm:()=>f.confirm,run:fn=>fn(),notify:message=>{f.notice=message;},setInterval(){},working:false,
    crypto:require('node:crypto').webcrypto,ethers,OlanasSessionPresets:require('./session-presets'),
    api:async(route,body,owner)=>{
      calls.push({route,body,owner});
      if(route==='/inference/config')return config;
      if(route==='/inference')return {registered:true,payer};
      if(route==='/inference/fund')return f.unknownTransfer?{status:'signing'}:{txHash,status:'submitted'};
      if(route==='/inference/deposits' && f.creditFails)throw Error('not finalized');
      return {};
    }});
  vm.runInContext(fs.readFileSync('inference-ui.js','utf8'),context);
  f.click=id=>nodes.get(id).onclick();
  f.submit=id=>nodes.get(id).onsubmit({preventDefault(){}});
  return f;
}
test('Orbio registration requires review and uses native owner authorization',async()=>{
  const f=fixture();f.confirm=false;await f.click('inference-connect');
  assert.ok(!f.calls.some(c=>c.route==='/inference/register'));
  f.confirm=true;await f.click('inference-connect');
  const call=f.calls.find(c=>c.route==='/inference/register');assert.equal(call.owner,true);assert.equal(call.body.receiver,receiver);
});
test('deposit finality retry keeps original hash and prevents a replacement transfer',async()=>{
  const f=fixture();await f.submit('inference-fund-form');
  assert.equal(f.nodes.get('inference-hash').value,txHash);
  await assert.rejects(f.submit('inference-credit-form'),/finalized/);
  await assert.rejects(f.submit('inference-fund-form'),/original deposit/);
  assert.equal(f.calls.filter(c=>c.route==='/inference/fund').length,1);
  f.creditFails=false;await f.submit('inference-credit-form');
  assert.equal(f.calls.filter(c=>c.route==='/inference/deposits').every(c=>c.body.txHash===txHash),true);
});
test('uncertain native top-up retains its identity and refuses changed amounts',async()=>{
  const f=fixture();f.unknownTransfer=true;
  await assert.rejects(f.submit('inference-fund-form'),/owner recovery/);
  f.nodes.get('inference-amount').value='2';await assert.rejects(f.submit('inference-fund-form'),/previous deposit/);
  f.nodes.get('inference-amount').value='1';f.unknownTransfer=false;await f.submit('inference-fund-form');
  const calls=f.calls.filter(c=>c.route==='/inference/fund');assert.equal(calls.length,2);assert.equal(calls[0].body.requestId,calls[1].body.requestId);
});
