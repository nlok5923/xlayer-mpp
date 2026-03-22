import type { Abi, Address } from "viem";

// ─── Chain IDs ────────────────────────────────────────────────────────────────

export const XLAYER_MAINNET_CHAIN_ID = 196 as const;
export const XLAYER_TESTNET_CHAIN_ID = 1952 as const;

export type XLayerNetwork = "mainnet" | "testnet";

// ─── RPC Endpoints ───────────────────────────────────────────────────────────

export const RPC_URLS: Record<XLayerNetwork, string> = {
  mainnet: "https://rpc.xlayer.tech",
  testnet: "https://testrpc.xlayer.tech/terigon",
};

// ─── USDC Addresses ──────────────────────────────────────────────────────────

export const USDC_ADDRESS: Record<XLayerNetwork, Address> = {
  mainnet: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
  // Placeholder — replace when OKX publishes an official testnet USDC deployment
  testnet: "0x0000000000000000000000000000000000000000",
};

// ─── Block Explorer ───────────────────────────────────────────────────────────

export const BLOCK_EXPLORER_URL = "https://www.okx.com/web3/explorer/xlayer";

// ─── ERC-20 Minimal ABI ──────────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

// ─── EIP-712 Domain ───────────────────────────────────────────────────────────

/**
 * Base EIP-712 domain for session voucher signing.
 * chainId is injected at runtime depending on the active network.
 */
export const EIP712_DOMAIN_BASE = {
  name: "XLayerMPPSession",
  version: "1",
} as const;
