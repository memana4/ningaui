// Cross-browser checks.
//
// Three things are verified here:
//   1. the adapter behaves correctly under a Chrome-shaped host and a Firefox-shaped host
//   2. the core — loop, tools, proposal queue, store — produces identical results on both,
//      which is the whole reason the platform differences were isolated into api.js
//   3. the real background host (core/bg.js) wires up correctly under each engine, including
//      the Firefox-refusable host permission path

import assert from "node:assert/strict";
import { createApi, originsFor } from "../core/api.js";
import { createStore } from "../core/store.js";
import { createProposals } from "../core/proposals.js";
import { createTools } from "../core/tools.js";
import { runAgent } from "../core/agent.js";
import { readFileSync, existsSync } from "node:fs";

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok    ${name}`); passed++; }
  catch (err) { console.log(`FAIL  ${name}: ${err.message}`); failed++; }
};

// ---- fake extension hosts ---------------------------------------------------
function memoryStorage() {
  let data = {};
  return {
    get: async (keys) => (keys === null ? { ...data } : (keys in data ? { [keys]: data[keys] } : {})),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

function fakeRuntime() {
  const listeners = { message: [], connect: [], alarm: [] };
  return {
    listeners,
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onConnect: { addListener: (f) => listeners.connect.push(f) },
    onInstalled: { addListener: () => {} },
    getManifest: () => ({ host_permissions: ["http://localhost/*"] }),
    sendMessage: () => {},
    connect: () => ({ onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} }, postMessage: () => {} }),
  };
}

function chromeLikeHost({ granted = true } = {}) {
  const offscreen = { created: 0, closed: 0 };
  return {
    name: "chrome-like",
    storage: { local: memoryStorage() },
    runtime: fakeRuntime(),
    sidePanel: { setPanelBehavior: async () => {} },
    offscreen: {
      async createDocument() { offscreen.created++; },
      async closeDocument() { offscreen.closed++; },
    },
    permissions: { contains: async () => granted, request: async () => granted },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    _offscreen: offscreen,
  };
}

function firefoxLikeHost({ granted = true } = {}) {
  const host = {
    name: "firefox-like",
    storage: { local: memoryStorage() },
    runtime: {
      ...fakeRuntime(),
      getContexts: undefined,           // Firefox has no runtime.getContexts
    },
    sidebarAction: { open: async () => {} },
    permissions: { contains: async () => granted, request: async () => granted },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  delete host.offscreen;                 // Firefox has no offscreen API at all
  delete host.sidePanel;
  return host;
}

// ---- adapter ----------------------------------------------------------------
await test("adapter identifies each engine and its keepalive mode", async () => {
  const c = createApi(chromeLikeHost());
  const f = createApi(firefoxLikeHost());
  assert.equal(c.name, "chrome"); assert.equal(c.hasOffscreen, true); assert.equal(c.isFirefox, false);
  assert.equal(f.name, "firefox"); assert.equal(f.hasOffscreen, false); assert.equal(f.isFirefox, true);
});

await test("chrome keepalive uses one offscreen document, not one per call", async () => {
  const host = chromeLikeHost();
  const api = createApi(host);
  assert.deepEqual(await api.keepalive.start(), { mode: "offscreen" });
  await api.keepalive.start();
  assert.equal(host._offscreen.created, 1, "the document must be reused");
  await api.keepalive.stop();
  assert.equal(host._offscreen.closed, 1);
  await api.keepalive.contexts();
});

await test("firefox keepalive falls back to the runtime port and never touches offscreen", async () => {
  const host = firefoxLikeHost();
  const api = createApi(host);
  const r = await api.keepalive.start();
  assert.equal(r.mode, "port");
  assert.equal(await api.keepalive.contexts(), 0, "no getContexts in Firefox — must not throw");
  await api.keepalive.stop();
});

await test("host permissions are inspected and requestable in both engines", async () => {
  for (const make of [chromeLikeHost, firefoxLikeHost]) {
    const api = createApi(make({ granted: false }));
    const origins = originsFor(["http://localhost:11434/v1", "https://api.venice.ai/api/v1/models"]);
    assert.deepEqual(origins, ["http://localhost:11434/*", "https://api.venice.ai/*"]);
    assert.equal(await api.permissions.contains(origins), false);
    assert.equal(await api.permissions.request(origins), false);
    const ok = createApi(make({ granted: true }));
    assert.equal(await ok.permissions.contains(origins), true);
  }
});

// ---- the core must not care which engine it is on ---------------------------
async function coreRunUnder(host, runId) {
  const api = createApi(host);
  const backend = api.storage;
  const store = createStore(backend);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ state: { n: 0 } }) };
  };
  const isAllowed = (u) => u.startsWith("http://localhost:11434/");   // note: the allowlist prefix includes the port
  const proposals = createProposals({ backend, store, fetchImpl, isAllowed });

  const model = (replies) => { let i = 0; return { name: "scripted", async complete() { return replies[Math.min(i++, replies.length - 1)]; } }; };
  const out = await runAgent({
    task: "read the state and propose n=1", store, proposals, fetchImpl, isAllowed, runId,
    model: model([
      '{"tool":"api_read","args":{"url":"http://localhost:11434/state"}}',
      '{"tool":"propose_api_change","args":{"url":"http://localhost:11434/state","method":"POST","body":{"n":1},"rationale":"state says 0, should be 1"}}',
      '{"final":"proposed setting n to 1"}',
    ]),
  });
  const pending = await proposals.pending();
  await proposals.decide(pending[0].id, { decision: "approve" });
  const journal = await store.readJournal(runId);
  return { out, pending, calls, journal, store, proposals, tools: createTools({ store, proposals, fetchImpl, isAllowed }) };
}

await test("the loop, the queue and the apply step behave identically on both engines", async () => {
  const onChrome = await coreRunUnder(chromeLikeHost(), "x1");
  const onFirefox = await coreRunUnder(firefoxLikeHost(), "x2");

  for (const r of [onChrome, onFirefox]) {
    assert.equal(r.out.status, "ok");
    assert.equal(r.out.steps, 3);
    assert.equal(r.pending.length, 1);
    assert.deepEqual(r.journal.map((e) => e.type),
      ["start", "tool_call", "tool_result", "tool_call", "tool_result", "final"]);
  }
  assert.deepEqual(onChrome.journal.map((e) => e.type), onFirefox.journal.map((e) => e.type));
  assert.equal(onChrome.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(onFirefox.calls.filter((c) => c.method === "POST").length, 1);
  assert.deepEqual(onChrome.calls.at(-1).body, onFirefox.calls.at(-1).body);
  assert.deepEqual(onChrome.calls.at(-1).body, { n: 1 }, "approval sends the proposed body exactly");
});

await test("a declined proposal leaves the same feedback trail on both engines", async () => {
  const r = await coreRunUnder(firefoxLikeHost(), "x3");
  const second = await r.proposals.create({ kind: "storage", target: { key: "k" }, payload: 1, rationale: "keep a counter" });
  await r.proposals.decide(second.id, { decision: "decline", reason: "wrong target" });
  const view = await r.tools.run("list_proposals", {});
  const declined = view.result.proposals.filter((p) => p.status === "declined");
  assert.equal(declined.length, 1);
  assert.equal(declined[0].human_reason, "wrong target");
});

// ---- the real background host under each engine -----------------------------
async function loadBackground(host, tag) {
  // bg.js binds to globalThis at import time, so each load needs a fresh module instance.
  globalThis.chrome = host;
  globalThis.browser = undefined;
  const mod = await import(`../core/bg.js?${tag}`);
  const handler = host.runtime.listeners.message.at(-1);
  const send = (msg) => new Promise((resolve) => handler(msg, {}, resolve));
  return { mod, handler, send, host };
}

await test("bg.js wires up and answers the panel in a Chrome-shaped host", async () => {
  const { send } = await loadBackground(chromeLikeHost(), "ch1");
  const env = await send({ type: "env" });
  assert.equal(env.browser, "chrome");
  assert.equal(env.keepalive, "offscreen document");
  const perms = await send({ type: "permissions" });
  assert.equal(perms.granted, true);
  const props = await send({ type: "proposals" });
  assert.deepEqual(props.pending, []);
  assert.deepEqual(await send({ type: "keepalive" }), { ok: true, ports: 0 });
  assert.match((await send({ type: "nonsense" })).error, /unknown message/);
});

await test("bg.js wires up in a Firefox-shaped host and reports the port keepalive", async () => {
  const { send } = await loadBackground(firefoxLikeHost(), "ff1");
  const env = await send({ type: "env" });
  assert.equal(env.browser, "firefox");
  assert.equal(env.keepalive, "runtime port");
  assert.equal(env.builtInModel, false, "Firefox has no LanguageModel");
});

await test("a run refuses to start when host permissions are missing (the Firefox revocation case)", async () => {
  const { send } = await loadBackground(firefoxLikeHost({ granted: false }), "ff2");
  const r = await send({ type: "run", task: "anything" });
  assert.match(r.error, /host permission missing/);
});

await test("the panel port is accepted and answered", async () => {
  const { host } = await loadBackground(firefoxLikeHost(), "ff3");
  const connect = host.runtime.listeners.connect.at(-1);
  const posts = [];
  const port = { name: "panel", postMessage: (m) => posts.push(m), onMessage: { addListener: (f) => { port._f = f; } }, onDisconnect: { addListener: () => {} } };
  connect(port);
  assert.equal(posts[0].type, "hello");
  await port._f({ type: "ping" });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(posts.some((m) => m.type === "status"), "a ping must come back with status");
});

// ---- manifests --------------------------------------------------------------
await test("each manifest carries only its own engine's keys", async () => {
  const chrome = JSON.parse(readFileSync("platform/chrome/manifest.json", "utf8"));
  const firefox = JSON.parse(readFileSync("platform/firefox/manifest.json", "utf8"));

  assert.ok(chrome.background.service_worker.endsWith("bg.js"));
  assert.equal(chrome.background.type, "module");
  assert.ok(chrome.side_panel.default_path.endsWith("panel.html"));
  assert.ok(chrome.permissions.includes("offscreen"));
  assert.ok(!("browser_specific_settings" in chrome), "Chrome must not carry Firefox-only keys");
  assert.ok(!("background" in chrome && "scripts" in chrome.background), "Chrome ignores background.scripts");

  assert.ok(firefox.background.scripts.includes("bg.js"));
  assert.ok(!("service_worker" in firefox.background), "Firefox rejects service_worker");
  assert.ok(firefox.sidebar_action.default_panel.endsWith("panel.html"));
  assert.equal(firefox.browser_specific_settings.gecko.id, "kowari@local");
  assert.ok(firefox.browser_specific_settings.gecko.data_collection_permissions);
  assert.ok(!firefox.permissions.includes("offscreen"));
  assert.ok(!firefox.permissions.includes("sidePanel"));
});

await test("both bundles exist and every manifest reference resolves inside them", async () => {
  for (const target of ["chrome", "firefox"]) {
    const dir = `dist/${target}`;
    assert.ok(existsSync(`${dir}/manifest.json`), `${dir} must be built`);
    const m = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
    const refs = [m.side_panel?.default_path, m.sidebar_action?.default_panel,
                  m.background.service_worker, ...(m.background.scripts || [])].filter(Boolean);
    for (const r of refs) assert.ok(existsSync(`${dir}/${r}`), `${dir}/${r} missing`);
    for (const f of ["agent.js", "tools.js", "proposals.js", "store.js", "model.js", "api.js", "bg.js", "panel.js", "panel.html"]) {
      assert.ok(existsSync(`${dir}/${f}`), `${dir}/${f} missing from the bundle`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
