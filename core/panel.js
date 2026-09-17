// Panel UI — one document, both browsers: Chrome renders it in the side panel,
// Firefox renders it in the sidebar; the manifest decides which.
//
// Two jobs: run the agent, and review what it proposed.
// Reviewer flow: the queue stacks up while you are away, every proposal is one line plus a
// rationale, and it is driven by four keys — arrows to move, a to approve, d to decline with
// a reason, s to skip. The reason is stored on the proposal and read back by the agent.

import { createApi, originsFor } from "./api.js";

const api = createApi(globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome);
const $ = (s) => document.querySelector(s);
let queue = { pending: [], decided: [] };
let sel = 0;

const send = (msg) => new Promise((res) => api.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function line(text, cls = "") {
  const el = document.createElement("div");
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
  if (msg.type === "event") line(fmtEvent(msg.event), msg.event.type);
  if (msg.type === "status") setState(msg.status);
});

// ---- keepalive -------------------------------------------------------------
// Firefox has no offscreen API: an open port from this panel is what stops the event page
// being reaped mid-run. It doubles as a push channel. Chrome ignores it (the offscreen
// document does the job there), but connecting costs nothing.
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
  if (st.state === "awaiting_approval") refreshQueue();
}

// ---- review ----------------------------------------------------------------
async function refreshQueue() {
  const r = await send({ type: "proposals" });
  queue = r || { pending: [], decided: [] };
  if (sel >= queue.pending.length) sel = Math.max(0, queue.pending.length - 1);
  $("#pendingcount").textContent = String(queue.pending.length);
  renderReview();
}

function renderReview() {
  const box = $("#review");
  if (!queue.pending.length) {
    box.innerHTML = '<div class="line dim">nothing waiting</div>';
  } else {
    box.innerHTML = queue.pending.map((p, i) => {
      const target = p.kind === "storage"
        ? `store key “${esc(p.target.key)}”`
        : `${esc(p.target.method)} ${esc(p.target.url)}`;
      const before = p.preview?.before ? esc(p.preview.before) : "—";
      const after = p.preview?.after ? esc(p.preview.after) : esc(JSON.stringify(p.payload));
      return `<div class="prop ${i === sel ? "sel" : ""}" data-i="${i}">
        <div class="prow"><b>${p.kind}</b> ${target} <span class="dim">${new Date(p.created).toLocaleTimeString()}</span></div>
        <div class="prat">${esc(p.rationale)}</div>
        <div class="pdiff"><span class="dim">now:</span> ${before}<br><span class="dim">after:</span> ${after}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".prop").forEach((el) => el.addEventListener("click", () => { sel = +el.dataset.i; renderReview(); }));
  }
  $("#decided").innerHTML = queue.decided.slice(0, 12).map((p) => {
    const what = p.kind === "storage" ? p.target.key : `${p.target.method} ${p.target.url}`;
    return `<div class="line ${p.status === "approved" ? "ok" : "warn"}">${p.status}: ${esc(what)}` +
           (p.reason ? ` — “${esc(p.reason)}”` : "") + `</div>`;
  }).join("") || '<div class="line dim">no decisions yet</div>';
}

async function decide(decision) {
  const p = queue.pending[sel];
  if (!p) return;
  const reason = $("#reason").value.trim();
  if (decision === "decline" && !reason) return line("declining needs a reason — the agent reads it", "warn");
  const r = await send({ type: "decide", id: p.id, decision, reason });
  if (!r.ok) return line("! " + r.error, "warn");
  const a = r.proposal.applied;
  line(`${decision === "approve" ? "✔ applied" : "✗ declined"} ${p.kind} ${p.kind === "storage" ? p.target.key : p.target.url}` +
       (a?.status ? ` (HTTP ${a.status})` : ""), decision === "approve" ? "ok" : "warn");
  $("#reason").value = "";
  await refreshQueue();
  await refreshStorage();
}

document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.key === "ArrowDown" || e.key === "j") { sel = Math.min(sel + 1, Math.max(0, queue.pending.length - 1)); renderReview(); }
  else if (e.key === "ArrowUp" || e.key === "k") { sel = Math.max(0, sel - 1); renderReview(); }
  else if (e.key === "a" || e.key === "Enter") decide("approve");
  else if (e.key === "d") decide("decline");
  else if (e.key === "s") { sel = Math.min(sel + 1, Math.max(0, queue.pending.length - 1)); renderReview(); }
  else if (e.key === "r") refreshQueue();
});

$("#approveAllStorage").addEventListener("click", async () => {
  const targets = queue.pending.filter((p) => p.kind === "storage");
  for (const p of targets) await send({ type: "decide", id: p.id, decision: "approve" });
  line(`approved ${targets.length} storage proposals`, "ok");
  await refreshQueue(); await refreshStorage();
});

$("#clearDecided").addEventListener("click", async () => {
  const r = await send({ type: "clearDecided" });
  line(`cleared ${r.cleared} decided proposals`, "ok");
  await refreshQueue();
});

document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { $("#reason").value = c.dataset.reason; }));

// ---- run -------------------------------------------------------------------
$("#run").addEventListener("click", async () => {
  const task = $("#task").value.trim();
  if (!task) return line("type a task first", "warn");
  $("#transcript").innerHTML = "";
  const r = await send({ type: "run", task });
  if (r && r.error) line("! " + r.error, "warn");
  await refreshQueue();
  await refreshStorage();
});

$("#stop").addEventListener("click", async () => {
  await send({ type: "stop" });
  setState((await api.storage.get("status")).status || { state: "idle" });
});

// ---- permissions and environment ------------------------------------------
async function refreshEnv() {
  const env = await send({ type: "env" });
  $("#env").textContent =
    `${env.browser} · keepalive: ${env.keepalive} · built-in model: ${env.builtInModel ? "available" : "not available"}`;
  const perms = await send({ type: "permissions" });
  $("#permstate").textContent = perms.granted ? "granted" : "NOT granted";
  $("#permstate").className = "state " + (perms.granted ? "done" : "error");
  $("#permorigins").textContent = perms.origins.join("  ") || "(none — set the allowlist)";
  if (env.isFirefox && !env.builtInModel) {
    $("#modelhint").textContent = "Firefox has no built-in model: use the OpenAI-compatible backend below (Ollama or a private endpoint).";
  }
}

$("#grant").addEventListener("click", async () => {
  const r = await send({ type: "permissions", request: true });
  line(r.granted ? "host permissions granted" : "permission request declined", r.granted ? "ok" : "warn");
  await refreshEnv();
});

// ---- storage + settings ----------------------------------------------------
async function refreshStorage() {
  const all = await api.storage.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("agent:")).sort();
  const box = $("#store");
  box.innerHTML = keys.map((k) => `<div class="line">${esc(k.slice(6))} = ${esc(JSON.stringify(all[k]).slice(0, 200))}</div>`).join("")
    || '<div class="line dim">empty</div>';
  $("#storecount").textContent = String(keys.length);
}

document.querySelector("#refresh")?.addEventListener("click", refreshStorage);

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
  const mf = api.runtime.getManifest();
  $("#hosts").textContent = (mf.host_permissions || []).join("  ");
}

$("#save").addEventListener("click", async () => {
  const allowlist = $("#allowlist").value.split("\n").map((s) => s.trim()).filter(Boolean);
  await api.storage.set({
    config: {
      backend: $("#backend").value,
      baseUrl: $("#baseUrl").value.trim(),
      model: $("#model").value.trim(),
      apiKey: $("#apiKey").value.trim(),
      allowlist,
      persona: $("#persona").value.trim(),
    },
  });
  line("settings saved — the allowlist is enforced in the background, not here", "ok");
  line(`origins to grant: ${originsFor(allowlist).join(", ")}`, "dim");
  await refreshEnv();
});

connectPort();
loadConfig();
refreshQueue();
refreshStorage();
refreshEnv();
api.storage.get("status").then((s) => setState(s.status || { state: "idle" }));
