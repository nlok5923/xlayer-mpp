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
  PAYMENT_CHANNEL_ABI,
  RPC_URLS,
  XLAYER_MAINNET_CHAIN_ID,
  XLAYER_TESTNET_CHAIN_ID,
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
  /** Address of the XLayerMPPChannel contract used to open this channel. */
  contractAddress: Address;
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
  /**
   * When auto-opening a channel, deposit this many times the request amount.
   * E.g. 10 means deposit 10× upfront so the first N requests need no topup.
   * Default: 10.
   */
  depositMultiplier?: number;
  /**
   * Address of the deployed XLayerMPPChannel escrow contract.
   * The client uses this to call approve() + open() / topup() on-chain.
   * If not provided, it is read from the challenge's methodDetails.contractAddress.
   */
  channelContractAddress?: Address;
}

export class XLayerSessionClient {
  private readonly walletClient: WalletClient;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly network: XLayerNetwork;
  private readonly autoOpen: boolean;
  private readonly autoTopup: boolean;
  private readonly depositMultiplier: bigint;
  private readonly channelContractAddress: Address | undefined;

  /** In-memory channel state. A production client would persist this. */
  private channel: ClientChannelState | null = null;

  constructor(config: SessionClientConfig) {
    this.walletClient = config.walletClient;
    this.network = config.network ?? "mainnet";
    this.autoOpen = config.autoOpen ?? true;
    this.autoTopup = config.autoTopup ?? false;
    this.depositMultiplier = BigInt(config.depositMultiplier ?? 10);
    this.channelContractAddress = config.channelContractAddress;

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
      // Deposit multiplier × requestAmount upfront so subsequent requests
      // don't need a topup immediately. First voucher only authorises requestAmount.
      const depositAmount = requestAmount * this.depositMultiplier;
      return this.openChannel(challenge, depositAmount, requestAmount);
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
   * 1. Approving the channel contract to spend `depositAmount` tokens.
   * 2. Calling contract.open() to lock funds in escrow (on-chain tx).
   * 3. Signing an initial voucher authorising only `firstRequestAmount`.
   *
   * Keeping deposit > firstRequestAmount means subsequent update vouchers
   * don't require an on-chain topup.
   */
  async openChannel(
    challenge: SessionChallenge,
    depositAmount: bigint,
    firstRequestAmount: bigint = depositAmount
  ): Promise<SessionCredential> {
    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const asset = challenge.asset as Address;
    const recipient = challenge.recipient as Address;
    const contractAddress = (this.channelContractAddress ??
      challenge.methodDetails.contractAddress) as Address;

    const channelId = challenge.channelId ?? crypto.randomUUID();

    // Step 1: Approve the contract to spend depositAmount
    const approveTxHash = await this.walletClient.sendTransaction({
      account,
      to: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [contractAddress, depositAmount],
      }),
      chain: this.walletClient.chain ?? null,
      value: 0n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveTxHash });

    // Step 2: Call contract.open() to lock funds in escrow
    const depositTxHash = await this.walletClient.sendTransaction({
      account,
      to: contractAddress,
      data: encodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        functionName: "open",
        args: [channelId, recipient, asset, depositAmount, 0n],
      }),
      chain: this.walletClient.chain ?? null,
      value: 0n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: depositTxHash });

    const sequence = 0;
    const cumulativeAmount = firstRequestAmount;

    const voucher = this.buildVoucher(
      challenge,
      channelId,
      cumulativeAmount,
      sequence,
      account.address,
      contractAddress
    );

    const signature = await signVoucher(voucher, this.walletClient, contractAddress);

    this.channel = {
      channelId,
      asset,
      recipient,
      cumulativeAmount,
      sequence,
      depositAmount,
      contractAddress,
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

    const { contractAddress, channelId, asset } = this.channel;

    // Step 1: Approve the contract to spend additionalAmount
    const approveTxHash = await this.walletClient.sendTransaction({
      account,
      to: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [contractAddress, additionalAmount],
      }),
      chain: this.walletClient.chain ?? null,
      value: 0n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveTxHash });

    // Step 2: Call contract.topup()
    const depositTxHash = await this.walletClient.sendTransaction({
      account,
      to: contractAddress,
      data: encodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        functionName: "topup",
        args: [channelId, additionalAmount],
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
   * The server will call contract.settle() after receiving this, distributing
   * funds from escrow according to the final authorised amount.
   */
  async closeChannel(challenge: SessionChallenge): Promise<SessionCredential> {
    if (!this.channel) {
      throw new Error("No open channel to close");
    }

    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const { contractAddress } = this.channel;
    const nextSequence = this.channel.sequence + 1;
    const voucher = this.buildVoucher(
      challenge,
      this.channel.channelId,
      this.channel.cumulativeAmount,
      nextSequence,
      account.address,
      contractAddress
    );

    const signature = await signVoucher(voucher, this.walletClient, contractAddress);

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

    const { contractAddress } = this.channel;
    const nextSequence = this.channel.sequence + 1;
    const voucher = this.buildVoucher(
      challenge,
      this.channel.channelId,
      newCumulative,
      nextSequence,
      account.address,
      contractAddress
    );

    const signature = await signVoucher(voucher, this.walletClient, contractAddress);

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
    payer: Address,
    _contractAddress: Address
  ): SessionVoucher {
    // Use actual chain ID from the wallet so it matches block.chainid on the network
    const chainId =
      this.walletClient.chain?.id ??
      (this.network === "mainnet" ? XLAYER_MAINNET_CHAIN_ID : XLAYER_TESTNET_CHAIN_ID);

    return {
      channelId,
      payer,
      recipient: challenge.recipient,
      asset: challenge.asset,
      cumulativeAmount: cumulativeAmount.toString(),
      sequence,
      serverNonce: challenge.methodDetails.serverNonce,
      chainId,
    };
  }
}
