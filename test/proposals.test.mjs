// Proposal-queue tests: the write path and its invariants.
// No browser, no network — the queue is built around injected backends on purpose.

import assert from "node:assert/strict";
import { createProposals, MAX_PENDING } from "../core/proposals.js";
import { createStore } from "../core/store.js";
import { createTools } from "../core/tools.js";

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok    ${name}`); passed++; }
  catch (err) { console.log(`FAIL  ${name}: ${err.message}`); failed++; }
};

function memoryBackend() {
  let data = {};
  return {
    get: async (keys) => (keys === null ? { ...data } : (keys in data ? { [keys]: data[keys] } : {})),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

function spyFetch(reply = { ok: true, status: 200, body: '{"ok":true}' }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: reply.ok, status: reply.status, text: async () => reply.body };
  };
  impl.calls = calls;
  return impl;
}

function harness({ allow = ["https://api.example.com/"], fetchImpl = spyFetch() } = {}) {
  const backend = memoryBackend();
  const store = createStore(backend);
  const proposals = createProposals({
    backend, store, fetchImpl,
    isAllowed: (u) => allow.some((p) => u.startsWith(p)),
  });
  return { backend, store, proposals, fetchImpl, allow };
}

await test("a proposal needs a rationale, and says so", async () => {
  const { proposals } = harness();
  await assert.rejects(() => proposals.create({ kind: "storage", target: { key: "a" }, payload: 1, rationale: "" }),
    /rationale is required/);
  await assert.rejects(() => proposals.create({ kind: "nonsense", target: {}, payload: 1, rationale: "why not this" }), /unknown kind/);
});

await test("reads are not proposals, and non-allowlisted targets are refused at propose time", async () => {
  const { proposals } = harness();
  await assert.rejects(() => proposals.create({ kind: "api", target: { url: "https://api.example.com/x", method: "GET" }, rationale: "read" }),
    /reads are api_read/);
  await assert.rejects(() => proposals.create({ kind: "api", target: { url: "https://evil.example/x", method: "POST" }, rationale: "push" }),
    /not on the allowlist/);
  await assert.rejects(() => proposals.create({ kind: "storage", target: {} , rationale: "no key" }), /need target.key/);
});

await test("nothing is written when a proposal is created", async () => {
  const { proposals, store, fetchImpl } = harness();
  await proposals.create({ kind: "api", target: { url: "https://api.example.com/state", method: "POST" }, payload: { n: 1 }, rationale: "set n" });
  await proposals.create({ kind: "storage", target: { key: "n" }, payload: 1, rationale: "keep n" });
  assert.equal(fetchImpl.calls.filter((c) => c.init && c.init.method === "POST").length, 0, "no POST before approval");
  assert.deepEqual(await store.list(), [], "no key written before approval");
  assert.equal((await proposals.pending()).length, 2);
});

await test("approving an api proposal sends exactly the proposed request", async () => {
  const { proposals, fetchImpl } = harness();
  const p = await proposals.create({
    kind: "api", target: { url: "https://api.example.com/state", method: "POST" },
    payload: { n: 1, note: "hello" }, rationale: "set n to 1",
  });
  const decided = await proposals.decide(p.id, { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.applied.status, 200);
  const sent = fetchImpl.calls.filter((c) => c.init.method === "POST");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.example.com/state");
  assert.deepEqual(JSON.parse(sent[0].init.body), { n: 1, note: "hello" });
  assert.equal((await proposals.pending()).length, 0);
});

await test("approving a storage proposal writes it, and a null payload deletes", async () => {
  const { proposals, store } = harness();
  const a = await proposals.create({ kind: "storage", target: { key: "x" }, payload: { v: 2 }, rationale: "set x" });
  await proposals.decide(a.id, { decision: "approve" });
  assert.deepEqual(await store.get("x"), { v: 2 });
  const b = await proposals.create({ kind: "storage", target: { key: "x" }, payload: null, rationale: "x is stale" });
  await proposals.decide(b.id, { decision: "approve" });
  assert.equal(await store.get("x"), null);
  assert.deepEqual(await store.list(), []);
});

await test("declining applies nothing and requires a reason", async () => {
  const { proposals, store, fetchImpl } = harness();
  const p = await proposals.create({ kind: "storage", target: { key: "y" }, payload: 5, rationale: "set y" });
  await assert.rejects(() => proposals.decide(p.id, { decision: "decline", reason: "   " }), /need a reason/);
  const d = await proposals.decide(p.id, { decision: "decline", reason: "wrong value, should be 7" });
  assert.equal(d.status, "declined");
  assert.equal(d.reason, "wrong value, should be 7");
  assert.equal(await store.get("y"), null, "declined proposals must not touch state");
  assert.equal(fetchImpl.calls.filter((c) => c.init && c.init.method === "POST").length, 0);
});

await test("a proposal cannot be decided twice", async () => {
  const { proposals } = harness();
  const p = await proposals.create({ kind: "storage", target: { key: "z" }, payload: 1, rationale: "set z" });
  await proposals.decide(p.id, { decision: "approve" });
  await assert.rejects(() => proposals.decide(p.id, { decision: "approve" }), /already approved/);
  await assert.rejects(() => proposals.decide("p-nope", { decision: "approve" }), /no proposal/);
});

await test("the allowlist is re-checked at apply time, not only at create time", async () => {
  const backend = memoryBackend();
  const store = createStore(backend);
  let allow = ["https://api.example.com/"];
  const proposals = createProposals({ backend, store, fetchImpl: spyFetch(), isAllowed: (u) => allow.some((p) => u.startsWith(p)) });
  const p = await proposals.create({ kind: "api", target: { url: "https://api.example.com/state", method: "POST" }, payload: {}, rationale: "push the new state" });
  allow = [];                                    // config changed while it sat in the queue
  await assert.rejects(() => proposals.decide(p.id, { decision: "approve" }), /no longer on the allowlist/);
  const still = await proposals.get(p.id);
  assert.equal(still.status, "pending", "a refused apply must leave the proposal pending");
});

await test("declined reasons are what the agent reads back", async () => {
  const { proposals, store, fetchImpl } = harness();
  const proposalsForTools = proposals;
  const tools = createTools({ store, proposals: proposalsForTools, fetchImpl, isAllowed: () => true });
  const p = await proposals.create({ kind: "api", target: { url: "https://api.example.com/state", method: "POST" }, payload: { n: 1 }, rationale: "set n" });
  await proposals.decide(p.id, { decision: "decline", reason: "not during quarter end" });
  const view = await tools.run("list_proposals", {});
  const seen = view.result.proposals.find((x) => x.id === p.id);
  assert.equal(seen.status, "declined");
  assert.equal(seen.human_reason, "not during quarter end");
  assert.equal(seen.rationale, "set n", "the agent's own rationale stays attached");
});

await test("the agent's proposal tools enforce a per-run cap and never write", async () => {
  const { proposals, store, fetchImpl } = harness();
  const tools = createTools({ store, proposals, fetchImpl, isAllowed: () => true, runId: "r1" });
  for (let i = 0; i < 12; i++) {
    await tools.run("propose_storage_change", { key: `k${i}`, value: i, rationale: `set k${i}` });
  }
  await assert.rejects(() => tools.run("propose_storage_change", { key: "k99", value: 1, rationale: "one more" }),
    /at most 12 proposals per run/);
  assert.deepEqual(await store.list(), [], "proposing never writes");
  assert.equal((await proposals.pending()).length, 12);
  const r = await tools.run("finish", { summary: "proposed a batch" });
  assert.equal(r.result.pending_review, 12, "finish reports how much is waiting on the human");
});

await test("the queue is capped so a looping agent cannot flood the reviewer", async () => {
  const { proposals } = harness();
  for (let i = 0; i < MAX_PENDING; i++) {
    await proposals.create({ kind: "storage", target: { key: `k${i}` }, payload: i, rationale: "bulk" });
  }
  await assert.rejects(() => proposals.create({ kind: "storage", target: { key: "one-too-many" }, payload: 1, rationale: "one more" }),
    /already pending review/);
});

await test("the audit log records creation and every decision", async () => {
  const { proposals } = harness();
  const a = await proposals.create({ kind: "storage", target: { key: "a" }, payload: 1, rationale: "set a" });
  const b = await proposals.create({ kind: "storage", target: { key: "b" }, payload: 2, rationale: "set b" });
  await proposals.decide(a.id, { decision: "approve" });
  await proposals.decide(b.id, { decision: "decline", reason: "not needed" });
  const log = await proposals.auditLog();
  assert.deepEqual(log.map((e) => e.action).sort(), ["approve", "created", "created", "decline"]);
  assert.equal(log.find((e) => e.action === "decline").reason, "not needed");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
