# Autonomous payments

The local Olanas signing wallet now uses the website's durable order engine.
The website layout and manual-wallet flow are unchanged. The local companion's
existing owner controls additionally accept service and recipient allowlists.

## Owner setup

1. Deploy the durable-order website backend before updating the companion.
   `/api/version` must report `purchaseFlow: durable-orders-v1`.
2. Configure the existing Olanas wallet provider (`PAYMENTS_WALLET_PROVIDER=olanas`),
   encrypted `OLANAS_KEYSTORE_FILE`, `OLANAS_ACCOUNT_ADDRESS`, owner password,
   network, and `PAYMENTS_LAUNCHPAD_URL`. Use testnet first. Never paste the
   password or wallet key into agent chat. Browser-wallet mode remains manual.
3. Fund the dedicated wallet with the payment asset and native gas asset.
4. Open the local companion, enter the owner password, and enable a session with
   token, per-call/total amount, per-call/total gas, expiration, allowed service
   slugs and recipient addresses. `*` explicitly allows any entry in that list.
5. Ask the agent to call `request_paid_api` with a stable requestId. Within policy,
   approval, transfer and execution need no per-payment browser interaction.

Limits are application-enforced, not smart-contract restrictions. Restarting the
companion disables new autonomous signing; it does not reset reserved budgets.
The local owner and other processes able to read its secrets remain trusted.

## Execution and recovery

The companion validates the exact request hash and token/network/amount against
local configuration. It checks policy before preparation and again before
broadcast. Principal and maximum gas are reserved before approval/signing.
The journal stores the nonce, approved quote, signed bytes and deterministic hash
before broadcast. MCP responses and companion state do not expose signed bytes.

The initial call polls the original hash for up to eight seconds after broadcast
(RPC requests have their own timeouts). Slow confirmations return `pending`.
`get_payment_status` and `reconcile_order` inspect that transaction and finish
durable delivery; neither broadcasts. Repeating the purchase with the same ID
may rebroadcast identical bytes within its active policy, never sign a replacement.
An owner-authenticated recovery may rebroadcast the original transaction even
after session expiration/revocation. It never creates a new payment.

Unpaid, unapproved expired quotes can refresh within policy. Rejected requests
never reopen automatically. If approval was interrupted before any signed
transaction was saved, owner controls can cancel the unpaid approval after the
owner checks wallet activity. Reservations remain counted. This cancellation is
not exposed to the agent and cannot cancel a saved signed transaction.

`needs_owner_action` is a hard stop, not permission to invent another request ID.
Confirmed-but-ambiguous delivery is not replayed. HTTP error responses are saved
results, not permission to pay again. Arbitrary upstream services cannot offer
exactly-once execution without their own idempotency support.

Existing legacy requests are never automatically migrated or paid again.

## Verification and rollout

Run `npm test`, the website's `npm test`, then `npm run build` here to rebuild
the installer bundle. Autonomous integration tests exercise real order-engine
storage and approval signatures with mocked chain transfers and upstream calls.
They do not prove real RPC, gas funding, token deployment or wallet interoperability.

Before production use: deploy to a separate testnet database, perform one funded
testnet purchase, repeat its requestId, restart while confirmation is pending,
retrieve the saved result, and test revocation and an upstream timeout. Verify
only one transfer and one upstream attempt. Then deploy the website before
restarting updated companions. Keep order tables and local journals on rollback.
Do not replay orders through the legacy payment gateway.
