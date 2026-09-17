// The tool surface: API first, with the sandbox store for the agent's own memory.
//
//   api_read            read state from an allow-listed API
//   api_request         change state through an allow-listed API
//   remember            write to the agent's own sandbox (never needs permission)
//   recall              read the sandbox back
//   list_actions        see what happened, and what is waiting on a human
//   request_autonomy    ask to be trusted with a class of action
//   finish              end the run
//
// api_request is the interesting one: policy decides whether it happens now (auto) or
// waits for a human (confirm). The agent does not choose, and cannot tell policy to
// hurry up — it can only ask, through an action a human has to approve.

export const TOOL_SPECS = [
  { name: "api_read", description: "GET an allow-listed API and read the current state.", args: { url: "string", headers: "object?" } },
  { name: "api_request", description: "Change state through an allow-listed API (POST/PUT/PATCH/DELETE). Policy decides whether it applies now or waits for human approval.", args: { url: "string", method: "string", body: "any", rationale: "string" } },
  { name: "remember", description: "Store a value in your own sandbox. Always available, never needs approval.", args: { key: "string", value: "any" } },
  { name: "recall", description: "Read your sandbox: one key, or every key with a prefix.", args: { key: "string?", prefix: "string?" } },
  { name: "list_actions", description: "See your actions: applied, awaiting a decision, declined, or reverted — with the human's reasons.", args: { status: "string?" } },
  { name: "request_autonomy", description: "Ask for autonomous use of a class of action. A human decides, once.", args: { class: "string", rationale: "string" } },
  { name: "finish", description: "Finish the run and report what you did and what awaits.", args: { summary: "string" } },
];

const MAX_BODY = 20_000;
const MAX_ACTIONS_PER_RUN = 12;
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export function createTools({ store, actions, policy, fetchImpl, isAllowed, clock = () => Date.now(), runId = null }) {
  let actedThisRun = 0;

  async function preview(url, method) {
    if (method === "DELETE") return null;
    try {
      const res = await fetchImpl(url, { method: "GET" });
      return { before: summarise((await res.text()).slice(0, 2_000)) };
    } catch (_) {
      return null;
    }
  }

  const handlers = {
    async api_read({ url, headers = {} }) {
      if (!isAllowed(url)) throw new Error(`api_read: ${url} is not on the allowlist`);
      const res = await fetchImpl(url, { method: "GET", headers });
      const text = await res.text();
      return { status: res.status, ok: res.ok, truncated: text.length > MAX_BODY, body: text.slice(0, MAX_BODY) };
    },

    async api_request({ url, method = "POST", body = null, rationale }) {
      if (!actions) throw new Error("api_request: no action log is attached in this context");
      const m = String(method).toUpperCase();
      if (!WRITE_METHODS.includes(m)) throw new Error(`api_request: use api_read for ${m}`);
      if (++actedThisRun > MAX_ACTIONS_PER_RUN) {
        throw new Error(`at most ${MAX_ACTIONS_PER_RUN} actions per run; finish and let the queue drain`);
      }
      const pv = await preview(url, m);
      const result = await actions.submit({
        runId, kind: "api", target: { url, method: m }, payload: body, rationale,
        preview: { ...(pv || {}), after: summarise(body) },
      });
      return result.mode === "auto"
        ? { mode: "auto", applied: true, status: result.applied?.status, body: result.applied?.body?.slice?.(0, 800) ?? null,
            note: "policy allowed this class to act autonomously; it is logged and reversible" }
        : { mode: "confirm", action_id: result.id, status: "awaiting human decision",
            note: "queued with your rationale; nothing has been sent" };
    },

    async remember({ key, value }) {
      const r = await store.set(key, value ?? null);
      return { ...r, note: "your own sandbox, always applied" };
    },

    async recall({ key, prefix } = {}) {
      if (key) return { key, value: await store.get(key) };
      const keys = await store.list();
      const want = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
      const values = {};
      for (const k of want.slice(0, 50)) values[k] = summarise(await store.get(k));
      return { keys: want, values };
    },

    async list_actions({ status } = {}) {
      if (!actions) return { autonomy: { enabled: false, autonomous_classes: [] }, actions: [] };
      const list = status === "pending" ? await actions.pending() : await actions.all();
      const policyView = policy ? await policy.view() : { enabled: false, autonomous: [] };
      return {
        autonomy: { enabled: policyView.enabled, autonomous_classes: policyView.autonomous },
        actions: list.slice(-40).map((a) => ({
          id: a.id, kind: a.kind, target: a.target, class: a.cls, mode: a.mode,
          status: a.status, rationale: a.rationale, human_reason: a.reason,
          applied: a.applied, decided: a.decided, reverted: a.reverted || null,
        })),
      };
    },

    async request_autonomy({ class: cls, rationale }) {
      if (!actions || !policy) throw new Error("request_autonomy: no policy is attached in this context");
      const result = await actions.submit({
        runId, kind: "policy", target: { cls }, payload: { level: "auto" },
        rationale: rationale || `asking for autonomy on ${cls}`,
        preview: { before: "confirm", after: "auto" },
      });
      return result.mode === "auto"
        ? { note: "this class already has autonomy", action_id: result.id }
        : { action_id: result.id, status: "awaiting human decision", note: "a human decides, once, and can revoke it" };
    },

    async finish({ summary }) {
      const pending = actions ? (await actions.pending()).length : 0;
      const v = policy ? await policy.view() : { autonomous: [] };
      return { finished: true, summary, at: clock(), awaiting_human: pending, autonomous_classes: v.autonomous };
    },
  };

  return {
    names: TOOL_SPECS.map((t) => t.name),
    spec: () => TOOL_SPECS.map((t) => `- ${t.name}(${Object.keys(t.args).join(", ")}): ${t.description}`).join("\n"),
    async run(name, args) {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      const started = clock();
      const result = await h(args || {});
      return { result, ms: clock() - started };
    },
  };
}

function summarise(v) {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
