#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { spawnSync } = require('node:child_process');
const { Writable } = require('node:stream');
const readline = require('node:readline');
const { ethers } = require('ethers');
const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.local', 'payments.env');
const defaultKeystoreFile = path.join(root, '.local', 'olanas-wallet.json');

function encode(value) {
  value = String(value);
  if (value.includes(String.fromCharCode(0))) throw new Error('Invalid environment value');
  const quote = [String.fromCharCode(39), String.fromCharCode(34)].find(q => !value.includes(q));
  if (!quote) throw new Error('Value contains unsupported quote combinations');
  return quote + value + quote;
}

function save(file, original, updates) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = original + '\n# Olanas setup configuration\n' +
    Object.entries(updates).map(([k, v]) => k + '=' + encode(v)).join('\n') + '\n';
  const temporary = file + '.setup-tmp';
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function saveKeystore(file, encrypted) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.setup-tmp';
  fs.writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function ask(label, secret = false) {
  if (!process.stdin.isTTY) throw new Error('Run setup in your own interactive terminal; never paste wallet passwords into agent chat.');
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({ write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    rl.on('SIGINT', () => { rl.close(); reject(new Error('Setup cancelled')); });
    rl.question(label + ': ', answer => {
      muted = false;
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = secret;
  });
}

function validateConfig(env) {
  if (!['mainnet', 'testnet'].includes(env.ROBINHOOD_NETWORK)) throw new Error('Choose mainnet or testnet');
  if (!env.PAYMENTS_OWNER_PASSWORD || env.PAYMENTS_OWNER_PASSWORD.length < 16) throw new Error('Owner password must be at least 16 characters');
  if (!path.isAbsolute(env.OLANAS_KEYSTORE_FILE || '')) throw new Error('Olanas keystore path must be absolute');
  const url = new URL(env.PAYMENTS_LAUNCHPAD_URL);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Launchpad must be an HTTPS origin (HTTP allowed only on localhost)');
  }
}

async function provision(env, walletFactory = () => ethers.Wallet.createRandom()) {
  validateConfig(env);
  let wallet;
  if (fs.existsSync(env.OLANAS_KEYSTORE_FILE)) {
    wallet = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(env.OLANAS_KEYSTORE_FILE, 'utf8'), env.PAYMENTS_OWNER_PASSWORD);
  } else {
    wallet = walletFactory();
    const encrypted = await wallet.encrypt(env.PAYMENTS_OWNER_PASSWORD);
    saveKeystore(env.OLANAS_KEYSTORE_FILE, encrypted);
  }
  const address = ethers.getAddress(wallet.address);
  if (env.OLANAS_ACCOUNT_ADDRESS && address !== ethers.getAddress(env.OLANAS_ACCOUNT_ADDRESS)) throw new Error('Olanas wallet address mismatch');
  return address;
}

function registrationArgs(file = envFile) {
  return ['mcp', 'add', 'olanas-payments', '--', process.execPath,
    '--env-file=' + file, path.join(__dirname, 'server.js')];
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('npm run payments:setup\nInteractive native Olanas wallet + Codex MCP setup. Creates an encrypted local keystore. No transfer or spending session is started. Requires Node 22 and Codex CLI.');
    return;
  }
  const codex = process.env.OLANAS_CODEX_BIN || 'codex';
  const available = spawnSync(codex, ['mcp', 'add', '--help'], { encoding: 'utf8', windowsHide: true });
  if (available.error || available.status !== 0) throw new Error('Codex CLI not found. Install it or set OLANAS_CODEX_BIN to the absolute codex.exe path, then retry.');
  console.log('Native Olanas wallet setup. The private key is generated locally and stored only in an encrypted keystore.\nNo funds are moved and no spending session is enabled.');
  const original = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const env = parseEnv(original);
  if (!env.PAYMENTS_OWNER_PASSWORD) {
    env.PAYMENTS_OWNER_PASSWORD = await ask('Choose wallet/owner password (16+ characters)', true);
    if (env.PAYMENTS_OWNER_PASSWORD !== await ask('Repeat wallet/owner password', true)) throw new Error('Passwords do not match');
  }
  env.ROBINHOOD_NETWORK ||= (await ask('Robinhood network [testnet / mainnet; default testnet]')) || 'testnet';
  env.PAYMENTS_LAUNCHPAD_URL ||= (await ask(env.ROBINHOOD_NETWORK === 'testnet'
    ? 'Your TESTNET launchpad origin (required)' : 'Launchpad origin [https://olanas.xyz]')) ||
    (env.ROBINHOOD_NETWORK === 'mainnet' ? 'https://olanas.xyz' : '');
  env.OLANAS_KEYSTORE_FILE ||= defaultKeystoreFile;
  env.PAYMENTS_WALLET_PROVIDER = 'olanas';
  env.PAYMENTS_MCP_PORT ||= '4782';
  validateConfig(env);
  console.log('Network: ' + env.ROBINHOOD_NETWORK + '\nLaunchpad: ' + env.PAYMENTS_LAUNCHPAD_URL +
    '\nKeystore: ' + env.OLANAS_KEYSTORE_FILE);
  if ((await ask('Create/reuse the native Olanas wallet and register olanas-payments in Codex? [yes/no]')).toLowerCase() !== 'yes') {
    console.log('Cancelled. No wallet or configuration changes made.'); return;
  }
  let address;
  try { address = await provision(env); }
  catch (error) { throw new Error('Wallet setup failed: ' + error.message + '. No transfer was attempted.'); }
  env.OLANAS_ACCOUNT_ADDRESS = address;
  const previous = parseEnv(original);
  const updates = Object.fromEntries(Object.entries(env).filter(([k, v]) => previous[k] !== v));
  if (Object.keys(updates).length) save(envFile, original, updates);
  const registered = spawnSync(codex, registrationArgs(), { encoding: 'utf8', windowsHide: true });
  if (registered.error || registered.status !== 0) throw new Error('Wallet configuration saved, but Codex registration failed. Rerun setup; the same wallet will be reused.');
  console.log('Setup complete. Wallet: ' + address + '\nRestart Codex, then ask: Show my Olanas wallet.\nFund only on Robinhood ' + env.ROBINHOOD_NETWORK + ', keep ETH for gas, then enable your spending budget in the wallet.\nNo payment has been made.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { encode, save, saveKeystore, validateConfig, provision, registrationArgs, defaultKeystoreFile };
