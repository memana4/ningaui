# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-10-05

A third target: the same harness as a bookmarklet, for when installing an extension is
not an option.

### Added
- **The bookmarklet build.** `build.py` now emits `dist/bookmarklet/` — a self-contained
  classic-script bundle (shim host + the whole core + the panel), an install page, and the
  packed install URL. The panel mounts into a shadow root on the current page; the page's
  CORS rules become the permission model.
- **`bookmarklet/shim.js`** — the WebExtension surface the core uses (`storage.local`,
  `runtime` messages and ports, `permissions`, `getManifest`) over `localStorage` and an
  in-page bus, so `bg.js` and the panel run unmodified inside a page.
- **`bookmarklet/mount.js`** — mounts the panel in a shadow root (page styles stay out,
  panel styles stay in) and makes a second click toggle it instead of booting twice.
- **`test/bookmarklet.test.mjs`** — drives the real bundle in a `vm` context through the
  real bus: runs, approvals, declines, allowlist refusals, storage namespacing, the
  re-run guard, and a pack/unpack round-trip of the install URL.
- A GitHub Pages workflow publishing the drag-to-install page.
- The install URL is gzip-packed (~31 kB) because Firefox truncates bookmark URLs around
  64 kB; the readable bundle ships alongside it.

### Changed
- `api.js`: `pickHost()` prefers the bookmarklet shim over the page's `window.chrome`;
  `createApi` reports a `bookmarklet` host name and never reads the UA for it.
- `panel.js/.html`: every lookup goes through a root element, so the same panel renders in
  an extension document or a shadow root; bookmarklet-specific hint text where it matters.
- `tools.js`: the pre-apply preview read is now allowlist-gated like every other request.
- CI runs the new suite; the bookmarklet zip joins the release artifacts.
- README, CONTRIBUTING and the docs cover the third target.

### Removed
- `core/proposals.js`, the pre-rename leftover — nothing imported it.

## [0.5.0] — 2026-09-17

Renamed to **Ningaui**, reframed around APIs, and the gate became a setting.

### Added
- **Earned autonomy.** Every action belongs to a class (`POST api.example.com/orders/{id}`),
  and each class has a level: `confirm` (default), `auto`, or `deny`. A class is promoted
  only by its record — a minimum number of approvals plus a clean stretch with no declines
  and no apply errors. `core/policy.js` holds the ledger, the thresholds and the quotas.
- **Revocation.** One decline, one apply error or one revert drops the class back to
  `confirm` immediately and starts a cooldown. `revoke all` in the panel returns everything
  to `confirm` in one click.
- **Quotas**, applied even to granted autonomy: 20 autonomous actions per run, 30 per hour.
  Hitting a quota falls back to `confirm` rather than failing.
- **Revert**, from the panel: sandbox actions restore the previous value, policy actions
  restore the level, API actions record the pre-apply state and mark the action reverted.
- `request_autonomy` — the agent can ask for trust on a class, but only a human can grant it.
- An **Autonomy** section in the panel: per-class counters, level dropdowns, an
  always-confirm pattern list, and the master switch.

### Changed
- The tool surface is API-first: `api_read`, `api_request`, `remember`, `recall`,
  `list_actions`, `request_autonomy`, `finish`. The sandbox is now the agent's own memory
  rather than the headline, and it never needs approval.
- `proposals.js` became `actions.js`: one record type for both paths, with a `mode` field
  saying which one applied.
- `proposals.test.mjs` became `actions.test.mjs`; `policy.test.mjs` is new. 59 checks total.
- A pre-flight refusal (an allowlist that changed under a queued action) now leaves the
  action pending instead of consuming the approval.

### Removed
- `propose_storage_change`, `propose_api_change`, `list_proposals`, `storage_get`,
  `storage_list`, and the assumption that every write needs a human.

## [0.4.0] — 2026-09-16

Named. Documented. Ready to publish.

### Added
- The name **Ningaui** and a mascot drawn from one shape list
  (`assets/mascot.py`) that emits both the SVG and the extension PNG icons.
- `docs/` — architecture, model protocol, the approval gate, cross-browser notes
  and the mascot's origins.
- Continuous integration: builds both bundles and runs all three suites on every
  push, then uploads the zips as artifacts.
- Issue and pull-request templates, security policy, contribution guide, code of
  conduct.

### Changed
- Bundle version to 0.4.0; manifests now declare icons for the toolbar, the
  extensions page and the Firefox sidebar.

## [0.3.0] — 2026-09-16

### Added
- Firefox support from the same source: `core/api.js` absorbs every engine
  difference, `build.py` emits and validates a bundle per browser.
- A run refuses to start when host permissions are missing, which matters on
  Firefox where the user can revoke them at any time.
- The panel reports its environment and offers a permission grant button.

### Changed
- The project is a single core plus per-target manifests, not a fork. Firefox
  runs the same `bg.js` as Chrome.

## [0.2.0] — 2026-09-16

### Added
- The approval gate: `proposals.js` and a review panel. **The agent has no write
  tool at all** — it proposes, a human decides, and only the decision applies the
  change.
- Decline reasons are stored on the proposal and read back by the agent through
  `list_proposals` on its next run.
- Caps: 12 proposals per run, 200 pending, plus an append-only audit log.

### Removed
- `storage_set`, `storage_delete` and `api_call`. Reads became `storage_list`,
  `storage_get` and `api_read`; writes became `propose_storage_change` and
  `propose_api_change`.

## [0.1.0] — 2026-09-16

### Added
- The harness: one agent loop, a sandboxed key-value store, one allow-listed HTTP
  tool, a run journal, and a panel. Chrome MV3, service worker background.
