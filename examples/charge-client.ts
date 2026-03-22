/**
 * Example: Charge (pull mode) — Client side
 *
 * The client:
 *   1. Receives an HTTP 402 challenge from the server.
 *   2. Signs the ERC-20 transfer (does NOT broadcast — server does).
 *   3. Sends the signed tx back to the server.
 *
 * Run (after building):
 *   npx ts-node examples/charge-client.ts
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { XLayerChargeClient } from "../src/client/index.js";
import { RPC_URLS, XLAYER_TESTNET_CHAIN_ID } from "../src/constants.js";
import type { ChargeChallenge } from "../src/Methods.js";

// ─── Wallet setup ─────────────────────────────────────────────────────────────

const account = privateKeyToAccount("0xYOUR_CLIENT_PRIVATE_KEY");

const walletClient = createWalletClient({
  account,
  transport: http(RPC_URLS.testnet),
  chain: {
    id: XLAYER_TESTNET_CHAIN_ID,
    name: "XLayer Testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URLS.testnet] } },
  },
});

// ─── Client setup ─────────────────────────────────────────────────────────────

const client = new XLayerChargeClient({
  walletClient,
  network: "testnet",
});

// ─── Simulate receiving a 402 challenge from the server ───────────────────────

const challenge: ChargeChallenge = {
  amount: "1.00",
  currency: "USDC",
  recipient: "0xSERVER_RECIPIENT_ADDRESS",
  description: "Access to /api/premium-data",
  methodDetails: {
    decimals: 6,
    tokenAddress: "0x0000000000000000000000000000000000000000", // testnet USDC placeholder
    network: "testnet",
    reference: "550e8400-e29b-41d4-a716-446655440000",
  },
};

// ─── Sign and return credential ───────────────────────────────────────────────

const credential = await client.handleChallenge(challenge);

console.log("=== Credential (send this back to the server) ===");
console.log(JSON.stringify(credential, null, 2));
// credential.transaction is the signed-but-not-broadcast RLP tx hex
// POST it back to the API — server will broadcast and serve the resource
