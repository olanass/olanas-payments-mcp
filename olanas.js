'use strict';
const fs = require('node:fs');
const { ethers } = require('ethers');

async function loadSigningWallet(env = process.env) {
  const file = env.OLANAS_KEYSTORE_FILE;
  const password = env.PAYMENTS_OWNER_PASSWORD;
  if (!file) throw new Error('OLANAS_KEYSTORE_FILE is required for Olanas wallet mode');
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error('PAYMENTS_OWNER_PASSWORD must contain at least 16 characters');
  }
  let encrypted;
  try { encrypted = fs.readFileSync(file, 'utf8'); }
  catch (_) { throw new Error('Cannot read the configured Olanas keystore'); }
  try { return await ethers.Wallet.fromEncryptedJson(encrypted, password); }
  catch (_) { throw new Error('Cannot unlock the configured Olanas keystore'); }
}

class OlanasRobinhoodSigner {
  constructor({ wallet, provider, chain }) {
    if (![4663, 46630].includes(chain.chainId)) throw new Error('Only Robinhood mainnet and testnet are allowed');
    if (!wallet?.address || typeof wallet.signTransaction !== 'function') throw new Error('A valid Olanas signing wallet is required');
    this.wallet = wallet; this.provider = provider; this.address = ethers.getAddress(wallet.address); this.chain = chain;
  }
  async prepare({ token, payTo, amount }, maxGasWei) {
    // Check the RPC itself, not just the provider's static network setting.
    if (Number(BigInt(await this.provider.send('eth_chainId', []))) !== this.chain.chainId) throw new Error('RPC returned the wrong chain');
    const asset = this.chain.supportedTokens[token];
    if (!asset || BigInt(amount) <= 0n || ethers.getAddress(payTo) === ethers.ZeroAddress) throw new Error('Invalid payment');
    if (asset.address) {
      if (await this.provider.getCode(asset.address) === '0x') throw new Error('Token contract not deployed');
      const contract = new ethers.Contract(asset.address, ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)'], this.provider);
      if (Number(await contract.decimals()) !== asset.decimals) throw new Error('Token decimals mismatch');
      if (await contract.balanceOf(this.address) < BigInt(amount)) throw new Error('Insufficient token balance');
    }
    const data = asset.address ? new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [payTo, BigInt(amount)]) : '0x';
    const transaction = { to: asset.address || ethers.getAddress(payTo), value: asset.address ? 0n : BigInt(amount), data, from: this.address };
    const fee = await this.provider.getFeeData();
    if (!fee.maxFeePerGas || fee.maxPriorityFeePerGas == null) throw new Error('EIP-1559 fee estimate unavailable');
    const gasLimit = (await this.provider.estimateGas(transaction)) * 120n / 100n;
    const gasCost = gasLimit * fee.maxFeePerGas;
    if (gasCost <= 0n || gasCost > BigInt(maxGasWei)) throw new Error('Transaction exceeds the approved gas limit');
    if (await this.provider.getBalance(this.address) < transaction.value + gasCost) throw new Error('Insufficient ETH for payment and gas');
    delete transaction.from;
    return { transaction: ethers.Transaction.from({ ...transaction, type: 2, chainId: this.chain.chainId,
      nonce: await this.provider.getTransactionCount(this.address, 'pending'), gasLimit,
      maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }), gasCost };
  }
  async sign(transaction) {
    let raw;
    try { raw = await this.wallet.signTransaction(transaction); }
    catch (_) { throw new Error('Olanas wallet could not sign the transaction'); }
    const signed = ethers.Transaction.from(raw);
    if (!signed.signature || signed.from?.toLowerCase() !== this.address.toLowerCase() || signed.unsignedSerialized !== transaction.unsignedSerialized) {
      throw new Error('Olanas wallet produced a different transaction or signer');
    }
    return { raw, hash: signed.hash };
  }
  async broadcast(raw) { return this.provider.broadcastTransaction(raw); }
  async receipt(hash) { return this.provider.getTransactionReceipt(hash); }
}

module.exports = { OlanasRobinhoodSigner, loadSigningWallet };
