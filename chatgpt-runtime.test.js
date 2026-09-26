'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { parseArgs } = require('./cli');

test('CLI requires explicit chatgpt command for payment flag', () => {
  assert.equal(parseArgs(['chatgpt']).allowPayments, undefined);
  assert.equal(parseArgs(['chatgpt', '--allow-payments']).allowPayments, true);
  assert.throws(() => parseArgs(['install', '--allow-payments']), /requires the chatgpt command/);
  assert.equal(parseArgs(['chatgpt','--read-only']).readOnly,true);
  assert.throws(()=>parseArgs(['chatgpt','--read-only','--allow-payments']),/Choose/);
});

for (const allowPayments of [false, true]) {
  test('packaged ChatGPT mode: payment tools ' + (allowPayments ? 'enabled' : 'disabled'), { timeout: 20000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'olanas-chatgpt-test-'));
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { PAYMENTS_DATA_DIR: directory, PAYMENTS_MCP_PORT: '0', PAYMENTS_CHATGPT_PORT: '0',
      PAYMENTS_WALLET_PROVIDER: 'browser', ROBINHOOD_NETWORK: 'mainnet', X402_DEMO_MODE: 'false' });
    const child = spawn(process.execPath, [path.join(__dirname, 'dist', 'bundle.js'), '--chatgpt', ...(allowPayments ? [] : ['--read-only'])],
      { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const client = new Client({ name: 'packaged-chatgpt-test', version: '1.0.0' });
    let output = '';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Recording listener did not start')), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Recording process exited before connection')); });
        child.stderr.on('data', data => {
          output += data.toString();
          if (output.includes('Private MCP URL:')) { clearTimeout(timer); resolve(); }
        });
      });
      const port = output.match(/ngrok http http:\/\/127\.0\.0\.1:(\d+)/)[1];
      const secretPath = output.match(/https:\/\/YOUR-NGROK-HOST(\/mcp\/[a-f0-9]{64})/)[1];
      const companion = new URL(output.match(/companion: (http:\/\/\S+)/)[1]);
      await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + secretPath)));
      const tools = (await client.listTools()).tools;
      assert.equal(tools.some(t => t.name === 'request_paid_api'), allowPayments);
      assert.equal(tools.some(t => t.name === 'reconcile_order'), allowPayments);
      assert.equal(tools.some(t => t.name === 'use_ai_model'), allowPayments);
      assert.equal(tools.some(t => t.name === 'credit_ai_deposit'), allowPayments);
      assert.equal(tools.some(t => t.name === 'recover_ai_inference'), allowPayments);
      for(const name of ['search_services','list_ai_models','get_ai_balance','quote_ai_model','get_inference_receipt'])assert.ok(tools.some(t=>t.name===name));
      const inference = await client.callTool({name:'get_ai_balance',arguments:{}});
      assert.equal(inference.isError,true);
      assert.match(inference.content[0].text,/local Olanas wallet/);
      assert.equal((await fetch(companion.origin+'/api/inference/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
      assert.equal(tools.some(t => /owner|withdraw|session/.test(t.name)), false);
      for (const name of ['show_wallet', 'get_funding_details']) {
        const result = await client.callTool({ name, arguments: {} });
        assert.equal(result.isError, undefined);
        assert.equal(result.content[0].text.includes(companion.hash.slice(1)), false);
        assert.equal(JSON.parse(result.content[0].text).walletUrl, undefined);
      }
      if (!allowPayments) {
        // Bypass discovery and attempt a direct write call: it must still fail.
        const result = await client.callTool({ name: 'request_paid_api', arguments: { slug: 'test', requestId: 'test-request' } });
        assert.equal(result.isError, true);
      }
      assert.equal((await fetch('http://127.0.0.1:' + port + '/api/state')).status, 404);
      assert.equal((await fetch(companion.origin + '/api/state')).status, 401);
    } finally {
      await client.close();
      if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
