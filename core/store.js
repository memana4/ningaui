// Sandboxed key-value store for the agent, plus a run journal.
// The agent can only see its own namespace. Nothing else in the browser is reachable.
//
// Backends: any object with { get(keys), set(obj), remove(keys) } that returns promises.
// chrome.storage.local satisfies that shape; so does the in-memory stub used by tests.

const NS = "agent:";          // every agent key lives under this prefix
const JOURNAL = "journal:";   // run records, same store, different prefix

export function createStore(backend) {
  const full = (k) => NS + k;

  return {
    async list() {
      const all = await backend.get(null);
      return Object.keys(all)
        .filter((k) => k.startsWith(NS))
        .map((k) => k.slice(NS.length))
        .sort();
    },

    async get(key) {
      const all = await backend.get(full(key));
      return all[full(key)] === undefined ? null : all[full(key)];
    },

    async set(key, value) {
      if (typeof key !== "string" || key.length === 0) throw new Error("storage_set: key required");
      if (key.length > 200) throw new Error("storage_set: key too long");
      const encoded = JSON.stringify(value ?? null);
      if (encoded.length > 256_000) throw new Error("storage_set: value over 256 kB, use several keys");
      await backend.set({ [full(key)]: value ?? null });
      return { ok: true, key, bytes: encoded.length };
    },

    async delete(key) {
      await backend.remove(full(key));
      return { ok: true, key };
    },

    async journal(runId, entry) {
      const key = JOURNAL + runId;
      const all = await backend.get(key);
      const log = (all[key] || []).concat([{ t: Date.now(), ...entry }]);
      await backend.set({ [key]: log.slice(-500) });
      return log.length;
    },

    async readJournal(runId) {
      const key = JOURNAL + runId;
      const all = await backend.get(key);
      return all[key] || [];
    },
  };
}
