# Olanas Payments MCP for Robinhood

Local stdio MCP server + companion wallet. Native Olanas mode creates an EVM
private key on the local machine, stores it in an encrypted JSON keystore, signs
locally, and broadcasts through Robinhood RPC. It has no hosted wallet or custody
provider dependency and is not endorsed by Robinhood.

## Quick start

Install directly from GitHub and configure Codex in one command:

```powershell
npx --yes github:olanass/launchpad-app --client codex --auto-config
```

For the interactive client selector, omit the flags:

```powershell
npx --yes github:olanass/launchpad-app
```

From a cloned repository:

```powershell
npm run payments:install
```

After the standalone npm package is published, the shorter equivalent will be:

```powershell
npx olanas-payments-mcp
```

Select Codex, Claude Desktop, Claude Code, Gemini CLI, or manual configuration.
The installer creates a native wallet automatically, encrypts it locally, saves
a generated owner password in the private installation directory, and optionally
configures the selected MCP client. It never asks for an API key or seed phrase.

Restart Codex and ask **Show my Olanas wallet**. Codex starts the wallet MCP for you;
do not also start the standalone wallet. Fund the displayed address on the selected
Robinhood network, keep ETH for gas, then enable a bounded spending session in the
companion. Setup never funds the wallet, signs a payment, or enables spending.
Sessions still need owner approval after a process restart.

Rerunning install or using `--force` preserves the same wallet. `uninstall`
removes the runtime and client registration while preserving wallet keys and
history. Protect the installation directory and do not share its password,
keystore, environment file, or private companion link.

### Installer commands

```powershell
# Interactive install
npx olanas-payments-mcp

# Configure Codex without installer prompts
npx olanas-payments-mcp install --client codex --auto-config

# Print manual MCP configuration
npx olanas-payments-mcp install --client other --no-auto-config

# Reinstall runtime files while keeping the same wallet
npx olanas-payments-mcp install --force

# Inspect or remove the installation
npx olanas-payments-mcp status
npx olanas-payments-mcp uninstall
```

Options: `--client/-c`, `--auto-config`, `--no-auto-config`,
`--network`, `--launchpad`, `--force/-f`, `--verbose/-v`, and
`--help/-h`. The default installation directory is
`~/.olanas-payments-mcp/`. Uninstall deliberately preserves the wallet.

## Manual Olanas autonomous setup

1. Run `npm run payments:setup` once to generate the encrypted keystore and
   private environment file. Use a unique password of at least 16 characters.
2. For manual configuration, copy `payments-mcp/olanas.env.example` to
   `.local/payments.env`, use an absolute `OLANAS_KEYSTORE_FILE` path, and set
   the public `OLANAS_ACCOUNT_ADDRESS` printed by setup.
3. Run `npm run payments:olanas` to open the companion separately, or configure
   an MCP client as below. Fund the address only on the displayed Robinhood
   network and keep ETH for gas. No automatic card onramp is provided.
4. In the companion, enter the owner password and explicitly enable a session:
   payment token, per-call cap, total budget, per-call/total ETH gas caps, and
   expiry. The session can purchase any service on the configured Olanas launchpad.
   **No per-payment wallet popup is needed.**
5. Ask the MCP client to call a service. `request_paid_api` pays automatically
   under this policy; poll `get_payment_status` if confirmation is pending.
6. Revoke the session in the companion anytime. Sending unused funds out uses
   the owner-password-protected withdrawal form, never an MCP tool.

Olanas wallet mode MCP configuration (merge with existing MCP entries):

```json
{
  "mcpServers": {
    "olanas-payments": {
      "command": "node",
      "args": [
        "--env-file=C:/Users/marco/Music/x402/.local/payments.env",
        "C:/Users/marco/Music/x402/payments-mcp/server.js"
      ]
    }
  }
}
```

Stop the separately running companion first; Claude starts its own process.
This implementation allows only Robinhood mainnet (4663) and testnet (46630).
For a testnet launchpad, change both `ROBINHOOD_NETWORK` and
`PAYMENTS_LAUNCHPAD_URL` and configure the testnet token contracts. Don't send
mainnet assets to testnet. Signing/broadcast integration must be tested live
with user-approved test funds before production use.

### Autonomous safeguards and limitations

- Durable principal/gas reservations happen before signing. Concurrent requests
  are serialized. Reusing a request ID cannot generate a second payment.
- Failed or ambiguous attempts retain their reserved budget. Gas accounting is
  conservative (maximum fee), not a promise that the whole reserve was spent.
- New processes disable sessions, preserving history. A human must enable a
  fresh session. Don't run another payment tool against this dedicated account.
- Session limits are **application enforced**, not on-chain spend policies. A
  compromised host or leaked password/environment file can unlock the keystore
  and bypass them. Use a dedicated low-balance wallet and review before launch.
- The companion session link doesn't grant owner actions. These additionally
  need the owner password, with failed-attempt rate limiting. No MCP tool can
  enable/increase budgets, withdraw funds or retrieve signed transaction bytes.
- Signed transaction bytes are stored in the private local journal for recovery.
  They authorize an already-approved transfer: protect them like credentials.
- `signing` after a crash: owner recovery cancels the unbroadcast attempt.
  `submitted`: owner recovery may rebroadcast **the same signed transaction**,
  never a new payment. Revoking a session cannot recall a broadcast transfer.
- No automatic email login, fiat onramp, multi-user hosted custody service,
  standard `exact`/`upto` support or per-token billing is included.
  It pays this launchpad's fixed-price `onchain-tx` APIs, not Claude's model bill.

## Optional browser-wallet mode

From the launchpad checkout, after `npm install`:

```powershell
npm run payments:wallet
```

Open the private loopback link printed in the terminal. Install/enable an EVM
browser wallet and click **Connect wallet**. This app never asks for a seed or
private key. Fund the displayed address on **Robinhood Chain**, with USDG for
USDG services and some ETH for gas. Use a dedicated low-balance wallet.

For MCP clients, use the local Node entry point directly (not `npm run`, whose
extra stdout can corrupt MCP transport):

```json
{
  "mcpServers": {
    "olanas-payments": {
      "command": "node",
      "args": ["C:/Users/marco/Music/x402/payments-mcp/server.js"],
      "env": { "PAYMENTS_LAUNCHPAD_URL": "https://olanas.xyz" }
    }
  }
}
```

Replace the absolute path for another machine. For VS Code `.vscode/mcp.json`,
use `servers` instead of `mcpServers` and add `"type": "stdio"` to the entry.
Only run one instance on the companion port. Stop `payments:wallet` before
starting the MCP client. No npm package has been published, and no client
configuration is automatically modified in this manual browser-wallet flow.

## Browser-wallet agent flow

1. `show_wallet`: user opens companion and connects a browser wallet.
2. `get_funding_details`, `get_wallet_balance`: public address and balances.
3. `search_services`: discover APIs on the configured launchpad.
4. `request_paid_api`: supply slug, method, body and a unique `requestId`.
5. User reviews exact request, network, token and recipient in the companion;
   the browser wallet prompts for the transfer.
6. `get_payment_status`: poll with returned id to retrieve API result/receipt.
7. `list_payments`: inspect local history. Agents have no send/withdraw tool.

Reusing `requestId` returns the original intent. Changed inputs need a new ID.
Quotes expire after five minutes. In browser mode every payment requires human approval.
Transfer of unused funds happens only through **Send funds out** in the UI,
and needs another wallet signature. It is an on-chain transfer, not a fiat
offramp. The user's existing wallet owns all unspent funds.

## Configuration

The standalone server reads process environment variables, not the website's
`.env` (so website secrets aren't unnecessarily loaded into an MCP process).

| Variable | Default |
|---|---|
| `PAYMENTS_LAUNCHPAD_URL` | `https://olanas.xyz` |
| `PAYMENTS_WALLET_PROVIDER` | `browser`; set `olanas` for autonomous mode |
| `OLANAS_KEYSTORE_FILE` | Absolute encrypted keystore path; required in Olanas mode |
| `OLANAS_ACCOUNT_ADDRESS` | Public address created by setup; required in Olanas mode |
| `PAYMENTS_MCP_PORT` | `4782` |
| `PAYMENTS_DATA_DIR` | OS home + `.olanas-payments` |
| `ROBINHOOD_NETWORK` | `mainnet` (or `testnet`) |
| `ROBINHOOD_RPC_URL` | Project's default RPC for chosen network |

Mainnet chain ID is 4663; testnet is 46630. Testnet token contract configuration
uses the existing `ROBINHOOD_TESTNET_*_CONTRACT_ADDRESS` variables. Configure a
working RPC if the public endpoint rejects automated access. This process must
run on the user's computer, **not Vercel**. The launchpad remains web-hosted.

## Recovery and boundaries

- Payment intent/transaction/API history is saved locally. It contains request
  and response data, so protect the directory and don't commit or share it.
- If the wallet prompt is cancelled before sending, create a new request. If
  anything was broadcast, enter the original hash instead. Never pay again to
  fix a timeout. `awaiting_wallet` is deliberately not automatically reset.
- `submitted`: use Check original payment after confirmation. Verification
  must succeed before the request is forwarded.
- `delivery_unknown`: the API may have run. Check with its owner before manually
  retrying the same proof; automatic retries could duplicate side effects.
- Failed API calls do not reverse on-chain transfers. Service refunds aren't
  provided by this version.
- Browser mode uses a connected browser wallet; Olanas wallet mode uses the
  configured encrypted local keystore. Neither implements email/OTP or a card onramp.
- Currently supports this launchpad's `onchain-tx` proof scheme, fixed-price
  APIs and Robinhood tokens configured in this repository. Doesn't pay a coding
  client's underlying model bill or replace its subscription.
- Loopback only, strict Host/Origin checks, unguessable session credential,
  and no remote scripts. Native Olanas mode stores its private key only in the
  encrypted local keystore. The session link is sensitive.
  Same-machine malware/agents controlling the browser remain outside this
  boundary. Use a wallet you review independently and keep balances small.

## Verification

`npm run test:payments` tests intent validation, replay/idempotency, persistence,
budget concurrency, revocation, local serialized signing, gas caps, owner
authentication, mocked transaction verification/delivery, stdio MCP and HTTP security.
Live transfers must be separately validated by a user on testnet before treating
this implementation as production-ready.
