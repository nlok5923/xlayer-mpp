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
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
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

// ─── XLayerMPPChannel Contract ABI ───────────────────────────────────────────

export const PAYMENT_CHANNEL_ABI = [
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "string" },
      { name: "recipient", type: "address" },
      { name: "asset", type: "address" },
      { name: "depositAmount", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "topup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "string" },
      { name: "additionalAmount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "string" },
      { name: "cumulativeAmount", type: "uint256" },
      { name: "sequence", type: "uint256" },
      { name: "serverNonce", type: "string" },
      { name: "expiresAt", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "payerSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "expire",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "string" }],
    outputs: [],
  },
  {
    type: "event",
    name: "ChannelOpened",
    inputs: [
      { name: "channelKey", type: "bytes32", indexed: true },
      { name: "channelId", type: "string", indexed: false },
      { name: "payer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: false },
      { name: "depositAmount", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelToppedUp",
    inputs: [
      { name: "channelKey", type: "bytes32", indexed: true },
      { name: "additionalAmount", type: "uint256", indexed: false },
      { name: "newDepositAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelSettled",
    inputs: [
      { name: "channelKey", type: "bytes32", indexed: true },
      { name: "settledAmount", type: "uint256", indexed: false },
      { name: "refundAmount", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

/**
 * Placeholder addresses — replace with actual deployed contract addresses.
 * For local Anvil testing, the contract is deployed fresh each run.
 */
export const PAYMENT_CHANNEL_ADDRESS: Record<XLayerNetwork, Address> = {
  mainnet: "0x5f24b97e061d3FCe1E87A44be91a543Ef85Dfc89",
  testnet: "0x0000000000000000000000000000000000000000",
};

// ─── EIP-712 Domain ───────────────────────────────────────────────────────────

/**
 * Base EIP-712 domain for session voucher signing.
 * chainId is injected at runtime depending on the active network.
 */
export const EIP712_DOMAIN_BASE = {
  name: "XLayerMPPSession",
  version: "1",
} as const;
