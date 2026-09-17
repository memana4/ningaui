// The entire tool surface. Seven tools: four read, two propose, one finish.
//
// There is no direct write tool. Anything that changes state is a proposal that a
// human approves or declines, with a reason.

export const TOOL_SPECS = [
  { name: "storage_list", description: "List the keys in your own sandboxed store.", args: {} },
  { name: "storage_get", description: "Read a value from your own store by key.", args: { key: "string" } },
  { name: "api_read", description: "GET an allow-listed endpoint and read its state. Read-only.", args: { url: "string", headers: "object?" } },
  { name: "propose_storage_change", description: "Propose writing a value to your own store (or deleting it by passing value: null). A human reviews it.", args: { key: "string", value: "any", rationale: "string" } },
  { name: "propose_api_change", description: "Propose a non-GET request to an allow-listed endpoint. A human reviews it before it is sent.", args: { url: "string", method: "string", body: "any", rationale: "string" } },
  { name: "list_proposals", description: "See your proposals and the human's decision on each, including their reason.", args: { status: "string?" } },
  { name: "finish", description: "Finish the run and report to the user.", args: { summary: "string" } },
];

const MAX_BODY = 20_000;
const MAX_PROPOSALS_PER_RUN = 12;

export function createTools({ store, proposals, fetchImpl, isAllowed, clock = () => Date.now(), runId = null }) {
  let proposedThisRun = 0;

  const handlers = {
    async storage_list() { return { keys: await store.list() }; },
    async storage_get({ key }) { return { key, value: await store.get(key) }; },

    async api_read({ url, headers = {} }) {
      if (!isAllowed(url)) throw new Error(`api_read: ${url} is not on the allowlist`);
      const res = await fetchImpl(url, { method: "GET", headers });
      const text = await res.text();
      return { status: res.status, ok: res.ok, truncated: text.length > MAX_BODY, body: text.slice(0, MAX_BODY) };
    },

    async propose_storage_change({ key, value, rationale }) {
      if (++proposedThisRun > MAX_PROPOSALS_PER_RUN) {
        throw new Error(`at most ${MAX_PROPOSALS_PER_RUN} proposals per run; finish and let the human catch up`);
      }
      const before = await store.get(key);
      const p = await proposals.create({
        runId, kind: "storage", target: { key }, payload: value ?? null, rationale,
        preview: { before: summarise(before), after: summarise(value ?? null) },
      });
      return { proposal_id: p.id, status: "pending human review", note: "the value is unchanged until it is approved" };
    },

    async propose_api_change({ url, method = "POST", body = null, rationale }) {
      if (++proposedThisRun > MAX_PROPOSALS_PER_RUN) {
        throw new Error(`at most ${MAX_PROPOSALS_PER_RUN} proposals per run; finish and let the human catch up`);
      }
      let preview = null;
      try {
        const res = await fetchImpl(url, { method: "GET" });
        preview = { before: summarise((await res.text()).slice(0, 2_000)) };
      } catch (_) { /* preview is best-effort */ }
      const p = await proposals.create({
        runId, kind: "api", target: { url, method }, payload: body, rationale,
        preview: preview ? { ...preview, after: summarise(body) } : { after: summarise(body) },
      });
      return { proposal_id: p.id, status: "pending human review", note: "nothing has been sent yet" };
    },

    async list_proposals({ status } = {}) {
      if (!proposals) return { proposals: [] };
      const list = status === "pending" ? await proposals.pending() : await proposals.all();
      return {
        proposals: list.slice(-40).map((p) => ({
          id: p.id, kind: p.kind, target: p.target, status: p.status,
          rationale: p.rationale, human_reason: p.reason, decided: p.decided,
        })),
      };
    },

    async finish({ summary }) {
      const pend = proposals ? (await proposals.pending()).length : 0;
      return { finished: true, summary, at: clock(), pending_review: pend };
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
