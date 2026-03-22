import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseUnits,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC20_ABI,
  RPC_URLS,
  USDC_ADDRESS,
  XLAYER_MAINNET_CHAIN_ID,
  XLAYER_TESTNET_CHAIN_ID,
  type XLayerNetwork,
} from "../constants.js";
import type { ChargeChallenge, ChargeCredential, ChargeReceipt } from "../Methods.js";
import type { Store } from "../session/Types.js";

const CONSUMED_KEY_PREFIX = "xlayer-charge:consumed:";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildChain(network: XLayerNetwork) {
  const id = network === "mainnet" ? XLAYER_MAINNET_CHAIN_ID : XLAYER_TESTNET_CHAIN_ID;
  const rpcUrl = RPC_URLS[network];
  // Minimal viem chain definition — sufficient for RPC calls
  return {
    id,
    name: network === "mainnet" ? "XLayer" : "XLayer Testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
}

// ─── XLayerChargeServer ───────────────────────────────────────────────────────

export interface ChargeServerConfig {
  rpcUrl?: string;
  /** Hex-encoded private key (0x-prefixed). Used to broadcast txs in pull mode. */
  signerPrivateKey: Hex;
  store: Store;
  network?: XLayerNetwork;
}

export class XLayerChargeServer {
  private readonly account: PrivateKeyAccount;
  private readonly store: Store;
  private readonly network: XLayerNetwork;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(config: ChargeServerConfig) {
    this.network = config.network ?? "mainnet";
    this.store = config.store;
    this.account = privateKeyToAccount(config.signerPrivateKey);

    const chain = buildChain(this.network);
    const transport = http(config.rpcUrl ?? RPC_URLS[this.network]);

    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport,
    });
  }

  // ─── Challenge ───────────────────────────────────────────────────────────────

  /**
   * Generates an HTTP 402 charge challenge.
   * Defaults to pull mode (`feePayer: true`) so the server broadcasts the tx
   * and covers OKB gas — the client only needs to sign.
   */
  async createChallenge(params: {
    amount: string;
    currency?: "USDC" | "OKB";
    recipient: Address;
    description?: string;
    externalId?: string;
  }): Promise<ChargeChallenge> {
    const currency = params.currency ?? "USDC";

    const tokenAddress =
      currency === "USDC"
        ? USDC_ADDRESS[this.network]
        : ("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address);

    const decimals = currency === "USDC" ? 6 : 18;

    const challenge: ChargeChallenge = {
      amount: params.amount,
      currency,
      recipient: params.recipient,
      methodDetails: {
        decimals,
        tokenAddress,
        network: this.network,
        reference: crypto.randomUUID(),
      },
    };

    if (params.description !== undefined) challenge.description = params.description;
    if (params.externalId !== undefined) challenge.externalId = params.externalId;

    return challenge;
  }

  // ─── Credential ──────────────────────────────────────────────────────────────

  /**
   * Processes a client's credential for a charge challenge (pull mode only).
   * Broadcasts the signed tx, waits for receipt, verifies a Transfer event
   * matching the expected recipient and amount.
   *
   * Replay protection: each txHash is recorded in the store.
   */
  async handleCredential(
    challenge: ChargeChallenge,
    credential: ChargeCredential
  ): Promise<ChargeReceipt> {
    const txHash = await this.publicClient.sendRawTransaction({
      serializedTransaction: credential.transaction as Hex,
    });

    // Replay protection
    const consumedKey = `${CONSUMED_KEY_PREFIX}${txHash}`;
    const alreadyConsumed = await this.store.get(consumedKey);
    if (alreadyConsumed !== null) {
      throw new Error(`Transaction already consumed: ${txHash}`);
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      throw new Error(`Transaction reverted: ${txHash}`);
    }

    // Verify Transfer event matches challenge parameters
    const expectedAmount = parseUnits(
      challenge.amount,
      challenge.methodDetails.decimals
    );

    const transferEvent = receipt.logs
      .filter(
        (log) =>
          log.address.toLowerCase() ===
          challenge.methodDetails.tokenAddress.toLowerCase()
      )
      .map((log) => {
        try {
          return decodeEventLog({
            abi: ERC20_ABI,
            eventName: "Transfer",
            data: log.data,
            topics: log.topics,
          });
        } catch {
          return null;
        }
      })
      .find(
        (decoded) =>
          decoded !== null &&
          decoded.args.to.toLowerCase() === challenge.recipient.toLowerCase() &&
          decoded.args.value >= expectedAmount
      );

    if (!transferEvent) {
      throw new Error(
        `No valid Transfer event found for recipient ${challenge.recipient} ` +
          `with amount >= ${challenge.amount} ${challenge.currency}`
      );
    }

    // Mark as consumed — store the reference for auditability
    await this.store.set(consumedKey, challenge.methodDetails.reference);

    return {
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      network: this.network,
    };
  }
}
