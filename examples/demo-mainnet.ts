/**
 * @xlayer/mpp — Mainnet Demo
 *
 * Runs against XLayer mainnet (Chain ID 196) using the pre-deployed
 * XLayerMPPChannel contract.
 *
 * Usage:
 *   npm run demo:mainnet
 *
 * Prerequisites:
 *   - forge build --contracts contracts/ --out artifacts/
 *   - Server wallet (below) must hold OKB on XLayer mainnet for gas
 */

import { runDemo } from "./demo-runner.js";
import { PAYMENT_CHANNEL_ADDRESS } from "../src/constants.js";
import type { Hex } from "viem";

await runDemo({
  network:         "mainnet",
  chain: {
    id:              196,
    name:            "XLayer",
    nativeCurrency:  { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls:         { default: { http: ["https://rpc.xlayer.tech"] } },
  },
  rpcUrl:          "https://rpc.xlayer.tech",
  explorerUrl:     "https://www.okx.com/web3/explorer/xlayer",
  serverKey:       (process.env["SERVER_KEY"] ?? "0x0f1bda3ca54909f8aa1f37348c1a0f836175e3f376f990f35082c90893504b22") as Hex,
  // Pre-deployed on XLayer mainnet — no re-deployment needed
  channelContract: PAYMENT_CHANNEL_ADDRESS.mainnet,
});
