# Protocol

Two protocols matter: what the model sends each step, and what the panel and background
say to each other.

## 1. The model protocol

The model's entire reply for a step is **one JSON object**. Nothing else.

```json
{"tool": "storage_get", "args": {"key": "counter"}}
```

```json
{"final": "read the state and proposed setting n to 1"}
```

`finish` exists as a tool as well as a final answer, so a model that prefers tools over
prose still has a way out:

```json
{"tool": "finish", "args": {"summary": "nothing to do"}}
```

### Tolerant parsing

Small models wrap JSON in prose and code fences, so the parser strips fences, finds the
first `{`, and walks braces (tracking strings and escapes) until the object balances. All
of these are accepted:

```
{"tool":"storage_list","args":{}}
```json
{"tool":"storage_list","args":{}}
```
Sure! Here you go: {"tool":"storage_list","args":{}} — that should do it.
```

A reply with no JSON, or unbalanced JSON, gets one correction message appended to the
history and no penalty beyond that. If the next reply is also unparsable, the loop keeps
going until the step budget is exhausted; the journal records every `parse_error`.

## 2. The tool surface

Seven tools. Four read, two propose, one finish.

| tool | args | notes |
|---|---|---|
| `storage_list` | — | keys in the agent's own store |
| `storage_get` | `key` | one value, or `null` |
| `api_read` | `url`, `headers?` | `GET` only, prefix-checked |
| `propose_storage_change` | `key`, `value`, `rationale` | `value: null` proposes a delete |
| `propose_api_change` | `url`, `method`, `body`, `rationale` | non-`GET`; `GET`/`HEAD` are refused |
| `list_proposals` | `status?` | includes the human's decision and reason |
| `finish` | `summary` | reports how much is awaiting review |

There is deliberately **no** `storage_set`, `storage_delete`, or arbitrary `api_call`.

## 3. The message protocol

Panel → background, over `runtime.sendMessage`. The listener replies asynchronously
(`return true`), which both engines honour.

| type | payload | reply |
|---|---|---|
| `run` | `task` | the run result, or `{error}` |
| `stop` | — | `{stopped: true}` |
| `proposals` | — | `{pending[], decided[], audit[]}` |
| `decide` | `id`, `decision`, `reason` | `{ok, proposal}` or `{ok:false, error}` |
| `clearDecided` | — | `{cleared: n}` |
| `journal` | `runId` | `{journal[]}` |
| `permissions` | `request?` | `{granted, origins[]}` |
| `env` | — | `{browser, isFirefox, keepalive, builtInModel}` |
| `keepalive` | — | `{ok, ports}` |

Panel → background, over a long-lived port named `panel`. On Firefox this port is what
stops the event page being reaped during a run.

| direction | message | meaning |
|---|---|---|
| background → panel | `{type: "hello", browser}` | sent on connect |
| panel → background | `{type: "ping"}` | keepalive, every 20 s while running |
| background → panel | `{type: "status", status}` | reply to a ping, and push on transitions |

## 4. Run states

`idle` · `running` · `awaiting_approval` · `done` · `stopped` · `interrupted` ·
`model_error` · `max_steps` · `timeout` · `error`

`awaiting_approval` is the interesting one: the run finished, but it left proposals in the
queue, and the next thing that happens is your decision rather than anything the agent
does.

## 5. The proposal record

```json
{
  "id": "p-mf3k1x-2",
  "runId": "run-mf3k1x",
  "kind": "api",
  "target": {"url": "http://localhost:11434/state", "method": "POST"},
  "payload": {"n": 1},
  "rationale": "state says 0, should be 1",
  "preview": {"before": "{\"state\":{\"n\":0}}", "after": "{\"n\":1}"},
  "status": "pending",
  "created": 1789086000000,
  "decided": null,
  "reason": null,
  "by": null,
  "applied": null
}
```

After a decision, `status` is `approved` or `declined`, `decided` and `by` are filled in,
`reason` holds your reason, and `applied` holds what actually happened — for an API
proposal, the HTTP status and a slice of the response body.
