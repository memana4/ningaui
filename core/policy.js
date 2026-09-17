// Policy: how much rope the agent gets, per kind of action.
//
// The approval gate is one of three levels, not the only option:
//
//   deny     the agent may not do this at all, and may not queue it either
//   confirm  queue it; a human decides, with a rationale and a preview  (default)
//   auto     the agent does it itself, journals it, and tells you afterwards
//
// Nothing is `auto` out of the box. A class of action is *earned* into autonomy by a
// record — enough approvals, a clean stretch with no declines and no apply errors — and
// loses it immediately on a single decline, error or revert. A human can also set or
// revoke a level by hand, and those decisions outrank the earned ones.
//
// Everything here is deterministic. There is no model in the loop deciding whether the
// model has been good: only counters, timestamps and thresholds.

const T = "trust:";
const AUTO_LOG = "autolog";

export const LEVELS = ["deny", "confirm", "auto"];

export const DEFAULT_POLICY = {
  enabled: true,          // master switch: off means everything is confirm
  autoPromote: true,      // allow classes to earn autonomy from their record
  minApprovals: 8,        // approvals before a class is eligible
  minCleanMs: 72 * 3600e3,// how long it must also have been free of declines and errors
  cooldownMs: 24 * 3600e3,// after a demotion, how long before it can be considered again
  maxAutoPerRun: 20,      // per run
  maxAutoPerHour: 30,     // per hour, across runs
  alwaysConfirm: [],      // class patterns that can never be auto, e.g. "DELETE *"
  autoAllow: [],          // class patterns the human has explicitly promoted
};

// An action class is the stable identity of "a kind of thing the agent does".
// Ids in paths are normalised so /orders/8 and /orders/9 are one class.
export function classFor(action) {
  if (action.kind === "store") {
    const head = String(action.target.key || "").split(/[.:/]/)[0];
    return `store ${head || "(root)"}`;
  }
  if (action.kind === "policy") return `policy ${action.target.cls}`;
  try {
    const u = new URL(action.target.url);
    const path = u.pathname
      // a uuid is one id, and must be replaced before the numeric rule sees its digits
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/{id}")
      // a path segment that is entirely digits
      .replace(/\/\d+(?=\/|$)/g, "/{id}")
      // a long opaque id: hex or alphanumeric, at least 16 characters
      .replace(/\/[0-9a-z]{16,}(?=\/|$)/gi, "/{id}")
      .replace(/\/$/, "");
    return `${action.target.method.toUpperCase()} ${u.host}${path || "/"}`;
  } catch (_) {
    return `${action.target.method || "?"} ${action.target.url || "?"}`;
  }
}

// Glob match against a class string. Only `*` is special.
export function matches(pattern, cls) {
  const p = String(pattern).trim();
  if (!p) return false;
  const rx = new RegExp("^" + p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return rx.test(cls);
}

export function createPolicy({ backend, clock = () => Date.now(), overrides = {} }) {
  let config = { ...DEFAULT_POLICY, ...overrides };
  let autoThisRun = 0;

  const key = (cls) => T + cls;
  const blank = (cls) => ({
    cls, level: "confirm", explicit: false, proposed: 0, approved: 0, declined: 0,
    auto: 0, errors: 0, reverted: 0, firstSeen: clock(), lastDecision: null,
    lastDecline: null, lastError: null, cooldownUntil: 0, note: null,
  });

  async function get(cls) {
    const raw = (await backend.get(key(cls)))[key(cls)];
    return { ...blank(cls), ...(raw || {}) };
  }

  async function put(rec) {
    await backend.set({ [key(rec.cls)]: rec });
    return rec;
  }

  async function ledger() {
    const all = await backend.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(T))
      .map(([, v]) => v)
      .sort((a, b) => b.approved - a.approved);
  }

  // Only the last hour counts, and the window is evaluated on read: a stored stamp older
  // than an hour must not keep the quota closed.
  async function autoLog() {
    const raw = (await backend.get(AUTO_LOG))[AUTO_LOG] || [];
    const now = clock();
    const fresh = raw.filter((t) => now - t < 3600e3);
    if (fresh.length !== raw.length) await backend.set({ [AUTO_LOG]: fresh });
    return fresh;
  }

  async function stampAuto() {
    const now = clock();
    const log = await autoLog();
    log.push(now);
    await backend.set({ [AUTO_LOG]: log.slice(-200) });
    autoThisRun++;
    return log.length;
  }

  // ---- the decision ---------------------------------------------------------
  async function decide(action) {
    const cls = classFor(action);
    if (!config.enabled) return { level: "confirm", cls, why: "autonomy is switched off" };

    // deny is checked before any pattern, because it is the stricter instruction
    const rec = await get(cls);
    if (rec.level === "deny") return { level: "deny", cls, why: rec.note || "denied by policy" };
    if (config.alwaysConfirm.some((p) => matches(p, cls))) {
      return { level: "confirm", cls, why: "matches an always-confirm pattern" };
    }

    const explicitAuto = config.autoAllow.some((p) => matches(p, cls)) || (rec.explicit && rec.level === "auto");
    const earnedAuto = rec.level === "auto";
    if (!explicitAuto && !earnedAuto) return { level: "confirm", cls, why: "no autonomy on this class yet" };

    // quotas are a safety net: they apply to granted autonomy as well as earned autonomy
    if (autoThisRun >= config.maxAutoPerRun) return { level: "confirm", cls, why: "per-run autonomy quota reached" };
    if ((await autoLog()).length >= config.maxAutoPerHour) return { level: "confirm", cls, why: "hourly autonomy quota reached" };

    return {
      level: "auto", cls,
      why: explicitAuto ? "you granted this class autonomy" : "earned: clean record on this class",
    };
  }

  // ---- the record -----------------------------------------------------------
  async function noteProposed(action) {
    const rec = await get(action.cls || classFor(action));
    rec.proposed++;
    return put(rec);
  }

  async function noteDecision(action, decision) {
    const cls = action.cls || classFor(action);
    const rec = await get(cls);
    const now = clock();
    rec.lastDecision = now;
    if (decision === "approve") rec.approved++;
    if (decision === "decline") {
      rec.declined++;
      rec.lastDecline = now;
      // A decline is a real signal: autonomy on this class ends now, and cannot be
      // reconsidered until the cooldown has passed.
      const wasAuto = rec.level === "auto";
      rec.level = "confirm";
      rec.explicit = false;
      rec.cooldownUntil = now + config.cooldownMs;
      await put(rec);
      return { changed: wasAuto, level: rec.level, why: "a decline revoked autonomy on this class" };
    }
    await put(rec);
    return maybePromote(rec);
  }

  async function noteApplied(action, { ok, error = null } = {}) {
    const cls = action.cls || classFor(action);
    const rec = await get(cls);
    if (action.mode === "auto") {
      rec.auto++;
      await stampAuto();            // the quotas count applications, not decisions
    }
    if (!ok) {
      rec.errors++;
      rec.lastError = clock();
      const wasAuto = rec.level === "auto";
      rec.level = "confirm";
      rec.explicit = false;
      rec.cooldownUntil = clock() + config.cooldownMs;
      rec.note = `revoked: apply error (${error})`;
      await put(rec);
      return { changed: wasAuto, level: rec.level, why: `an apply error revoked autonomy: ${error}` };
    }
    await put(rec);
    return { changed: false, level: rec.level, why: null };
  }

  async function noteReverted(action, reason = "") {
    const cls = action.cls || classFor(action);
    const rec = await get(cls);
    rec.reverted++;
    const wasAuto = rec.level === "auto";
    rec.level = "confirm";
    rec.explicit = false;
    rec.cooldownUntil = clock() + config.cooldownMs;
    rec.note = reason ? `revoked: ${reason}` : "revoked after a revert";
    await put(rec);
    return { changed: wasAuto, level: rec.level, why: "a revert revoked autonomy on this class" };
  }

  async function maybePromote(rec) {
    if (!config.autoPromote) return { changed: false, level: rec.level, why: null };
    if (rec.level !== "confirm" || rec.explicit) return { changed: false, level: rec.level, why: null };
    const now = clock();
    if (rec.approved < config.minApprovals) return { changed: false, level: rec.level, why: null };
    if (now < rec.cooldownUntil) return { changed: false, level: rec.level, why: null };
    const lastProblem = Math.max(rec.lastDecline || 0, rec.lastError || 0, rec.firstSeen);
    if (now - lastProblem < config.minCleanMs) return { changed: false, level: rec.level, why: null };

    rec.level = "auto";
    rec.explicit = false;
    rec.note = `earned after ${rec.approved} approvals and no declines or errors`;
    await put(rec);
    return { changed: true, level: "auto", why: rec.note, promoted: true, cls: rec.cls };
  }

  // ---- human control --------------------------------------------------------
  async function setLevel(cls, level, note = "") {
    if (!LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
    const rec = await get(cls);
    rec.level = level;
    rec.explicit = level !== "confirm" || rec.approved > 0;   // a human set this
    rec.note = note || `set to ${level} by hand`;
    if (level === "auto") rec.cooldownUntil = 0;
    if (level === "confirm") rec.cooldownUntil = clock() + config.cooldownMs;
    return put(rec);
  }

  async function revokeAll() {
    const all = await ledger();
    const now = clock();
    let n = 0;
    for (const rec of all) {
      if (rec.level === "auto") {
        rec.level = "confirm";
        rec.explicit = false;
        rec.cooldownUntil = now + config.cooldownMs;
        rec.note = "revoked: autonomy switched off globally";
        await put(rec);
        n++;
      }
    }
    return n;
  }

  return {
    get config() { return config; },
    setConfig(patch) { config = { ...config, ...patch }; return config; },
    beginRun() { autoThisRun = 0; },
    classFor,
    decide,
    noteProposed,
    noteDecision,
    noteApplied,
    noteReverted,
    get,
    put,
    ledger,
    setLevel,
    revokeAll,
    autoThisRun: () => autoThisRun,
    view: async () => {
      const all = await ledger();
      // A class can be autonomous two ways — earned into the ledger, or granted by a
      // pattern in the config. The panel has to show both, or a granted class would be
      // invisible exactly when it matters most.
      const granted = (cls) => config.autoAllow.some((p) => matches(p, cls));
      // with autonomy switched off, nothing is autonomous — including classes that were
      // granted by a pattern, which would otherwise look trusted in the panel
      const isAutonomous = (r) =>
        config.enabled && r.level !== "deny" && !config.alwaysConfirm.some((p) => matches(p, r.cls)) &&
        (r.level === "auto" || granted(r.cls));
      return {
        enabled: config.enabled,
        autoPromote: config.autoPromote,
        minApprovals: config.minApprovals,
        autoHour: (await autoLog()).length,
        maxAutoPerHour: config.maxAutoPerHour,
        autoAllow: [...config.autoAllow],
        alwaysConfirm: [...config.alwaysConfirm],
        autonomous: all.filter(isAutonomous).map((r) => r.cls),
        classes: all.map((r) => ({
          cls: r.cls, level: r.level, explicit: r.explicit, granted: granted(r.cls),
          approved: r.approved, declined: r.declined, auto: r.auto, errors: r.errors,
          reverted: r.reverted, note: r.note,
          eligible: r.approved >= config.minApprovals && !r.lastDecline && !r.lastError,
        })),
      };
    },
  };
}
