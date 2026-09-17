// Action-log tests: both paths through the gate, and everything that has to stay true.

import assert from "node:assert/strict";
import { createActions, MAX_PENDING } from "../core/actions.js";
import { createPolicy } from "../core/policy.js";
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
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    return { ok: reply.ok, status: reply.status, text: async () => reply.body };
  };
  impl.calls = calls;
  return impl;
}

function fixture({ policyOverrides = {}, allow = ["https://api.example.com/"], fetchImpl = spyFetch() } = {}) {
  const backend = memoryBackend();
  const store = createStore(backend);
  const policy = createPolicy({ backend, overrides: policyOverrides });
  const actions = createActions({ backend, store, fetchImpl, policy, isAllowed: (u) => allow.some((p) => u.startsWith(p)) });
  const tools = createTools({ store, actions, policy, fetchImpl, isAllowed: (u) => allow.some((p) => u.startsWith(p)) });
  return { backend, store, policy, actions, tools, fetchImpl, allow };
}

const API = { kind: "api", target: { url: "https://api.example.com/state", method: "POST" }, payload: { n: 1 }, rationale: "state says 0, should be 1" };

await test("by default an API action waits for a human, and nothing is sent", async () => {
  const f = fixture();
  const a = await f.actions.submit(API);
  assert.equal(a.mode, "confirm");
  assert.equal(a.status, "pending");
  assert.match(a.policyWhy, /no autonomy/);
  assert.equal(f.fetchImpl.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal((await f.actions.pending()).length, 1);
});

await test("a rationale is required, and the action kinds validate their targets", async () => {
  const f = fixture();
  await assert.rejects(() => f.actions.submit({ ...API, rationale: "" }), /rationale is required/);
  await assert.rejects(() => f.actions.submit({ kind: "nonsense", target: {}, rationale: "why not" }), /unknown kind/);
  await assert.rejects(() => f.actions.submit({ kind: "store", target: {}, payload: 1, rationale: "no key" }), /need target.key/);
  await assert.rejects(() => f.actions.submit({ kind: "policy", target: {}, payload: { level: "auto" }, rationale: "no class" }), /need target.cls/);
  await assert.rejects(() => f.actions.submit({ kind: "api", target: { url: "https://evil.example/x", method: "POST" }, rationale: "exfiltrate" }), /not on the allowlist/);
});

await test("a granted class is autonomous: applied immediately, exact request, response returned", async () => {
  const f = fixture({ policyOverrides: { autoAllow: ["POST api.example.com/*"] } });
  const a = await f.actions.submit(API);
  assert.equal(a.mode, "auto");
  assert.equal(a.status, "applied");
  assert.equal(a.by, "policy");
  const sent = f.fetchImpl.calls.filter((c) => c.method === "POST");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { n: 1 });
  assert.equal(a.applied.status, 200);
  assert.equal((await f.actions.pending()).length, 0);
});

await test("a denied class cannot even queue", async () => {
  const f = fixture();
  await f.policy.setLevel("POST api.example.com/state", "deny", "do not touch that endpoint");
  await assert.rejects(() => f.actions.submit(API), /refused by policy: do not touch that endpoint/);
  assert.equal((await f.actions.all()).length, 0);
  const audit = await f.actions.auditLog();
  assert.ok(audit.some((e) => e.action === "denied"));
});

await test("approving applies exactly what was proposed", async () => {
  const f = fixture();
  const a = await f.actions.submit(API);
  const r = await f.actions.decide(a.id, { decision: "approve" });
  assert.equal(r.status, "applied");
  assert.equal(r.by, "human");
  const sent = f.fetchImpl.calls.filter((c) => c.method === "POST");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { n: 1 });
});

await test("declining needs a reason and applies nothing", async () => {
  const f = fixture();
  const a = await f.actions.submit(API);
  const postsBefore = f.fetchImpl.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(() => f.actions.decide(a.id, { decision: "decline", reason: "   " }), /need a reason/);
  assert.equal((await f.actions.get(a.id)).status, "pending", "a refused decline leaves it pending");
  const d = await f.actions.decide(a.id, { decision: "decline", reason: "not during quarter end" });
  assert.equal(d.status, "declined");
  assert.equal(d.reason, "not during quarter end");
  assert.equal(f.fetchImpl.calls.filter((c) => c.method === "POST").length, postsBefore, "nothing was sent");
});

await test("an action cannot be decided twice, and a failed apply is recorded as failed", async () => {
  const f = fixture();
  const a = await f.actions.submit(API);
  await f.actions.decide(a.id, { decision: "approve" });
  await assert.rejects(() => f.actions.decide(a.id, { decision: "approve" }), /already applied/);
  await assert.rejects(() => f.actions.decide("a-nope", { decision: "approve" }), /no action/);

  const bad = fixture({ fetchImpl: async () => { throw new Error("connection refused"); } });
  const b = await bad.actions.submit(API);
  const r = await bad.actions.decide(b.id, { decision: "approve" });
  assert.equal(r.status, "failed");
  assert.match(r.applied.error, /connection refused/);
  assert.equal((await bad.policy.get("POST api.example.com/state")).errors, 1);
});

await test("the allowlist is re-checked at apply time, and a refused apply keeps the decision", async () => {
  const f = fixture();
  const a = await f.actions.submit(API);
  f.allow.length = 0;                      // configuration changed while it sat in the queue

  const held = await f.actions.decide(a.id, { decision: "approve" });
  assert.equal(held.status, "pending", "a pre-flight refusal must not consume the approval");
  assert.match(held.policyWhy, /no longer on the allowlist/);
  assert.equal(f.fetchImpl.calls.filter((c) => c.method === "POST").length, 0, "nothing was sent");
  assert.ok((await f.actions.auditLog()).some((e) => e.action === "held"));

  // fix the configuration and the same decision goes through
  f.allow.push("https://api.example.com/");
  const applied = await f.actions.decide(a.id, { decision: "approve" });
  assert.equal(applied.status, "applied");
  assert.equal(f.fetchImpl.calls.filter((c) => c.method === "POST").length, 1);
});

await test("the queue is capped, and one run is capped too", async () => {
  const f = fixture();
  for (let i = 0; i < MAX_PENDING; i++) {
    await f.actions.submit({ ...API, payload: { i }, rationale: `bulk ${i}` });
  }
  await assert.rejects(() => f.actions.submit({ ...API, rationale: "one too many" }), /already awaiting your decision/);

  const g = fixture();
  for (let i = 0; i < 12; i++) {
    await g.tools.run("api_request", { url: "https://api.example.com/state", method: "POST", body: { i }, rationale: `run ${i}` });
  }
  await assert.rejects(() => g.tools.run("api_request", { url: "https://api.example.com/state", method: "POST", body: {}, rationale: "one more" }),
    /at most 12 actions per run/);
});

await test("the audit log tells the whole story", async () => {
  const f = fixture({ policyOverrides: { autoAllow: ["POST api.example.com/*"] } });
  const auto = await f.actions.submit(API);
  f.policy.setConfig({ autoAllow: [] });          // the next one has to queue
  const queued = await f.actions.submit({ ...API, payload: { n: 3 }, rationale: "another change" });
  await f.actions.decide(queued.id, { decision: "decline", reason: "duplicate" });
  await f.actions.revert(auto.id, { reason: "wrong amount" });

  const log = await f.actions.auditLog();
  const kinds = log.map((e) => e.action);
  for (const k of ["auto", "applied", "created", "decline", "reverted"]) {
    assert.ok(kinds.includes(k), `audit log should contain ${k}`);
  }
  assert.equal(log.find((e) => e.action === "decline").reason, "duplicate");
});

await test("reverting a store action restores the previous value", async () => {
  const f = fixture();
  await f.store.set("counter", 1);
  const a = await f.actions.submit({ kind: "store", target: { key: "counter" }, payload: 2, rationale: "bump the counter", preview: { before: 1, after: 2 } });
  await f.actions.decide(a.id, { decision: "approve" });
  assert.equal(await f.store.get("counter"), 2);
  const r = await f.actions.revert(a.id, { reason: "should have stayed 1" });
  assert.equal(await f.store.get("counter"), 1);
  assert.deepEqual(r.undone, { restored: "counter" });
  assert.equal(r.status, "reverted");
  await assert.rejects(() => f.actions.revert(a.id), /nothing to revert/);
});

await test("reverting an API action records the pre-apply state and says it is manual", async () => {
  const f = fixture();
  const a = await f.actions.submit({ ...API, preview: { before: '{"n":0}', after: '{"n":1}' } });
  await f.actions.decide(a.id, { decision: "approve" });
  const r = await f.actions.revert(a.id, { reason: "wrong target" });
  assert.equal(r.undone.manual, true);
  assert.equal(r.undone.before, '{"n":0}');
  assert.match(r.undone.note, /not generically reversible/);
});

await test("the agent can ask for autonomy, and approval grants it", async () => {
  const f = fixture();
  const cls = "POST api.example.com/state";
  const asked = await f.tools.run("request_autonomy", { class: cls, rationale: "these writes are routine and reversible" });
  assert.equal(asked.result.status, "awaiting human decision");
  const pending = await f.actions.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "policy");

  await f.actions.decide(pending[0].id, { decision: "approve" });
  assert.equal((await f.policy.get(cls)).level, "auto");
  const now = await f.actions.submit(API);
  assert.equal(now.mode, "auto", "the class is autonomous from the next action onward");
});

await test("reverting a policy grant takes the autonomy back", async () => {
  const f = fixture();
  const cls = "POST api.example.com/state";
  await f.policy.setLevel(cls, "auto", "granted earlier");
  const a = await f.actions.submit({ kind: "policy", target: { cls }, payload: { level: "auto" }, rationale: "keep it autonomous" });
  await f.actions.decide(a.id, { decision: "approve" });
  assert.equal((await f.policy.get(cls)).level, "auto");
  await f.actions.revert(a.id, { reason: "changed my mind" });
  assert.equal((await f.policy.get(cls)).level, "confirm");
});

await test("the sandbox is the agent's own memory: remember and recall never queue", async () => {
  const f = fixture();
  await f.tools.run("remember", { key: "plan", value: "step one" });
  assert.equal(await f.store.get("plan"), "step one");
  assert.equal((await f.actions.pending()).length, 0);
  const back = await f.tools.run("recall", { key: "plan" });
  assert.equal(back.result.value, "step one");
});

await test("list_actions shows the human's decisions and the current autonomy", async () => {
  const f = fixture({ policyOverrides: { autoAllow: ["POST api.example.com/*"] } });
  const a = await f.actions.submit(API);
  // PATCH is a different class from POST, so this one has to queue
  const b = await f.actions.submit({ kind: "api", target: { url: API.target.url, method: "PATCH" }, payload: { n: 5 }, rationale: "another" });
  await f.actions.decide(b.id, { decision: "decline", reason: "not now" });
  const view = await f.tools.run("list_actions", {});
  const declined = view.result.actions.find((x) => x.id === b.id);
  assert.equal(declined.status, "declined");
  assert.equal(declined.human_reason, "not now");
  assert.equal(declined.rationale, "another");
  assert.deepEqual(view.result.autonomy.autonomous_classes, ["POST api.example.com/state"]);
  assert.ok(view.result.actions.some((x) => x.id === a.id && x.mode === "auto"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
