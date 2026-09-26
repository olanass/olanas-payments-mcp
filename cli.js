#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { parseEnv } = require('node:util');
const { Wallet } = require('ethers');
const pkg = require('./package.json');

const installDir = path.resolve(process.env.OLANAS_INSTALL_DIR || path.join(os.homedir(), '.olanas-payments-mcp'));
const runtimeDir = path.join(installDir, 'runtime');
const envFile = path.join(installDir, 'payments.env');
const walletFile = path.join(installDir, 'wallet.json');
const ownerFile = path.join(installDir, 'owner-password.txt');
const manifestFile = path.join(installDir, 'install.json');
const clients = ['claude', 'claude-code', 'codex', 'gemini', 'other'];

function log(message = '') { process.stdout.write(message + '\n'); }
function verbose(options, message) { if (options.verbose) log('[verbose] ' + message); }
function quoteEnv(value) { return String.fromCharCode(39) + String(value).replaceAll(String.fromCharCode(39), '') + String.fromCharCode(39); }
function writePrivate(file, content) { fs.writeFileSync(file, content, { mode: 0o600 }); }
function commandExists(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}
function parseArgs(argv) {
  const options = { command: 'install', autoConfig: null, verbose: false, force: false, client: null, network: 'mainnet',
    launchpad: 'https://olanas.xyz', networkProvided: false, launchpadProvided: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith('-')) { options.command = argv[0]; index++; }
  for (; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--auto-config') options.autoConfig = true;
    else if (value === '--allow-payments') options.allowPayments = true;
    else if (value === '--read-only') options.readOnly = true;
    else if (value === '--no-auto-config') options.autoConfig = false;
    else if (value === '--verbose' || value === '-v') options.verbose = true;
    else if (value === '--force' || value === '-f') options.force = true;
    else if (value === '--help' || value === '-h') options.command = 'help';
    else if (value === '--client' || value === '-c') options.client = argv[++index];
    else if (value === '--wallet') {
      options.wallet = argv[++index];
      if (!['new', 'import'].includes(options.wallet)) throw new Error('--wallet must be new or import');
    }
    else if (value === '--network') { options.network = argv[++index]; options.networkProvided = true; }
    else if (value === '--launchpad') { options.launchpad = argv[++index]; options.launchpadProvided = true; }
    else throw new Error('Unknown option: ' + value);
  }
  if (options.client && !clients.includes(options.client)) throw new Error('Client must be one of: ' + clients.join(', '));
  if (options.wallet && options.command !== 'install') throw new Error('--wallet requires the install command');
  if (options.allowPayments && options.command !== 'chatgpt') throw new Error('--allow-payments requires the chatgpt command');
  if (options.readOnly && options.command !== 'chatgpt') throw new Error('--read-only requires the chatgpt command');
  if (options.readOnly && options.allowPayments) throw new Error('Choose --read-only or --allow-payments');
  if (!['mainnet', 'testnet'].includes(options.network)) throw new Error('Network must be mainnet or testnet');
  const origin = new URL(options.launchpad);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Launchpad must be an origin without a path');
  return options;
}
function ask(question, secret = false, input = process.stdin, destination = process.stdout) {
  if (!input.isTTY) throw new Error('Run interactive setup in your own terminal. For unattended setup, use --wallet new, --client and --auto-config or --no-auto-config.');
  return new Promise((resolve, reject) => {
    let muted = false, settled = false;
    const output = new Writable({ write(chunk, encoding, done) {
      if (!muted) destination.write(chunk, encoding);
      done();
    } });
    const rl = readline.createInterface({ input, output, terminal: true, historySize: 0 });
    rl.on('close', () => {
      if (secret) destination.write('\n');
      if (!settled) reject(new Error('Setup cancelled.'));
    });
    rl.on('SIGINT', () => rl.close());
    rl.question(question, answer => {
      settled = true;
      rl.close();
      resolve(secret ? answer : answer.trim());
    });
    muted = secret;
  });
}
function protectDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new Error('Cannot identify the Windows account for private file permissions');
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true });
  } else fs.chmodSync(directory, 0o700);
}

function serverDefinition() {
  return { command: process.execPath, args: ['--env-file=' + envFile, path.join(runtimeDir, 'bundle.js')] };
}
function manualConfig() {
  log('\nAdd this MCP server configuration:');
  log(JSON.stringify({ mcpServers: { 'olanas-payments': serverDefinition() } }, null, 2));
}
function mergeJsonConfig(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let config = {};
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw new Error('Cannot safely update invalid JSON config: ' + file); }
  }
  config.mcpServers ||= {};
  config.mcpServers['olanas-payments'] = serverDefinition();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}
function configureClient(client, options) {
  verbose(options, 'Configuring MCP client: ' + client);
  if (client === 'other') { manualConfig(); return false; }
  if (client === 'claude') {
    const file = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    mergeJsonConfig(file); log('Configured Claude Desktop: ' + file); return true;
  }
  if (client === 'gemini') {
    const file = path.join(os.homedir(), '.gemini', 'settings.json');
    mergeJsonConfig(file); log('Configured Gemini CLI: ' + file); return true;
  }
  const command = client === 'codex' ? 'codex' : 'claude';
  if (!commandExists(command)) {
    log(command + ' CLI was not found. Installation completed; use the manual configuration below.');
    manualConfig(); return false;
  }
  const definition = serverDefinition();
  const removeArgs = client === 'codex' ? ['mcp', 'remove', 'olanas-payments'] : ['mcp', 'remove', '--scope', 'user', 'olanas-payments'];
  spawnSync(command, removeArgs, { encoding: 'utf8', windowsHide: true });
  const args = client === 'codex'
    ? ['mcp', 'add', 'olanas-payments', '--', definition.command, ...definition.args]
    : ['mcp', 'add', '--scope', 'user', 'olanas-payments', '--', definition.command, ...definition.args];
  const configured = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (configured.error || configured.status !== 0) {
    log('Automatic configuration failed. Installation completed; use the manual configuration below.');
    if (options.verbose) log((configured.stderr || configured.error?.message || '').trim());
    manualConfig(); return false;
  }
  log('Configured ' + (client === 'codex' ? 'Codex CLI' : 'Claude Code') + '.');
  return true;
}

async function selectClient(options) {
  if (options.client) return options.client;
  log('Select your MCP client:');
  log('  1) Claude - Claude Desktop application');
  log('  2) Claude Code - Claude Code CLI');
  log('  3) Codex - OpenAI Codex CLI');
  log('  4) Gemini - Google Gemini CLI');
  log('  5) Other - Other MCP-compatible tools');
  const answer = await ask('Client [3]: ');
  return ({ '': 'codex', '1': 'claude', '2': 'claude-code', '3': 'codex', '4': 'gemini', '5': 'other' })[answer] || answer;
}
function configText(values) {
  return Object.entries(values).map(([key, value]) => key + '=' + quoteEnv(value)).join('\n') + '\n';
}
async function createOrLoadWallet(options, { directory = installDir, prompt = ask, interactive = !!process.stdin.isTTY, protect = protectDirectory } = {}) {
  const walletFile = path.join(directory, 'wallet.json');
  const envFile = path.join(directory, 'payments.env');
  const ownerFile = path.join(directory, 'owner-password.txt');
  const hasWallet = fs.existsSync(walletFile);
  const hasEnv = fs.existsSync(envFile);
  if (hasWallet !== hasEnv) throw new Error('Incomplete existing wallet installation. Restore the missing wallet/config file before reinstalling.');
  if (hasWallet) {
    if (options.wallet === 'import') throw new Error('An installed wallet already exists. To import another wallet, set OLANAS_INSTALL_DIR to a different, empty directory. The existing wallet was not changed.');
    const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
    const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(walletFile, 'utf8'), env.PAYMENTS_OWNER_PASSWORD);
    return { wallet, password: env.PAYMENTS_OWNER_PASSWORD, env };
  }
  let choice = options.wallet;
  if (!choice && interactive) {
    const answer = await prompt('Wallet: [1] Create a new wallet, [2] Import a private key [1]: ');
    if (!['', '1', '2'].includes(answer)) throw new Error('Choose wallet option 1 or 2.');
    choice = answer === '2' ? 'import' : 'new';
  }
  let wallet;
  if (choice === 'import') {
    if (!interactive) throw new Error('Private-key import requires your own interactive terminal. Never pass the key as a command argument or in chat.');
    let privateKey = await prompt('Wallet private key (hidden; paste here, not in chat): ', true);
    try {
      const normalized = privateKey.trim().replace(/^0x/i, '');
      if (!/^[a-fA-F0-9]{64}$/.test(normalized)) throw new Error();
      wallet = new Wallet('0x' + normalized);
    } catch (_) { throw new Error('Invalid private key. Nothing was saved.'); }
    finally { privateKey = ''; }
    const confirmation = await prompt('Import wallet ' + wallet.address + '? Type IMPORT to confirm: ');
    if (confirmation !== 'IMPORT') throw new Error('Import cancelled. Nothing was saved.');
  } else wallet = Wallet.createRandom();
  let password;
  if (interactive) {
    password = await prompt('Choose owner password (16+ characters, hidden): ', true);
    if (password.length < 16 || /[\r\n\0']/.test(password)) {
      throw new Error('Use an owner password of at least 16 characters without single quotes or line breaks. Nothing was saved.');
    }
    if (password !== await prompt('Confirm owner password (hidden): ', true)) {
      throw new Error('Passwords do not match. Nothing was saved.');
    }
  } else password = crypto.randomBytes(24).toString('base64url');
  const encrypted = await wallet.encrypt(password);
  protect(directory);
  writePrivate(walletFile, encrypted);
  writePrivate(ownerFile, password + '\n');
  verbose(options, choice === 'import' ? 'Imported wallet into an encrypted local keystore.' : 'Created a new encrypted local wallet.');
  return { wallet, password, env: {} };
}
async function install(options) {
  const sourceRuntime = path.join(__dirname, 'dist');
  if (!fs.existsSync(path.join(sourceRuntime, 'bundle.js'))) throw new Error('Package runtime is missing. Reinstall with --force.');
  const saved = await createOrLoadWallet(options);
  if (fs.existsSync(manifestFile) && !options.force) log('Updating the existing installation and preserving its wallet.');
  const network = options.networkProvided ? options.network : (saved.env.ROBINHOOD_NETWORK || options.network);
  const launchpad = options.launchpadProvided ? options.launchpad : (saved.env.PAYMENTS_LAUNCHPAD_URL || options.launchpad);
  const values = { PAYMENTS_WALLET_PROVIDER: 'olanas', OLANAS_KEYSTORE_FILE: walletFile,
    OLANAS_ACCOUNT_ADDRESS: saved.wallet.address, PAYMENTS_OWNER_PASSWORD: saved.password,
    ROBINHOOD_NETWORK: network, PAYMENTS_LAUNCHPAD_URL: launchpad, PAYMENTS_MCP_PORT: '0',
    PAYMENTS_DATA_DIR: path.join(installDir, 'data') };
  writePrivate(envFile, configText(values));
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.cpSync(sourceRuntime, runtimeDir, { recursive: true });
  const client = await selectClient(options);
  if (!clients.includes(client)) throw new Error('Unknown MCP client: ' + client);
  let autoConfig = options.autoConfig;
  if (autoConfig == null) autoConfig = (await ask('Configure ' + client + ' automatically? [Y/n]: ')).toLowerCase() !== 'n';
  const configured = autoConfig ? configureClient(client, options) : (manualConfig(), false);
  writePrivate(manifestFile, JSON.stringify({ version: pkg.version, client, configured, address: saved.wallet.address,
    network, installedAt: new Date().toISOString() }, null, 2) + '\n');
  log('\nOlanas Payments MCP installed.');
  log('Wallet: ' + saved.wallet.address);
  log('Network: ' + network);
  log('Owner password file: ' + ownerFile);
  log('Restart your MCP client, then ask: Show my Olanas wallet.');
  log('No funds were moved and autonomous spending is disabled.');
}

function status() {
  if (!fs.existsSync(manifestFile) || !fs.existsSync(path.join(runtimeDir, 'bundle.js'))) {
    log('Olanas Payments MCP is not installed.');
    if (fs.existsSync(walletFile)) log('A preserved wallet exists at: ' + walletFile);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  log('Olanas Payments MCP ' + manifest.version + ' is installed.');
  log('Client: ' + manifest.client + (manifest.configured ? ' (configured)' : ' (manual configuration)'));
  log('Wallet: ' + manifest.address);
  log('Network: ' + manifest.network);
  log('Directory: ' + installDir);
}
function removeJsonEntry(file) {
  if (!fs.existsSync(file)) return;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.mcpServers?.['olanas-payments']) return;
  delete config.mcpServers['olanas-payments'];
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}
function uninstall(options) {
  let manifest = {};
  if (fs.existsSync(manifestFile)) manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const client = manifest.client;
  if (manifest.configured && client === 'codex' && commandExists('codex')) spawnSync('codex', ['mcp', 'remove', 'olanas-payments'], { windowsHide: true });
  if (manifest.configured && client === 'claude-code' && commandExists('claude')) spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'olanas-payments'], { windowsHide: true });
  if (manifest.configured && client === 'claude') {
    const file = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    removeJsonEntry(file);
  }
  if (manifest.configured && client === 'gemini') removeJsonEntry(path.join(os.homedir(), '.gemini', 'settings.json'));
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(manifestFile, { force: true });
  log('Olanas Payments MCP runtime and client configuration were removed.');
  if (fs.existsSync(walletFile)) {
    log('Your wallet, password, and payment history were preserved at: ' + installDir);
    log('Reinstall to use the same wallet again.');
  }
  verbose(options, 'Uninstall never deletes wallet keys or funds.');
}
function help() {
  log('Olanas Payments MCP ' + pkg.version);
  log('');
  log('Usage:');
  log('  npx olanas-payments-mcp');
  log('  npx olanas-payments-mcp install [options]');
  log('  npx olanas-payments-mcp status');
  log('  npx olanas-payments-mcp chatgpt [--read-only]');
  log('  npx olanas-payments-mcp uninstall');
  log('');
  log('Options:');
  log('  --client, -c <client>   claude, claude-code, codex, gemini, other');
  log('  --wallet <mode>        new or import (hidden private-key prompt; fresh install only)');
  log('  --auto-config          Configure the selected MCP client automatically');
  log('  --no-auto-config       Print manual configuration instead');
  log('  --network <network>    mainnet or testnet (default: mainnet)');
  log('  --launchpad <origin>   Launchpad origin (default: https://olanas.xyz)');
  log('  --force, -f            Reinstall runtime files while preserving the wallet');
  log('  --verbose, -v          Show detailed output');
  log('  --help, -h             Show help');
}

async function chatgpt(options) {
  if (!fs.existsSync(envFile)) throw new Error('Install Olanas first: node cli.js install --client other --no-auto-config');
  const bundle = path.join(__dirname, 'dist', 'bundle.js');
  if (!fs.existsSync(bundle)) throw new Error('Packaged runtime is missing; build the package first');
  log('Starting a two-hour agent connection. Stop any other Olanas MCP using this wallet first.');
  const args = ['--env-file=' + envFile, bundle, '--chatgpt'];
  if (options.allowPayments) args.push('--allow-payments');
  if (options.readOnly) args.push('--read-only');
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  const stop = () => child.kill();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { process.exitCode = code ?? 1; resolve(); });
  }).finally(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') return help();
  if (options.command === 'status') return status();
  if (options.command === 'chatgpt') return chatgpt(options);
  if (options.command === 'uninstall') return uninstall(options);
  if (options.command !== 'install') throw new Error('Unknown command: ' + options.command);
  await install(options);
}
if (require.main === module) main().catch(error => { console.error('Error: ' + error.message); process.exitCode = 1; });
module.exports = { parseArgs, serverDefinition, configText, install, status, uninstall, ask, createOrLoadWallet };
