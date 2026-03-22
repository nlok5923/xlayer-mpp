import {
  createPublicClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import {
  ERC20_ABI,
  RPC_URLS,
  XLAYER_MAINNET_CHAIN_ID,
  type XLayerNetwork,
} from "../constants.js";
import type {
  SessionChallenge,
  SessionCredential,
  SessionVoucher,
} from "../Methods.js";
import { signVoucher } from "../session/Voucher.js";

// ─── Client-side Channel State ────────────────────────────────────────────────

interface ClientChannelState {
  channelId: string;
  asset: Address;
  recipient: Address;
  /** Cumulative amount authorised so far (bigint in token base units). */
  cumulativeAmount: bigint;
  sequence: number;
  depositAmount: bigint;
}

// ─── XLayerSessionClient ──────────────────────────────────────────────────────

export interface SessionClientConfig {
  rpcUrl?: string;
  network?: XLayerNetwork;
  walletClient: WalletClient;
  /**
   * Automatically open a channel if none is active when a challenge is received.
   * Default: true.
   */
  autoOpen?: boolean;
  /**
   * Automatically top up the channel when balance is insufficient.
   * Default: false.
   */
  autoTopup?: boolean;
}

export class XLayerSessionClient {
  private readonly walletClient: WalletClient;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly network: XLayerNetwork;
  private readonly autoOpen: boolean;
  private readonly autoTopup: boolean;

  /** In-memory channel state. A production client would persist this. */
  private channel: ClientChannelState | null = null;

  constructor(config: SessionClientConfig) {
    this.walletClient = config.walletClient;
    this.network = config.network ?? "mainnet";
    this.autoOpen = config.autoOpen ?? true;
    this.autoTopup = config.autoTopup ?? false;

    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl ?? RPC_URLS[this.network]),
    });
  }

  // ─── Challenge Handler ────────────────────────────────────────────────────────

  /**
   * Responds to an HTTP 402 SessionChallenge.
   *
   * - If no channel is open and `autoOpen` is true: opens a new channel first,
   *   depositing enough to cover the initial request.
   * - Otherwise: signs a new voucher with an incremented sequence and updated
   *   cumulativeAmount, returning action "update".
   */
  async handleChallenge(
    challenge: SessionChallenge,
    /** The amount to pay for this specific request (in token base units). */
    requestAmount: bigint
  ): Promise<SessionCredential> {
    if (!this.channel) {
      if (!this.autoOpen) {
        throw new Error(
          "No open channel. Enable autoOpen or call openChannel() manually."
        );
      }
      return this.openChannel(challenge, requestAmount);
    }

    // Check if the channel has enough remaining balance
    const newCumulative = this.channel.cumulativeAmount + requestAmount;
    if (newCumulative > this.channel.depositAmount) {
      if (!this.autoTopup) {
        throw new Error(
          `Insufficient channel balance. Need ${newCumulative}, have ${this.channel.depositAmount}. ` +
            "Enable autoTopup or call topupChannel() manually."
        );
      }
      return this.topupChannel(challenge, requestAmount);
    }

    return this.signUpdate(challenge, newCumulative);
  }

  // ─── Open ─────────────────────────────────────────────────────────────────────

  /**
   * Opens a new payment channel by:
   * 1. Broadcasting a deposit tx to transfer tokens to the server's address.
   * 2. Signing an initial voucher (sequence 0, cumulativeAmount = requestAmount).
   */
  async openChannel(
    challenge: SessionChallenge,
    initialDepositAmount: bigint
  ): Promise<SessionCredential> {
    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const asset = challenge.asset as Address;
    const recipient = challenge.recipient as Address;

    // Broadcast deposit
    const depositTxHash = await this.walletClient.sendTransaction({
      account,
      to: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipient, initialDepositAmount],
      }),
      chain: this.walletClient.chain ?? null,
      value: 0n,
    });

    // Wait for deposit confirmation before signing the voucher
    await this.publicClient.waitForTransactionReceipt({ hash: depositTxHash });

    const channelId = challenge.channelId ?? crypto.randomUUID();
    const sequence = 0;
    const cumulativeAmount = initialDepositAmount;

    const voucher = this.buildVoucher(
      challenge,
      channelId,
      cumulativeAmount,
      sequence,
      account.address
    );

    const signature = await signVoucher(voucher, this.walletClient);

    this.channel = {
      channelId,
      asset,
      recipient,
      cumulativeAmount,
      sequence,
      depositAmount: initialDepositAmount,
    };

    return {
      action: "open",
      voucher,
      signature,
      depositTxHash,
    };
  }

  // ─── Topup ────────────────────────────────────────────────────────────────────

  /**
   * Tops up the existing channel's deposit when balance runs low.
   */
  async topupChannel(
    challenge: SessionChallenge,
    additionalAmount: bigint
  ): Promise<SessionCredential> {
    if (!this.channel) {
      throw new Error("No open channel to top up");
    }

    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const depositTxHash = await this.walletClient.sendTransaction({
      account,
      to: this.channel.asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [this.channel.recipient, additionalAmount],
      }),
      chain: this.walletClient.chain ?? null,
      value: 0n,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: depositTxHash });

    this.channel.depositAmount += additionalAmount;

    // Issue an update voucher with the incremented cumulative after topup
    const newCumulative = this.channel.cumulativeAmount + additionalAmount;
    return this.signUpdate(challenge, newCumulative, depositTxHash);
  }

  // ─── Close ────────────────────────────────────────────────────────────────────

  /**
   * Signals channel close by signing a final voucher with action "close".
   * The server should settle on-chain after receiving this.
   */
  async closeChannel(challenge: SessionChallenge): Promise<SessionCredential> {
    if (!this.channel) {
      throw new Error("No open channel to close");
    }

    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const nextSequence = this.channel.sequence + 1;
    const voucher = this.buildVoucher(
      challenge,
      this.channel.channelId,
      this.channel.cumulativeAmount,
      nextSequence,
      account.address
    );

    const signature = await signVoucher(voucher, this.walletClient);

    // Clear local state
    this.channel = null;

    return { action: "close", voucher, signature };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  private async signUpdate(
    challenge: SessionChallenge,
    newCumulative: bigint,
    depositTxHash?: Hex
  ): Promise<SessionCredential> {
    if (!this.channel) throw new Error("No open channel");

    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const nextSequence = this.channel.sequence + 1;
    const voucher = this.buildVoucher(
      challenge,
      this.channel.channelId,
      newCumulative,
      nextSequence,
      account.address
    );

    const signature = await signVoucher(voucher, this.walletClient);

    this.channel.cumulativeAmount = newCumulative;
    this.channel.sequence = nextSequence;

    return {
      action: depositTxHash ? "topup" : "update",
      voucher,
      signature,
      ...(depositTxHash ? { depositTxHash } : {}),
    };
  }

  private buildVoucher(
    challenge: SessionChallenge,
    channelId: string,
    cumulativeAmount: bigint,
    sequence: number,
    payer: Address
  ): SessionVoucher {
    return {
      channelId,
      payer,
      recipient: challenge.recipient,
      asset: challenge.asset,
      cumulativeAmount: cumulativeAmount.toString(),
      sequence,
      serverNonce: challenge.methodDetails.serverNonce,
      chainId: XLAYER_MAINNET_CHAIN_ID,
    };
  }
}
