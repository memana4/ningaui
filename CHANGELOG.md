# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-09-16

Named. Documented. Ready to publish.

### Added
- The name **Kowari** and a mascot drawn from one shape list
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
