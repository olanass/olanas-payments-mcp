# Set up Olanas Payments MCP for an AI agent

Run Olanas Payments MCP on your computer to give an AI agent access to your
Olanas wallet and available services. This guide uses ChatGPT as the example
client and starts with a read-only connection. Payment tools can be enabled
after the connection works.

The wallet and signing process run locally. In this setup, ChatGPT reaches the
MCP server through an HTTPS tunnel; your computer and both terminal processes
must remain running.

## 1. Prepare your computer

Install Node.js 22 or newer, Git, and ngrok. Set up ngrok with your own account
and complete its CLI authentication before continuing. Verify the tools:

```powershell
node --version
npm --version
git --version
ngrok version
```

You also need access to ChatGPT developer mode. Availability depends on your
account and workspace policy. The ChatGPT steps below follow the
[official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt),
checked on September 26, 2026. If your desktop app does not show these controls,
use ChatGPT on the web with the same account.

## 2. Download and install Olanas

In a terminal, run:

```powershell
git clone https://github.com/olanass/olanas-payments-mcp.git
cd olanas-payments-mcp
npm ci
node cli.js install --client other --no-auto-config
```

If you already have this repository and wallet installed, skip the clone and
installation steps and open a terminal in your existing checkout.

The installer creates an encrypted local wallet and prints its address,
network, and owner-password file location. It defaults to Robinhood mainnet.
No funds move during installation, and autonomous spending starts disabled.
The committed `dist/` runtime is ready to use; no build is required.

The installer also prints a local MCP JSON configuration. For the ChatGPT
HTTPS connection below, use the private MCP URL instead of that JSON.

## 3. Start the agent connection

Stop any other Olanas MCP process using this wallet, then run:

```powershell
node cli.js chatgpt --read-only
```

The command is named `chatgpt`; it starts the agent's HTTP MCP connection.
Leave this terminal open. Its output includes:

- A local companion URL for opening your wallet in your browser.
- An ngrok command for exposing the separate MCP listener.
- A private MCP URL containing `YOUR-NGROK-HOST` and a generated secret path.
- The connection's expiry time, two hours after startup.

Open the companion URL locally if you want to inspect the wallet. Keep its
private link and owner password out of chat.

## 4. Create the HTTPS tunnel

Open a second terminal and run the exact ngrok command printed by Olanas.
With the default MCP port, it is:

```powershell
ngrok http http://127.0.0.1:4784 --host-header=rewrite
```

Leave this terminal open too. Copy ngrok's HTTPS forwarding origin and replace
only `https://YOUR-NGROK-HOST` in the private MCP URL printed by Olanas.
The result has this shape; the values below are placeholders:

```text
https://YOUR-TUNNEL-DOMAIN/mcp/YOUR-GENERATED-SECRET
```

Preserve the entire generated `/mcp/...` path. Do not add a trailing slash or
query string. Tunnel the MCP port, not the companion wallet port. The complete
MCP URL grants tool access: enter it in ChatGPT's connection settings and keep
it private.

## 5. Connect it in ChatGPT

1. Open **Settings → Security and login** and enable **Developer mode**.
2. Open **Plugins**, select the **+** button, and name the connection
   **Olanas Payments**.
3. Choose the public endpoint connection and paste the full HTTPS MCP URL
   from step 4.
4. If an authentication choice is shown, choose **No authentication**. This
   Olanas transport uses the secret URL itself as its credential and does not
   implement OAuth. Do not enter your wallet password here.
5. Create the connection and review the discovered tools.

These menu names follow the
[official ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
If developer mode is unavailable, check your account or workspace access.

Open the new plugin in your personal plugins and install it if prompted. Start
a new **Work** chat, type `@`, and select **Olanas Payments**, following the
[official plugin quickstart](https://developers.openai.com/plugins/quickstart).

## 6. Check the connection

Ask ChatGPT:

> Use Olanas Payments to show my wallet address, network, and current balance,
> then list the available services. Do not make any payments.

Confirm that ChatGPT actually calls Olanas tools such as `get_funding_details`,
`get_wallet_balance`, and `search_services`. A new wallet may have a zero balance.
Payment tools such as `request_paid_api` are hidden in read-only mode.

## 7. Enable payments when ready

Stop the MCP process with **Ctrl+C** in its terminal, then restart it with:

```powershell
node cli.js chatgpt --allow-payments
```

This exposes payment tools; spending still needs wallet authorization.
Running `node cli.js chatgpt` without either flag also exposes payment tools.

Every restart generates a new secret MCP path. Repeat step 4 with the new path,
update or recreate the ChatGPT connection, refresh its tool list, and start a
new chat. Keep the existing ngrok process if it still forwards to the correct
MCP port.

Open the new local companion URL and check the displayed network and address.
For paid API use, fund that address with the service's payment token and ETH
for gas on the displayed network. In the companion, enter the owner password
from the file identified during installation and approve the payment token,
per-call limit, total budget, gas caps, and session expiry.

The agent can then request paid APIs within those limits. Owner authorization
and budget changes happen in the local companion. Orbio prepaid inference
requires its own connection, deposit, and inference budget; see the
[Orbio instructions in the README](README.md#one-mcp-for-all-three-services).

## Reconnect or troubleshoot

| Symptom | What to check |
|---|---|
| ChatGPT cannot connect | Both terminals are running; use the HTTPS origin plus the complete secret MCP path. |
| HTTP 403 | Use the printed ngrok command, including `--host-header=rewrite`. |
| HTTP 404 | Copy the current secret path exactly; omit trailing slashes and query strings. |
| Connection expired / HTTP 410 | Restart Olanas after its two-hour expiry and replace the URL in ChatGPT. |
| Companion already running | Stop the other Olanas process using this wallet before starting another. |
| Payment tools missing | Restart with `--allow-payments`, replace the connection URL, and refresh tools. |
| Spending session disabled | Authorize a session in the local companion; sessions need approval after restart. |

To disconnect, press **Ctrl+C** in both terminals. Installation files and wallet
history remain in `~/.olanas-payments-mcp/` by default. Protect this directory:
it contains the keystore, owner password, and private configuration.

## Use another local AI agent

For an agent that supports local stdio MCP, the installer can configure it
directly, without the HTTPS tunnel. For example:

```powershell
node cli.js install --client codex --auto-config
```

Other supported client values are `claude`, `claude-code`, and `gemini`. For
another compatible client, use `--client other --no-auto-config` and add the
printed configuration to that client's MCP settings. Stop the standalone
agent connection before letting another client start the same wallet.
