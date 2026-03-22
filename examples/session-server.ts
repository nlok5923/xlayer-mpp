/**
 * Example: Session (off-chain EIP-712 vouchers) — Server side
 *
 * The session model lets a client open a channel with a deposit upfront, then
 * authorize each subsequent API call with a signed off-chain voucher — no
 * on-chain tx per request.
 *
 * Server flow:
 *   1. Issue a 402 SessionChallenge on every unauthenticated request.
 *   2. On credential receipt: verify EIP-712 signature, dispatch to the right
 *      lifecycle handler (open / update / topup / close).
 *   3. Serve the resource if the credential is valid.
 *
 * Run (after building):
 *   npx ts-node examples/session-server.ts
 */

import { XLayerSessionServer } from "../src/server/index.js";
import { USDC_ADDRESS } from "../src/constants.js";
import type { SessionCredential } from "../src/Methods.js";
import { createMemoryStore } from "./in-memory-store.js";

const store = createMemoryStore();

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new XLayerSessionServer({
  recipient: "0xYOUR_RECIPIENT_ADDRESS",
  acceptedAssets: [USDC_ADDRESS.testnet],
  network: "testnet",
  store,
  maxChannelDuration: 24 * 60 * 60, // 1 day
});

// ─── Step 1: Issue a 402 challenge ───────────────────────────────────────────

const challenge = await server.createChallenge({
  amount: "0.01", // 0.01 USDC per request
  asset: USDC_ADDRESS.testnet,
});

console.log("=== SessionChallenge (send as HTTP 402 body) ===");
console.log(JSON.stringify(challenge, null, 2));

// ─── Step 2: Handle incoming credential ──────────────────────────────────────
// (In a real server this arrives from the HTTP request body)

// Simulated "open" credential from the client
const openCredential: SessionCredential = {
  action: "open",
  depositTxHash: "0xDEPOSIT_TX_HASH",
  voucher: {
    channelId: "my-channel-001",
    payer: "0xCLIENT_ADDRESS",
    recipient: "0xYOUR_RECIPIENT_ADDRESS",
    asset: USDC_ADDRESS.testnet,
    cumulativeAmount: "10000000", // 10 USDC deposit (6 decimals)
    sequence: 0,
    serverNonce: challenge.methodDetails.serverNonce,
    chainId: 1952, // testnet
  },
  signature: "0xEIP712_SIGNATURE_FROM_CLIENT",
};

try {
  const receipt = await server.handleCredential(challenge, openCredential);
  console.log("\n=== SessionReceipt (channel opened) ===");
  console.log(JSON.stringify(receipt, null, 2));
} catch (err) {
  console.error("Session credential failed:", err);
}

// ─── Subsequent requests: update vouchers ────────────────────────────────────
// Each API call the client sends a new voucher with an incremented
// sequence and higher cumulativeAmount. No on-chain tx needed.
//
// const updateChallenge = await server.createChallenge({ channelId: receipt.channelId, amount: "0.01" });
// const receipt2 = await server.handleCredential(updateChallenge, updateCredential);
