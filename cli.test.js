'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { Wallet } = require('ethers');
const { ask, createOrLoadWallet, configText, parseArgs } = require('./cli');

function directoryFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olanas-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'installation');
}
function scriptedPrompt(answers, calls = []) {
  return async (label, secret) => {
    calls.push({ label, secret });
    assert.ok(answers.length, 'unexpected prompt');
    return answers.shift();
  };
}

test('wallet flag accepts only installation modes and never a key value', () => {
  assert.equal(parseArgs(['install', '--wallet', 'import']).wallet, 'import');
  assert.equal(parseArgs(['--wallet', 'new']).wallet, 'new');
  assert.throws(() => parseArgs(['install', '--wallet']), /must be new or import/);
  assert.throws(() => parseArgs(['install', '--wallet', 'not-a-key']), /must be new or import/);
  assert.throws(() => parseArgs(['status', '--wallet', 'import']), /requires the install command/);
});

test('interactive install imports a generated test key, confirms its address and encrypts it', async t => {
  const directory = directoryFor(t), original = Wallet.createRandom(), calls = [];
  const password = 'local-test-password-1234';
  const saved = await createOrLoadWallet({}, { directory, interactive: true,
    prompt: scriptedPrompt(['2', original.privateKey.slice(2), 'IMPORT', password, password], calls) });
  assert.equal(saved.wallet.address, original.address);
  assert.equal(calls[1].secret, true);
  assert.ok(calls[2].label.includes(original.address));
  assert.equal(calls[3].secret, true);
  assert.equal(calls[4].secret, true);
  assert.equal(saved.password, password);
  const encrypted = fs.readFileSync(path.join(directory, 'wallet.json'), 'utf8');
  assert.equal((await Wallet.fromEncryptedJson(encrypted, saved.password)).address, original.address);
  for (const name of fs.readdirSync(directory)) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8').includes(original.privateKey.slice(2)), false);
  }
  assert.equal(fs.readFileSync(path.join(directory, 'owner-password.txt'), 'utf8').trim(), saved.password);
  fs.writeFileSync(path.join(directory, 'payments.env'), configText({ PAYMENTS_OWNER_PASSWORD: saved.password }));
  const before = fs.readFileSync(path.join(directory, 'wallet.json'), 'utf8');
  const reloaded = await createOrLoadWallet({ force: true }, { directory,
    prompt: () => assert.fail('existing wallet should not prompt') });
  assert.equal(reloaded.wallet.address, original.address);
  await assert.rejects(createOrLoadWallet({ wallet: 'import', force: true }, { directory }), /already exists/);
  assert.equal(fs.readFileSync(path.join(directory, 'wallet.json'), 'utf8'), before);
  const installed = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'install', '--client', 'other', '--no-auto-config'], {
    env: { ...process.env, OLANAS_INSTALL_DIR: directory }, encoding: 'utf8', windowsHide: true
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes(original.address));
  assert.ok(fs.existsSync(path.join(directory, 'runtime', 'bundle.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'install.json'), 'utf8')).address, original.address);
  const config = fs.readFileSync(path.join(directory, 'payments.env'), 'utf8');
  assert.equal(config.includes(original.privateKey.slice(2)), false);
  assert.equal((installed.stdout + installed.stderr).includes(original.privateKey.slice(2)), false);
});

test('invalid keys, rejected confirmation, and noninteractive imports save nothing', async t => {
  const directory = directoryFor(t), valid = Wallet.createRandom().privateKey;
  for (const key of ['invalid-secret', '0x' + '0'.repeat(64), '0x' + 'f'.repeat(64)]) {
    await assert.rejects(createOrLoadWallet({ wallet: 'import' }, {
      directory, interactive: true, prompt: scriptedPrompt([key])
    }), error => error.message === 'Invalid private key. Nothing was saved.');
    assert.equal(fs.existsSync(directory), false);
  }
  await assert.rejects(createOrLoadWallet({ wallet: 'import' }, {
    directory, interactive: true, prompt: scriptedPrompt([valid, 'no'])
  }), /cancelled/);
  await assert.rejects(createOrLoadWallet({ wallet: 'import' }, {
    directory, interactive: false, prompt: () => assert.fail('must not read piped keys')
  }), /interactive terminal/);
  assert.equal(fs.existsSync(directory), false);
});

test('new wallet supports interactive default and unattended setup', async t => {
  for (const interactive of [false, true]) {
    const directory = directoryFor(t);
    const password = 'new-wallet-test-password';
    const saved = await createOrLoadWallet({}, { directory, interactive, prompt: scriptedPrompt(['', password, password]) });
    if (interactive) assert.equal(saved.password, password);
    else assert.ok(saved.password.length >= 16);
    assert.ok(Wallet.fromEncryptedJsonSync(fs.readFileSync(path.join(directory, 'wallet.json'), 'utf8'), saved.password));
  }
});

test('short, unsupported, mismatched, or cancelled passwords do not save a wallet', async t => {
  for (const answers of [['short'], ["long-password-with-'"], ['password-with\na-newline'], ['valid-long-password', 'different-password']]) {
    const directory = directoryFor(t);
    await assert.rejects(createOrLoadWallet({ wallet: 'new' }, {
      directory, interactive: true, prompt: scriptedPrompt([...answers])
    }), /Nothing was saved/);
    assert.equal(fs.existsSync(directory), false);
  }
  const directory = directoryFor(t);
  await assert.rejects(createOrLoadWallet({ wallet: 'new' }, {
    directory, interactive: true, prompt: () => { throw new Error('Setup cancelled.'); }
  }), /cancelled/);
  assert.equal(fs.existsSync(directory), false);
});

test('directory protection must succeed before writing any secrets', async t => {
  const directory = directoryFor(t);
  await assert.rejects(createOrLoadWallet({ wallet: 'new' }, {
    directory, protect: () => { throw new Error('permission setup failed'); }
  }), /permission setup failed/);
  assert.equal(fs.existsSync(directory), false);
});

test('hidden terminal input is not echoed and handles cancellation and EOF', async () => {
  for (const action of ['submit', 'interrupt', 'end']) {
    const input = new PassThrough();
    input.isTTY = true;
    let output = '';
    const destination = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    const pending = ask('Private key: ', true, input, destination);
    input.write(' dummy-secret ');
    if (action === 'submit') {
      input.write('\r');
      assert.equal(await pending, ' dummy-secret ');
    } else {
      const rejected = assert.rejects(pending, /cancelled/);
      if (action === 'interrupt') input.write('\x03');
      else input.end();
      await rejected;
    }
    assert.ok(output.includes('Private key: '));
    assert.equal(output.includes('dummy-secret'), false);
    input.destroy();
  }
});
