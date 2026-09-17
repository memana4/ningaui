// Policy tests: the rules that decide when the agent may act without asking.
//
// The clock is injected, so the time-based thresholds are tested in milliseconds rather
// than by waiting three days.

import assert from "node:assert/strict";
import { createPolicy, classFor, matches, DEFAULT_POLICY } from "../core/policy.js";

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

const HOUR = 3600e3, DAY = 24 * HOUR;
function fixture(overrides = {}) {
  let now = 1_700_000_000_000;
  const backend = memoryBackend();
  const policy = createPolicy({ backend, clock: () => now, overrides });
  return { policy, backend, tick: (ms) => { now += ms; }, now: () => now };
}

const API = { kind: "api", target: { url: "https://api.example.com/orders/42", method: "POST" } };

await test("classFor normalises ids so /orders/8 and /orders/9 are one class", () => {
  assert.equal(classFor(API), "POST api.example.com/orders/{id}");
  assert.equal(classFor({ kind: "api", target: { url: "https://api.example.com/orders/999", method: "post" } }),
    "POST api.example.com/orders/{id}");
  assert.equal(classFor({ kind: "api", target: { url: "https://a.example.com/x/2fa8f1c0-9c2b-4a11-8f0e-9b1c2d3e4f50", method: "PATCH" } }),
    "PATCH a.example.com/x/{id}");
  assert.equal(classFor({ kind: "store", target: { key: "notes:today" } }), "store notes");
  assert.equal(classFor({ kind: "policy", target: { cls: "POST api/orders/{id}" } }), "policy POST api/orders/{id}");
});

await test("matches() is a glob over the class string, case-insensitive", () => {
  assert.ok(matches("DELETE *", "DELETE api.example.com/orders/{id}"));
  assert.ok(matches("POST api.example.com/*", "POST api.example.com/orders/{id}"));
  assert.ok(!matches("GET *", "POST api.example.com/orders/{id}"));
  assert.ok(!matches("", "POST x"));
  assert.ok(matches("*", "anything at all"));
});

await test("nothing is autonomous out of the box", async () => {
  const { policy } = fixture();
  const d = await policy.decide(API);
  assert.equal(d.level, "confirm");
  assert.match(d.why, /no autonomy on this class yet/);
  assert.equal(DEFAULT_POLICY.enabled, true);
  assert.equal(DEFAULT_POLICY.autoPromote, true);
});

await test("with autonomy switched off, everything waits for a human", async () => {
  const { policy } = fixture({ enabled: false });
  const d = await policy.decide(API);
  assert.equal(d.level, "confirm");
  assert.match(d.why, /switched off/);
});

await test("deny is absolute, and alwaysConfirm outranks an earned auto", async () => {
  const f = fixture({ alwaysConfirm: ["DELETE *"] });
  await f.policy.setLevel("DELETE api.example.com/orders/{id}", "deny", "never");
  assert.equal((await f.policy.decide({ kind: "api", target: { url: "https://api.example.com/orders/1", method: "DELETE" } })).level, "deny");

  await f.policy.setLevel("POST api.example.com/orders/{id}", "auto", "trusted once");
  const cfg = f.policy.setConfig({ alwaysConfirm: ["POST api.example.com/*"] });
  assert.deepEqual(cfg.alwaysConfirm, ["POST api.example.com/*"]);
  assert.equal((await f.policy.decide(API)).level, "confirm");
});

await test("an explicitly allowed pattern is autonomous without earning it", async () => {
  const { policy } = fixture({ autoAllow: ["POST api.example.com/*"] });
  const d = await policy.decide(API);
  assert.equal(d.level, "auto");
  assert.match(d.why, /you granted/);
});

await test("autonomy is earned: approvals plus a clean stretch, and it takes time", async () => {
  const f = fixture({ minApprovals: 3, minCleanMs: DAY });
  const cls = classFor(API);
  for (let i = 0; i < 3; i++) {
    await f.policy.noteDecision({ ...API, cls }, "approve");
    f.tick(HOUR);
  }
  assert.equal((await f.policy.get(cls)).level, "confirm", "not yet: the clean stretch has not elapsed");
  f.tick(DAY);
  const change = await f.policy.noteDecision({ ...API, cls }, "approve");
  assert.equal(change.changed, true);
  assert.equal((await f.policy.get(cls)).level, "auto");
  assert.equal((await f.policy.decide(API)).level, "auto");
});

await test("no promotion when autoPromote is off, however good the record", async () => {
  const f = fixture({ autoPromote: false, minApprovals: 1, minCleanMs: 0 });
  const cls = classFor(API);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  assert.equal((await f.policy.get(cls)).level, "confirm");
});

await test("a decline revokes autonomy instantly and starts a cooldown", async () => {
  const f = fixture({ minApprovals: 1, minCleanMs: 0, cooldownMs: DAY });
  const cls = classFor(API);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  assert.equal((await f.policy.get(cls)).level, "auto");

  const change = await f.policy.noteDecision({ ...API, cls }, "decline");
  assert.equal(change.changed, true, "the decline must report that it revoked something");
  assert.equal((await f.policy.get(cls)).level, "confirm");
  assert.equal((await f.policy.decide(API)).level, "confirm");

  // a clean record is not enough while the cooldown holds
  f.tick(HOUR);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  assert.equal((await f.policy.get(cls)).level, "confirm", "still cooling down");
  f.tick(DAY);
  const back = await f.policy.noteDecision({ ...API, cls }, "approve");
  assert.equal(back.changed, true, "after the cooldown and a clean stretch it can be earned again");
});

await test("an apply error revokes autonomy and starts a cooldown", async () => {
  const f = fixture({ minApprovals: 1, minCleanMs: 0, cooldownMs: DAY });
  const cls = classFor(API);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  const change = await f.policy.noteApplied({ ...API, cls, mode: "auto" }, { ok: false, error: "HTTP 500" });
  assert.equal(change.changed, true);
  assert.equal((await f.policy.get(cls)).level, "confirm");
  assert.match((await f.policy.get(cls)).note, /HTTP 500/);
});

await test("a revert revokes autonomy", async () => {
  const f = fixture({ minApprovals: 1, minCleanMs: 0 });
  const cls = classFor(API);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  const change = await f.policy.noteReverted({ ...API, cls }, "sent the wrong amount");
  assert.equal(change.changed, true);
  const rec = await f.policy.get(cls);
  assert.equal(rec.level, "confirm");
  assert.equal(rec.reverted, 1);
});

await test("the per-run quota stops autonomous action and falls back to confirm", async () => {
  const f = fixture({ autoAllow: ["POST *"], maxAutoPerRun: 2 });
  await f.policy.beginRun();
  assert.equal((await f.policy.decide(API)).level, "auto");
  await f.policy.noteApplied({ ...API, cls: classFor(API), mode: "auto" }, { ok: true });
  await f.policy.noteApplied({ ...API, cls: classFor(API), mode: "auto" }, { ok: true });
  const d = await f.policy.decide(API);
  assert.equal(d.level, "confirm");
  assert.match(d.why, /per-run autonomy quota/);
  await f.policy.beginRun();
  assert.equal((await f.policy.decide(API)).level, "auto", "a new run gets a fresh quota");
});

await test("the hourly quota is checked against recent auto applications", async () => {
  const f = fixture({ autoAllow: ["POST *"], maxAutoPerHour: 2, maxAutoPerRun: 100 });
  const cls = classFor(API);
  await f.policy.beginRun();
  await f.policy.noteApplied({ ...API, cls, mode: "auto" }, { ok: true });
  await f.policy.noteApplied({ ...API, cls, mode: "auto" }, { ok: true });
  assert.match((await f.policy.decide(API)).why, /hourly autonomy quota/);
  f.tick(HOUR + 1);
  assert.equal((await f.policy.decide(API)).level, "auto", "the window rolls");
});

await test("a hand-set level is explicit, and revokeAll clears earned autonomy", async () => {
  const f = fixture({ minApprovals: 1, minCleanMs: 0 });
  const cls = classFor(API);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  assert.equal((await f.policy.get(cls)).level, "auto");

  const rec = await f.policy.setLevel(cls, "confirm", "not this week");
  assert.equal(rec.explicit, true);
  assert.equal(rec.note, "not this week");

  await f.policy.setLevel(cls, "auto", "ok, go");
  assert.equal((await f.policy.decide(API)).level, "auto");
  const n = await f.policy.revokeAll();
  assert.equal(n, 1);
  assert.equal((await f.policy.get(cls)).level, "confirm");
  assert.equal((await f.policy.decide(API)).level, "confirm");
});

await test("view() reports what is trusted, and why a class is not", async () => {
  const f = fixture({ minApprovals: 2, minCleanMs: 0 });
  const cls = classFor(API);
  await f.policy.noteDecision({ ...API, cls }, "approve");
  let v = await f.policy.view();
  assert.equal(v.classes.length, 1);
  assert.equal(v.classes[0].approved, 1);
  assert.equal(v.classes[0].eligible, false, "one approval short");
  await f.policy.noteDecision({ ...API, cls }, "approve");
  v = await f.policy.view();
  assert.deepEqual(v.autonomous, [cls]);
  assert.equal(v.classes[0].eligible, true);
  assert.equal(v.enabled, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
