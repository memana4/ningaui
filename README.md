<p align="center">
  <img src="assets/kowari-512.png" alt="Kowari, a small crested-tailed marsupial wearing a harness" width="180">
</p>

<h1 align="center">Kowari</h1>

<p align="center"><em>A tiny browser-agent harness with a human approval gate on every write.</em></p>

---

A kowari is a small carnivorous marsupial from the Australian outback: big-eyed, crested
tail, quick. It also does the one thing this project is about — it works on its own, and
nothing it brings back reaches the nest until you take it from its paws.

Kowari is a browser extension that runs a small language-model agent with a deliberately
tiny environment:

- **reads** — its own sandboxed key-value store, and `GET` on allow-listed endpoints
- **proposes** — writes to that store, or non-`GET` requests to those endpoints
- **nothing else.** No pages, tabs, cookies, history or files. And **no write tool at all**.

Seven tools, one loop, roughly a thousand lines, no dependencies and no build toolchain
beyond a Python script that copies files and refuses to build a broken manifest.

```
agent reads state  →  proposes a change  →  queue  →  you approve or decline
                                                       │            │
                                       apply exactly as proposed    reason recorded
```

## Install

### Chrome

`chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome`, or drag
`kowari-chrome.zip`.

### Firefox (including ESR)

Firefox will not permanently load an unsigned extension in a release build. Pick one:

1. **ESR / Developer Edition / Nightly** — set `xpinstall.signatures.required` to `false`
   in `about:config`, then `about:addons` → gear → **Install Add-on From File** → the
   Firefox zip. Release builds do not expose that preference.
2. **Temporary, any build** — `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on** → `dist/firefox/manifest.json`. Gone when Firefox restarts.
3. **Signed, permanent** — `web-ext sign` against AMO as an *unlisted* add-on, which
   returns a signed XPI installable anywhere.

Then open the panel: the toolbar button on Chrome, **View → Sidebar → Kowari** on Firefox.

### Configure

Choose a backend:

- **Browser built-in model** — on-device, no key. Chrome only; Firefox has none.
- **OpenAI-compatible endpoint** — `http://localhost:11434/v1` for Ollama, or a private
  host. On Firefox this is the only option.

Then list the URL prefixes the agent may reach. Two gates apply: the prefix list inside
the extension, and the host permissions declared in the manifest. On Firefox the browser
can revoke host permissions at any time, so the panel shows whether they are currently
granted and offers a grant button.

> Allowlist prefixes include the port (`http://localhost:11434/v1`); manifest patterns do
> not (`http://localhost/*` matches any port).

## Reviewing what it proposes

Proposals stack up while you are away — each one carries the agent's rationale and a
before/after preview.

| key | does |
|---|---|
| `↑` `↓` | move through the queue |
| `a` | approve, applying it exactly as proposed |
| `d` | decline, using the reason in the box |
| `s` | skip · `r` refresh |

Quick-reason buttons fill the reason box: *wrong value, wrong target, duplicate, not now,
too risky*. **Approve all storage** bulk-applies the local writes; API calls are never
bulk-approved. **Clear decided** prunes the queue.

**Your reason is not thrown away.** It is stored on the proposal and the agent reads it
back through `list_proposals` on its next run, so a decline is a correction rather than a
dead end.

## What it cannot do

| | |
|---|---|
| read the page you are looking at | no — never requests page access |
| write anything without you | no — there is no write tool |
| reach an arbitrary URL | no — prefix allowlist, checked again at apply time |
| flood your review queue | no — 12 proposals per run, 200 pending |
| hide what it did | no — every step and decision is journaled |
| survive you ignoring it | yes — proposals wait; the worker wakes when you decide |

## Architecture

```
core/               platform-agnostic — the whole agent
  agent.js            the loop: prompt, parse one JSON step, run a tool, journal, repeat
  tools.js            the tool surface: four reads, two proposals, finish
  proposals.js        the queue: create, decide, apply, audit
  store.js            sandboxed key-value store + run journal
  model.js            built-in model adapter, OpenAI-compatible adapter
  api.js              the adapter that hides every browser difference
  bg.js               background host — same file for both engines
  panel.js/.html      one panel document for side panel and sidebar
platform/chrome/      manifest.json + offscreen keepalive + icons
platform/firefox/     manifest.json + icons
assets/               mascot: one shape list, SVG and PNGs
build.py              assembles and validates dist/chrome and dist/firefox
test/                 36 checks across three suites
```

More detail: [architecture](docs/architecture.md) ·
[model protocol](docs/protocol.md) · [the approval gate](docs/approval-gate.md) ·
[cross-browser notes](docs/cross-browser.md) · [the mascot](docs/mascot.md).

## Development

```bash
python3 build.py          # both bundles, validated
python3 assets/mascot.py  # regenerate the SVG and icons
npm test                  # build + all three suites
```

The suites need no browser, no network and no API key: the core takes its storage, fetch
and model as injected dependencies, and the cross-browser suite drives the real background
host against fake Chrome-shaped and Firefox-shaped APIs.

## Limitations worth knowing

- Extension storage is **not encrypted**. The API key and the proposal queue are plain text
  in your profile. Prefer a local endpoint with no key where you can.
- The audit log is **client-side**. If this becomes the front door to real state, move the
  durable record to the server that receives the changes.
- On Firefox, closing the sidebar mid-run can let the background page be reaped. Every step
  is already on disk, and a sweep marks the run `interrupted`, so nothing is silently lost,
  but the run stops there.
- One agent. No planner, no subagents, no MCP. The smallness is the feature.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Licence

MIT — see [LICENSE](LICENSE).

The mascot is drawn from a single shape list in [`assets/mascot.py`](assets/mascot.py),
which emits both the SVG and the extension icons.
