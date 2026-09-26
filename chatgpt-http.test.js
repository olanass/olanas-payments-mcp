'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startChatgptHttp } = require('./chatgpt-http');

test('recording HTTP transport discovers tools, isolates requests, rejects unauthorized access and expires', async () => {
  let now = 1000;
  const server = await startChatgptHttp({ port: 0, now: () => now, lifetimeMs: 100,
    createServer: () => {
      const mcp = new McpServer({ name: 'test', version: '1.0.0' });
      mcp.registerTool('hello', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'hello' }] }));
      return mcp;
    }
  });
  const origin = 'http://127.0.0.1:' + server.port;
  const url = new URL(origin + server.secretPath);
  const client = new Client({ name: 'recording-test', version: '1.0.0' });
  try {
    for (const route of ['/mcp', '/api/state', '/api/owner/session', '/wallet.js', '/', server.secretPath + '?extra=1', server.secretPath + '/']) {
      assert.equal((await fetch(origin + route)).status, 404);
    }
    assert.equal((await fetch(url, { headers: { origin: 'https://untrusted.example' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(url, { headers: { host: 'untrusted.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(url)).status, 405);
    const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify('x'.repeat(40000)) })).status, 413);
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['hello']);
    const responses = await Promise.all([1, 2, 3].map(() => client.callTool({ name: 'hello', arguments: {} })));
    assert.ok(responses.every(result => result.content[0].text === 'hello'));
    now = 1100;
    assert.equal((await fetch(url, { method: 'POST' })).status, 410);
  } finally { await client.close(); await server.close(); }
});
