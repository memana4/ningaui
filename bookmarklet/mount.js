// Bookmarklet UI: mounts the same panel into a shadow root on the current page.
// There is no background worker in this mode — the shim, the core and this UI all run
// in the page — so the panel talks to bg.js over the in-page bus instead of runtime
// messages, and the page's styles stay outside the shadow root.
//
// No imports on purpose: build.py inlines this file into the classic-script bundle.

const NINGAUI_HOST_ID = "ningaui-bookmarklet";

const NINGAUI_MOUNT_CSS = `
:host {
  all: initial;
  display: block;
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483640;
  width: 420px;
  max-width: calc(100vw - 32px);
}
.app {
  max-height: calc(100vh - 32px);
  overflow: auto;
  border: 1px solid var(--line, #26313a);
  border-radius: 10px;
  box-shadow: 0 12px 44px rgba(0, 0, 0, .55);
}
.ng-x {
  position: absolute;
  top: -9px;
  right: -9px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #26313a;
  color: #e7edf1;
  border: 1px solid #3a4550;
  font: 13px/20px system-ui, sans-serif;
  text-align: center;
  cursor: pointer;
  user-select: none;
}
.ng-x:hover { background: #e2622c; border-color: #e2622c; color: #fff; }
`;

function ningauiMount() {
  const doc = globalThis.document;
  let hostEl = doc.getElementById(NINGAUI_HOST_ID);
  if (!hostEl) {
    hostEl = doc.createElement("div");
    hostEl.id = NINGAUI_HOST_ID;
    (doc.body || doc.documentElement).appendChild(hostEl);
  }
  if (hostEl.shadowRoot) return hostEl;

  const shadow = hostEl.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = NINGAUI_MOUNT_CSS;
  shadow.appendChild(style);

  const wrap = doc.createElement("div");
  wrap.className = "app";
  shadow.appendChild(wrap);

  // The panel's own markup and styles, parsed inert and adopted into the shadow root.
  const parsed = new DOMParser().parseFromString(__NINGAUI_PANEL_HTML__, "text/html");
  for (const node of parsed.head.querySelectorAll("style")) wrap.appendChild(doc.importNode(node, true));
  for (const node of parsed.body.childNodes) {
    if (node.nodeName === "SCRIPT") continue;
    wrap.appendChild(doc.importNode(node, true));
  }

  const close = doc.createElement("div");
  close.className = "ng-x";
  close.textContent = "×";
  close.title = "hide Ningaui (click the bookmarklet again to show it)";
  close.addEventListener("click", () => { hostEl.style.display = "none"; });
  shadow.appendChild(close);

  hostEl.style.display = "block";
  globalThis.__NINGAUI_ROOT__ = shadow;
  return hostEl;
}

function ningauiToggle() {
  const doc = globalThis.document;
  if (!doc || !doc.body) return;
  const hostEl = doc.getElementById(NINGAUI_HOST_ID);
  if (!hostEl) {
    ningauiMount();
    if (typeof __ningaui_panel === "function") __ningaui_panel();
    return;
  }
  hostEl.style.display = hostEl.style.display === "none" ? "block" : "none";
}
