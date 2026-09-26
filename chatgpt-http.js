'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

// Personal recording transport. The random URL is a bearer credential, not OAuth.
// This listener deliberately has no companion UI or owner-control routes.
async function startChatgptHttp({ createServer, port = 4784, now = Date.now, lifetimeMs = 2 * 60 * 60 * 1000 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid ChatGPT MCP port');
  const secretPath = '/mcp/' + crypto.randomBytes(32).toString('hex');
  const expiresAt = now() + lifetimeMs;
  const active = new Set();
  const app = express();
  app.disable('x-powered-by');
  let listener;
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (req.get('host') !== '127.0.0.1:' + listener.address().port || req.get('origin')) return res.sendStatus(403);
    // Exact comparison also rejects query strings and trailing paths.
    const actual = Buffer.from(req.originalUrl), expected = Buffer.from(secretPath);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.sendStatus(404);
    if (now() >= expiresAt) return res.status(410).json({ error: 'Recording connection expired. Restart and reconnect.' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.post(secretPath, async (req, res) => {
    if (active.size >= 16) return res.sendStatus(429);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    active.add(server);
    res.on('close', () => { active.delete(server); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (_) {
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
      else res.end();
    }
  });
  app.all(secretPath, (req, res) => res.set('Allow', 'POST').sendStatus(405));
  app.use((err, req, res, next) => res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body' }));
  listener = await new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
  const address = listener.address();
  return {
    port: address.port, secretPath, expiresAt,
    close: async () => {
      listener.close();
      listener.closeAllConnections();
      await Promise.allSettled([...active].map(server => server.close()));
    }
  };
}
module.exports = { startChatgptHttp };
