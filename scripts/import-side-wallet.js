#!/usr/bin/env node
'use strict';
// Run in the owner's terminal, never via an agent-controlled interactive session.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { ethers } = require('ethers');

function ask(label, secret = false) {
  if (!process.stdin.isTTY) throw Error('Run this command yourself in an interactive terminal. Never send the key or password in chat.');
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    rl.on('SIGINT', () => { rl.close(); reject(Error('Import cancelled')); });
    rl.question(label + ': ', answer => { muted = false; rl.close(); if (secret) process.stdout.write('\n'); resolve(answer.trim()); });
    muted = secret;
  });
}
function protectDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw Error('Cannot identify the Windows account for private file permissions');
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true });
  }
}
function envQuote(value) {
  if (/[\r\n\0']/.test(value)) throw Error('Unsupported character in configuration value');
  return "'" + value + "'";
}
async function saveImportedWallet({ privateKey, password, directory }, protect = protectDirectory) {
  if (password.length < 16 || /[\r\n\0']/.test(password)) throw Error('Use a password of at least 16 characters without single quotes or line breaks');
  if (fs.existsSync(directory)) throw Error('Target directory already exists. Existing wallets and histories are never overwritten.');
  let wallet;
  try { wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey); }
  catch (_) { throw Error('Invalid private key. It has not been saved.'); }
  const encrypted = await wallet.encrypt(password);
  protect(directory); // Must succeed before writing secrets.
  const keystore = path.join(directory, 'wallet.json');
  fs.writeFileSync(keystore, encrypted, { flag: 'wx', mode: 0o600 });
  const values = { PAYMENTS_WALLET_PROVIDER: 'olanas', ROBINHOOD_NETWORK: 'mainnet',
    PAYMENTS_LAUNCHPAD_URL: 'https://olanas.xyz', PAYMENTS_MCP_PORT: '4782', PAYMENTS_DATA_DIR: path.join(directory, 'data'),
    OLANAS_KEYSTORE_FILE: keystore, OLANAS_ACCOUNT_ADDRESS: wallet.address, PAYMENTS_OWNER_PASSWORD: password };
  const envFile = path.join(directory, 'payments.env');
  fs.writeFileSync(envFile, Object.entries(values).map(([key, value]) => key + '=' + envQuote(value)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return { address: wallet.address, envFile };
}
async function main() {
  const directory = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Olanas', 'side-wallet-mainnet') : path.join(os.homedir(), '.local', 'share', 'olanas-side-wallet-mainnet');
  if (process.argv.includes('--help')) {
    console.log('node scripts/import-side-wallet.js\nOwner-only, hidden-input import of an existing side-wallet key. Creates a separate mainnet configuration outside the repo. No payment, MCP registration or spending session is started.'); return;
  }
  if (process.argv.length > 2) throw Error('No key or password arguments are accepted. Use the hidden interactive prompts.');
  if (fs.existsSync(directory)) throw Error('Side-wallet configuration already exists at ' + directory + '. Nothing was overwritten.');
  console.log('Import a dedicated side wallet for MAINNET. Do not use your primary wallet.\nNo payments will be made. Spending starts disabled.\nThe encrypted keystore and its unlock password are stored in a private local directory outside this repository. Your Windows account and software running as you can access them.\nDestination: ' + directory);
  let privateKey = await ask('Side-wallet private key (hidden; paste here, not in chat)', true);
  let wallet;
  try { wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey); }
  catch (_) { throw Error('Invalid private key. Nothing was saved.'); }
  console.log('Wallet address: ' + wallet.address + '\nNetwork: Robinhood mainnet (chain 4663)');
  const password = await ask('Choose local owner password (16+ characters, hidden)', true);
  if (password !== await ask('Repeat owner password', true)) throw Error('Passwords do not match. Nothing was saved.');
  if (await ask('Verify the address above. Type IMPORT MAINNET to save this wallet') !== 'IMPORT MAINNET') { console.log('Cancelled. Nothing saved.'); return; }
  const result = await saveImportedWallet({ privateKey, password, directory }); privateKey = ''; wallet = null;
  const runtime = path.resolve(__dirname, '..', 'dist', 'bundle.js');
  console.log('Imported wallet: ' + result.address + '\nNo funds moved. Spending disabled.\nLaunch the local wallet from this folder:\nnode --env-file="' + result.envFile + '" "' + runtime + '" --wallet-only\nFor your MCP client, use the same command without --wallet-only. Keep the existing installation until outstanding payments are resolved.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { saveImportedWallet, envQuote };
