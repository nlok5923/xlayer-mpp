/**
 * @xlayer/mpp — Testnet Demo
 *
 * Runs against XLayer testnet (Chain ID 1952). Deploys a fresh
 * XLayerMPPChannel contract as part of setup (no pre-deployment needed).
 *
 * Usage:
 *   SERVER_KEY=0x<your_testnet_key> npm run demo:testnet
 *
 * Prerequisites:
 *   - forge build --contracts contracts/ --out artifacts/
 *   - SERVER_KEY env var: a wallet with testnet OKB for gas
 *   - Get testnet OKB from the XLayer faucet:
 *     https://www.okx.com/xlayer/faucet
 */

import { runDemo } from "./demo-runner.js";
import type { Hex } from "viem";

const SERVER_KEY = process.env["SERVER_KEY"] as Hex | undefined;

if (!SERVER_KEY) {
  console.error("\n  ✗  SERVER_KEY env var required for testnet demo.");
  console.error("     Export a wallet private key that holds testnet OKB:");
  console.error("     export SERVER_KEY=0x<your_key>\n");
  console.error("     Get testnet OKB: https://www.okx.com/xlayer/faucet\n");
  process.exit(1);
}

await runDemo({
  network:     "testnet",
  chain: {
    id:             1952,
    name:           "XLayer Testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls:        { default: { http: ["https://testrpc.xlayer.tech/terigon"] } },
  },
  rpcUrl:      "https://testrpc.xlayer.tech/terigon",
  explorerUrl: "https://www.okx.com/web3/explorer/xlayer-test",
  serverKey:   SERVER_KEY,
  // No channelContract provided → demo-runner deploys it fresh on testnet
});
