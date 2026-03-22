import { z } from "zod";

// ─── Shared primitives ────────────────────────────────────────────────────────

const HexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid checksummed EVM address");

const HexString = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "Must be a 0x-prefixed hex string");

const NetworkSchema = z.enum(["mainnet", "testnet"]);

// ─── Charge ──────────────────────────────────────────────────────────────────

/**
 * HTTP 402 challenge the server sends when payment is required for a Charge.
 * Always pull mode: client signs the tx, server broadcasts and covers OKB gas.
 */
export const ChargeChallengeSchema = z.object({
  amount: z.string().describe("Decimal-string amount, e.g. '1.50'"),
  currency: z.enum(["USDC", "OKB"]),
  recipient: HexAddress,
  description: z.string().optional(),
  externalId: z.string().optional(),
  methodDetails: z.object({
    decimals: z.number().int().nonnegative(),
    tokenAddress: HexAddress,
    network: NetworkSchema,
    /** Unique UUID that ties challenge → credential → receipt. */
    reference: z.string().uuid(),
  }),
});

export type ChargeChallenge = z.infer<typeof ChargeChallengeSchema>;

/**
 * Client response to a ChargeChallenge.
 * Pull mode only: client returns a signed-but-not-broadcast RLP-encoded tx.
 * The server broadcasts it and pays OKB gas.
 */
export const ChargeCredentialSchema = z.object({
  transaction: HexString.describe("RLP-encoded signed transaction hex"),
});

export type ChargeCredential = z.infer<typeof ChargeCredentialSchema>;

export const ChargeReceiptSchema = z.object({
  txHash: HexString,
  blockNumber: z.string().describe("Block number as a decimal string"),
  network: NetworkSchema,
});

export type ChargeReceipt = z.infer<typeof ChargeReceiptSchema>;

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * HTTP 402 challenge for session-based streaming payments.
 * Uses pure off-chain EIP-712 vouchers — no on-chain channel contract required.
 */
export const SessionChallengeSchema = z.object({
  /** Undefined on first open; server may re-issue with channelId after open. */
  channelId: z.string().optional(),
  recipient: HexAddress,
  /** ERC-20 token address used for settlement (e.g. USDC). */
  asset: HexAddress,
  /** Cost per request, as a decimal string in the token's native unit. */
  amount: z.string(),
  methodDetails: z.object({
    network: NetworkSchema,
    channelProgram: z.literal("offchain-eip712"),
    /** Server-generated nonce to bind credential to this challenge. */
    serverNonce: z.string(),
  }),
});

export type SessionChallenge = z.infer<typeof SessionChallengeSchema>;

/**
 * Off-chain EIP-712 voucher authorising the server to claim `cumulativeAmount`
 * from the client's deposited balance. Monotonically increasing sequence
 * replaces on-chain state.
 */
export const SessionVoucherSchema = z.object({
  channelId: z.string(),
  payer: HexAddress,
  recipient: HexAddress,
  asset: HexAddress,
  /** Running total authorised, as a decimal bigint string (no floating point). */
  cumulativeAmount: z.string(),
  sequence: z.number().int().nonnegative(),
  serverNonce: z.string(),
  /** Unix timestamp (seconds). Undefined means the voucher never expires. */
  expiresAt: z.number().int().optional(),
  chainId: z.union([z.literal(196), z.literal(1952)]),
});

export type SessionVoucher = z.infer<typeof SessionVoucherSchema>;

export const SessionCredentialSchema = z.object({
  action: z.enum(["open", "update", "topup", "close"]),
  voucher: SessionVoucherSchema,
  /** EIP-712 signature over the voucher, produced by the payer's wallet. */
  signature: HexString,
  /** Required for "open" and "topup" actions to prove on-chain deposit. */
  depositTxHash: HexString.optional(),
});

export type SessionCredential = z.infer<typeof SessionCredentialSchema>;

export const SessionReceiptSchema = z.object({
  channelId: z.string(),
  sequence: z.number().int().nonnegative(),
  /** Total amount the server is authorised to settle, as a decimal string. */
  authorizedAmount: z.string(),
});

export type SessionReceipt = z.infer<typeof SessionReceiptSchema>;
