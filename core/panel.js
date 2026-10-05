// Panel UI — one document, both browsers: Chrome renders it in the side panel,
// Firefox renders it in the sidebar; the manifest decides which.
//
// Three jobs: run the agent, decide what it is waiting on you for, and manage how much
// autonomy it has earned.

import { createApi, pickHost, originsFor } from "./api.js";

const api = createApi(pickHost());
// The extension renders this file in its own document; the bookmarklet mounts it inside a
// shadow root under __NINGAUI_ROOT__. Every lookup goes through the root, so both work.
const root = globalThis.__NINGAUI_ROOT__ || document;
const $ = (s) => root.querySelector(s);
const mk = (tag) => (root.ownerDocument || document).createElement(tag);
let queue = { pending: [], recent: [], audit: [] };
let trust = { classes: [], autonomous: [], enabled: true };
let sel = 0;

const send = (msg) => new Promise((res) => api.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const short = (o, n = 200) => esc(JSON.stringify(o)?.slice(0, n) ?? "");

function line(text, cls = "") {
  const el = mk("div");
  el.className = "line " + cls;
  el.textContent = text;
  $("#transcript").appendChild(el);
  $("#transcript").scrollTop = $("#transcript").scrollHeight;
}

function fmtEvent(e) {
  switch (e.type) {
    case "start": return `▶ ${e.task}`;
    case "tool_call": return `→ ${e.name}(${JSON.stringify(e.args ?? {}).slice(0, 160)})`;
    case "tool_result": return `← ${e.name} (${e.ms} ms) ${JSON.stringify(e.result ?? {}).slice(0, 220)}`;
    case "final": return `✔ ${e.text}`;
    case "parse_error": return `! reply was not JSON (${e.error}) — asking again`;
    case "model_error": return `! model error: ${e.error}`;
    case "stop": return `■ stopped: ${e.reason}`;
    default: return JSON.stringify(e);
  }
}

api.runtime.onMessage.addListener((msg) => {
  if (msg.type === "event") {
    const cls = msg.event.type;
    line(fmtEvent(msg.event), cls);
    if (cls === "tool_result" && /list_actions|request_autonomy/.test(msg.event.name || "")) refreshAll();
  }
  if (msg.type === "status") setState(msg.status);
});

// ---- keepalive -------------------------------------------------------------
// Firefox has no offscreen API: an open port from this panel is what stops the event page
// being reaped mid-run. It doubles as a push channel. Chrome ignores it.
let port = null;
function connectPort() {
  try {
    port = api.runtime.connect({ name: "panel" });
    port.onMessage.addListener((m) => { if (m.type === "status") setState(m.status); });
    port.onDisconnect.addListener(() => { port = null; });
  } catch (_) { port = null; }
}
setInterval(() => { try { port?.postMessage({ type: "ping" }); } catch (_) {} }, 20_000);

function setState(st) {
  if (!st) return;
  $("#state").textContent = st.state + (st.model ? ` · ${st.model}` : "");
  $("#state").className = "state " + st.state;
  if (st.result) line(`result: ${st.result}`, "ok");
  if (st.error) line(`error: ${st.error}`, "warn");
  if (st.pending !== undefined) $("#pendingcount").textContent = String(st.pending);
  if (st.state === "awaiting_decision") refreshAll();
}

// ---- refresh ---------------------------------------------------------------
async function refreshAll() { await Promise.all([refreshQueue(), refreshTrust()]); }

async function refreshQueue() {
  const r = await send({ type: "actions" });
  queue = r || { pending: [], recent: [] };
  if (sel >= queue.pending.length) sel = Math.max(0, queue.pending.length - 1);
  $("#pendingcount").textContent = String(queue.pending.length);
  renderQueue();
}

async function refreshTrust() {
  trust = await send({ type: "trust" });
  renderTrust();
}

// ---- the queue -------------------------------------------------------------
function actionRow(a, i) {
  const target = a.kind === "store" ? `store “${esc(a.target.key)}”`
    : a.kind === "policy" ? `policy for ${esc(a.target.cls)}`
    : `${esc(a.target.method)} ${esc(a.target.url)}`;
  const before = a.preview?.before ? esc(a.preview.before) : "—";
  const after = a.preview?.after ? esc(a.preview.after) : short(a.payload);
  return `<div class="prop ${i === sel ? "sel" : ""}" data-i="${i}">
    <div class="prow"><b>${a.kind}</b> ${target} <span class="dim">${a.cls || ""}</span></div>
    <div class="prat">${esc(a.rationale)}</div>
    <div class="pdiff"><span class="dim">now:</span> ${before}<br><span class="dim">after:</span> ${after}</div>
    <div class="pwhy dim">why not auto: ${esc(a.policyWhy || "")}</div>
  </div>`;
}

function renderQueue() {
  const box = $("#review");
  box.innerHTML = queue.pending.length
    ? queue.pending.map(actionRow).join("")
    : '<div class="line dim">nothing waiting on you</div>';
  box.querySelectorAll(".prop").forEach((el) => el.addEventListener("click", () => { sel = +el.dataset.i; renderQueue(); }));

  $("#recent").innerHTML = queue.recent.slice(0, 25).map((a) => {
    const what = a.kind === "store" ? a.target.key
      : a.kind === "policy" ? `policy ${a.target.cls}`
      : `${a.target.method} ${a.target.url}`;
    const tag = a.mode === "auto" ? "auto" : "approved";
    const cls = a.status === "applied" ? (a.mode === "auto" ? "ok" : "ok") : a.status === "declined" ? "warn" : "dim";
    const status = a.applied?.status ? ` · HTTP ${a.applied.status}` : "";
    const reason = a.reason ? ` — “${esc(a.reason)}”` : "";
    const revert = a.status === "applied"
      ? `<button class="mini ghost rev" data-id="${a.id}">revert</button>` : "";
    return `<div class="line ${cls}">${tag}: ${esc(what)} <span class="dim">${a.cls || ""}</span>${status}${reason}${revert}</div>`;
  }).join("") || '<div class="line dim">nothing yet</div>';

  $("#recent").querySelectorAll(".rev").forEach((b) => b.addEventListener("click", async () => {
    const reason = prompt("Why revert this action?");
    if (reason === null) return;
    const r = await send({ type: "revert", id: b.dataset.id, reason });
    line(r.ok ? `reverted ${b.dataset.id}` : `! ${r.error}`, r.ok ? "ok" : "warn");
    await refreshAll();
  }));
}

async function decide(decision) {
  const a = queue.pending[sel];
  if (!a) return;
  const reason = $("#reason").value.trim();
  if (decision === "decline" && !reason) return line("declining needs a reason — the agent reads it", "warn");
  const r = await send({ type: "decide", id: a.id, decision, reason });
  if (!r.ok) return line("! " + r.error, "warn");
  const applied = r.action.applied;
  line(`${decision === "approve" ? "✔ applied" : "✗ declined"} ${a.kind} ${a.cls}` +
       (applied?.status ? ` (HTTP ${applied.status})` : ""), decision === "approve" ? "ok" : "warn");
  const pc = r.action.policyChange;
  if (pc && pc.changed) line(`policy: ${pc.why}`, "warn");
  $("#reason").value = "";
  await refreshAll();
}

root.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.key === "ArrowDown" || e.key === "j") { sel = Math.min(sel + 1, Math.max(0, queue.pending.length - 1)); renderQueue(); }
  else if (e.key === "ArrowUp" || e.key === "k") { sel = Math.max(0, sel - 1); renderQueue(); }
  else if (e.key === "a" || e.key === "Enter") decide("approve");
  else if (e.key === "d") decide("decline");
  else if (e.key === "s") { sel = Math.min(sel + 1, Math.max(0, queue.pending.length - 1)); renderQueue(); }
  else if (e.key === "r") refreshAll();
});

$("#approveAllStore").addEventListener("click", async () => {
  const targets = queue.pending.filter((a) => a.kind === "store" || a.kind === "policy");
  for (const a of targets) await send({ type: "decide", id: a.id, decision: "approve" });
  line(`approved ${targets.length} sandbox/policy actions`, "ok");
  await refreshAll();
});

$("#clearDecided").addEventListener("click", async () => {
  const r = await send({ type: "clearDecided" });
  line(`cleared ${r.cleared} decided actions`, "ok");
  await refreshAll();
});

root.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { $("#reason").value = c.dataset.reason; }));

// ---- autonomy --------------------------------------------------------------
function renderTrust() {
  const t = trust || {};
  const on = t.enabled !== false;
  $("#autostate").textContent = on
    ? `${(t.autonomous || []).length} class${(t.autonomous || []).length === 1 ? "" : "es"} trusted · ${t.autoHour || 0}/${t.maxAutoPerHour || 0} auto actions this hour`
    : "autonomy off — everything waits for you";
  $("#autostate").className = "state " + (on && (t.autonomous || []).length ? "done" : "idle");
  $("#autotoggle").textContent = on ? "turn autonomy off" : "turn autonomy on";

  $("#trust").innerHTML = (t.classes || []).length ? (t.classes || []).map((c) => `
    <div class="trow">
      <div class="tname"><b>${esc(c.level)}</b> ${esc(c.cls)}
        <span class="dim">${c.approved} approved · ${c.declined} declined · ${c.auto} auto · ${c.errors} errors${c.reverted ? ` · ${c.reverted} reverted` : ""}</span>
        ${c.note ? `<span class="dim">${esc(c.note)}</span>` : ""}
      </div>
      <select class="tlevel" data-cls="${esc(c.cls)}">
        <option value="confirm"${c.level === "confirm" ? " selected" : ""}>confirm</option>
        <option value="auto"${c.level === "auto" ? " selected" : ""}>auto</option>
        <option value="deny"${c.level === "deny" ? " selected" : ""}>deny</option>
      </select>
    </div>`).join("") : '<div class="line dim">no classes yet — the ledger fills as the agent proposes things</div>';

  $("#trust").querySelectorAll(".tlevel").forEach((sel2) => sel2.addEventListener("change", async () => {
    const r = await send({ type: "setLevel", cls: sel2.dataset.cls, level: sel2.value });
    line(r.ok ? `${sel2.dataset.cls} → ${sel2.value} (by hand; outranks the earned level)` : `! ${r.error}`, r.ok ? "ok" : "warn");
    await refreshTrust();
  }));
}

$("#revokeall").addEventListener("click", async () => {
  const r = await send({ type: "revokeAll" });
  line(`revoked autonomy on ${r.revoked} classes`, "warn");
  await refreshAll();
});

$("#autotoggle").addEventListener("click", async () => {
  const r = await send({ type: "setPolicy", patch: { enabled: trust.enabled === false } });
  trust = r.policy;
  line(`autonomy ${trust.enabled ? "on" : "off"}`, trust.enabled ? "ok" : "warn");
  renderTrust();
});

// ---- run -------------------------------------------------------------------
$("#run").addEventListener("click", async () => {
  const task = $("#task").value.trim();
  if (!task) return line("type a task first", "warn");
  $("#transcript").innerHTML = "";
  const r = await send({ type: "run", task });
  if (r && r.error) line("! " + r.error, "warn");
  await refreshAll(); await refreshStorage();
});

$("#stop").addEventListener("click", async () => {
  await send({ type: "stop" });
  setState((await api.storage.get("status")).status || { state: "idle" });
});

// ---- permissions, storage, settings ---------------------------------------
async function refreshEnv() {
  const env = await send({ type: "env" });
  $("#env").textContent = `${env.browser} · keepalive: ${env.keepalive} · built-in model: ${env.builtInModel ? "available" : "not available"}`;
  const perms = await send({ type: "permissions" });
  $("#permstate").textContent = perms.granted ? "granted" : "NOT granted";
  $("#permstate").className = "state " + (perms.granted ? "done" : "error");
  $("#permorigins").textContent = perms.origins.join("  ") || "(none — set the allowlist)";
  if (env.isFirefox && !env.builtInModel) {
    $("#modelhint").textContent = "Firefox has no built-in model: use the OpenAI-compatible backend below (Ollama or a private endpoint).";
  }
  if (env.browser === "bookmarklet") {
    $("#modelhint").textContent = "Bookmarklet mode: this page's CORS rules decide which endpoints answer, and anything saved here is visible to this site's own scripts — prefer local endpoints, or sites you trust.";
  }
}

$("#grant").addEventListener("click", async () => {
  const r = await send({ type: "permissions", request: true });
  line(r.granted ? "host permissions granted" : "permission request declined", r.granted ? "ok" : "warn");
  await refreshEnv();
});

async function refreshStorage() {
  const all = await api.storage.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("agent:")).sort();
  $("#store").innerHTML = keys.map((k) => `<div class="line">${esc(k.slice(6))} = ${esc(JSON.stringify(all[k]).slice(0, 200))}</div>`).join("")
    || '<div class="line dim">empty</div>';
  $("#storecount").textContent = String(keys.length);
}
$("#refresh")?.addEventListener("click", refreshStorage);

$("#clear").addEventListener("click", async () => {
  const all = await api.storage.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("agent:"));
  if (keys.length) await api.storage.remove(keys);
  await refreshStorage();
  line(`cleared ${keys.length} keys`, "ok");
});

async function loadConfig() {
  const cfg = (await api.storage.get("config")).config || {};
  $("#backend").value = cfg.backend || "nano";
  $("#baseUrl").value = cfg.baseUrl || "http://localhost:11434/v1";
  $("#model").value = cfg.model || "";
  $("#apiKey").value = cfg.apiKey || "";
  $("#allowlist").value = (cfg.allowlist || []).join("\n");
  $("#persona").value = cfg.persona || "";
  const pol = cfg.policy || {};
  $("#minapprovals").value = pol.minApprovals ?? 8;
  $("#alwaysconfirm").value = (pol.alwaysConfirm || []).join("\n");
  const hosts = api.runtime.getManifest()?.host_permissions || [];
  $("#hosts").textContent = hosts.length ? hosts.join("  ") : "(bookmarklet mode: the page's CORS rules apply, not manifest permissions)";
}

$("#save").addEventListener("click", async () => {
  const cfg = (await api.storage.get("config")).config || {};
  const allowlist = $("#allowlist").value.split("\n").map((s) => s.trim()).filter(Boolean);
  await api.storage.set({
    config: {
      ...cfg,
      backend: $("#backend").value,
      baseUrl: $("#baseUrl").value.trim(),
      model: $("#model").value.trim(),
      apiKey: $("#apiKey").value.trim(),
      allowlist,
      persona: $("#persona").value.trim(),
      policy: {
        ...(cfg.policy || {}),
        minApprovals: Number($("#minapprovals").value) || 8,
        alwaysConfirm: $("#alwaysconfirm").value.split("\n").map((s) => s.trim()).filter(Boolean),
      },
    },
  });
  line("settings saved — policy is enforced in the background, not here", "ok");
  line(`origins to grant: ${originsFor(allowlist).join(", ")}`, "dim");
  await refreshEnv();
});

connectPort();
loadConfig();
refreshAll();
refreshStorage();
refreshEnv();
api.storage.get("status").then((s) => setState(s.status || { state: "idle" }));
