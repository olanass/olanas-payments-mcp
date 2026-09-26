'use strict';
// Live, non-spending smoke check of the shipped ChatGPT MCP. No real wallet is loaded.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
async function main(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'olanas-integrations-'));
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{PAYMENTS_DATA_DIR:dir,PAYMENTS_MCP_PORT:'0',PAYMENTS_CHATGPT_PORT:'0',PAYMENTS_WALLET_PROVIDER:'browser',ROBINHOOD_NETWORK:'mainnet',X402_DEMO_MODE:'false'});
  const child=spawn(process.execPath,[path.resolve(__dirname,'../dist/bundle.js'),'--chatgpt'],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});
  let output='',id=0;
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('MCP startup timed out')),10000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('MCP exited before startup'));});
      child.stderr.on('data',chunk=>{output+=chunk.toString();if(output.includes('Private MCP URL:')){clearTimeout(timer);resolve();}});
    });
    const port=output.match(/ngrok http http:\/\/127\.0\.0\.1:(\d+)/)[1];
    const secretPath=output.match(/https:\/\/YOUR-NGROK-HOST(\/mcp\/[a-f0-9]{64})/)[1];
    async function rpc(method,params){
      const res=await fetch('http://127.0.0.1:'+port+secretPath,{method:'POST',signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
      assert.equal(res.status,200);const data=await res.json();assert.equal(data.error,undefined);return data.result;
    }
    async function tool(name,args={}){const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.isError,name+' failed');return JSON.parse(r.content[0].text);}
    await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'olanas-integration-check',version:'1.0.0'}});
    const listed=await rpc('tools/list',{});
    for(const name of ['request_paid_api','use_ai_model','quote_ai_model','recover_ai_inference'])assert.ok(listed.tools.some(t=>t.name===name));
    console.log('PASS: one MCP exposes fixed-price and prepaid payment tools by default');
    const services=await tool('search_services');
    for(const slug of ['olanas-onchain-explainer','startup-pitch-scorer'])assert.ok(services.services.some(s=>s.slug===slug));
    assert.ok(services.integrations.some(s=>s.name==='Orbio Inference'));
    console.log('PASS: Onchain Explainer, Startup Pitch Scorer and Orbio discovery');
    const models=await tool('list_ai_models');assert.ok(models.data.length);
    const input={model:models.data[0].id,messages:[{role:'user',content:'Say hello.'}],max_tokens:16};
    const quote=await tool('quote_ai_model',input);assert.equal(quote.currency,'USDG');
    console.log('PASS: live Orbio quote ('+quote.maximumMicros+' USDG micros reserved maximum; no inference run)');
    const denied=await rpc('tools/call',{name:'use_ai_model',arguments:{...input,requestId:'unapproved-smoke-check'}});
    assert.equal(denied.isError,true);assert.match(denied.content[0].text,/Connect this wallet/);
    console.log('PASS: unapproved inference rejected locally; no funds spent');
    for(const endpoint of ['/calls/unapproved-smoke-check','/calls/unapproved-smoke-check/recover']){
      const response=await fetch('https://orbio-inference.vercel.app/api/inference/prepaid'+endpoint,{method:endpoint.endsWith('/recover')?'POST':'GET',signal:AbortSignal.timeout(15000)});
      assert.equal(response.status,401);
    }
    console.log('PASS: live receipt endpoints require authenticated account access');
  }finally{
    if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()))throw Error('Unexpected temporary directory');
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
