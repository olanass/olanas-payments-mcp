#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'server.js')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: false,
  sourcemap: false
});

for (const file of ['wallet.html', 'wallet.js', 'wallet.css']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}
fs.copyFileSync(path.join(root, 'node_modules', 'ethers', 'dist', 'ethers.umd.min.js'), path.join(out, 'ethers.js'));
console.log('Built Olanas Payments MCP package in ' + out);
