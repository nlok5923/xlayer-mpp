/**
 * Example: Session (off-chain EIP-712 vouchers) — Client side
 *
 * The client:
 *   1. On first 402: opens a channel (deposits USDC on-chain, signs initial voucher).
 *   2. On subsequent 402s: signs a new voucher with incremented sequence — no
 *      on-chain tx, just an EIP-712 signature.
 *   3. When done: closes the channel.
 *
 * Run (after building):
 *   npx ts-node examples/session-client.ts
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { XLayerSessionClient } from "../src/client/index.js";
import { RPC_URLS, USDC_ADDRESS, XLAYER_TESTNET_CHAIN_ID } from "../src/constants.js";
import type { SessionChallenge } from "../src/Methods.js";

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

const client = new XLayerSessionClient({
  walletClient,
  network: "testnet",
  autoOpen: true,   // automatically open a channel on first challenge
  autoTopup: false, // require explicit topup when balance runs out
  // Deployed XLayerMPPChannel contract (can also be read from challenge.methodDetails.contractAddress)
  channelContractAddress: "0xYOUR_CHANNEL_CONTRACT_ADDRESS",
});

// ─── Simulate first 402 challenge (no channel yet) ───────────────────────────

const firstChallenge: SessionChallenge = {
  recipient: "0xSERVER_RECIPIENT_ADDRESS",
  asset: USDC_ADDRESS.testnet,
  amount: "0.01",
  methodDetails: {
    network: "testnet",
    channelProgram: "onchain-eip712",
    serverNonce: "nonce-abc-001",
    contractAddress: "0xYOUR_CHANNEL_CONTRACT_ADDRESS",
  },
};

// 10 USDC initial deposit (6 decimals)
const depositAmount = 10_000_000n;

const openCredential = await client.handleChallenge(firstChallenge, depositAmount);
console.log("=== Open credential (action: open) ===");
console.log(JSON.stringify(openCredential, null, 2));
// Send this to the server — it verifies the deposit tx and opens the channel

// ─── Subsequent requests: pure off-chain EIP-712 vouchers ────────────────────

const secondChallenge: SessionChallenge = {
  channelId: "my-channel-001", // server echoes back the channelId
  recipient: "0xSERVER_RECIPIENT_ADDRESS",
  asset: USDC_ADDRESS.testnet,
  amount: "0.01",
  methodDetails: {
    network: "testnet",
    channelProgram: "onchain-eip712",
    serverNonce: "nonce-abc-002", // fresh nonce per challenge
    contractAddress: "0xYOUR_CHANNEL_CONTRACT_ADDRESS",
  },
};

const updateCredential = await client.handleChallenge(secondChallenge, 10_000n); // 0.01 USDC
console.log("\n=== Update credential (action: update, no on-chain tx) ===");
console.log(JSON.stringify(updateCredential, null, 2));

// ─── Close the channel when done ─────────────────────────────────────────────

const closeChallenge: SessionChallenge = {
  channelId: "my-channel-001",
  recipient: "0xSERVER_RECIPIENT_ADDRESS",
  asset: USDC_ADDRESS.testnet,
  amount: "0",
  methodDetails: {
    network: "testnet",
    channelProgram: "onchain-eip712",
    serverNonce: "nonce-abc-003",
    contractAddress: "0xYOUR_CHANNEL_CONTRACT_ADDRESS",
  },
};

const closeCredential = await client.closeChannel(closeChallenge);
console.log("\n=== Close credential (action: close) ===");
console.log(JSON.stringify(closeCredential, null, 2));
// Server marks channel as closing and can settle the final amount on-chain
