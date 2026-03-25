import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PAYMENT_CHANNEL_ABI,
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
  private readonly signerWallet: ReturnType<typeof createWalletClient>;
  private readonly chainId: number;

  constructor(config: SessionConfig) {
    this.config = {
      ...config,
      maxChannelDuration: config.maxChannelDuration ?? DEFAULT_MAX_CHANNEL_DURATION,
    };
    this.channelStore = new ChannelStore(config.store);

    const network = config.network;
    this.chainId =
      network === "mainnet" ? XLAYER_MAINNET_CHAIN_ID : XLAYER_TESTNET_CHAIN_ID;

    const chain = {
      id: this.chainId,
      name: network === "mainnet" ? "XLayer" : "XLayer Testnet",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URLS[network]] } },
    } as const;

    const transport = http(config.rpcUrl ?? RPC_URLS[network]);

    this.publicClient = createPublicClient({ chain, transport });

    const signerAccount = privateKeyToAccount(config.signerPrivateKey);
    this.signerWallet = createWalletClient({
      account: signerAccount,
      chain,
      transport,
    });
  }

  // ─── Challenge ───────────────────────────────────────────────────────────────

  /**
   * Generates an HTTP 402 session challenge.
   * `amount` is the per-request cost as a decimal string (e.g. "0.01" for 0.01 USDC).
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
        channelProgram: "onchain-eip712",
        serverNonce,
        contractAddress: this.config.channelContractAddress,
      },
    };
  }

  // ─── Credential ──────────────────────────────────────────────────────────────

  async handleCredential(
    challenge: SessionChallenge,
    credential: SessionCredential
  ): Promise<SessionReceipt> {
    const { voucher, action } = credential;
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

    const depositAmount = await this.verifyOpenTx(
      depositTxHash as Hex,
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

    const additionalDeposit = await this.verifyTopupTx(
      depositTxHash as Hex,
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

  /**
   * Closes the channel by calling contract.settle() on-chain.
   * Transfers the authorised amount to the recipient and refunds the remainder
   * to the payer — all from the contract's escrow.
   */
  private async handleClose(credential: SessionCredential): Promise<SessionReceipt> {
    const { voucher, signature } = credential;

    const updated = await this.channelStore.updateChannel(voucher.channelId, {
      status: "closing",
      lastAuthorizedAmount: BigInt(voucher.cumulativeAmount),
      lastSequence: voucher.sequence,
    });

    // Broadcast settle() to the channel contract
    const account = this.signerWallet.account;
    if (!account) throw new Error("Signer wallet must have an account");

    const settleTxHash = await this.signerWallet.sendTransaction({
      account,
      to: this.config.channelContractAddress as Address,
      data: encodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        functionName: "settle",
        args: [
          voucher.channelId,
          BigInt(voucher.cumulativeAmount),
          BigInt(voucher.sequence),
          voucher.serverNonce,
          BigInt(voucher.expiresAt ?? 0),
          BigInt(voucher.chainId),
          signature as Hex,
        ],
      }),
      chain: this.signerWallet.chain ?? null,
      value: 0n,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: settleTxHash });

    await this.channelStore.updateChannel(voucher.channelId, { status: "closed" });

    return {
      channelId: voucher.channelId,
      sequence: voucher.sequence,
      authorizedAmount: updated.lastAuthorizedAmount.toString(),
      settleTxHash,
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
    const valid = await verifyVoucher(
      voucher,
      signature,
      voucher.payer as Address,
      this.config.channelContractAddress as Address
    );
    if (!valid) {
      throw new Error("Invalid EIP-712 voucher signature");
    }
  }

  /**
   * Verifies a channel open transaction by checking for a ChannelOpened event
   * emitted by the XLayerMPPChannel contract. Returns the deposited amount.
   */
  private async verifyOpenTx(
    txHash: Hex,
    channelId: string
  ): Promise<bigint> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      throw new Error(`Open transaction reverted: ${txHash}`);
    }

    const contractAddress = this.config.channelContractAddress.toLowerCase();

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress) continue;

      try {
        const decoded = decodeEventLog({
          abi: PAYMENT_CHANNEL_ABI,
          eventName: "ChannelOpened",
          data: log.data,
          topics: log.topics,
        });

        if (decoded.args.channelId === channelId) {
          return decoded.args.depositAmount;
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      `No ChannelOpened event found for channelId ${channelId} in tx ${txHash}`
    );
  }

  /**
   * Verifies a channel top-up transaction by checking for a ChannelToppedUp event.
   * Returns the additional deposited amount.
   */
  private async verifyTopupTx(
    txHash: Hex,
    _channelId: string
  ): Promise<bigint> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      throw new Error(`Topup transaction reverted: ${txHash}`);
    }

    const contractAddress = this.config.channelContractAddress.toLowerCase();

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress) continue;

      try {
        const decoded = decodeEventLog({
          abi: PAYMENT_CHANNEL_ABI,
          eventName: "ChannelToppedUp",
          data: log.data,
          topics: log.topics,
        });

        return decoded.args.additionalAmount;
      } catch {
        continue;
      }
    }

    throw new Error(`No ChannelToppedUp event found in tx ${txHash}`);
  }
}
