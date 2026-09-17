<p align="center">
  <img src="assets/ningaui-512.png" alt="Ningaui, a tiny big-eyed marsupial wearing a harness" width="180">
</p>

<h1 align="center">Ningaui</h1>

<p align="center"><em>A small browser agent for API work, with autonomy it has to earn.</em></p>

---

A ningaui is one of the smallest carnivorous marsupials alive — five to ten grams, huge
eyes, active at night, entirely at home in country that would kill most things twice its
size. It suits this project for a mundane reason as much as a charming one: it goes out,
works alone, and comes back with what it decided to carry.

Ningaui is a browser extension that runs a small language-model agent against **your APIs**.
Its whole environment is a sandboxed memory and an allow-list of endpoints. No pages, no
tabs, no cookies, no files.

Seven tools, one loop, no dependencies, no build toolchain beyond a Python script that
copies files and refuses to build a broken manifest.

## Autonomy is earned, not assumed

Every action belongs to a **class** — `POST api.example.com/orders/{id}`, `store notes` — and
each class has one of three levels:

| level | what happens |
|---|---|
| **confirm** | the action queues with a rationale and a before/after preview until you decide *(default)* |
| **auto** | the agent does it, journals it, and tells you afterwards. Reversible from the panel |
| **deny** | refused outright; it cannot even queue |

Nothing is `auto` out of the box. A class earns it: enough approvals, plus a clean stretch
with no declines and no apply errors. One decline, one error, or one revert revokes it
immediately and starts a cooldown. Quotas cap autonomous actions per run and per hour
regardless of how trusted a class is.

You can also grant a class by hand, or deny one, and your setting outranks the earned
level. `revoke all` puts everything back to confirm in one click.

The agent can *ask* for autonomy — `request_autonomy` files an action like any other — but
it cannot grant it. Nothing in the loop decides whether the model has been good; only
counters, timestamps and thresholds do.

Full detail: [docs/autonomy.md](docs/autonomy.md).

## Install

### Chrome

`chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome`, or drag
`ningaui-chrome.zip`.

### Firefox (including ESR)

Firefox will not permanently load an unsigned extension in a release build. Pick one:

1. **ESR / Developer Edition / Nightly** — set `xpinstall.signatures.required` to `false`
   in `about:config`, then `about:addons` → gear → **Install Add-on From File** → the
   Firefox zip. Release builds do not expose that preference.
2. **Temporary, any build** — `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on** → `dist/firefox/manifest.json`. Gone when Firefox restarts.
3. **Signed, permanent** — `web-ext sign` against AMO as an *unlisted* add-on.

Then open the panel: the toolbar button on Chrome, **View → Sidebar → Ningaui** on Firefox.

### Configure

- **Backend** — the browser's built-in model (on-device, no key, Chrome only) or any
  OpenAI-compatible endpoint: `http://localhost:11434/v1` for Ollama, or a private host.
- **Allowlist** — the URL prefixes the agent may reach. Two gates apply: this list inside
  the extension, and the host permissions in the manifest. Firefox can revoke host
  permissions at any time, so the panel shows the current state and offers a grant button.

> Allowlist entries include the port (`http://localhost:11434/v1`); manifest patterns do
> not (`http://localhost/*` matches any port).

## Reviewing what it wants to do

Proposals queue while you are away, each with a rationale, the class it belongs to, why it
was not autonomous, and a before/after preview.

| key | does |
|---|---|
| `↑` `↓` | move through the queue |
| `a` | approve, applying it exactly as proposed |
| `d` | decline, using the reason in the box |
| `s` | skip · `r` refresh |

Quick-reason buttons fill the reason box: *wrong value, wrong target, duplicate, not now,
too risky*. **Approve sandbox + policy** bulk-applies the harmless kinds. **Clear decided**
prunes the history.

Your reason is stored on the action and read back by the agent through `list_actions` on its
next run, so a decline is a correction rather than a dead end.

## What it cannot do

| | |
|---|---|
| read the page you are looking at | no — never requests page access |
| act outside the allowlist | no — checked when submitted and again when applied |
| act autonomously on a new class | no — autonomy is earned or granted, never assumed |
| run away with a trusted class | no — per-run and per-hour quotas apply regardless |
| hide what it did | no — every action, decision and policy change is journaled |
| flood your review queue | no — 12 actions per run, 200 pending |

## Architecture

```
core/               platform-agnostic — the whole agent
  agent.js            the loop: prompt, parse one JSON step, run a tool, journal, repeat
  tools.js            the tool surface: API first, policy-routed writes
  policy.js           action classes, earned autonomy, quotas, revocation
  actions.js          the action log: auto-applied, queued, decided, reverted
  store.js            the sandbox: key-value memory + run journal
  model.js            built-in model adapter, OpenAI-compatible adapter
  api.js              the adapter that hides every browser difference
  bg.js               background host — same file for both engines
  panel.js/.html      one panel document for side panel and sidebar
platform/chrome/      manifest.json + offscreen keepalive + icons
platform/firefox/     manifest.json + icons
assets/               mascot: one shape list, SVG and PNGs
build.py              assembles and validates dist/chrome and dist/firefox
test/                 59 checks across four suites
```

More detail: [autonomy](docs/autonomy.md) · [architecture](docs/architecture.md) ·
[protocol](docs/protocol.md) · [cross-browser](docs/cross-browser.md) ·
[the mascot](docs/mascot.md).

## Development

```bash
python3 build.py          # both bundles, validated
python3 assets/mascot.py  # regenerate the SVG and icons
npm test                  # build + all four suites
```

No browser, no network and no API key is needed: the core takes its storage, fetch, policy
and action log as injected dependencies, and the cross-browser suite drives the real
background host against fake Chrome-shaped and Firefox-shaped APIs.

## Limitations worth knowing

- Extension storage is **not encrypted**. The API key and the action log are plain text in
  your profile. Prefer a local endpoint with no key where you can.
- The audit log is **client-side**. If this becomes the front door to real state, move the
  durable record to the server that receives the changes.
- Autonomy expands the blast radius. That is why it is earned, quota-limited, reversible
  and revocable in one click — and why the default is confirm.
- On Firefox, closing the sidebar mid-run can let the background page be reaped. Every step
  is already on disk and a sweep marks the run `interrupted`, so nothing is silently lost,
  but the run stops there.
- One agent. No planner, no subagents, no MCP. The smallness is the feature.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Licence

MIT — see [LICENSE](LICENSE). The mascot is drawn from a single shape list in
[`assets/mascot.py`](assets/mascot.py), which emits both the SVG and the extension icons.
