import { Mutex } from "async-mutex";
import type { ChannelState, Store } from "./Types.js";

const CHANNEL_KEY_PREFIX = "xlayer-mpp:channel:";

function channelKey(channelId: string): string {
  return `${CHANNEL_KEY_PREFIX}${channelId}`;
}

// ─── ChannelStore ─────────────────────────────────────────────────────────────

/**
 * Thread-safe (per-channel) wrapper around a `Store` for ChannelState
 * persistence. Each channelId gets its own Mutex so concurrent updates to
 * different channels don't block each other.
 */
export class ChannelStore {
  private readonly store: Store;
  /** One mutex per channel to prevent interleaved read-modify-write cycles. */
  private readonly mutexes = new Map<string, Mutex>();

  constructor(store: Store) {
    this.store = store;
  }

  private getMutex(channelId: string): Mutex {
    let mutex = this.mutexes.get(channelId);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(channelId, mutex);
    }
    return mutex;
  }

  // ─── Serialization ──────────────────────────────────────────────────────────

  private serialize(state: ChannelState): string {
    // bigint cannot be directly JSON.stringify'd
    return JSON.stringify({
      ...state,
      depositAmount: state.depositAmount.toString(),
      lastAuthorizedAmount: state.lastAuthorizedAmount.toString(),
      settledAmount: state.settledAmount.toString(),
    });
  }

  private deserialize(raw: string): ChannelState {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(parsed as Omit<
        ChannelState,
        "depositAmount" | "lastAuthorizedAmount" | "settledAmount"
      >),
      depositAmount: BigInt(parsed["depositAmount"] as string),
      lastAuthorizedAmount: BigInt(parsed["lastAuthorizedAmount"] as string),
      settledAmount: BigInt(parsed["settledAmount"] as string),
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async getChannel(channelId: string): Promise<ChannelState | null> {
    const raw = await this.store.get(channelKey(channelId));
    if (raw === null) return null;
    return this.deserialize(raw);
  }

  /**
   * Atomically reads, merges `update`, and writes back the channel state.
   * Acquires the per-channel mutex to prevent concurrent writes.
   */
  async updateChannel(
    channelId: string,
    update: Partial<ChannelState>
  ): Promise<ChannelState> {
    const mutex = this.getMutex(channelId);
    return mutex.runExclusive(async () => {
      const existing = await this.getChannel(channelId);
      if (!existing) {
        throw new Error(`Channel not found: ${channelId}`);
      }
      const next: ChannelState = { ...existing, ...update };
      await this.store.set(channelKey(channelId), this.serialize(next));
      return next;
    });
  }

  /**
   * Creates a new channel entry. Throws if a channel with the same ID already
   * exists to prevent accidental overwrites.
   */
  async createChannel(state: ChannelState): Promise<ChannelState> {
    const mutex = this.getMutex(state.channelId);
    return mutex.runExclusive(async () => {
      const existing = await this.getChannel(state.channelId);
      if (existing) {
        throw new Error(`Channel already exists: ${state.channelId}`);
      }
      await this.store.set(channelKey(state.channelId), this.serialize(state));
      return state;
    });
  }

  /**
   * Atomically deducts from the channel's remaining available balance.
   *
   * "Available balance" = depositAmount - lastAuthorizedAmount.
   * Throws if the new cumulativeAmount would exceed the deposited funds.
   * This is a debit-check helper used during handleUpdate.
   */
  async deductFromChannel(
    channelId: string,
    newCumulativeAmount: bigint
  ): Promise<ChannelState> {
    const mutex = this.getMutex(channelId);
    return mutex.runExclusive(async () => {
      const state = await this.getChannel(channelId);
      if (!state) throw new Error(`Channel not found: ${channelId}`);
      if (state.status !== "open") {
        throw new Error(`Channel ${channelId} is not open (status: ${state.status})`);
      }
      if (newCumulativeAmount > state.depositAmount) {
        throw new Error(
          `Insufficient channel balance: requested ${newCumulativeAmount}, ` +
            `deposited ${state.depositAmount}`
        );
      }
      if (newCumulativeAmount <= state.lastAuthorizedAmount) {
        throw new Error(
          `cumulativeAmount must be strictly greater than lastAuthorizedAmount ` +
            `(got ${newCumulativeAmount}, last was ${state.lastAuthorizedAmount})`
        );
      }
      const next: ChannelState = {
        ...state,
        lastAuthorizedAmount: newCumulativeAmount,
      };
      await this.store.set(channelKey(channelId), this.serialize(next));
      return next;
    });
  }
}
