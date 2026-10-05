# The bookmarklet

The extension needs an install. The bookmarklet does not: one bookmark, no permissions
prompt, and the same harness mounts on whatever page you are on.

## Install

- **Hosted:** open the [install page](https://memana4.github.io/ningaui/) and drag the
  button to your bookmarks bar. Create a bookmark manually if dragging is blocked — the
  page has a copy button for the URL.
- **Local build:** run `python3 build.py`, then open `dist/bookmarklet/install.html` and
  drag from there. That page is self-contained; it needs no server.

The installable URL is gzip-packed (roughly 31 kB) because Firefox truncates bookmark
addresses around 64 kB. The readable bundle it unpacks at click time is
`dist/bookmarklet/ningaui-bookmarklet.js` — the same code, formatted.

## What it is

`build.py` bundles `bookmarklet/shim.js`, the entire `core/`, and the panel into one
classic script. The shim implements the WebExtension surface the core uses:

| extension API | bookmarklet implementation |
|---|---|
| `storage.local` | page `localStorage`, namespaced under `ningaui:` |
| `runtime.sendMessage` / `onMessage` | an in-page bus carrying the same message shapes |
| `runtime.connect` (keepalive port) | an in-page port pair; there is no worker to keep alive |
| `permissions` | always granted — the page's CORS rules are the real gate |
| `getManifest().host_permissions` | empty; the panel says so |

The panel mounts into a **shadow root** on the current page, so page styles cannot leak
in and panel styles cannot leak out. Clicking the bookmarklet again toggles the panel; a
second boot never happens.

## What changes versus the extension

- **CORS is the permission model.** An endpoint answers the page if and only if it sends
  the right headers. `http://localhost` is exempt from mixed-content rules, so local
  models generally work from https pages; other APIs need to allow the origin of the
  page you clicked on.
- **Storage is per-site.** `localStorage` is scoped to the origin, so the sandbox, the
  queue and the settings live separately on each site.
- **Strict-CSP pages refuse bookmarklets.** If a site's `script-src` forbids inline
  script, the bookmarklet cannot run there, and blocked inline styles can leave the
  panel unstyled. Use the extension on those sites.
- **The page shares the context.** The site's own scripts can read what the harness
  stores (including the API key in settings) and can interfere with it. Click it only on
  sites you trust; prefer local endpoints with no key. See [SECURITY.md](../SECURITY.md).
- **Unpacking uses `new Function`.** A page whose CSP allows inline script but blocks
  `unsafe-eval` loads nothing; the console says so. Same fix as above: the extension.

## How it is built and tested

The bundler is deliberately strict: imports must be single-line named imports, exports
must be top-level `function`, `async function` or `const` declarations. Anything else
fails the build instead of producing a subtly wrong bundle. `test/bookmarklet.test.mjs`
then drives the built bundle in a `vm` context through the real bus — runs, approvals,
declines, allowlist refusals, storage namespacing, the re-run guard — and round-trips
the packed install URL back to the readable bundle on every run.

## Rebuilding after changes

```bash
python3 build.py     # writes dist/bookmarklet/ningaui-bookmarklet.js + url.txt + install.html
```

Re-drag the bookmarklet after rebuilding — bookmarks keep a copy of the old URL, and
nothing auto-updates in place.
