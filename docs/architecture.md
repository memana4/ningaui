# Architecture

## The shape of it

One agent loop, one tool surface, one queue, two browser shells.

```
                 ┌───────────────────────────────────────────┐
                 │  panel.js  (side panel / sidebar)         │
                 │  run · transcript · review · settings     │
                 └───────────────┬───────────────────────────┘
                     runtime.sendMessage  │  runtime.connect("panel")
                                         ▼
                 ┌───────────────────────────────────────────┐
                 │  bg.js  (service worker / event page)     │
                 │  run control · approvals · status         │
                 └───────┬───────────────────────┬───────────┘
                         ▼                       ▼
              ┌──────────────────┐    ┌──────────────────────┐
              │  agent.js        │    │  proposals.js        │
              │  the loop        │───▶│  the queue           │
              └────────┬─────────┘    └───────┬──────────────┘
                       ▼                      ▼  (on your decision)
              ┌──────────────────┐    ┌──────────────────────┐
              │  tools.js        │    │  store.js            │
              │  4 reads, 2      │    │  agent:<key>         │
              │  proposals,      │    │  journal:<run>       │
              │  finish          │    │  proposal:<id>       │
              └────────┬─────────┘    │  audit:log           │
                       ▼              └──────────────────────┘
              ┌──────────────────┐
              │  model.js        │
              │  built-in / HTTP │
              └──────────────────┘
```

`core/api.js` sits under all of it and is the only file that knows which browser is
running.

## Why the core is engine-agnostic

The two engines are close enough to share almost everything and different enough that the
differences, left unmanaged, produce bugs that look like logic errors. They are collected
into one adapter, built as a factory so it can be constructed twice in a test:

```js
const api = createApi(globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome);
```

What the adapter owns: the storage handle, whether an offscreen document exists, how to
keep the background alive, whether host permissions are present, and which panel surface
the manifest declared. Nothing else in the project branches on the browser.

## State, and where it lives

Everything durable is in the extension's local storage area. The background page holds
exactly one piece of in-memory state — the currently running task — and losing it is a
recoverable event rather than a bug.

| key | contents | written when |
|---|---|---|
| `agent:<key>` | the agent's own sandboxed store | on an approved storage proposal |
| `journal:<runId>` | one run's event log, capped at 500 entries | after every step |
| `proposal:<id>` | one proposal, its preview, its decision and reason | on create, then on decide |
| `audit:log` | append-only list of creations and decisions, capped at 1000 | alongside every proposal change |
| `config` | backend, endpoint, key, allowlist, persona | when you save settings |
| `status` | current run state for the panel | on every state transition |

## Surviving termination

Chrome kills a service worker after roughly 30 seconds of inactivity; Firefox reaps an
event page on a similar idle timer but less eagerly. The design assumes the worst engine:

- the agent writes the journal entry for a step **before** starting the next one;
- during a run, Chrome keeps an offscreen document pinging and Firefox keeps an open
  runtime port from the panel;
- an `alarms` sweep every minute is the only timer that survives both, and it marks a run
  whose background died as `interrupted` rather than leaving it `running` forever.

The best case is that a killed worker loses the loop and nothing else. The worst case is
that you find an `interrupted` run with a complete journal and re-run it.

## The loop

`runAgent()` is a `while` with four exits: a final answer, a budget, a model failure, or a
tool result that says it is finished. Per step it:

1. calls the model with the whole message history,
2. parses **one** JSON object out of the reply (tolerant: models wrap JSON in prose and
   code fences),
3. journals the tool call, runs it, journals the result,
4. appends the result to the history and loops.

A reply with no parsable JSON gets exactly one correction attempt, because small local
models otherwise loop until the step budget kills them.

## Budgets

| budget | default | where |
|---|---|---|
| steps per run | 12 | `DEFAULT_LIMITS` in `agent.js` |
| wall clock per run | 120 s | same |
| per tool call | 20 s | same |
| proposals per run | 12 | `tools.js` |
| pending proposals | 200 | `proposals.js` |
| stored value size | 256 kB | `store.js` |
| API response kept | 20 kB | `tools.js` |

They are constants on purpose. A harness whose limits are configurable is a harness whose
limits are wrong in somebody's deployment.
