# @xlayer/mpp

Machine Payments Protocol (MPP) SDK for [XLayer](https://www.okx.com/xlayer) — OKX's EVM L2 (Chain ID: 196).

MPP is an open standard built on the long-dormant `HTTP 402 Payment Required` HTTP status code. It lets any API charge per request in stablecoins, and lets AI agents or scripts pay autonomously — no subscriptions, no API keys, no billing infrastructure needed.

This SDK brings MPP to XLayer: sub-cent gas fees, ~2s finality, native USDC, and access to the OKX ecosystem of 50M+ users.

---

## What becomes possible

### Pay-per-call APIs
Wrap any HTTP endpoint with a payment wall. Clients pay in USDC per request. Payment is the authentication — no API keys, no Stripe, no fraud.

### AI agents that pay autonomously
An agent hits your API, receives a `402`, signs a USDC payment, and gets access — fully autonomous, no human in the loop.

```
Agent → POST /api/generate     → 402 + Challenge
Agent ← signs USDC tx (no broadcast, server pays gas)
Agent → POST /api/generate     → 200 OK + result
```

### Metered billing — no on-chain tx per request
Open a USDC payment channel upfront. Every API call is authorized with a cheap off-chain EIP-712 signature — **no gas, no latency per request**. Perfect for LLM token billing, GPU compute, data streaming.

```
Open channel: 1 on-chain tx (deposit)
Request 1:    EIP-712 signature  ← no tx
Request 2:    EIP-712 signature  ← no tx
Request 3:    EIP-712 signature  ← no tx
...
Close:        final signature + optional settlement tx
```

### Agent-to-agent payments
One AI agent pays another for a subtask — fully autonomous, settling in USDC on XLayer at sub-cent fees.

---

## Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `196` | `1952` |
| Gas token | OKB | OKB |
| RPC | `https://rpc.xlayer.tech` | `https://testrpc.xlayer.tech/terigon` |
| USDC | `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | — |
| Explorer | [okx.com/web3/explorer/xlayer](https://www.okx.com/web3/explorer/xlayer) | — |

> **Gas model (pull mode):** The server holds a funded signer key and broadcasts transactions, paying OKB gas. Clients only need to hold USDC — the payment token. No OKB required on the client side.

---

## Installation

```bash
npm install @xlayer/mpp
```

---

## Payment method 1: Charge

A single USDC transfer per API call. Best for low-frequency requests — image generation, data queries, one-off computations.

### Flow

```
Client                              Server
  |  ←── HTTP 402 + Challenge ────  |
  |  ──── signed tx (unsigned) ───► |   client signs, does NOT broadcast
  |                                 |   server broadcasts, pays OKB gas
  |  ←── HTTP 200 + Receipt ──────  |   Transfer event verified on-chain
```

### Server

```ts
import { XLayerChargeServer } from "@xlayer/mpp/server";

const server = new XLayerChargeServer({
  signerPrivateKey: "0xSERVER_KEY", // broadcasts txs, pays OKB gas
  store,                            // pluggable KV store (see below)
  network: "mainnet",
});

// Step 1: client hits your API unauthenticated
// Return this as HTTP 402 body
const challenge = await server.createChallenge({
  amount: "1.00",          // 1 USDC
  currency: "USDC",
  recipient: "0xYOUR_RECIPIENT",
  description: "Access to /api/data",
  externalId: "req_001",  // optional — your internal reference
});

// Step 2: client retries with credential in body/header
// Verifies Transfer event on-chain, returns txHash + blockNumber
const receipt = await server.handleCredential(challenge, credential);
// Now serve the protected resource
```

### Client

```ts
import { XLayerChargeClient } from "@xlayer/mpp/client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const walletClient = createWalletClient({
  account: privateKeyToAccount("0xCLIENT_KEY"),
  transport: http("https://rpc.xlayer.tech"),
  chain: { id: 196, name: "XLayer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
           rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } } },
});

const client = new XLayerChargeClient({ walletClient, network: "mainnet" });

// Receive 402 challenge from server
// Signs the ERC-20 transfer but does NOT broadcast — server does
const credential = await client.handleChallenge(challenge);
// credential.transaction — signed RLP tx hex
// POST this back to the server
```

---

## Payment method 2: Session (metered / streaming)

Open a payment channel with a USDC deposit upfront. Each API call is authorized with an off-chain **EIP-712 voucher** — no on-chain transaction, no gas per request.

Best for: LLM token billing, GPU compute by the minute, data stream subscriptions, any high-frequency metered workload.

### How sessions work

Each voucher carries a monotonically increasing `cumulativeAmount` and `sequence`. The server verifies the EIP-712 signature and updates channel state — no chain interaction needed until settlement.

```
Client                                     Server
  |                                           |
  |── deposit 10 USDC (on-chain tx) ────────► |  open
  |── voucher { cumulative: 1, seq: 0 } ────► |
  |                                           |
  |── voucher { cumulative: 2, seq: 1 } ────► |  update (no tx)
  |── voucher { cumulative: 3, seq: 2 } ────► |  update (no tx)
  |── voucher { cumulative: 4, seq: 3 } ────► |  update (no tx)
  |                                           |
  |── voucher { cumulative: 4, seq: 4 } ────► |  close
  |                                           |
  |           server settles on-chain ──────► |  (optional final tx)
```

### Session actions

| Action | Trigger | On-chain tx? |
|---|---|---|
| `open` | First request, no channel exists | Yes — deposit |
| `update` | Every subsequent request | **No** — EIP-712 signature only |
| `topup` | Balance running low | Yes — add more deposit |
| `close` | Done with the session | No — final signature |

### Server

```ts
import { XLayerSessionServer } from "@xlayer/mpp/server";
import { USDC_ADDRESS } from "@xlayer/mpp";

const server = new XLayerSessionServer({
  recipient: "0xYOUR_RECIPIENT",
  acceptedAssets: [USDC_ADDRESS.mainnet],  // tokens you accept
  network: "mainnet",
  store,
  maxChannelDuration: 86400,  // max channel lifetime: 1 day (optional)
});

// On unauthenticated request — return as HTTP 402
const challenge = await server.createChallenge({
  channelId: existingChannelId,  // omit on first open
  amount: "0.01",                // 0.01 USDC per request
  asset: USDC_ADDRESS.mainnet,
});

// On follow-up with credential
const receipt = await server.handleCredential(challenge, credential);
// receipt.channelId        — pass back to client for subsequent calls
// receipt.sequence         — monotonically increasing
// receipt.authorizedAmount — total USDC authorized so far
```

### Client

```ts
import { XLayerSessionClient } from "@xlayer/mpp/client";

const client = new XLayerSessionClient({
  walletClient,
  network: "mainnet",
  autoOpen: true,          // open a channel automatically on first 402
  autoTopup: false,        // require explicit topup when balance runs low
  depositMultiplier: 10,   // deposit 10× the per-request cost upfront
                           // e.g. 0.01 USDC/req → deposits 0.10 USDC
});

// Every 402 from the server:
const perRequestCost = 10_000n; // 0.01 USDC (6 decimals)
const credential = await client.handleChallenge(challenge, perRequestCost);
// First call:  opens channel (deposits 10 × 0.01 = 0.10 USDC on-chain)
// Later calls: pure EIP-712 signature — no tx, no gas

// When done — close the channel
const closeCredential = await client.closeChannel(challenge);
```

### Manual channel control

If you prefer explicit control over the channel lifecycle:

```ts
// Open with a specific deposit (not using autoOpen)
const client = new XLayerSessionClient({ walletClient, network: "mainnet", autoOpen: false });

// Deposit 5 USDC, first voucher authorises 0.01 USDC
const openCredential = await client.openChannel(
  challenge,
  5_000_000n,  // depositAmount: 5 USDC
  10_000n      // firstRequestAmount: 0.01 USDC
);

// Later: topup when needed
const topupCredential = await client.topupChannel(challenge, 5_000_000n);

// Close when done
const closeCredential = await client.closeChannel(challenge);
```

---

## Bring your own Store

Both servers accept a pluggable `Store` interface. The charge server uses it for replay protection; the session server uses it for channel state.

```ts
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

**In-memory (dev/testing):**
```ts
import { createMemoryStore } from "@xlayer/mpp/examples/in-memory-store";
// or roll your own:
const map = new Map<string, string>();
const store: Store = {
  get: async (key) => map.get(key) ?? null,
  set: async (key, value) => { map.set(key, value); },
  delete: async (key) => { map.delete(key); },
};
```

**Redis (production):**
```ts
import { createClient } from "redis";
const redis = createClient();
await redis.connect();

const store: Store = {
  get: async (key) => redis.get(key),
  set: async (key, value) => { await redis.set(key, value); },
  delete: async (key) => { await redis.del(key); },
};
```

---

## Full example — Express API with both payment methods

```ts
import express from "express";
import { XLayerChargeServer, XLayerSessionServer } from "@xlayer/mpp/server";
import { USDC_ADDRESS } from "@xlayer/mpp";

const app = express();
app.use(express.json());

const store = /* Redis or SQLite store */;

const chargeServer = new XLayerChargeServer({
  signerPrivateKey: process.env.SERVER_PRIVATE_KEY!,
  store,
  network: "mainnet",
});

const sessionServer = new XLayerSessionServer({
  recipient: process.env.RECIPIENT_ADDRESS!,
  acceptedAssets: [USDC_ADDRESS.mainnet],
  network: "mainnet",
  store,
});

// ── One-time charge: pay 0.05 USDC per image ──────────────────────────────────

app.post("/api/image", async (req, res) => {
  const credential = req.headers["x-mpp-credential"];

  if (!credential) {
    const challenge = await chargeServer.createChallenge({
      amount: "0.05",
      currency: "USDC",
      recipient: process.env.RECIPIENT_ADDRESS!,
      description: "Image generation",
    });
    return res.status(402).json(challenge);
  }

  await chargeServer.handleCredential(
    JSON.parse(req.headers["x-mpp-challenge"] as string),
    JSON.parse(credential as string)
  );

  res.json({ url: "https://cdn.example.com/image.png" });
});

// ── Metered session: 0.001 USDC per token batch ───────────────────────────────

app.post("/api/inference", async (req, res) => {
  const credential = req.headers["x-mpp-credential"];

  if (!credential) {
    const challenge = await sessionServer.createChallenge({
      channelId: req.headers["x-mpp-channel-id"] as string | undefined,
      amount: "0.001",
      asset: USDC_ADDRESS.mainnet,
    });
    return res.status(402).json(challenge);
  }

  const receipt = await sessionServer.handleCredential(
    JSON.parse(req.headers["x-mpp-challenge"] as string),
    JSON.parse(credential as string)
  );

  res.json({
    tokens: "...",
    channelId: receipt.channelId,       // client should store this
    authorizedAmount: receipt.authorizedAmount,
  });
});

app.listen(3000, () => console.log("Listening on :3000"));
```

---

## Running the test suite

Requires [Foundry](https://getfoundry.sh):

```bash
# 1. Install Foundry (one-time)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. Compile the mock ERC-20
forge build --contracts contracts/ --out artifacts/

# 3. Start local Anvil node (in a separate terminal)
anvil

# 4. Run the full e2e test suite
npm run test:e2e
```

**What the tests cover:**
- Charge: challenge → client signs → server broadcasts → Transfer event verified → receipt returned → replay rejected
- Session: open channel (on-chain deposit) → 3 off-chain update vouchers → close → balance assertions

---

## Project structure

```
src/
├── constants.ts          — Chain IDs, RPC URLs, USDC addresses, ERC-20 ABI
├── Methods.ts            — Zod schemas for all challenge/credential/receipt types
├── index.ts              — Main exports
├── server/
│   ├── Charge.ts         — XLayerChargeServer
│   └── Session.ts        — XLayerSessionServer
├── client/
│   ├── Charge.ts         — XLayerChargeClient
│   └── Session.ts        — XLayerSessionClient
└── session/
    ├── Types.ts           — ChannelState, Store, SessionConfig interfaces
    ├── Voucher.ts         — EIP-712 voucher signing and verification
    └── ChannelStore.ts    — Mutex-locked channel state persistence

contracts/
└── MockERC20.sol         — Minimal ERC-20 for local testing

examples/
├── charge-server.ts      — Charge server walkthrough
├── charge-client.ts      — Charge client walkthrough
├── session-server.ts     — Session server walkthrough
├── session-client.ts     — Session client walkthrough
├── in-memory-store.ts    — Dev/test Store (Map-backed)
└── test-e2e.ts           — Full end-to-end test against Anvil
```

---

## License

MIT
