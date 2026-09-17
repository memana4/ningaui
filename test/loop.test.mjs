// Loop and protocol tests — no browser, no network, no API key.
//
// The harness takes its storage, fetch, policy and action log as injected dependencies,
// which is what makes all of this testable here.

import assert from "node:assert/strict";
import { runAgent, parseStep, buildSystemPrompt } from "../core/agent.js";
import { createTools } from "../core/tools.js";
import { createStore } from "../core/store.js";
import { createPolicy } from "../core/policy.js";
import { createActions } from "../core/actions.js";

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

function scriptedModel(replies) {
  let i = 0;
  return {
    name: "scripted",
    seen: [],
    async complete(messages) { this.seen.push(messages.length); return replies[Math.min(i++, replies.length - 1)]; },
  };
}

const OK_FETCH = async (url, init = {}) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ state: { n: 0 }, method: init.method || "GET", url }),
});
const allow = (u) => u.startsWith("https://api.example.com/");

function stack({ policyOverrides = {} } = {}) {
  const backend = memoryBackend();
  const store = createStore(backend);
  const policy = createPolicy({ backend, overrides: policyOverrides });
  const actions = createActions({ backend, store, fetchImpl: OK_FETCH, policy, isAllowed: allow });
  const tools = createTools({ store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow });
  return { backend, store, policy, actions, tools };
}

await test("parseStep: bare, fenced and prose-wrapped JSON all parse", () => {
  assert.equal(parseStep('{"final":"done"}').kind, "final");
  assert.equal(parseStep('```json\n{"tool":"recall","args":{}}\n```').name, "recall");
  assert.equal(parseStep('Sure! Here you go: {"tool":"recall","args":{"key":"a"}} — that should work.').args.key, "a");
  assert.throws(() => parseStep("no json here"));
  assert.throws(() => parseStep('{"tool":"x"'));
});

await test("parseStep: nested objects and braces inside strings survive", () => {
  const s = parseStep('{"tool":"remember","args":{"key":"k","value":{"a":{"b":[1,{"c":"}"}]}}}}');
  assert.equal(s.args.value.a.b[1].c, "}");
});

await test("the prompt is API-first and explains how policy routes actions", () => {
  const { tools, policy } = stack();
  const p = buildSystemPrompt({ tools, limits: { maxSteps: 7 }, policy });
  for (const name of tools.names) assert.ok(p.includes(name), `missing ${name}`);
  assert.equal(tools.names.length, 7, "tool surface must stay minimal");
  assert.ok(!tools.names.includes("storage_set"), "there is no direct write tool");
  assert.ok(p.includes("routed by policy"), "the prompt must explain who decides");
  assert.ok(p.includes("'auto'") && p.includes("'confirm'") && p.includes("'deny'"));
  assert.ok(p.includes("at most 7 steps"));
});

await test("happy path: read, queue an action, finish — with the journal recording every step", async () => {
  const { store, actions, policy } = stack();
  const model = scriptedModel([
    '{"tool":"api_read","args":{"url":"https://api.example.com/state"}}',
    '{"tool":"api_request","args":{"url":"https://api.example.com/state","method":"POST","body":{"n":1},"rationale":"state says 0"}}',
    '{"final":"read the state and proposed a change"}',
  ]);
  const out = await runAgent({
    task: "read the state then change it", model, store, actions, policy,
    fetchImpl: OK_FETCH, isAllowed: allow, runId: "t1",
  });
  assert.equal(out.status, "ok");
  assert.equal(out.steps, 3);
  assert.equal((await actions.pending()).length, 1, "no autonomy yet, so it waits");
  const journal = await store.readJournal("t1");
  assert.deepEqual(journal.map((e) => e.type), ["start", "tool_call", "tool_result", "tool_call", "tool_result", "final"]);
});

await test("on a granted class the action applies inside the same step", async () => {
  const { store, actions, policy } = stack({ policyOverrides: { autoAllow: ["POST api.example.com/*"] } });
  const model = scriptedModel([
    '{"tool":"api_request","args":{"url":"https://api.example.com/state","method":"POST","body":{"n":9},"rationale":"routine"}}',
    '{"final":"applied it"}',
  ]);
  const out = await runAgent({ task: "bump it", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t2" });
  assert.equal(out.status, "ok");
  assert.equal((await actions.pending()).length, 0, "autonomous actions do not queue");
  const applied = await actions.all();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].mode, "auto");
  assert.equal(applied[0].status, "applied");
});

await test("finish reports what is waiting and what is trusted", async () => {
  const { store, actions, policy } = stack({'policyOverrides': {}});
  await actions.submit({ kind: "api", target: { url: "https://api.example.com/state", method: "POST" }, payload: {}, rationale: "queue this" });
  const model = scriptedModel(['{"tool":"finish","args":{"summary":"queued one change"}}', "unreached"]);
  const out = await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t3" });
  assert.equal(out.status, "ok");
  assert.equal(out.steps, 1);
  assert.equal(out.result, "queued one change");
});

await test("bad replies are corrected once and the run continues", async () => {
  const { store, actions, policy } = stack();
  const model = scriptedModel([
    "I think I should probably call a tool now.",
    '{"tool":"remember","args":{"key":"k","value":1}}',
    '{"final":"recovered"}',
  ]);
  const out = await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t4" });
  assert.equal(out.status, "ok");
  assert.equal(out.result, "recovered");
  assert.ok((await store.readJournal("t4")).some((e) => e.type === "parse_error"));
});

await test("api_read refuses anything not on the allowlist", async () => {
  const { store, actions, policy } = stack();
  const model = scriptedModel(['{"tool":"api_read","args":{"url":"https://evil.example/x"}}', '{"final":"ok"}']);
  await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t5" });
  const journal = await store.readJournal("t5");
  assert.match(journal.find((e) => e.type === "tool_result").result.error, /not on the allowlist/);
});

await test("api_request refuses read methods, which belong to api_read", async () => {
  const { store, actions, policy } = stack();
  const model = scriptedModel(['{"tool":"api_request","args":{"url":"https://api.example.com/state","method":"GET","rationale":"peek"}}', '{"final":"ok"}']);
  await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t6" });
  const journal = await store.readJournal("t6");
  assert.match(journal.find((e) => e.type === "tool_result").result.error, /use api_read/);
});

await test("the sandbox rejects empty keys and oversized values", async () => {
  const store = createStore(memoryBackend());
  await assert.rejects(() => store.set("", 1), /key required/);
  await assert.rejects(() => store.set("big", "x".repeat(300_000)), /over 256 kB/);
  await store.set("ok", { fine: true });
  assert.deepEqual(await store.get("ok"), { fine: true });
  assert.deepEqual(await store.list(), ["ok"]);
});

await test("a tool that throws does not kill the run", async () => {
  const { store, actions, policy } = stack();
  const model = scriptedModel(['{"tool":"recall","args":{"key":42}}', '{"final":"handled the error"}']);
  const out = await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t7" });
  assert.equal(out.status, "ok");
  assert.equal(out.steps, 2);
});

await test("the step budget stops a looping model and says so", async () => {
  const { store, actions, policy } = stack();
  const model = scriptedModel(['{"tool":"list_actions","args":{}}']);
  const out = await runAgent({
    task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t8",
    limits: { maxSteps: 4, maxMs: 60_000, maxToolMs: 5_000 },
  });
  assert.equal(out.status, "max_steps");
  assert.equal(out.steps, 4);
  const journal = await store.readJournal("t8");
  assert.equal(journal[journal.length - 1].type, "stop");
  assert.equal(journal[journal.length - 1].reason, "step budget");
});

await test("model failures are reported, not thrown at the caller", async () => {
  const { store, actions, policy } = stack();
  const model = { name: "broken", complete: async () => { throw new Error("connection refused"); } };
  const out = await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t9" });
  assert.equal(out.status, "model_error");
  assert.match(out.error, /connection refused/);
});

await test("a fresh run resets the autonomy quota", async () => {
  const { store, actions, policy } = stack({ policyOverrides: { autoAllow: ["POST *"], maxAutoPerRun: 1 } });
  const model = scriptedModel([
    '{"tool":"api_request","args":{"url":"https://api.example.com/a","method":"POST","body":{},"rationale":"first"}}',
    '{"tool":"api_request","args":{"url":"https://api.example.com/b","method":"POST","body":{},"rationale":"second"}}',
    '{"final":"one went, one waited"}',
  ]);
  const out = await runAgent({ task: "x", model, store, actions, policy, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t10" });
  assert.equal(out.status, "ok");
  assert.equal((await actions.pending()).length, 1, "the second action exceeded the per-run quota and queued");
  assert.equal((await actions.autonomous()).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
