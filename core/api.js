// Cross-browser adapter. Everything platform-specific lives here, so the loop,
// the tools, the proposal queue and the panel are written once.
//
// What actually differs between Chrome (MV3 service worker) and Firefox (MV3 event page):
//   * background form          — service_worker vs scripts          (manifest)
//   * keepalive                — chrome.offscreen vs an open runtime port
//   * panel surface            — chrome.sidePanel vs sidebar_action (manifest)
//   * runtime.getContexts()    — Chrome only
//   * the built-in model       — LanguageModel exists in Chrome, not in Firefox
//   * host permissions         — revocable at any time in Firefox, so they must be
//                                checked and re-requested rather than assumed
//   * the bookmarklet           — a page-context shim host (bookmarklet/shim.js) exposing
//                                this same surface over localStorage and an in-page bus
//
// createApi(host) takes the extension global so both shapes can be exercised in tests.

export function pickHost() {
  // A bookmarklet installs its own shim host before the core runs. It is checked first so
  // the page's own window.chrome (present without extension APIs) can never win.
  if (globalThis.__NINGAUI__?.host) return globalThis.__NINGAUI__.host;
  if (typeof globalThis.browser !== "undefined" && globalThis.browser?.runtime) return globalThis.browser;
  if (typeof globalThis.chrome !== "undefined" && globalThis.chrome?.runtime) return globalThis.chrome;
  return null;
}

export function createApi(host) {
  if (!host) {
    const dead = () => { throw new Error("no extension API available in this context"); };
    return { name: "none", storage: null, runtime: null, hasOffscreen: false, hasBuiltInModel: false,
             isFirefox: false, keepalive: { start: dead, stop: dead }, permissions: { contains: dead, request: dead },
             ports: new Set(), onPort: () => {} };
  }

  // The bookmarklet shim marks itself; it is never one of the engines, whatever the UA says.
  const isBookmarklet = host.__ningaui === "bookmarklet";
  const isFirefox = !isBookmarklet &&
    ((!host.offscreen && !!host.sidebarAction) || /Firefox/i.test(globalThis.navigator?.userAgent || ""));
  const ports = new Set();
  let offscreenOpen = false;

  const keepalive = {
    // Chrome: an offscreen document that messages the worker every 20 s, which resets
    // the service worker's 30 s idle timer. Documented and supported.
    // Firefox: there is no offscreen API. An open runtime port from the panel keeps the
    // event page alive instead, so start() only records that we are in a run and the
    // panel's port does the work.
    async start() {
      if (host.offscreen) {
        if (offscreenOpen) return { mode: "offscreen" };
        try {
          await host.offscreen.createDocument({
            url: "offscreen.html", reasons: ["BLOBS"],
            justification: "keep the agent worker alive during a run",
          });
          offscreenOpen = true;
        } catch (err) {
          if (!String(err).includes("Only a single offscreen")) throw err;
        }
        return { mode: "offscreen" };
      }
      return { mode: "port", holders: ports.size };
    },
    async stop() {
      if (host.offscreen && offscreenOpen) {
        try { await host.offscreen.closeDocument(); } catch (_) {}
        offscreenOpen = false;
      }
      return { ok: true };
    },
    async contexts() {
      if (!host.runtime?.getContexts) return offscreenOpen ? 1 : 0;   // Firefox has no getContexts
      try {
        return (await host.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length;
      } catch (_) { return 0; }
    },
  };

  const permissions = {
    async contains(origins) {
      if (!origins?.length) return true;
      try { return await host.permissions.contains({ origins }); } catch (_) { return false; }
    },
    async request(origins) {
      if (!origins?.length) return true;
      try { return await host.permissions.request({ origins }); } catch (_) { return false; }
    },
  };

  return {
    name: isBookmarklet ? "bookmarklet" : isFirefox ? "firefox" : "chrome",
    isFirefox,
    storage: host.storage.local,
    runtime: host.runtime,
    hasOffscreen: !!host.offscreen,
    hasBuiltInModel: typeof globalThis.LanguageModel !== "undefined",
    keepalive,
    permissions,
    ports,
    onPort(port) { ports.add(port); port.onDisconnect.addListener(() => ports.delete(port)); },
  };
}

// Host permission patterns derived from the configured allowlist. Firefox lets the user
// revoke these at any time from about:addons, so a check-then-request path is required.
export function originsFor(allowlist) {
  return allowlist.map((u) => {
    try {
      const { protocol, host } = new URL(u.includes("*") ? u.replace(/\*.*$/, "") : u);
      return `${protocol}//${host}/*`;
    } catch (_) { return null; }
  }).filter(Boolean);
}
