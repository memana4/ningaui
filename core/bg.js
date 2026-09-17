// Host entry point, shared by both browsers.
//
// The only difference between the builds is the manifest: Chrome starts this file as a
// service worker, Firefox starts it as an event page. Everything below is written for the
// stricter of the two — every step and every proposal is on disk before the next begins,
// so a recycled worker loses the loop but never the record.

import { createApi, originsFor } from "./api.js";
import { runAgent, DEFAULT_LIMITS } from "./agent.js";
import { createStore } from "./store.js";
import { createProposals } from "./proposals.js";
import { pickModel } from "./model.js";

const api = createApi(globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome);

const DEFAULTS = {
  backend: "nano",
  baseUrl: "http://localhost:11434/v1",
  model: "",
  apiKey: "",
  allowlist: ["https://api.venice.ai/api/v1/models"],
  persona: "",
};

const store = createStore(api.storage);
let active = null;

const config = async () => ({ ...DEFAULTS, ...((await api.storage.get("config")).config || {}) });
const isAllowedWith = (allow) => (url) => typeof url === "string" && allow.some((p) => url.startsWith(p));
const proposalsWith = async (allow) =>
  createProposals({ backend: api.storage, store, fetchImpl: fetch, isAllowed: isAllowedWith(allow) });

async function status(patch) {
  const cur = (await api.storage.get("status")).status || { state: "idle" };
  const next = { ...cur, ...patch, at: Date.now() };
  await api.storage.set({ status: next });
  try { api.runtime.sendMessage({ type: "status", status: next }); } catch (_) {}
  return next;
}

async function startRun(task) {
  if (active) return { error: "a run is already in progress" };
  const cfg = await config();
  const proposals = await proposalsWith(cfg.allowlist);

  // Firefox: host permissions are revocable, so a run that silently cannot reach its
  // API is worse than a run that refuses to start.
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
  await status({ state: "running", task, model: model.name, pending: (await proposals.pending()).length });

  const result = await runAgent({
    task, model, store, proposals, fetchImpl: fetch,
    isAllowed: isAllowedWith(cfg.allowlist),
    persona: cfg.persona,
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) },
    onEvent: (e) => {
      try { api.runtime.sendMessage({ type: "event", event: e }); } catch (_) {}
      if (e.type === "tool_call") status({ lastTool: e.name });
    },
  });

  const pending = (await proposals.pending()).length;
  active = null;
  await api.keepalive.stop();
  await status({
    state: result.status !== "ok" ? result.status : (pending ? "awaiting_approval" : "done"),
    runId: result.runId, steps: result.steps, result: result.result || null,
    error: result.error || null, pending,
  });
  return result;
}

api.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const cfg = await config();
    const proposals = await proposalsWith(cfg.allowlist);
    switch (msg.type) {
      case "run": reply(await startRun(msg.task)); break;
      case "stop": active = null; reply({ stopped: true }); await status({ state: "stopped" }); break;
      case "proposals": reply({
        pending: await proposals.pending(),
        decided: (await proposals.decided()).slice(-50).reverse(),
        audit: (await proposals.auditLog()).slice(-30).reverse(),
      }); break;
      case "decide": {
        try {
          const r = await proposals.decide(msg.id, { decision: msg.decision, reason: msg.reason || "" });
          const pending = (await proposals.pending()).length;
          await status({ pending, state: pending ? "awaiting_approval" : "idle" });
          reply({ ok: true, proposal: r });
        } catch (err) { reply({ ok: false, error: String(err.message || err) }); }
        break;
      }
      case "clearDecided": reply({ cleared: await proposals.clearDecided() }); break;
      case "journal": reply({ journal: await store.readJournal(msg.runId) }); break;
      case "permissions": {
        const origins = originsFor(cfg.allowlist);
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
// also gives the panel a push channel, so status changes arrive without polling.
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  api.onPort(port);
  port.onMessage.addListener(async (m) => {
    if (m.type === "ping") {
      const st = (await api.storage.get("status")).status;
      port.postMessage({ type: "status", status: st });
    }
  });
  port.postMessage({ type: "hello", browser: api.name });
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
