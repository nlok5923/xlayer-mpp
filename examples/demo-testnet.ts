/**
 * @xlayer/mpp — Testnet Demo
 *
 * Deploys XLayerMPPChannel via `forge create`, then runs the full demo
 * against XLayer testnet (Chain ID 1952).
 *
 * Usage:
 *   SERVER_KEY=0x<your_testnet_key> npm run demo:testnet
 *
 * Prerequisites:
 *   1. Install Foundry:  curl -L https://foundry.paradigm.xyz | bash && foundryup
 *   2. forge build --contracts contracts/ --out artifacts/
 *   3. Fund SERVER_KEY wallet with testnet OKB: https://www.okx.com/xlayer/faucet
 */

import { execSync } from "child_process";
import type { Address, Hex } from "viem";
import { runDemo } from "./demo-runner.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC        = "https://testrpc.xlayer.tech/terigon";
const SERVER_KEY = process.env["SERVER_KEY"] as Hex | undefined;

// ─── Validate env ─────────────────────────────────────────────────────────────

if (!SERVER_KEY) {
  console.error("\n  ✗  SERVER_KEY env var is required.");
  console.error("     Export a wallet private key that holds testnet OKB:");
  console.error("     export SERVER_KEY=0x<your_key>\n");
  console.error("     Get testnet OKB from: https://www.okx.com/xlayer/faucet\n");
  process.exit(1);
}

// ─── Deploy via forge ─────────────────────────────────────────────────────────

function forgeCreate(contract: string): Address {
  console.log(`\n\x1b[90m  → Running: forge create ${contract} --rpc-url <testnet> --via-ir\x1b[0m`);

  const output = execSync(
    [
      "forge create",
      `contracts/${contract}.sol:${contract}`,
      `--rpc-url ${RPC}`,
      `--private-key ${SERVER_KEY}`,
      "--via-ir",
      "--optimizer-runs 200",
    ].join(" "),
    { encoding: "utf-8" }
  );

  // Parse "Deployed to: 0x..." from forge output
  const match = output.match(/Deployed to:\s+(0x[0-9a-fA-F]{40})/);
  if (!match?.[1]) throw new Error(`Could not parse deployed address from forge output:\n${output}`);

  const address = match[1] as Address;

  // Print relevant forge output lines
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("Deployer:") ||
      trimmed.startsWith("Deployed to:") ||
      trimmed.startsWith("Transaction hash:")
    ) {
      console.log(`\x1b[90m     ${trimmed}\x1b[0m`);
    }
  }

  return address;
}

// ─── Deploy XLayerMPPChannel and start demo ───────────────────────────────────

console.log("\n\x1b[1m\x1b[36m  Deploying XLayerMPPChannel via forge...\x1b[0m");
const channelContract = forgeCreate("XLayerMPPChannel");

await runDemo({
  network:     "testnet",
  chain: {
    id:             1952,
    name:           "XLayer Testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls:        { default: { http: [RPC] } },
  },
  rpcUrl:          RPC,
  explorerUrl:     "https://www.okx.com/web3/explorer/xlayer-test",
  serverKey:       SERVER_KEY,
  channelContract,   // freshly deployed by forge above — runner skips re-deploy
});
