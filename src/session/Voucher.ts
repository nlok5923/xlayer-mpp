import {
  verifyTypedData,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { EIP712_DOMAIN_BASE, XLAYER_MAINNET_CHAIN_ID } from "../constants.js";
import type { SessionVoucher } from "../Methods.js";

// ─── EIP-712 Type Definitions ─────────────────────────────────────────────────

/**
 * EIP-712 typed data types for SessionVoucher.
 * Must exactly mirror the fields in `SessionVoucher` that get signed.
 */
export const SESSION_VOUCHER_TYPES = {
  SessionVoucher: [
    { name: "channelId", type: "string" },
    { name: "payer", type: "address" },
    { name: "recipient", type: "address" },
    { name: "asset", type: "address" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "sequence", type: "uint256" },
    { name: "serverNonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

// ─── Domain Builder ───────────────────────────────────────────────────────────

function buildDomain(chainId: number = XLAYER_MAINNET_CHAIN_ID, verifyingContract?: Address) {
  return {
    ...EIP712_DOMAIN_BASE,
    chainId,
    ...(verifyingContract ? { verifyingContract } : {}),
  } as const;
}

// ─── Voucher Message Builder ──────────────────────────────────────────────────

/**
 * Converts SessionVoucher to the EIP-712 message object.
 * `cumulativeAmount` is kept as a bigint for ABI encoding; `expiresAt`
 * defaults to 0 (meaning "no expiry") if absent.
 */
function voucherToMessage(voucher: SessionVoucher) {
  return {
    channelId: voucher.channelId,
    payer: voucher.payer as Address,
    recipient: voucher.recipient as Address,
    asset: voucher.asset as Address,
    cumulativeAmount: BigInt(voucher.cumulativeAmount),
    sequence: BigInt(voucher.sequence),
    serverNonce: voucher.serverNonce,
    expiresAt: BigInt(voucher.expiresAt ?? 0),
    chainId: BigInt(voucher.chainId),
  } as const;
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

/**
 * Signs a SessionVoucher using EIP-712 typed data.
 * The wallet client must have an account attached.
 */
export async function signVoucher(
  voucher: SessionVoucher,
  walletClient: WalletClient,
  /** Include the contract address in the EIP-712 domain for on-chain verification. */
  contractAddress?: Address
): Promise<Hex> {
  if (!walletClient.account) {
    throw new Error("WalletClient must have an account to sign vouchers");
  }

  return walletClient.signTypedData({
    account: walletClient.account,
    domain: buildDomain(voucher.chainId, contractAddress),
    types: SESSION_VOUCHER_TYPES,
    primaryType: "SessionVoucher",
    message: voucherToMessage(voucher),
  });
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Verifies an EIP-712 signature over a SessionVoucher.
 * Returns true only if the recovered signer matches `expectedPayer`.
 * Also checks that the voucher has not expired (if expiresAt is set).
 */
export async function verifyVoucher(
  voucher: SessionVoucher,
  signature: Hex,
  expectedPayer: Address,
  /** Must match the contractAddress used during signing for on-chain verification. */
  contractAddress?: Address
): Promise<boolean> {
  // Reject expired vouchers before bothering with crypto
  if (voucher.expiresAt !== undefined) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > voucher.expiresAt) {
      return false;
    }
  }

  try {
    // verifyTypedData in viem v2 is async
    const valid = await verifyTypedData({
      address: expectedPayer,
      domain: buildDomain(voucher.chainId, contractAddress),
      types: SESSION_VOUCHER_TYPES,
      primaryType: "SessionVoucher",
      message: voucherToMessage(voucher),
      signature,
    });
    return valid;
  } catch {
    return false;
  }
}
