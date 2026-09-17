// Cross-browser checks.
//
//   1. the adapter behaves correctly under a Chrome-shaped host and a Firefox-shaped host
//   2. the core — loop, tools, action log, policy — behaves identically on both
//   3. the real background host (core/bg.js) wires up under each engine, including the
//      Firefox-refusable host permission path and the autonomy messages

import assert from "node:assert/strict";
import { createApi, originsFor } from "../core/api.js";
import { createStore } from "../core/store.js";
import { createPolicy } from "../core/policy.js";
import { createActions } from "../core/actions.js";
import { createTools } from "../core/tools.js";
import { runAgent } from "../core/agent.js";
import { readFileSync, existsSync } from "node:fs";

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok    ${name}`); passed++; }
  catch (err) { console.log(`FAIL  ${name}: ${err.message}`); failed++; }
};

function memoryStorage() {
  let data = {};
  return {
    get: async (keys) => (keys === null ? { ...data } : (keys in data ? { [keys]: data[keys] } : {})),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

function fakeRuntime() {
  const listeners = { message: [], connect: [] };
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
    storage: { local: memoryStorage() },
    runtime: fakeRuntime(),
    sidePanel: { setPanelBehavior: async () => {} },
    offscreen: { async createDocument() { offscreen.created++; }, async closeDocument() { offscreen.closed++; } },
    permissions: { contains: async () => granted, request: async () => granted },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    _offscreen: offscreen,
  };
}

function firefoxLikeHost({ granted = true } = {}) {
  const host = {
    storage: { local: memoryStorage() },
    runtime: { ...fakeRuntime(), getContexts: undefined },
    sidebarAction: { open: async () => {} },
    permissions: { contains: async () => granted, request: async () => granted },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  delete host.offscreen;
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
  assert.equal(host._offscreen.created, 1);
  await api.keepalive.stop();
  assert.equal(host._offscreen.closed, 1);
});

await test("firefox keepalive falls back to the runtime port and never touches offscreen", async () => {
  const api = createApi(firefoxLikeHost());
  assert.equal((await api.keepalive.start()).mode, "port");
  assert.equal(await api.keepalive.contexts(), 0, "no getContexts in Firefox — must not throw");
  await api.keepalive.stop();
});

await test("host permissions are inspectable and requestable in both engines", async () => {
  for (const make of [chromeLikeHost, firefoxLikeHost]) {
    const api = createApi(make({ granted: false }));
    const origins = originsFor(["http://localhost:11434/v1", "https://api.venice.ai/api/v1/models"]);
    assert.deepEqual(origins, ["http://localhost:11434/*", "https://api.venice.ai/*"]);
    assert.equal(await api.permissions.contains(origins), false);
    assert.equal(await api.permissions.request(origins), false);
    assert.equal(await createApi(make({ granted: true })).permissions.contains(origins), true);
  }
});

// ---- the core must not care which engine it is on ---------------------------
async function coreRunUnder(host, runId, { autonomous = false } = {}) {
  const api = createApi(host);
  const backend = api.storage;
  const store = createStore(backend);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ state: { n: 0 } }) };
  };
  const isAllowed = (u) => u.startsWith("http://localhost:11434/");
  const policy = createPolicy({ backend, overrides: autonomous ? { autoAllow: ["POST localhost:11434/*"] } : {} });
  const actions = createActions({ backend, store, fetchImpl, policy, isAllowed });
  const tools = createTools({ store, actions, policy, fetchImpl, isAllowed });

  const replies = [
    '{"tool":"api_read","args":{"url":"http://localhost:11434/state"}}',
    '{"tool":"api_request","args":{"url":"http://localhost:11434/state","method":"POST","body":{"n":1},"rationale":"state says 0, should be 1"}}',
    '{"final":"proposed setting n to 1"}',
  ];
  let i = 0;
  const model = { name: "scripted", async complete() { return replies[Math.min(i++, replies.length - 1)]; } };

  const out = await runAgent({ task: "read then change", model, store, actions, policy, fetchImpl, isAllowed, runId });
  const pending = await actions.pending();
  if (pending.length) await actions.decide(pending[0].id, { decision: "approve" });
  const journal = await store.readJournal(runId);
  const view = await policy.view();
  return { out, pending, calls, journal, store, actions, tools, policy, view };
}

await test("the loop, the action log and the apply step behave identically on both engines", async () => {
  const onChrome = await coreRunUnder(chromeLikeHost(), "x1");
  const onFirefox = await coreRunUnder(firefoxLikeHost(), "x2");

  for (const r of [onChrome, onFirefox]) {
    assert.equal(r.out.status, "ok");
    assert.equal(r.out.steps, 3);
    assert.equal(r.pending.length, 1, "no autonomy by default, so it queues on both");
    assert.deepEqual(r.journal.map((e) => e.type),
      ["start", "tool_call", "tool_result", "tool_call", "tool_result", "final"]);
  }
  assert.deepEqual(onChrome.journal.map((e) => e.type), onFirefox.journal.map((e) => e.type));
  for (const r of [onChrome, onFirefox]) {
    const posts = r.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1, "the approval applied it exactly once");
    assert.deepEqual(posts[0].body, { n: 1 });
  }
});

await test("autonomy works the same way on both engines", async () => {
  const onChrome = await coreRunUnder(chromeLikeHost(), "x3", { autonomous: true });
  const onFirefox = await coreRunUnder(firefoxLikeHost(), "x4", { autonomous: true });
  for (const r of [onChrome, onFirefox]) {
    assert.equal(r.pending.length, 0, "a granted class does not queue");
    const applied = await r.actions.all();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].mode, "auto");
    assert.equal(applied[0].status, "applied");
    assert.deepEqual(r.view.autonomous, ["POST localhost:11434/state"]);
  }
});

await test("a declined action leaves the same feedback trail on both engines", async () => {
  const r = await coreRunUnder(firefoxLikeHost(), "x5");
  const second = await r.actions.submit({ kind: "api", target: { url: "http://localhost:11434/other", method: "PATCH" }, payload: { n: 2 }, rationale: "keep a counter" });
  await r.actions.decide(second.id, { decision: "decline", reason: "wrong target" });
  const view = await r.tools.run("list_actions", {});
  const declined = view.result.actions.filter((a) => a.status === "declined");
  assert.equal(declined.length, 1);
  assert.equal(declined[0].human_reason, "wrong target");
});

// ---- the real background host under each engine -----------------------------
async function loadBackground(host, tag) {
  globalThis.chrome = host;
  globalThis.browser = undefined;
  await import(`../core/bg.js?${tag}`);
  const handler = host.runtime.listeners.message.at(-1);
  const send = (msg) => new Promise((resolve) => handler(msg, {}, resolve));
  return { handler, send, host };
}

await test("bg.js wires up and answers the panel in a Chrome-shaped host", async () => {
  const { send } = await loadBackground(chromeLikeHost(), "ch1");
  const env = await send({ type: "env" });
  assert.equal(env.browser, "chrome");
  assert.equal(env.keepalive, "offscreen document");
  assert.equal((await send({ type: "permissions" })).granted, true);
  const a = await send({ type: "actions" });
  assert.deepEqual(a.pending, []);
  const t = await send({ type: "trust" });
  assert.equal(t.enabled, true);
  assert.deepEqual(t.autonomous, []);
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
  assert.match((await send({ type: "run", task: "anything" })).error, /host permission missing/);
});

await test("the panel can grant, deny and revoke autonomy through the background", async () => {
  const { send } = await loadBackground(chromeLikeHost(), "ch2");
  const cls = "POST localhost:11434/state";

  let r = await send({ type: "setLevel", cls, level: "auto", note: "granted in a test" });
  assert.equal(r.ok, true);
  assert.equal(r.record.level, "auto");
  let t = await send({ type: "trust" });
  assert.deepEqual(t.autonomous, [cls]);

  r = await send({ type: "revokeAll" });
  assert.equal(r.revoked, 1);
  t = await send({ type: "trust" });
  assert.deepEqual(t.autonomous, []);

  r = await send({ type: "setPolicy", patch: { autoAllow: ["POST localhost:11434/*"] } });
  assert.deepEqual(r.policy.autonomous, [cls], "a granted pattern shows up as autonomous");

  r = await send({ type: "setPolicy", patch: { enabled: false } });
  assert.equal(r.policy.enabled, false);
  assert.deepEqual(r.policy.autonomous, []);
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

// ---- manifests and bundles --------------------------------------------------
await test("each manifest carries only its own engine's keys", async () => {
  const chrome = JSON.parse(readFileSync("platform/chrome/manifest.json", "utf8"));
  const firefox = JSON.parse(readFileSync("platform/firefox/manifest.json", "utf8"));

  assert.ok(chrome.background.service_worker.endsWith("bg.js"));
  assert.equal(chrome.background.type, "module");
  assert.ok(chrome.side_panel.default_path.endsWith("panel.html"));
  assert.ok(chrome.permissions.includes("offscreen"));
  assert.ok(!("browser_specific_settings" in chrome));
  assert.ok(!("scripts" in chrome.background));

  assert.ok(firefox.background.scripts.includes("bg.js"));
  assert.ok(!("service_worker" in firefox.background));
  assert.ok(firefox.sidebar_action.default_panel.endsWith("panel.html"));
  assert.equal(firefox.browser_specific_settings.gecko.id, "ningaui@local");
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
                  m.background.service_worker, ...(m.background.scripts || []),
                  ...Object.values(m.icons || {}), ...Object.values(m.action?.default_icon || {})].filter(Boolean);
    for (const r of refs) assert.ok(existsSync(`${dir}/${r}`), `${dir}/${r} missing`);
    for (const f of ["agent.js", "tools.js", "actions.js", "policy.js", "store.js", "model.js", "api.js", "bg.js", "panel.js", "panel.html"]) {
      assert.ok(existsSync(`${dir}/${f}`), `${dir}/${f} missing from the bundle`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
