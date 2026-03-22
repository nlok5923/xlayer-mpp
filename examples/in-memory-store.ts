/**
 * A simple in-memory Store implementation for local development and examples.
 * In production, replace with a Redis or SQLite-backed store.
 */
import type { Store } from "../src/session/Types.js";

export function createMemoryStore(): Store {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}
