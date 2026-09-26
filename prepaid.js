'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const { ethers } = require('ethers');
const { readBounded } = require('./core');
const PREFIX = '/api/inference/prepaid';
const DEFAULT_ORIGIN = 'https://orbio-inference.vercel.app';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const micros = value => {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value)) throw Error('Use a positive USDG amount with at most six decimals');
  const amount = ethers.parseUnits(value, 6);
  if (amount <= 0n || amount > 100000000n) throw Error('Choose an amount greater than zero and at most 100 USDG');
  return Number(amount);
};
function input(body) {
  if (!body || !/^[a-z0-9._/-]{1,150}$/i.test(body.model || '') || !Number.isInteger(body.max_tokens) || body.max_tokens<1 || body.max_tokens>4096 ||
      !Array.isArray(body.messages) || !body.messages.length || body.messages.length>40 ||
      body.messages.some(m => !m || !['system','developer','user','assistant'].includes(m.role) || typeof m.content!=='string' || Object.keys(m).some(k=>!['role','content'].includes(k))) ||
      Object.keys(body).some(k=>!['model','messages','max_tokens'].includes(k))) throw Error('Supply a text model, messages and max_tokens from 1 to 4096');
  const normalized = {model:body.model,messages:body.messages.map(m=>({role:m.role,content:m.content})),max_tokens:body.max_tokens};
  if (Buffer.byteLength(JSON.stringify(normalized))>16000) throw Error('Request exceeds 16 KB');
  return normalized;
}

// Separate encrypted journal: credentials and prompts never enter wallet state/MCP results.
class PrepaidInference {
  constructor({wallet, file, secret, origin=DEFAULT_ORIGIN, fetchImpl=fetch}) {
    const url = new URL(origin);
    if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('Orbio must use a configured HTTPS origin');
    this.origin=url.origin; this.wallet=wallet; this.file=file; this.fetch=fetchImpl;
    this.key=crypto.createHash('sha256').update(secret).digest(); this.tail=Promise.resolve();
    this.state={calls:[]};
    if (file && fs.existsSync(file)) {
      const saved=JSON.parse(fs.readFileSync(file,'utf8'));
      const cipher=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(saved.iv,'hex'));
      cipher.setAuthTag(Buffer.from(saved.tag,'hex'));
      this.state=JSON.parse(Buffer.concat([cipher.update(Buffer.from(saved.data,'base64')),cipher.final()]).toString());
    }
    if (this.state.origin && this.state.origin!==this.origin) throw Error('Orbio origin changed; use the original service or a separate data directory');
    if (this.state.policy) this.state.policy.active=false;
    this.save();
  }
  save() {
    if (!this.file) return;
    const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
    const data=Buffer.concat([cipher.update(JSON.stringify(this.state)),cipher.final()]);
    const fd=fs.openSync(this.file+'.tmp','w',0o600);
    try { fs.writeFileSync(fd,JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('base64')})); fs.fsyncSync(fd); }
    finally {fs.closeSync(fd);}
    fs.renameSync(this.file+'.tmp',this.file);
  }
  exclusive(fn) { const work=this.tail.then(fn,fn); this.tail=work.catch(()=>{}); return work; }
  bound() {
    if (!this.state.registered || this.state.payer!==this.wallet.state.address?.toLowerCase()) throw Error('Connect this wallet to Orbio in the local Olanas wallet page first');
  }
  view() { return {origin:this.origin,payer:this.state.payer || null,registered:Boolean(this.state.registered),receiver:this.state.receiver || null,
    policy:this.state.policy ? {...this.state.policy,active:this.state.policy.active && this.state.policy.expiresAt>Date.now()} : null,
    calls:this.state.calls.slice(-30).reverse().map(({requestId,status,maximumMicros,chargedMicros})=>({requestId,status,maximumMicros,chargedMicros}))}; }
  async request(path,{body,authenticated=false,id,maximum}={}) {
    if (authenticated) this.bound();
    let response, result;
    try {
      response=await this.fetch(this.origin+PREFIX+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(55000),
        headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer '+this.state.apiKey}:{}),...(id?{'idempotency-key':id}:{}),...(maximum?{'X-Olanas-Maximum-Micros':String(maximum)}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      result=JSON.parse(await readBounded(response,2*1024*1024));
    } catch { throw Error('Orbio request could not be confirmed. Keep the original requestId or deposit hash; do not make a replacement payment.'); }
    if (!response.ok) throw Object.assign(Error('Orbio returned HTTP '+response.status+'. Check the original receipt before retrying; reconnect in the wallet for 401, or check prepaid funds for 402.'),{status:response.status});
    return {body:result,response};
  }
  async config() {
    const {body:c}=await this.request('/config');
    if (c.scheme!=='prepaid-balance' || c.keyAuthorizationOrigin!==this.origin || c.network!=='eip155:'+this.wallet.chain.chainId || c.decimals!==6 ||
        !ethers.isAddress(c.receiver) || c.receiver.toLowerCase()===ethers.ZeroAddress ||
        c.token?.toLowerCase()!==this.wallet.chain.supportedTokens.USDG?.address?.toLowerCase() ||
        (this.state.receiver && c.receiver.toLowerCase()!==this.state.receiver)) throw Error('Orbio configuration does not match the approved network, token or receiver');
    return {...c,receiver:c.receiver.toLowerCase(),origin:this.origin};
  }
  prepare(receiver) { return this.exclusive(async()=>{
    const c=await this.config(), payer=this.wallet.state.address?.toLowerCase();
    if (!payer || payer===c.receiver) throw Error('Connect a buyer wallet first');
    if (receiver?.toLowerCase()!==c.receiver) throw Error('Review and approve the displayed Orbio receiver first');
    if (this.state.payer && this.state.payer!==payer) throw Error('Reconnect the original Orbio payer wallet');
    this.state.origin=this.origin; this.state.receiver=c.receiver; this.state.payer=payer;
    this.state.apiKey ||= 'olan_'+crypto.randomBytes(32).toString('hex');
    const body={payer,keyHash:hash(this.state.apiKey),timestamp:String(Date.now())};
    const message='Olanas prepaid key authorization\n'+JSON.stringify({origin:this.origin,chainId:this.wallet.chain.chainId,method:'POST',path:PREFIX+'/keys/register',...body});
    this.state.authorization={body,message}; this.save();
    return {message};
  }); }
  finish(signature) { return this.exclusive(async()=>{
    const authorization=this.state.authorization;
    if (!authorization || Date.now()-Number(authorization.body.timestamp)>300000 ||
        this.wallet.state.address?.toLowerCase()!==this.state.payer || ethers.verifyMessage(authorization.message,signature).toLowerCase()!==this.state.payer) throw Error('Invalid or expired Orbio wallet authorization');
    await this.config();
    const result=(await this.request('/keys/register',{body:{...authorization.body,signature}})).body;
    if (result.payer!==this.state.payer || result.keyHash!==hash(this.state.apiKey) || result.status!=='active') throw Error('Unexpected Orbio registration response');
    this.state.registered=true; delete this.state.authorization; this.save(); return this.view();
  }); }
  enable({perCall,budget,minutes}) { return this.exclusive(async()=>{
    this.bound();
    const cap=micros(perCall), total=micros(budget);
    if (cap>2000000 || cap>total || !Number.isInteger(minutes) || minutes<1 || minutes>1440) throw Error('Maximum 2 USDG per call; total must cover it; duration 1-1440 minutes');
    if (this.state.calls.some(c=>c.status!=='completed')) {
      const p=this.state.policy;
      if (!p || cap!==p.perCallMicros || total!==p.budgetMicros) throw Error('Resume the original pending inference with its existing per-call cap and total budget; reservations cannot be reset');
      p.active=true; p.expiresAt=Date.now()+minutes*60000;
    } else this.state.policy={active:true,perCallMicros:cap,budgetMicros:total,spentMicros:0,heldMicros:0,expiresAt:Date.now()+minutes*60000};
    this.save(); return this.view();
  }); }
  // Synchronous revocation also stops requests waiting on a quote/network call.
  revoke() {if(this.state.policy)this.state.policy.active=false; this.save(); return this.view();}
  models() {return this.request('/models').then(r=>r.body);}
  async balance() {this.bound(); return {...(await this.request('/balance',{authenticated:true})).body,connection:this.view()};}
  async quote(body) {
    const result=(await this.request('/quote',{body:input(body)})).body;
    if (!/^[1-9]\d{0,6}$/.test(result.maximumMicros) || Number(result.maximumMicros)>2000000 || result.currency!=='USDG') throw Error('Invalid Orbio quote');
    return result;
  }
  async credit(txHash) {
    if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw Error('Use the original deposit transaction hash');
    await this.config(); return (await this.request('/deposits',{body:{txHash},authenticated:true})).body;
  }
  policy() {this.bound(); const p=this.state.policy; if(!p?.active || p.expiresAt<=Date.now())throw Error('Enable an Orbio spending session in the local Olanas wallet'); return p;}
  settle(call,response,chargedMicros) {
    if (!/^\d{1,7}$/.test(String(chargedMicros)) || Number(chargedMicros)>call.maximumMicros) throw Error('Uncertain Orbio charge; retain the original reservation for reconciliation');
    const p=this.state.policy;
    p.heldMicros-=call.maximumMicros; p.spentMicros+=Number(chargedMicros);
    Object.assign(call,{status:'completed',response,chargedMicros:String(chargedMicros)}); this.save();
  }
  result(call,replayed=true) {return {response:call.response,receipt:{requestId:call.requestId,currency:'USDG',chargedMicros:call.chargedMicros,replayed,billing:'prepaid-balance'}};}
  use(body,requestId) {return this.exclusive(async()=>{
    body=input(body);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) throw Error('Keep one requestId of 8-100 letters, digits, underscores or hyphens');
    this.bound();
    const fingerprint=hash(JSON.stringify(body));
    let call=this.state.calls.find(c=>c.requestId===requestId), replayed=Boolean(call);
    if(call && call.fingerprint!==fingerprint)throw Error('requestId already belongs to different input');
    if(call?.status==='completed')return this.result(call);
    this.policy();
    if(!call) {
      if(this.state.calls.some(c=>c.status!=='completed'))throw Error('Another inference is unresolved; check its original receipt');
      const maximum=Number((await this.quote(body)).maximumMicros), p=this.policy();
      if(maximum>p.perCallMicros || maximum+p.spentMicros+p.heldMicros>p.budgetMicros)throw Error('Orbio quote exceeds approved spending limits');
      p.heldMicros+=maximum;
      call={requestId,fingerprint,body,maximumMicros:maximum,status:'pending'}; this.state.calls.push(call); this.save();
    }
    const result=await this.request('/chat/completions',{body:call.body,id:requestId,maximum:call.maximumMicros,authenticated:true});
    this.settle(call,result.body,result.response.headers.get('X-Olanas-Charged-Micros'));
    return this.result(call,replayed);
  });}
  receipt(requestId) {return this.exclusive(async()=>{
    this.bound(); const call=this.state.calls.find(c=>c.requestId===requestId);
    if(!call)return {requestId,status:'not_found'};
    if(call.status==='completed')return {status:'completed',...this.result(call)};
    let remote=(await this.request('/calls/'+encodeURIComponent(requestId),{authenticated:true})).body;
    if(remote.requestId!==requestId)throw Error('Orbio receipt does not match the original request');
    if(remote.status==='completed'){this.settle(call,remote.response,remote.chargedMicros);return {status:'completed',...this.result(call)};}
    return {requestId,status:remote.status,instructions:'Keep the same requestId and exact input. No new payment was sent. Pending outcomes need operator reconciliation.'};
  });}
  recover(requestId) {return this.exclusive(async()=>{
    this.bound(); const call=this.state.calls.find(c=>c.requestId===requestId);
    if(!call)throw Error('No original local inference to recover');
    if(call.status==='completed')return this.result(call);
    const result=(await this.request('/calls/'+encodeURIComponent(requestId)+'/recover',{body:{},authenticated:true})).body;
    if(result.requestId!==requestId || result.status!=='completed')throw Error('Original result is not ready for recovery');
    this.settle(call,result.response,result.chargedMicros); return this.result(call);
  });}
}
module.exports={PrepaidInference,DEFAULT_ORIGIN,input,micros};
