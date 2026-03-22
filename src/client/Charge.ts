import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { ERC20_ABI, RPC_URLS, type XLayerNetwork } from "../constants.js";
import type { ChargeChallenge, ChargeCredential } from "../Methods.js";

// ─── XLayerChargeClient ───────────────────────────────────────────────────────

export interface ChargeClientConfig {
  rpcUrl?: string;
  network?: XLayerNetwork;
  walletClient: WalletClient;
}

export class XLayerChargeClient {
  private readonly walletClient: WalletClient;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly network: XLayerNetwork;

  constructor(config: ChargeClientConfig) {
    this.walletClient = config.walletClient;
    this.network = config.network ?? "mainnet";

    const rpcUrl = config.rpcUrl ?? RPC_URLS[this.network];
    this.publicClient = createPublicClient({ transport: http(rpcUrl) });
  }

  /**
   * Responds to an HTTP 402 ChargeChallenge (pull mode).
   * Signs the ERC-20 transfer tx without broadcasting — the server broadcasts
   * it and covers OKB gas.
   */
  async handleChallenge(challenge: ChargeChallenge): Promise<ChargeCredential> {
    const account = this.walletClient.account;
    if (!account) {
      throw new Error("WalletClient must have an account attached");
    }

    const { tokenAddress, decimals } = challenge.methodDetails;
    const recipient = challenge.recipient as Address;
    const amountRaw = parseUnits(challenge.amount, decimals);

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipient, amountRaw],
    });

    const transaction = await this.signTransferTx({
      account,
      to: tokenAddress as Address,
      data,
    });

    return { transaction };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  private async signTransferTx(params: {
    account: NonNullable<WalletClient["account"]>;
    to: Address;
    data: Hex;
  }): Promise<Hex> {
    const { account, to, data } = params;

    // Fetch nonce and gas estimate so the signed tx is immediately broadcastable
    const [nonce, gasPrice, gas] = await Promise.all([
      this.publicClient.getTransactionCount({ address: account.address }),
      this.publicClient.getGasPrice(),
      this.publicClient.estimateGas({ account: account.address, to, data }),
    ]);

    // signTransaction is available on WalletClient when an account is attached
    const signed = await this.walletClient.signTransaction({
      account,
      to,
      data,
      nonce,
      gasPrice,
      gas,
      chain: this.walletClient.chain ?? null,
      // value is 0 — this is a token transfer, not a native transfer
      value: 0n,
    });

    return signed;
  }
}
