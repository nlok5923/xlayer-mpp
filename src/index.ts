// ─── Constants ────────────────────────────────────────────────────────────────
export {
  XLAYER_MAINNET_CHAIN_ID,
  XLAYER_TESTNET_CHAIN_ID,
  RPC_URLS,
  USDC_ADDRESS,
  BLOCK_EXPLORER_URL,
  ERC20_ABI,
  EIP712_DOMAIN_BASE,
} from "./constants.js";
export type { XLayerNetwork } from "./constants.js";

// ─── Zod Schemas & Types ──────────────────────────────────────────────────────
export {
  ChargeChallengeSchema,
  ChargeCredentialSchema,
  ChargeReceiptSchema,
  SessionChallengeSchema,
  SessionVoucherSchema,
  SessionCredentialSchema,
  SessionReceiptSchema,
} from "./Methods.js";
export type {
  ChargeChallenge,
  ChargeCredential,
  ChargeReceipt,
  SessionChallenge,
  SessionVoucher,
  SessionCredential,
  SessionReceipt,
} from "./Methods.js";

// ─── Session: Types ───────────────────────────────────────────────────────────
export type {
  ChannelState,
  ChannelStatus,
  Store,
  AuthorizeOpenInput,
  AuthorizeUpdateInput,
  SessionConfig,
} from "./session/Types.js";

// ─── Session: Voucher ─────────────────────────────────────────────────────────
export {
  SESSION_VOUCHER_TYPES,
  signVoucher,
  verifyVoucher,
} from "./session/Voucher.js";

// ─── Session: ChannelStore ────────────────────────────────────────────────────
export { ChannelStore } from "./session/ChannelStore.js";

// ─── Server ───────────────────────────────────────────────────────────────────
export { XLayerChargeServer, XLayerSessionServer } from "./server/index.js";
export type { ChargeServerConfig } from "./server/index.js";

// ─── Client ───────────────────────────────────────────────────────────────────
export { XLayerChargeClient, XLayerSessionClient } from "./client/index.js";
export type { ChargeClientConfig, SessionClientConfig } from "./client/index.js";
