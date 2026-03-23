import type { Address } from "viem";
import type { XLayerNetwork } from "../constants.js";

// ─── Channel State ────────────────────────────────────────────────────────────

export type ChannelStatus = "open" | "closing" | "closed";

/**
 * Server-side representation of a payment channel.
 * All amounts are in the ERC-20 token's smallest unit (i.e. already scaled by
 * decimals — no floating-point arithmetic here).
 */
export interface ChannelState {
  channelId: string;
  payer: Address;
  recipient: Address;
  /** ERC-20 token used for settlement (e.g. USDC on XLayer). */
  asset: Address;
  /** Total amount deposited on-chain. */
  depositAmount: bigint;
  /** Highest cumulativeAmount signed by the payer so far. */
  lastAuthorizedAmount: bigint;
  /** Amount already settled / claimed on-chain. */
  settledAmount: bigint;
  lastSequence: number;
  status: ChannelStatus;
  /** Unix timestamp (seconds) when the channel was opened. */
  createdAt: number;
  /** Optional expiry. Undefined = no expiry enforced. */
  expiresAt?: number;
}

// ─── Store Interface ──────────────────────────────────────────────────────────

/**
 * Key-value persistence abstraction.
 * Implementors can use in-memory Maps, Redis, SQLite, etc.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── ChannelStore Inputs ──────────────────────────────────────────────────────

export interface AuthorizeOpenInput {
  channelId: string;
  payer: Address;
  recipient: Address;
  asset: Address;
  depositAmount: bigint;
  expiresAt?: number;
}

export interface AuthorizeUpdateInput {
  channelId: string;
  /** New cumulative amount (must be > lastAuthorizedAmount). */
  cumulativeAmount: bigint;
  /** New sequence (must be > lastSequence). */
  sequence: number;
}

// ─── Server Configuration ─────────────────────────────────────────────────────

export interface SessionConfig {
  /** Token addresses the server will accept for settlement. */
  acceptedAssets: Address[];
  /** Server's settlement address (receives funds on claim). */
  recipient: Address;
  network: XLayerNetwork;
  store: Store;
  /** Maximum channel lifetime in seconds. Default: 7 days. */
  maxChannelDuration?: number;
  /** Override the RPC URL (useful for local testing against Anvil). */
  rpcUrl?: string;
}
