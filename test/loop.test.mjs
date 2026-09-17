// Node test for the loop, the tool surface and the store — no browser, no API key.
//
// The harness is written so the host injects its capabilities (storage backend,
// fetch, model), which is exactly what makes it testable here: we substitute an
// in-memory store, a stub fetch, and a scripted model.

import assert from "node:assert/strict";
import { runAgent, parseStep, buildSystemPrompt } from "../core/agent.js";
import { createTools } from "../core/tools.js";
import { createProposals } from "../core/proposals.js";
import { createStore } from "../core/store.js";

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok    ${name}`); passed++; }
  catch (err) { console.log(`FAIL  ${name}: ${err.message}`); failed++; }
};

// ---- fixtures ---------------------------------------------------------------
function memoryBackend() {
  let data = {};
  return {
    get: async (keys) => (keys === null ? { ...data } : keys instanceof Array
      ? Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
      : (keys in data ? { [keys]: data[keys] } : {})),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

function scriptedModel(replies) {
  let i = 0;
  return {
    name: "scripted",
    seen: [],
    async complete(messages) {
      this.seen.push(messages.length);
      const r = replies[Math.min(i++, replies.length - 1)];
      return typeof r === "function" ? r(messages) : r;
    },
  };
}

const OK_FETCH = async () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ data: [{ id: "z-ai-glm-5-3" }] }),
});
const allow = (u) => u.startsWith("https://api.example.com/");

// ---- tests ------------------------------------------------------------------
await test("parseStep: bare JSON, fenced JSON, and prose-wrapped JSON all parse", () => {
  assert.equal(parseStep('{"final":"done"}').kind, "final");
  assert.equal(parseStep('```json\n{"tool":"storage_list","args":{}}\n```').name, "storage_list");
  assert.equal(parseStep('Sure! Here you go: {"tool":"storage_get","args":{"key":"a"}} — that should work.').args.key, "a");
  assert.throws(() => parseStep("no json here"));
  assert.throws(() => parseStep('{"tool":"x"'));
});

await test("parseStep: nested objects and braces inside strings survive", () => {
  const s = parseStep('{"tool":"storage_set","args":{"key":"k","value":{"a":{"b":[1,{"c":"}"}]}}}}');
  assert.equal(s.args.value.a.b[1].c, "}");
});

await test("system prompt lists every tool and the step budget", () => {
  const store = createStore(memoryBackend());
  const proposals = createProposals({ backend: memoryBackend(), store, fetchImpl: OK_FETCH, isAllowed: allow });
  const tools = createTools({ store, proposals, fetchImpl: OK_FETCH, isAllowed: allow });
  const p = buildSystemPrompt({ tools, limits: { maxSteps: 7 } });
  for (const name of tools.names) assert.ok(p.includes(name), `missing ${name}`);
  assert.ok(p.includes("at most 7 steps"));
  assert.ok(p.includes("you cannot write anything directly"), "the prompt must state the approval rule");
  assert.equal(tools.names.length, 7, "tool surface must stay minimal");
  assert.ok(tools.names.includes("propose_storage_change") && tools.names.includes("api_read"));
  assert.ok(!tools.names.includes("storage_set"), "there is no direct write tool");
});

await test("happy path: write, call, finish — and the journal records every step", async () => {
  const backend = memoryBackend();
  const store = createStore(backend);
  const proposals = createProposals({ backend, store, fetchImpl: OK_FETCH, isAllowed: allow });
  const model = scriptedModel([
    '{"tool":"api_read","args":{"url":"https://api.example.com/v1/models"}}',
    '{"tool":"propose_storage_change","args":{"key":"note","value":"hello","rationale":"remember what happened"}}',
    '{"final":"read the model list and proposed a note"}',
  ]);
  const out = await runAgent({
    task: "read the model list then propose a note", model, store, proposals,
    fetchImpl: OK_FETCH, isAllowed: allow, runId: "t1",
  });
  assert.equal(out.status, "ok");
  assert.equal(out.steps, 3);
  assert.match(out.result, /proposed a note/);
  assert.equal(await store.get("note"), null, "the write waits for approval");
  assert.equal((await proposals.pending()).length, 1);
  const j = await store.readJournal("t1");
  const types = j.map((e) => e.type);
  assert.deepEqual(types, ["start", "tool_call", "tool_result", "tool_call", "tool_result", "final"]);
});

await test("finish tool ends the run from the tool side, not the model side", async () => {
  const store = createStore(memoryBackend());
  const model = scriptedModel(['{"tool":"finish","args":{"summary":"nothing to do"}}', "should not be reached"]);
  const out = await runAgent({ task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t2" });
  assert.equal(out.status, "ok");
  assert.equal(out.result, "nothing to do");
  assert.equal(out.steps, 1);
});

await test("bad reply is corrected once, then the run continues", async () => {
  const store = createStore(memoryBackend());
  const model = scriptedModel([
    "I think I should probably call a tool now.",
    '{"tool":"storage_set","args":{"key":"k","value":1}}',
    '{"final":"recovered"}',
  ]);
  const out = await runAgent({ task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t3" });
  assert.equal(out.status, "ok");
  assert.equal(out.result, "recovered");
  const j = await store.readJournal("t3");
  assert.ok(j.some((e) => e.type === "parse_error"), "parse_error should be journaled");
});

await test("api_call refuses anything not on the allowlist", async () => {
  const store = createStore(memoryBackend());
  const model = scriptedModel(['{"tool":"api_read","args":{"url":"https://evil.example/x"}}', '{"final":"ok"}']);
  await runAgent({ task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t4" });
  const j = await store.readJournal("t4");
  const res = j.find((e) => e.type === "tool_result");
  assert.match(res.result.error, /not on the allowlist/);
});

await test("storage rejects empty keys and oversized values", async () => {
  const store = createStore(memoryBackend());
  await assert.rejects(() => store.set("", 1), /key required/);
  await assert.rejects(() => store.set("big", "x".repeat(300_000)), /over 256 kB/);
  await store.set("ok", { fine: true });
  assert.deepEqual(await store.get("ok"), { fine: true });
  assert.deepEqual(await store.list(), ["ok"]);
});

await test("a tool that throws does not kill the run", async () => {
  const store = createStore(memoryBackend());
  const model = scriptedModel([
    '{"tool":"storage_get","args":{}}',                       // missing key -> handler throws
    '{"final":"handled the error"}',
  ]);
  const out = await runAgent({ task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t5" });
  assert.equal(out.status, "ok");
  assert.equal(out.steps, 2);
});

await test("step budget stops a looping model and says so", async () => {
  const store = createStore(memoryBackend());
  const model = scriptedModel(['{"tool":"storage_list","args":{}}']);   // loops forever
  const out = await runAgent({
    task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t6",
    limits: { maxSteps: 4, maxMs: 60_000, maxToolMs: 5_000 },
  });
  assert.equal(out.status, "max_steps");
  assert.equal(out.steps, 4);
  const j = await store.readJournal("t6");
  assert.equal(j[j.length - 1].type, "stop");
  assert.equal(j[j.length - 1].reason, "step budget");
});

await test("model failures are reported, not thrown at the caller", async () => {
  const store = createStore(memoryBackend());
  const model = { name: "broken", complete: async () => { throw new Error("connection refused"); } };
  const out = await runAgent({ task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t7" });
  assert.equal(out.status, "model_error");
  assert.match(out.error, /connection refused/);
});

await test("the conversation handed to the model carries tool results back", async () => {
  const store = createStore(memoryBackend());
  const model = scriptedModel(['{"tool":"storage_set","args":{"key":"a","value":42}}', '{"final":"done"}']);
  await runAgent({ task: "x", model, store, fetchImpl: OK_FETCH, isAllowed: allow, runId: "t8" });
  const secondCall = model.seen[1];
  assert.ok(secondCall >= 4, `second model call should include system+task+assistant+tool result, got ${secondCall}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
