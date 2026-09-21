#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = process.env.OLANAS_LAUNCHPAD_SOURCE ? path.resolve(process.env.OLANAS_LAUNCHPAD_SOURCE) :
  (fs.existsSync(path.join(__dirname, '..', 'src', 'server', 'config', 'chain.js')) ? path.resolve(__dirname, '..') : path.join(__dirname, '.main-worktree'));
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });

async function build() {
await esbuild.build({
  entryPoints: [path.join(__dirname, 'server.js')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: false,
  sourcemap: false,
  plugins: [{ name: 'launchpad-source', setup(build) {
    build.onResolve({ filter: /^\.\.\/src\/server\// }, args => ({ path: require.resolve(path.join(root, args.path.slice(3))) }));
  } }]
});

for (const file of ['wallet.html', 'wallet.js', 'wallet.css', 'session-presets.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}
fs.copyFileSync(path.join(path.dirname(require.resolve('ethers')), '..', 'dist', 'ethers.umd.min.js'), path.join(out, 'ethers.js'));
console.log('Built Olanas Payments MCP package in ' + out);
}
build().catch(error => { console.error(error); process.exitCode = 1; });
