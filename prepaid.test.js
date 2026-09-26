'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Wallet}=require('ethers');
const {PrepaidInference}=require('./prepaid');
const origin='https://orbio.test', receiver='0x'+'22'.repeat(20), token='0x'+'33'.repeat(20);
const body={model:'test/model',messages:[{role:'user',content:'Private prompt'}],max_tokens:16};
async function fixture(options={}) {
  const signer=Wallet.createRandom(), requests=[], remote=new Map();
  const wallet={state:{address:signer.address},chain:{chainId:4663,supportedTokens:{USDG:{address:token}}}};
  const f={signer,wallet,requests,remote,maximum:100,charged:'9',timeout:false};
  const fetchImpl=async(url,opts)=>{
    const route=new URL(url).pathname.replace('/api/inference/prepaid','');
    const value=opts.body?JSON.parse(opts.body):null;requests.push({route,opts,value});
    let result;
    if(route==='/config') result={scheme:'prepaid-balance',network:'eip155:4663',decimals:6,token,receiver:f.receiver || receiver,keyAuthorizationOrigin:origin};
    else if(route==='/keys/register')result={payer:value.payer,keyHash:value.keyHash,status:'active'};
    else if(route==='/quote') {if(f.quoteHook)await f.quoteHook();result={maximumMicros:String(f.maximum),currency:'USDG'};}
    else if(route==='/chat/completions') {
      const id=opts.headers['idempotency-key'];
      assert.ok(f.client.state.calls.some(c=>c.requestId===id && c.status==='pending'));
      assert.ok(f.client.state.policy.heldMicros>=f.maximum);
      assert.equal(opts.headers['X-Olanas-Maximum-Micros'],String(f.maximum));
      remote.set(id,{requestId:id,status:'completed',response:{choices:[{message:{content:'Hello'}}]},chargedMicros:f.charged});
      if(f.timeout)throw Error('secret credential in network error');
      return new Response(JSON.stringify(remote.get(id).response),{headers:{'X-Olanas-Charged-Micros':f.charged}});
    }
    else if(route.startsWith('/calls/')) {
      const id=route.split('/')[2]; result=remote.get(id) || {requestId:id,status:'not_found'};
      if(route.endsWith('/recover') && result.status==='ready')result={...result,status:'completed'};
    }
    else if(route==='/balance')result={availableMicros:'1000',reservedMicros:'0'};
    else if(route==='/deposits')result={credited:true};
    else if(route==='/models')result={data:[{id:'test/model'}]};
    else throw Error('Unexpected route '+route);
    return new Response(JSON.stringify(result));
  };
  f.options={wallet,secret:'test-private-token',origin,fetchImpl,...options};
  f.client=new PrepaidInference(f.options);
  const authorization=await f.client.prepare(receiver);
  await f.client.finish(await signer.signMessage(authorization.message));
  f.enable=()=>f.client.enable({perCall:'0.0001',budget:'0.0002',minutes:60});
  return f;
}
test('one wallet registers without exposing credentials; disabled sessions cannot spend',async()=>{
  const f=await fixture();
  assert.equal(f.client.view().payer,f.signer.address.toLowerCase());
  assert.ok(!JSON.stringify(f.client.view()).includes(f.client.state.apiKey));
  assert.equal((await f.client.models()).data[0].id,'test/model');
  await assert.rejects(f.client.use(body,'request-001'),/Enable an Orbio/);
  assert.equal(f.requests.filter(r=>r.route==='/chat/completions').length,0);
});
test('actual charges release unused reserve; concurrent identical calls replay exactly once',async()=>{
  const f=await fixture();await f.enable();
  const results=await Promise.all(Array.from({length:5},()=>f.client.use(body,'request-001')));
  assert.equal(results[0].receipt.chargedMicros,'9');
  assert.equal(f.requests.filter(r=>r.route==='/chat/completions').length,1);
  assert.equal(f.client.view().policy.spentMicros,9);assert.equal(f.client.view().policy.heldMicros,0);
  await assert.rejects(f.client.use({...body,max_tokens:20},'request-001'),/different input/);
  f.client.revoke();assert.equal((await f.client.use(body,'request-001')).receipt.replayed,true);
});
test('per-call caps and budget exhaustion block requests before provider submission',async()=>{
  const f=await fixture();await f.enable();f.maximum=101;
  await assert.rejects(f.client.use(body,'request-001'),/spending limits/);
  f.maximum=100;f.charged='100';await f.client.use(body,'request-001');await f.client.use(body,'request-002');
  await assert.rejects(f.client.use(body,'request-003'),/spending limits/);
  assert.equal(f.requests.filter(r=>r.route==='/chat/completions').length,2);
});
test('revocation while fetching quote prevents an in-flight new charge',async()=>{
  const f=await fixture();await f.enable();f.quoteHook=()=>f.client.revoke();
  await assert.rejects(f.client.use(body,'request-001'),/Enable an Orbio/);
  assert.equal(f.requests.filter(r=>r.route==='/chat/completions').length,0);
});
test('timeouts hold budget and block replacement; receipt reconciles original charge',async()=>{
  const f=await fixture();await f.enable();f.timeout=true;
  await assert.rejects(f.client.use(body,'request-001'),e=>!e.message.includes('secret credential'));
  assert.equal(f.client.view().policy.heldMicros,100);
  await assert.rejects(f.client.use(body,'request-002'),/unresolved/);
  await assert.rejects(f.client.enable({perCall:'0.0001',budget:'0.001',minutes:60}),/pending inference/);
  await f.enable();assert.equal(f.client.view().policy.heldMicros,100);
  f.client.revoke();assert.equal((await f.client.receipt('request-001')).receipt.chargedMicros,'9');
  assert.equal(f.requests.filter(r=>r.route==='/chat/completions').length,1);
});
test('encrypted journal survives restart without re-enabling spend; ready result can recover',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'olanas-prepaid-'));
  try {
    const file=path.join(dir,'prepaid.json'), f=await fixture({file});await f.enable();f.timeout=true;
    await assert.rejects(f.client.use(body,'request-001'));
    const disk=fs.readFileSync(file,'utf8');assert.ok(!disk.includes(f.client.state.apiKey));assert.ok(!disk.includes('Private prompt'));
    f.client=new PrepaidInference(f.options);assert.equal(f.client.view().policy.active,false);
    f.remote.get('request-001').status='ready';
    assert.equal((await f.client.recover('request-001')).receipt.chargedMicros,'9');
    assert.equal(f.requests.filter(r=>r.route==='/chat/completions').length,1);
    await assert.rejects(f.client.use(body,'request-002'),/Enable an Orbio/);
    assert.throws(()=>new PrepaidInference({...f.options,secret:'wrong'}));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('changed receiver, network or payer cannot redirect access or funds',async()=>{
  const f=await fixture();f.receiver='0x'+'44'.repeat(20);await assert.rejects(f.client.config(),/configuration/);
  f.receiver=null;f.wallet.chain.chainId=1;await assert.rejects(f.client.config(),/configuration/);
  f.wallet.chain.chainId=4663;f.wallet.state.address=Wallet.createRandom().address;
  await assert.rejects(f.client.balance(),/Connect this wallet/);
  await assert.rejects(f.client.prepare(receiver),/original Orbio payer/);
});
test('wrong signature and unreviewed receiver never register a key',async()=>{
  const f=await fixture();const before=f.requests.filter(r=>r.route==='/keys/register').length;
  await assert.rejects(f.client.prepare('0x'+'44'.repeat(20)),/Review/);
  const challenge=await f.client.prepare(receiver);
  await assert.rejects(f.client.finish(await Wallet.createRandom().signMessage(challenge.message)),/Invalid/);
  assert.equal(f.requests.filter(r=>r.route==='/keys/register').length,before);
});
test('excessive/missing cost leaves reservation unresolved; deposit credit never sends a transfer',async()=>{
  const f=await fixture();await f.enable();f.charged='101';
  await assert.rejects(f.client.use(body,'request-001'),/Uncertain Orbio charge/);
  assert.equal(f.client.view().policy.heldMicros,100);
  const txHash='0x'+'ab'.repeat(32);await f.client.credit(txHash);await f.client.credit(txHash);
  assert.deepEqual(f.requests.filter(r=>r.route==='/deposits').map(r=>r.value),[{txHash},{txHash}]);
});
