// Bookmarklet host shim: the slice of the WebExtension API the core actually uses,
// implemented against page globals. localStorage backs storage.local (namespaced
// under "ningaui:"), a small in-page bus backs runtime, and permissions are always
// reported as granted — in a page there is no manifest permission gate; the page's
// CORS rules are the real gate, and a failed fetch surfaces to the agent as a tool error.
//
// No imports on purpose: build.py inlines this file verbatim into the classic-script
// bundle, and it must define createNingauiHost() before any core module runs.

function createNingauiHost({ localStorage: pageStorage } = {}) {
  const PREFIX = "ningaui:";

  // ---- storage.local over localStorage --------------------------------------
  const fallback = () => {
    const mem = new Map();
    return {
      get length() { return mem.size; },
      key: (i) => [...mem.keys()][i] ?? null,
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
    };
  };
  const backing = pageStorage || fallback();

  const read = (key) => {
    try {
      const raw = backing.getItem(PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (_) { return undefined; }
  };
  const write = (key, value) => {
    try { backing.setItem(PREFIX + key, JSON.stringify(value)); }
    catch (_) { throw new Error("storage is full (localStorage quota) — clear old runs in the panel, then retry"); }
  };

  const storageLocal = {
    async get(keys) {
      if (keys === null || keys === undefined) {
        const out = {};
        for (let i = 0; i < backing.length; i++) {
          const full = backing.key(i);
          if (full && full.startsWith(PREFIX)) {
            const key = full.slice(PREFIX.length);
            const value = read(key);
            if (value !== undefined) out[key] = value;
          }
        }
        return out;
      }
      if (typeof keys === "string") {
        const value = read(keys);
        return value === undefined ? {} : { [keys]: value };
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) { const value = read(key); if (value !== undefined) out[key] = value; }
        return out;
      }
      if (typeof keys === "object") {
        const out = { ...keys };
        for (const key of Object.keys(keys)) { const value = read(key); if (value !== undefined) out[key] = value; }
        return out;
      }
      return {};
    },
    async set(obj) { for (const [key, value] of Object.entries(obj)) write(key, value); },
    async remove(keys) { for (const key of [].concat(keys)) backing.removeItem(PREFIX + key); },
    async clear() {
      const doomed = [];
      for (let i = 0; i < backing.length; i++) {
        const full = backing.key(i);
        if (full && full.startsWith(PREFIX)) doomed.push(full);
      }
      for (const full of doomed) backing.removeItem(full);
    },
  };

  // ---- runtime: one in-page message bus --------------------------------------
  const messageListeners = [];
  const connectListeners = [];

  function send(message, callback) {
    let settled = false;
    const reply = (value) => {
      if (settled) return;
      settled = true;
      try { callback?.(value); } catch (_) {}
    };
    let waiting = false;
    for (const fn of messageListeners.slice()) {
      try {
        const ret = fn(message, { id: "ningaui-bookmarklet" }, reply);
        if (ret === true) waiting = true;
        else if (ret && typeof ret.then === "function") { waiting = true; ret.then(reply, () => reply(undefined)); }
      } catch (_) {}
    }
    // chrome.runtime.sendMessage hands the callback undefined when nobody replies; do the
    // same, one tick later, so synchronous replies and returned promises still win.
    if (!waiting) queueMicrotask(() => reply(undefined));
  }

  function newPort(name) {
    const port = {
      name,
      onMessage: { addListener: (fn) => port.__msg.push(fn) },
      onDisconnect: { addListener: (fn) => port.__disc.push(fn) },
      postMessage: (m) => {
        const other = port.__other;
        if (!other) return;
        queueMicrotask(() => { for (const fn of other.__msg.slice()) { try { fn(m); } catch (_) {} } });
      },
      disconnect: () => {
        const other = port.__other;
        port.__other = null;
        if (other) {
          other.__other = null;
          for (const fn of other.__disc.slice()) { try { fn(port); } catch (_) {} }
        }
      },
      __msg: [], __disc: [], __other: null,
    };
    return port;
  }

  const runtime = {
    id: "ningaui-bookmarklet",
    sendMessage: (message, callback) => send(message, callback),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onConnect: { addListener: (fn) => connectListeners.push(fn) },
    connect: (options) => {
      const caller = newPort(options?.name);
      const receiver = newPort(options?.name);
      caller.__other = receiver;
      receiver.__other = caller;
      for (const fn of connectListeners.slice()) { try { fn(receiver); } catch (_) {} }
      return caller;
    },
    getManifest: () => ({ manifest_version: 3, name: "Ningaui (bookmarklet)", host_permissions: [] }),
    getURL: (path) => String(path ?? ""),
  };

  const permissions = { contains: async () => true, request: async () => true };

  return {
    __ningaui: "bookmarklet",
    storage: { local: storageLocal },
    runtime,
    permissions,
    // test hooks: drive the bus directly, and watch it for leaks on re-execution
    __send: (message, callback) => send(message, callback),
    __debug: {
      messageListeners: () => messageListeners.length,
      connectListeners: () => connectListeners.length,
    },
  };
}
