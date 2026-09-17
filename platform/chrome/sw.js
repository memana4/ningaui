// Service worker: the host. Wires the loop and the proposal queue to Chrome's APIs.
//
// MV3 reality this file exists to handle:
//   * the worker is killed after ~30 s idle, so every run step and every proposal
//     is written to chrome.storage.local and survives the worker's death;
//   * an offscreen document that messages the worker every 20 s resets the idle
//     timer for the duration of a run, which is the supported keepalive;
//   * chrome.alarms is the only timer that survives worker death, so it is the
//     sweep that notices an abandoned run.
//
// Approval is asynchronous by design: a run may end with proposals pending, the
// human reviews them whenever, and the decisions (with reasons) are waiting in
// list_proposals the next time the agent runs.

import { runAgent, DEFAULT_LIMITS } from "./agent.js";
import { createStore } from "./store.js";
import { createProposals } from "./proposals.js";
import { pickModel } from "./model.js";

const DEFAULTS = {
  backend: "nano",
  baseUrl: "http://localhost:11434/v1",
  model: "",
  apiKey: "",
  allowlist: ["https://api.venice.ai/api/v1/models"],
  persona: "",
};

const store = createStore(chrome.storage.local);
let active = null;

const config = async () => ({ ...DEFAULTS, ...((await chrome.storage.local.get("config")).config || {}) });
const isAllowedWith = (allow) => (url) =>
  typeof url === "string" && allow.some((prefix) => url.startsWith(prefix));

const proposalsWith = async (allow) =>
  createProposals({ backend: chrome.storage.local, store, fetchImpl: fetch, isAllowed: isAllowedWith(allow) });

async function status(patch) {
  const cur = (await chrome.storage.local.get("status")).status || { state: "idle" };
  const next = { ...cur, ...patch, at: Date.now() };
  await chrome.storage.local.set({ status: next });
  try { chrome.runtime.sendMessage({ type: "status", status: next }); } catch (_) {}
  return next;
}

async function keepAlive(on) {
  const existing = chrome.runtime.getContexts
    ? (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length
    : 0;
  if (on && !existing) {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html", reasons: ["BLOBS"],
        justification: "keep the agent worker alive during a run",
      });
    } catch (err) {
      if (!String(err).includes("Only a single offscreen")) throw err;
    }
  }
  if (!on && existing) { try { await chrome.offscreen.closeDocument(); } catch (_) {} }
}

async function startRun(task) {
  if (active) return { error: "a run is already in progress" };
  const cfg = await config();
  const proposals = await proposalsWith(cfg.allowlist);

  let model;
  try {
    model = await pickModel({ config: cfg, fetchImpl: fetch, LanguageModel: self.LanguageModel });
  } catch (err) {
    await status({ state: "error", error: String(err.message || err) });
    return { error: String(err.message || err) };
  }

  active = { task };
  await keepAlive(true);
  await status({ state: "running", task, model: model.name, pending: (await proposals.pending()).length });

  const result = await runAgent({
    task, model, store, proposals, fetchImpl: fetch,
    isAllowed: isAllowedWith(cfg.allowlist),
    persona: cfg.persona,
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) },
    onEvent: (e) => {
      try { chrome.runtime.sendMessage({ type: "event", event: e }); } catch (_) {}
      if (e.type === "tool_call") status({ lastTool: e.name });
    },
  });

  const pending = (await proposals.pending()).length;
  active = null;
  await keepAlive(false);
  await status({
    state: result.status !== "ok" ? result.status : (pending ? "awaiting_approval" : "done"),
    runId: result.runId, steps: result.steps, result: result.result || null,
    error: result.error || null, pending,
  });
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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
      case "keepalive": reply({ ok: true }); break;
      default: reply({ error: `unknown message ${msg.type}` });
    }
  })();
  return true;
});

chrome.alarms.create("sweep", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  const st = (await chrome.storage.local.get("status")).status;
  if (st && st.state === "running" && !active) {
    await status({ state: "interrupted", note: "worker was recycled mid-run; journal retained" });
  }
});

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
