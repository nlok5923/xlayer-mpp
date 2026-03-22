/**
 * Example: Charge (pull mode) — Server side
 *
 * This shows how an API server gates a resource behind an HTTP 402 charge.
 * The server:
 *   1. Returns a challenge on the first unauthenticated request.
 *   2. On the follow-up request, verifies the signed tx and serves the resource.
 *
 * Run (after building):
 *   npx ts-node examples/charge-server.ts
 */

import { XLayerChargeServer } from "../src/server/index.js";
import { createMemoryStore } from "./in-memory-store.js";

const store = createMemoryStore();

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new XLayerChargeServer({
  // Private key of the account that will broadcast txs and pay OKB gas
  signerPrivateKey: "0xYOUR_SERVER_PRIVATE_KEY",
  store,
  network: "testnet",
});

// ─── Step 1: client hits the API — server issues 402 + challenge ──────────────

const challenge = await server.createChallenge({
  amount: "1.00",          // 1 USDC
  currency: "USDC",
  recipient: "0xYOUR_RECIPIENT_ADDRESS",
  description: "Access to /api/premium-data",
  externalId: "req_001",
});

console.log("=== Challenge (send this as HTTP 402 body) ===");
console.log(JSON.stringify(challenge, null, 2));

// ─── Step 2: client sends back a signed credential ───────────────────────────
// (In a real server this comes from the HTTP request body)

// Simulate receiving a credential from the client
const simulatedCredential = {
  transaction: "0xSIGNED_TX_HEX_FROM_CLIENT",
};

try {
  const receipt = await server.handleCredential(challenge, simulatedCredential);
  console.log("\n=== Receipt (attach as Payment-Receipt header) ===");
  console.log(JSON.stringify(receipt, null, 2));
  // Now serve the protected resource
} catch (err) {
  console.error("Payment verification failed:", err);
}
