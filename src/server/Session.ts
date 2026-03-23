import {
  createPublicClient,
  decodeEventLog,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  ERC20_ABI,
  RPC_URLS,
  XLAYER_MAINNET_CHAIN_ID,
  XLAYER_TESTNET_CHAIN_ID,
} from "../constants.js";
import type {
  SessionChallenge,
  SessionCredential,
  SessionReceipt,
  SessionVoucher,
} from "../Methods.js";
import { ChannelStore } from "../session/ChannelStore.js";
import type { ChannelState, SessionConfig } from "../session/Types.js";
import { verifyVoucher } from "../session/Voucher.js";

const DEFAULT_MAX_CHANNEL_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds

// ─── XLayerSessionServer ──────────────────────────────────────────────────────

export class XLayerSessionServer {
  private readonly config: Required<Omit<SessionConfig, "rpcUrl">> & Pick<SessionConfig, "rpcUrl">;
  private readonly channelStore: ChannelStore;
  private readonly publicClient: ReturnType<typeof createPublicClient>;

  constructor(config: SessionConfig) {
    this.config = {
      ...config,
      maxChannelDuration: config.maxChannelDuration ?? DEFAULT_MAX_CHANNEL_DURATION,
    };
    this.channelStore = new ChannelStore(config.store);

    const network = config.network;
    const chainId =
      network === "mainnet" ? XLAYER_MAINNET_CHAIN_ID : XLAYER_TESTNET_CHAIN_ID;
    const chain = {
      id: chainId,
      name: network === "mainnet" ? "XLayer" : "XLayer Testnet",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URLS[network]] } },
    } as const;

    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl ?? RPC_URLS[network]),
    });
  }

  // ─── Challenge ───────────────────────────────────────────────────────────────

  /**
   * Generates an HTTP 402 session challenge.
   * `amount` is the per-request cost in the token's smallest unit as a
   * decimal string (e.g. "1000000" for 1 USDC with 6 decimals).
   */
  async createChallenge(params: {
    channelId?: string;
    amount: string;
    asset?: Address;
  }): Promise<SessionChallenge> {
    const asset = params.asset ?? this.config.acceptedAssets[0];
    if (!asset) {
      throw new Error("No accepted assets configured");
    }

    const serverNonce = crypto.randomUUID();

    return {
      ...(params.channelId !== undefined ? { channelId: params.channelId } : {}),
      recipient: this.config.recipient,
      asset,
      amount: params.amount,
      methodDetails: {
        network: this.config.network,
        channelProgram: "offchain-eip712",
        serverNonce,
      },
    };
  }

  // ─── Credential ──────────────────────────────────────────────────────────────

  async handleCredential(
    challenge: SessionChallenge,
    credential: SessionCredential
  ): Promise<SessionReceipt> {
    const { voucher, action } = credential;
    // The Zod schema validates the 0x-prefix; cast to viem's branded Hex type.
    const signature = credential.signature as Hex;

    this.validateVoucherMeta(challenge, voucher);
    await this.verifySignature(voucher, signature);

    switch (action) {
      case "open":
        return this.handleOpen(challenge, credential);
      case "update":
        return this.handleUpdate(credential);
      case "topup":
        return this.handleTopup(credential);
      case "close":
        return this.handleClose(credential);
      default:
        throw new Error(`Unknown session action: ${action as string}`);
    }
  }

  // ─── Action Handlers ──────────────────────────────────────────────────────────

  private async handleOpen(
    challenge: SessionChallenge,
    credential: SessionCredential
  ): Promise<SessionReceipt> {
    const { voucher, depositTxHash } = credential;

    if (!depositTxHash) {
      throw new Error("depositTxHash is required for action 'open'");
    }

    const depositAmount = await this.verifyDepositTx(
      depositTxHash as Hex,
      voucher.asset as Address,
      this.config.recipient,
      voucher.channelId
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const state: ChannelState = {
      channelId: voucher.channelId,
      payer: voucher.payer as Address,
      recipient: voucher.recipient as Address,
      asset: voucher.asset as Address,
      depositAmount,
      lastAuthorizedAmount: BigInt(voucher.cumulativeAmount),
      settledAmount: 0n,
      lastSequence: voucher.sequence,
      status: "open",
      createdAt: nowSeconds,
      ...(voucher.expiresAt !== undefined
        ? { expiresAt: voucher.expiresAt }
        : {
            expiresAt: nowSeconds + this.config.maxChannelDuration,
          }),
    };

    await this.channelStore.createChannel(state);

    return {
      channelId: voucher.channelId,
      sequence: voucher.sequence,
      authorizedAmount: voucher.cumulativeAmount,
    };
  }

  private async handleUpdate(credential: SessionCredential): Promise<SessionReceipt> {
    const { voucher } = credential;

    // sequence check + balance check + write all happen atomically inside the mutex
    const updated = await this.channelStore.authorizeUpdate(
      voucher.channelId,
      BigInt(voucher.cumulativeAmount),
      voucher.sequence
    );

    return {
      channelId: voucher.channelId,
      sequence: voucher.sequence,
      authorizedAmount: updated.lastAuthorizedAmount.toString(),
    };
  }

  private async handleTopup(credential: SessionCredential): Promise<SessionReceipt> {
    const { voucher, depositTxHash } = credential;

    if (!depositTxHash) {
      throw new Error("depositTxHash is required for action 'topup'");
    }

    const additionalDeposit = await this.verifyDepositTx(
      depositTxHash as Hex,
      voucher.asset as Address,
      this.config.recipient,
      voucher.channelId
    );

    const state = await this.channelStore.getChannel(voucher.channelId);
    if (!state) throw new Error(`Channel not found: ${voucher.channelId}`);

    const updated = await this.channelStore.updateChannel(voucher.channelId, {
      depositAmount: state.depositAmount + additionalDeposit,
    });

    return {
      channelId: voucher.channelId,
      sequence: state.lastSequence,
      authorizedAmount: updated.lastAuthorizedAmount.toString(),
    };
  }

  private async handleClose(credential: SessionCredential): Promise<SessionReceipt> {
    const { voucher } = credential;

    const updated = await this.channelStore.updateChannel(voucher.channelId, {
      status: "closing",
      lastAuthorizedAmount: BigInt(voucher.cumulativeAmount),
      lastSequence: voucher.sequence,
    });

    return {
      channelId: voucher.channelId,
      sequence: voucher.sequence,
      authorizedAmount: updated.lastAuthorizedAmount.toString(),
    };
  }

  // ─── Validation Helpers ────────────────────────────────────────────────────────

  private validateVoucherMeta(
    challenge: SessionChallenge,
    voucher: SessionVoucher
  ): void {
    if (
      voucher.recipient.toLowerCase() !== this.config.recipient.toLowerCase()
    ) {
      throw new Error(
        `Voucher recipient mismatch: got ${voucher.recipient}, ` +
          `expected ${this.config.recipient}`
      );
    }

    if (
      !this.config.acceptedAssets.some(
        (a) => a.toLowerCase() === voucher.asset.toLowerCase()
      )
    ) {
      throw new Error(`Asset not accepted: ${voucher.asset}`);
    }

    if (voucher.serverNonce !== challenge.methodDetails.serverNonce) {
      throw new Error("serverNonce mismatch — credential does not match challenge");
    }

    if (challenge.channelId !== undefined && voucher.channelId !== challenge.channelId) {
      throw new Error(
        `channelId mismatch: got ${voucher.channelId}, expected ${challenge.channelId}`
      );
    }
  }

  private async verifySignature(voucher: SessionVoucher, signature: Hex): Promise<void> {
    const valid = await verifyVoucher(voucher, signature, voucher.payer as Address);
    if (!valid) {
      throw new Error("Invalid EIP-712 voucher signature");
    }
  }

  /**
   * Fetches the deposit transaction receipt and confirms a Transfer event
   * whose `to` matches the server's recipient.
   * Returns the transferred amount in token base units.
   *
   * Note: the `channelId` parameter is intentionally not on-chain; it is only
   * used for logging / error context. The actual deposit verification is purely
   * balance-based (token Transfer event).
   */
  private async verifyDepositTx(
    txHash: Hex,
    asset: Address,
    recipient: Address,
    _channelId: string
  ): Promise<bigint> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      throw new Error(`Deposit transaction reverted: ${txHash}`);
    }

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== asset.toLowerCase()) continue;

      try {
        const decoded = decodeEventLog({
          abi: ERC20_ABI,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
        });

        if (decoded.args.to.toLowerCase() === recipient.toLowerCase()) {
          return decoded.args.value;
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      `No Transfer event found for recipient ${recipient} in tx ${txHash}`
    );
  }
}
