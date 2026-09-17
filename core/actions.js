// The action log — everything the agent did or wants to do.
//
// Two paths through the same record:
//
//   auto     applied immediately by the agent, because policy says this class is earned:
//            recorded, journaled, and reversible from the panel
//   confirm  queued with a rationale and a preview, until a human approves or declines
//
// Nothing reaches the world any other way. There is no third path.

const A = "action:";
const AUDIT = "audit:";
export const MAX_PENDING = 200;
export const MAX_PAYLOAD = 64_000;

let seq = 0;
const newId = (clock) => `a-${clock().toString(36)}-${(seq++).toString(36)}`;

export function createActions({ backend, store, fetchImpl, isAllowed, policy, clock = () => Date.now() }) {
  const all = async () => {
    const dump = await backend.get(null);
    return Object.entries(dump)
      .filter(([k]) => k.startsWith(A))
      .map(([, v]) => v)
      .sort((a, b) => a.created - b.created);
  };
  const put = async (a) => { await backend.set({ [A + a.id]: a }); return a; };

  const audit = async (entry) => {
    const cur = (await backend.get(AUDIT + "log"))[AUDIT + "log"] || [];
    const next = cur.concat([{ t: clock(), ...entry }]).slice(-1000);
    await backend.set({ [AUDIT + "log"]: next });
    return next;
  };

  function validate({ kind, target, payload, rationale }) {
    if (!rationale || String(rationale).trim().length < 3) throw new Error("refused: a rationale is required");
    if (!["api", "store", "policy"].includes(kind)) throw new Error(`refused: unknown kind ${kind}`);
    if (JSON.stringify(payload ?? null).length > MAX_PAYLOAD) throw new Error("refused: payload too large");
    if (kind === "store") {
      if (!target || typeof target.key !== "string" || !target.key.trim()) throw new Error("refused: store actions need target.key");
    } else if (kind === "api") {
      if (!target || typeof target.url !== "string") throw new Error("refused: api actions need target.url");
      if (!isAllowed(target.url)) throw new Error(`refused: ${target.url} is not on the allowlist`);
    } else if (kind === "policy") {
      if (!target || typeof target.cls !== "string") throw new Error("refused: policy actions need target.cls");
    }
  }

  // The single entry point. Policy decides the mode; this function honours it.
  async function submit({ kind, target, payload = null, rationale, runId = null, preview = null }) {
    validate({ kind, target, payload, rationale });
    const cls = policy.classFor({ kind, target });
    const verdict = await policy.decide({ kind, target });

    if (verdict.level === "deny") {
      await audit({ action: "denied", cls, target, runId, why: verdict.why });
      throw new Error(`refused by policy: ${verdict.why}`);
    }

    const pendingN = (await all()).filter((a) => a.status === "pending").length;
    if (verdict.level === "confirm" && pendingN >= MAX_PENDING) {
      throw new Error(`refused: ${MAX_PENDING} actions already awaiting your decision`);
    }

    const action = await put({
      id: newId(clock), runId, kind, target, payload, rationale: String(rationale).trim(),
      cls, mode: verdict.level, policyWhy: verdict.why, preview,
      status: verdict.level === "auto" ? "applying" : "pending",
      created: clock(), decided: null, reason: null, by: null, applied: null,
    });
    await policy.noteProposed(action);
    await audit({ action: verdict.level === "auto" ? "auto" : "created", id: action.id, cls, mode: action.mode, why: verdict.why, runId });

    if (verdict.level === "auto") return apply(action, { autonomous: true });
    return action;
  }

  async function apply(action, { autonomous = false } = {}) {
    // A refusal that happens before anything is attempted — a URL no longer on the
    // allowlist, say — must not consume an approval. The action goes back to pending with
    // the reason attached, so the configuration can be fixed and the decision retried.
    try {
      preflight(action);
    } catch (err) {
      const why = `apply refused: ${err.message}`;
      const held = await put({ ...action, status: "pending", policyWhy: why });
      await audit({ action: "held", id: action.id, cls: action.cls, why });
      return held;
    }

    let applied;
    try {
      applied = await execute(action);
    } catch (err) {
      const failed = await put({ ...action, status: "failed", applied: { error: String(err.message || err) } });
      const change = await policy.noteApplied(failed, { ok: false, error: String(err.message || err) });
      await audit({ action: "failed", id: action.id, cls: action.cls, error: String(err.message || err) });
      return { ...failed, policyChange: change };
    }
    const done = await put({ ...action, status: "applied", applied, decided: clock(), by: autonomous ? "policy" : "human" });
    const change = await policy.noteApplied(done, { ok: true });
    await audit({ action: "applied", id: action.id, cls: action.cls, mode: action.mode, applied });
    return { ...done, policyChange: change };
  }

  function preflight(action) {
    if (action.kind === "api" && !isAllowed(action.target.url)) {
      throw new Error(`${action.target.url} is no longer on the allowlist`);
    }
  }

  async function execute(action) {
    if (action.kind === "store") {
      if (action.payload === null || action.payload === undefined) {
        await store.delete(action.target.key);
        return { kind: "store", key: action.target.key, action: "delete" };
      }
      const r = await store.set(action.target.key, action.payload);
      return { kind: "store", key: action.target.key, action: "set", bytes: r.bytes };
    }

    if (action.kind === "policy") {
      const rec = await policy.setLevel(action.target.cls, action.payload.level || "auto",
        action.rationale);
      return { kind: "policy", cls: rec.cls, level: rec.level };
    }

    // re-check at apply time: the configuration may have changed since the decision
    if (!isAllowed(action.target.url)) throw new Error(`apply refused: ${action.target.url} is no longer on the allowlist`);
    const res = await fetchImpl(action.target.url, {
      method: action.target.method,
      headers: { "content-type": "application/json", ...(action.target.headers || {}) },
      body: action.payload === null || action.payload === undefined ? undefined : JSON.stringify(action.payload),
    });
    const text = (await res.text()).slice(0, 4_000);
    return { kind: "api", status: res.status, ok: res.ok, body: text };
  }

  // ---- human decisions ------------------------------------------------------
  async function decide(id, { decision, reason = "", by = "human" } = {}) {
    const key = A + id;
    const a = (await backend.get(key))[key];
    if (!a) throw new Error(`no action ${id}`);
    if (a.status !== "pending") throw new Error(`action ${id} is already ${a.status}`);
    if (decision !== "approve" && decision !== "decline") throw new Error("decision must be approve or decline");
    if (decision === "decline" && !String(reason).trim()) throw new Error("declined actions need a reason");

    if (decision === "decline") {
      const d = await put({ ...a, status: "declined", decided: clock(), reason: String(reason).trim(), by });
      const change = await policy.noteDecision(d, "decline");
      await audit({ action: "decline", id, reason: d.reason, by, policyChange: change.changed ? change.why : null });
      return { ...d, policyChange: change };
    }
    const change = await policy.noteDecision(a, "approve");
    const applied = await apply({ ...a, decided: clock(), by }, { autonomous: false });
    return { ...applied, policyChange: applied.policyChange?.changed ? applied.policyChange : change };
  }

  // ---- reverting ------------------------------------------------------------
  // Storage and policy actions undo cleanly. An API call usually cannot: we record
  // the state we saw before applying, mark it reverted, and revoke autonomy on the
  // class either way, so the same mistake cannot repeat unattended.
  async function revert(id, { reason = "" } = {}) {
    const key = A + id;
    const a = (await backend.get(key))[key];
    if (!a) throw new Error(`no action ${id}`);
    if (!["applied", "failed"].includes(a.status)) throw new Error(`action ${id} is ${a.status}, nothing to revert`);
    if (a.status === "failed") throw new Error(`action ${id} never applied`);

    let undone = null;
    if (a.kind === "store") {
      if (a.preview && "before" in a.preview && a.preview.before !== null) {
        await store.set(a.target.key, a.preview.before);
        undone = { restored: a.target.key };
      } else {
        await store.delete(a.target.key);
        undone = { deleted: a.target.key };
      }
    } else if (a.kind === "policy") {
      await policy.setLevel(a.target.cls, "confirm", `reverted: ${reason || "no reason given"}`);
      undone = { level: "confirm", cls: a.target.cls };
    } else {
      undone = { manual: true, before: a.preview?.before ?? null, note: "API changes are not generically reversible; the pre-apply state is recorded here" };
    }

    const r = await put({ ...a, status: "reverted", reason: String(reason).trim() || a.reason, reverted: clock() });
    const change = await policy.noteReverted(r, reason);
    await audit({ action: "reverted", id, undone, reason, policyChange: change.changed ? change.why : null });
    return { ...r, undone, policyChange: change };
  }

  return {
    submit, apply, execute, decide, revert, all,
    pending: async () => (await all()).filter((a) => a.status === "pending"),
    recent: async (n = 50) => (await all()).filter((a) => a.status !== "pending").slice(-n).reverse(),
    autonomous: async () => (await all()).filter((a) => a.mode === "auto"),
    get: async (id) => (await backend.get(A + id))[A + id] || null,
    auditLog: async () => (await backend.get(AUDIT + "log"))[AUDIT + "log"] || [],
    clearDecided: async () => {
      const done = (await all()).filter((a) => a.status !== "pending");
      if (done.length) await backend.remove(done.map((a) => A + a.id));
      return done.length;
    },
  };
}
