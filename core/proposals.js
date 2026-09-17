// Proposal queue — the write path.
//
// Invariant: the agent has no write access to anything. It can read state (its own
// store, and allow-listed GETs) and it can *propose* a change. A proposal sits in
// the queue until a human approves or declines it with a reason. Only the apply
// step, which runs on human decision, touches the world.
//
// That gives three things at once: an audit trail of everything the agent wanted
// to do, a rate limit on runaway loops (the queue is capped), and a place for the
// human's reason to become context the agent reads on its next run.

const P = "proposal:";
const AUDIT = "audit:";
export const MAX_PENDING = 200;
export const MAX_PAYLOAD = 64_000;

let seq = 0;
const newId = (clock) => `p-${clock().toString(36)}-${(seq++).toString(36)}`;

export function createProposals({ backend, store, fetchImpl, isAllowed, clock = () => Date.now() }) {
  const all = async () => {
    const dump = await backend.get(null);
    return Object.entries(dump)
      .filter(([k]) => k.startsWith(P))
      .map(([, v]) => v)
      .sort((a, b) => a.created - b.created);
  };

  const put = async (p) => { await backend.set({ [P + p.id]: p }); return p; };

  const audit = async (entry) => {
    const key = AUDIT + "log";
    const cur = (await backend.get(key))[key] || [];
    const next = cur.concat([{ t: clock(), ...entry }]).slice(-1000);
    await backend.set({ [key]: next });
    return next;
  };

  async function create({ runId = null, kind, target, payload = null, rationale, preview = null }) {
    if (!rationale || rationale.trim().length < 3) throw new Error("proposal rejected: a rationale is required");
    if (kind !== "storage" && kind !== "api") throw new Error(`proposal rejected: unknown kind ${kind}`);
    if (JSON.stringify(payload ?? null).length > MAX_PAYLOAD) throw new Error("proposal rejected: payload too large");

    if (kind === "storage") {
      if (!target || typeof target.key !== "string" || !target.key.trim()) {
        throw new Error("proposal rejected: storage proposals need target.key");
      }
    } else {
      if (!target || typeof target.url !== "string") throw new Error("proposal rejected: api proposals need target.url");
      const method = (target.method || "POST").toUpperCase();
      if (method === "GET" || method === "HEAD") throw new Error("proposal rejected: reads are api_read, not a proposal");
      if (!isAllowed(target.url)) throw new Error(`proposal rejected: ${target.url} is not on the allowlist`);
      target = { ...target, method };
    }

    const pendingCount = (await all()).filter((p) => p.status === "pending").length;
    if (pendingCount >= MAX_PENDING) throw new Error(`proposal rejected: ${MAX_PENDING} proposals already pending review`);

    const p = await put({
      id: newId(clock), runId, kind, target, payload, rationale: rationale.trim(), preview,
      status: "pending", created: clock(), decided: null, reason: null, applied: null,
    });
    await audit({ action: "created", id: p.id, kind, target, runId });
    return p;
  }

  async function decide(id, { decision, reason = "", by = "human" } = {}) {
    const key = P + id;
    const p = (await backend.get(key))[key];
    if (!p) throw new Error(`no proposal ${id}`);
    if (p.status !== "pending") throw new Error(`proposal ${id} was already ${p.status}`);
    if (decision !== "approve" && decision !== "decline") throw new Error("decision must be approve or decline");
    if (decision === "decline" && !String(reason).trim()) throw new Error("declined proposals need a reason");

    let applied = null;
    if (decision === "approve") {
      applied = await apply(p);
    }

    const next = await put({
      ...p,
      status: decision === "approve" ? "approved" : "declined",
      decided: clock(), reason: String(reason).trim() || null, by, applied,
    });
    await audit({ action: decision, id, reason: next.reason, by });
    return next;
  }

  async function apply(p) {
    if (p.kind === "storage") {
      if (p.payload === null || p.payload === undefined) {
        await store.delete(p.target.key);
        return { kind: "storage", key: p.target.key, action: "delete" };
      }
      const r = await store.set(p.target.key, p.payload);
      return { kind: "storage", key: p.target.key, action: "set", bytes: r.bytes };
    }
    // Re-check the allowlist at apply time: the config may have changed since the
    // proposal was made, and the apply step is the one with real-world effect.
    if (!isAllowed(p.target.url)) throw new Error(`apply refused: ${p.target.url} is no longer on the allowlist`);
    const res = await fetchImpl(p.target.url, {
      method: p.target.method,
      headers: { "content-type": "application/json", ...(p.target.headers || {}) },
      body: p.payload === null ? undefined : JSON.stringify(p.payload),
    });
    const text = (await res.text()).slice(0, 4_000);
    return { kind: "api", status: res.status, ok: res.ok, body: text };
  }

  return {
    create,
    decide,
    apply,
    all,
    pending: async () => (await all()).filter((p) => p.status === "pending"),
    decided: async () => (await all()).filter((p) => p.status !== "pending"),
    get: async (id) => (await backend.get(P + id))[P + id] || null,
    auditLog: async () => (await backend.get(AUDIT + "log"))[AUDIT + "log"] || [],
    clearDecided: async () => {
      const done = await (async () => (await all()).filter((p) => p.status !== "pending"))();
      if (done.length) await backend.remove(done.map((p) => P + p.id));
      return done.length;
    },
  };
}
