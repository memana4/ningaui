// Host entry point, shared by both browsers.
//
// The only difference between the builds is the manifest: Chrome starts this file as a
// service worker, Firefox starts it as an event page. Everything below is written for the
// stricter of the two — every step, action and policy change is on disk before the next
// begins, so a recycled worker loses the loop but never the record.

import { createApi, originsFor } from "./api.js";
import { runAgent, DEFAULT_LIMITS } from "./agent.js";
import { createStore } from "./store.js";
import { createPolicy, DEFAULT_POLICY } from "./policy.js";
import { createActions } from "./actions.js";
import { pickModel } from "./model.js";

const api = createApi(globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome);

const DEFAULTS = {
  backend: "nano",
  baseUrl: "http://localhost:11434/v1",
  model: "",
  apiKey: "",
  allowlist: ["https://api.venice.ai/api/v1/models"],
  persona: "",
  policy: {},
};

const store = createStore(api.storage);
let active = null;

const config = async () => ({ ...DEFAULTS, ...((await api.storage.get("config")).config || {}) });
const isAllowedWith = (allow) => (url) => typeof url === "string" && allow.some((p) => url.startsWith(p));

async function stack() {
  const cfg = await config();
  const policy = createPolicy({ backend: api.storage, overrides: cfg.policy || {} });
  const actions = createActions({
    backend: api.storage, store, fetchImpl: fetch, policy,
    isAllowed: isAllowedWith(cfg.allowlist),
  });
  return { cfg, policy, actions };
}

async function status(patch) {
  const cur = (await api.storage.get("status")).status || { state: "idle" };
  const next = { ...cur, ...patch, at: Date.now() };
  await api.storage.set({ status: next });
  try { api.runtime.sendMessage({ type: "status", status: next }); } catch (_) {}
  return next;
}

async function startRun(task) {
  if (active) return { error: "a run is already in progress" };
  const { cfg, policy, actions } = await stack();

  const origins = originsFor(cfg.allowlist);
  if (!(await api.permissions.contains(origins))) {
    const err = `host permission missing for ${origins.join(", ")} — grant it in the panel`;
    await status({ state: "error", error: err });
    return { error: err };
  }

  let model;
  try {
    model = await pickModel({ config: cfg, fetchImpl: fetch, LanguageModel: globalThis.LanguageModel });
  } catch (err) {
    await status({ state: "error", error: String(err.message || err) });
    return { error: String(err.message || err) };
  }

  active = { task };
  await api.keepalive.start();
  const v = await policy.view();
  await status({
    state: "running", task, model: model.name,
    pending: (await actions.pending()).length, autonomous: v.autonomous.length,
  });

  const result = await runAgent({
    task, model, store, actions, policy, fetchImpl: fetch,
    isAllowed: isAllowedWith(cfg.allowlist),
    persona: cfg.persona,
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) },
    onEvent: (e) => {
      try { api.runtime.sendMessage({ type: "event", event: e }); } catch (_) {}
      if (e.type === "tool_call") status({ lastTool: e.name });
    },
  });

  const pending = (await actions.pending()).length;
  const v2 = await policy.view();
  active = null;
  await api.keepalive.stop();
  await status({
    state: result.status !== "ok" ? result.status : (pending ? "awaiting_decision" : "done"),
    runId: result.runId, steps: result.steps, result: result.result || null,
    error: result.error || null, pending, autonomous: v2.autonomous.length,
  });
  return result;
}

api.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const { policy, actions } = await stack();
    switch (msg.type) {
      case "run": reply(await startRun(msg.task)); break;
      case "stop": active = null; reply({ stopped: true }); await status({ state: "stopped" }); break;

      case "actions": reply({
        pending: await actions.pending(),
        recent: await actions.recent(60),
        audit: (await actions.auditLog()).slice(-40).reverse(),
      }); break;

      case "decide": {
        try {
          const r = await actions.decide(msg.id, { decision: msg.decision, reason: msg.reason || "" });
          const pending = (await actions.pending()).length;
          await status({ pending, state: pending ? "awaiting_decision" : "idle" });
          reply({ ok: true, action: r });
        } catch (err) { reply({ ok: false, error: String(err.message || err) }); }
        break;
      }

      case "revert": {
        try {
          const r = await actions.revert(msg.id, { reason: msg.reason || "" });
          reply({ ok: true, action: r });
        } catch (err) { reply({ ok: false, error: String(err.message || err) }); }
        break;
      }

      case "clearDecided": reply({ cleared: await actions.clearDecided() }); break;
      case "journal": reply({ journal: await store.readJournal(msg.runId) }); break;

      case "trust": reply(await policy.view()); break;

      case "setLevel": {
        try {
          const rec = await policy.setLevel(msg.cls, msg.level, msg.note || "");
          reply({ ok: true, record: rec });
        } catch (err) { reply({ ok: false, error: String(err.message || err) }); }
        break;
      }

      case "revokeAll": {
        const n = await policy.revokeAll();
        await api.storage.set({ config: { ...(await config()), policy: { ...(await config()).policy, enabled: true } } });
        reply({ ok: true, revoked: n });
        break;
      }

      case "setPolicy": {
        const cfg = await config();
        const next = { ...cfg.policy, ...msg.patch };
        await api.storage.set({ config: { ...cfg, policy: next } });
        const p = createPolicy({ backend: api.storage, overrides: next });
        if (next.enabled === false) await p.revokeAll();
        reply({ ok: true, policy: await p.view() });
        break;
      }

      case "permissions": {
        const origins = originsFor((await config()).allowlist);
        if (msg.request) reply({ granted: await api.permissions.request(origins), origins });
        else reply({ granted: await api.permissions.contains(origins), origins });
        break;
      }

      case "env": reply({
        browser: api.name, isFirefox: api.isFirefox,
        keepalive: api.hasOffscreen ? "offscreen document" : "runtime port",
        builtInModel: api.hasBuiltInModel,
      }); break;

      case "keepalive": reply({ ok: true, ports: api.ports.size }); break;
      default: reply({ error: `unknown message ${msg.type}` });
    }
  })();
  return true;
});

// Firefox keepalive: while the panel holds a port, the event page is not reaped. The port
// doubles as a push channel, so status changes arrive without polling.
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  api.onPort(port);
  port.onMessage.addListener(async (m) => {
    if (m.type === "ping") {
      const st = (await api.storage.get("status")).status;
      port.postMessage({ type: "status", status: st });
    }
  });
  port.postMessage({ type: "hello", browser: api.name, policyDefaults: DEFAULT_POLICY });
});

api.runtime.onInstalled?.addListener(async () => {
  const cfg = await config();
  if (!(await api.permissions.contains(originsFor(cfg.allowlist)))) {
    await status({ state: "idle", note: "host permissions not granted yet" });
  }
});

// The only timer that survives worker death in either engine.
const alarms = globalThis.browser?.alarms || globalThis.chrome?.alarms;
alarms?.create("sweep", { periodInMinutes: 1 });
alarms?.onAlarm.addListener(async () => {
  const st = (await api.storage.get("status")).status;
  if (st && st.state === "running" && !active) {
    await status({ state: "interrupted", note: "background context was recycled mid-run; journal retained" });
  }
});

// Chrome only: the side panel opens on toolbar click. Firefox uses sidebar_action.
(globalThis.chrome?.sidePanel)?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
