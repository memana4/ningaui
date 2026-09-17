# Architecture

## The shape of it

One agent loop, one tool surface, one queue, two browser shells.

```
                 ┌───────────────────────────────────────────┐
                 │  panel.js  (side panel / sidebar)         │
                 │  run · transcript · queue · autonomy      │
                 └───────────────┬───────────────────────────┘
                     runtime.sendMessage  │  runtime.connect("panel")
                                         ▼
                 ┌───────────────────────────────────────────┐
                 │  bg.js  (service worker / event page)     │
                 │  run control · decisions · policy · status│
                 └───────┬───────────────────────┬───────────┘
                         ▼                       ▼
              ┌──────────────────┐    ┌──────────────────────┐
              │  agent.js        │    │  policy.js           │
              │  the loop        │    │  class → level       │
              └────────┬─────────┘    │  earned autonomy     │
                       ▼              │  quotas, revocation  │
              ┌──────────────────┐    └───────┬──────────────┘
              │  tools.js        │            ▼
              │  api_read        │    ┌──────────────────────┐
              │  api_request ────┼───▶│  actions.js          │
              │  remember/recall │    │  auto: apply now     │
              │  list_actions    │    │  confirm: queue      │
              │  request_autonomy│    │  decide · revert     │
              │  finish          │    │  audit:log           │
              └────────┬─────────┘    └───────┬──────────────┘
                       ▼                      ▼
              ┌──────────────────┐    ┌──────────────────────┐
              │  model.js        │    │  store.js            │
              │  built-in / HTTP │    │  agent:<key>         │
              └──────────────────┘    │  journal:<run>       │
                                      │  action:<id>         │
                                      │  trust:<class>       │
                                      └──────────────────────┘
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
| `agent:<key>` | the agent's sandboxed memory | on `remember`, or an approved store action |
| `journal:<runId>` | one run's event log, capped at 500 entries | after every step |
| `action:<id>` | one action: class, mode, preview, decision, reason, result | on submit, then on apply or decide |
| `trust:<class>` | the autonomy ledger for one class | on every decision and application |
| `audit:log` | append-only list of actions, decisions, policy changes, reverts, capped at 1000 | alongside every change |
| `autolog` | timestamps of autonomous applications in the last hour | on every autonomous application |
| `config` | backend, endpoint, key, allowlist, persona, policy | when you save settings |
| `status` | current run state for the panel | on every state transition |

## How an action flows

```
tool call: api_request
      │
      ▼
policy.decide(action) ──▶ deny ──── refused, audit only, nothing queued
      │
      ├──▶ confirm ──▶ apply() on your decision ──▶ execute() ──▶ world
      │                    │                            │
      │                    └── pre-flight refusal ──────┘  (stays pending, reason attached)
      │
      └──▶ auto ──▶ apply() immediately ──▶ execute() ──▶ world
                        │                      │
                        └── success or failure ─┴──▶ policy.noteApplied()
                                                     (failure revokes the class)
```

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
| actions per run (any mode) | 12 | `tools.js` |
| pending actions | 200 | `actions.js` |
| autonomous actions per run | 20 | `DEFAULT_POLICY` |
| autonomous actions per hour | 30 | `DEFAULT_POLICY` |
| approvals before autonomy | 8 | `DEFAULT_POLICY` |
| clean stretch before autonomy | 72 h | `DEFAULT_POLICY` |
| cooldown after a revocation | 24 h | `DEFAULT_POLICY` |
| stored value size | 256 kB | `store.js` |
| API response kept | 20 kB | `tools.js` |

They are constants on purpose. A harness whose limits are configurable is a harness whose
limits are wrong in somebody's deployment.
