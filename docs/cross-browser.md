# Cross-browser notes

## What differs, and what it costs

| | Chrome | Firefox |
|---|---|---|
| background | service worker, `background.service_worker` | event page, `background.scripts` |
| idle behaviour | killed after ~30 s, no globals kept | reaped on idle, **globals kept**, less eager |
| keepalive | offscreen document, messaging every 20 s | open runtime port from the panel |
| panel | `side_panel` + `chrome.sidePanel`, per tab | `sidebar_action`, per window |
| `runtime.getContexts` | available | absent |
| built-in model | `LanguageModel` (Gemini Nano), on-device | **none** — Mozilla declined to implement it |
| host permissions | granted at install | granted at install, **revocable any time** from about:addons |
| unsigned add-ons | dev mode only | ESR / Developer Edition / Nightly with a preference |

Firefox rejects `background.service_worker` outright rather than ignoring it, so the two
manifests are generated separately and validated at build time:

```
python3 build.py
# fails if:
#   chrome:  missing service_worker, present browser_specific_settings, no offscreen permission
#   firefox: present service_worker, missing sidebar_action, no gecko id, offscreen/sidePanel
#   either:  a referenced document or icon that is not in the bundle
```

A wrong manifest does not fail loudly at install; it fails later as a confusing runtime
bug. That is why the build refuses.

## Consequences handled in code

- **Keepalive switches implementation.** Chrome opens an offscreen document; Firefox relies
  on the panel's open port. Closing the sidebar mid-run on Firefox can therefore let the
  event page be reaped — the journal is already on disk and the alarm sweep marks the run
  `interrupted`, so nothing is silently lost, but the run stops.
- **A missing host permission is a hard stop.** On Firefox the user can revoke it at any
  time, so a run checks first and refuses with a clear message instead of failing at the
  first API call. The panel shows the state and offers a grant button.
- **No built-in model on Firefox.** The panel detects it and says so; the OpenAI-compatible
  backend is the only route there.
- **Allowlist prefixes include the port.** Manifest patterns do not — `http://localhost/*`
  matches any port, while the in-code prefix check is literal.

## Installing on Firefox ESR

```bash
# 1. about:config → xpinstall.signatures.required → false
#    (ESR, Developer Edition and Nightly expose this; release builds do not)
# 2. about:addons → gear → Install Add-on From File → ningaui-firefox-<version>.zip
```

Or `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** for a one-session
install, or `web-ext sign` against AMO as an unlisted add-on for a signed XPI you can
install anywhere.

## How this is tested without a browser

`test/crossbrowser.test.mjs` builds two fake extension APIs — one Chrome-shaped (offscreen,
`getContexts`, `sidePanel`), one Firefox-shaped (no offscreen, no `getContexts`,
`sidebarAction`) — then:

- constructs the adapter against each and checks the mode it reports;
- loads the **real** `core/bg.js` twice, once per host, and drives its message handlers
  through `run`, `proposals`, `decide`, `permissions`, `env` and `keepalive`;
- verifies the permission-refusal path that only Firefox can produce;
- runs the loop, the action log and the policy engine on both and asserts the journals,
  the applied payloads and the autonomy view are identical;
- validates both manifests and both built bundles.

Loading `bg.js` twice needs a cache-busting import (`?tag`) because it binds to
`globalThis` at import time — each fake host gets a fresh module instance.
