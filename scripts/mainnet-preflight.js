#!/usr/bin/env node
'use strict';
// Read-only checks: no key decryption, signing, order creation, or broadcasting.
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const ORIGIN = 'https://olanas.xyz';
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
function requireCheck(ok, message) { if (!ok) throw Error(message); }
function checkConfig(env, exists = fs.existsSync) {
  requireCheck(env.PAYMENTS_WALLET_PROVIDER === 'olanas', 'Configure the native side wallet; browser mode is not autonomous.');
  requireCheck(env.ROBINHOOD_NETWORK === 'mainnet', 'ROBINHOOD_NETWORK must explicitly be mainnet.');
  requireCheck(env.PAYMENTS_LAUNCHPAD_URL === ORIGIN, 'Launchpad must be https://olanas.xyz.');
  requireCheck(env.X402_DEMO_MODE !== 'true', 'Demo mode must be disabled.');
  requireCheck(ethers.isAddress(env.OLANAS_ACCOUNT_ADDRESS || ''), 'Side-wallet public address is missing.');
  requireCheck(env.OLANAS_KEYSTORE_FILE && exists(env.OLANAS_KEYSTORE_FILE), 'Encrypted side-wallet keystore is missing.');
  requireCheck((env.PAYMENTS_OWNER_PASSWORD || '').length >= 16, 'Owner password configuration is missing. Never paste it in chat.');
}
function checkDeployment(version, network, service) {
  requireCheck(version.purchaseFlow === 'durable-orders-v1', 'Production durable-order backend is not deployed.');
  requireCheck(network.chainId === 4663 && network.testnet === false, 'Production backend is not on Robinhood mainnet.');
  const token = network.tokens?.find(t => t.symbol === 'USDG');
  requireCheck(token?.decimals === 6 && token.address?.toLowerCase() === USDG.toLowerCase(), 'Production USDG asset mismatch.');
  requireCheck(service?.slug === 'startup-pitch-scorer' && service.status === 'live' && service.chainId === 4663 &&
    service.currency === 'USDG' && service.allowedMethods?.includes('POST'), 'Startup Pitch Scorer is not available for mainnet POST payments.');
  requireCheck(ethers.parseUnits(String(service.price), 6) > 0n, 'Service price must be positive.');
  requireCheck(ethers.isAddress(service.payoutAddress || '') && service.payoutAddress !== ethers.ZeroAddress, 'Service payment recipient is invalid.');
}
async function main() {
  const publicOnly = process.argv.includes('--public');
  requireCheck(process.argv.slice(2).every(arg => arg === '--public'), 'Usage: node scripts/mainnet-preflight.js [--public]');
  if (!publicOnly) checkConfig(process.env);
  for (const file of ['wallet.html', 'wallet.js', 'wallet.css', 'session-presets.js']) {
    requireCheck(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') === fs.readFileSync(path.join(__dirname, '..', 'dist', file), 'utf8'), 'Rebuild the wallet package: stale ' + file);
  }
  const get = async route => {
    const response = await fetch(ORIGIN + route, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    requireCheck(response.ok, 'Production endpoint ' + route + ' returned HTTP ' + response.status);
    return response.json();
  };
  const [version, network, { service }] = await Promise.all([
    get('/api/version'), get('/api/orders/network'), get('/api/services/startup-pitch-scorer')]);
  checkDeployment(version, network, service);
  console.log('PASS: Production durable orders, mainnet chain 4663, and wallet UI assets.');
  console.log('Service: ' + service.name + ' / POST / ' + service.price + ' USDG');
  console.log('Recipient: ' + service.payoutAddress);
  const request = new ethers.FetchRequest(process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_RPC_URL || RPC);
  request.timeout = 12000;
  const provider = new ethers.JsonRpcProvider(request, 4663, { staticNetwork: true });
  try {
    requireCheck(Number(BigInt(await provider.send('eth_chainId', []))) === 4663, 'RPC chain mismatch.');
    requireCheck(await provider.getCode(USDG) !== '0x', 'USDG contract is not deployed at the expected address.');
    const token = new ethers.Contract(USDG, ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)'], provider);
    requireCheck(Number(await token.decimals()) === 6, 'USDG on-chain decimals mismatch.');
    console.log('PASS: Live mainnet RPC and USDG contract.');
    if (publicOnly) {
      console.log('PUBLIC CHECK ONLY: side-wallet import, balance, unlock, and MCP configuration are not verified.');
    } else {
      const address = ethers.getAddress(process.env.OLANAS_ACCOUNT_ADDRESS);
      const keyMetadata = JSON.parse(fs.readFileSync(process.env.OLANAS_KEYSTORE_FILE, 'utf8'));
      requireCheck(keyMetadata.address?.replace(/^0x/, '').toLowerCase() === address.slice(2).toLowerCase(), 'Keystore/public address mismatch.');
      const [eth, usdg] = await Promise.all([provider.getBalance(address), token.balanceOf(address)]);
      console.log('Side wallet: ' + address);
      console.log('Balance: ' + ethers.formatEther(eth) + ' ETH / ' + ethers.formatUnits(usdg, 6) + ' USDG');
      requireCheck(usdg >= ethers.parseUnits(String(service.price), 6), 'Insufficient USDG for one listed API call.');
      requireCheck(eth >= ethers.parseEther('0.00001'), 'ETH is below the configured per-call gas ceiling.');
      console.log('PASS: Configured mainnet side wallet has funds for one listed call plus the gas ceiling.');
      console.log('Unlock and MCP startup still need verification. Live gas estimation occurs before signing.');
    }
    console.log('No session enabled, order created, transaction signed, or funds moved.');
  } finally { provider.destroy(); }
}
if (require.main === module) main().catch(error => { console.error('NOT READY: ' + error.message); process.exitCode = 1; });
module.exports = { checkConfig, checkDeployment };
