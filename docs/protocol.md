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

Seven tools. API first: two for the world, two for the agent's own memory, two about
policy, one to stop.

| tool | args | notes |
|---|---|---|
| `api_read` | `url`, `headers?` | `GET` only, allowlist-checked |
| `api_request` | `url`, `method`, `body`, `rationale` | non-`GET`; routed by policy, not by the agent |
| `remember` | `key`, `value` | the agent's own sandbox — always applies, never queues |
| `recall` | `key?`, `prefix?` | read one value, or up to 50 by prefix |
| `list_actions` | `status?` | applied, queued, declined, reverted, plus the autonomy view |
| `request_autonomy` | `class`, `rationale` | files a policy action a human must approve |
| `finish` | `summary` | reports what awaits a human and what is trusted |

`api_request` is the only way to change state through an API, and it does not decide its own
outcome. It returns exactly what happened:

```json
{"mode": "auto", "applied": true, "status": 200, "body": "…",
 "note": "policy allowed this class to act autonomously; it is logged and reversible"}
```

```json
{"mode": "confirm", "action_id": "a-mf3k1x-2", "status": "awaiting human decision",
 "note": "queued with your rationale; nothing has been sent"}
```

## 3. The message protocol

Panel → background, over `runtime.sendMessage`. The listener replies asynchronously
(`return true`), which both engines honour.

| type | payload | reply |
|---|---|---|
| `run` | `task` | the run result, or `{error}` |
| `stop` | — | `{stopped: true}` |
| `actions` | — | `{pending[], recent[], audit[]}` |
| `decide` | `id`, `decision`, `reason` | `{ok, action}` or `{ok:false, error}` |
| `revert` | `id`, `reason` | `{ok, action}` or `{ok:false, error}` |
| `trust` | — | the policy view: classes, levels, counters, quotas |
| `setLevel` | `cls`, `level`, `note?` | `{ok, record}` |
| `setPolicy` | `patch` | `{ok, policy}` |
| `revokeAll` | — | `{ok, revoked}` |
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

`idle` · `running` · `awaiting_decision` · `done` · `stopped` · `interrupted` ·
`model_error` · `max_steps` · `timeout` · `error`

`awaiting_decision` is the interesting one: the run finished, but it left actions in the
queue, and the next thing that happens is your decision rather than anything the agent does.

## 5. The action record

```json
{
  "id": "a-mf3k1x-2",
  "runId": "run-mf3k1x",
  "kind": "api",
  "target": {"url": "http://localhost:11434/state", "method": "POST"},
  "payload": {"n": 1},
  "rationale": "state says 0, should be 1",
  "cls": "POST localhost:11434/state",
  "mode": "confirm",
  "policyWhy": "no autonomy on this class yet",
  "preview": {"before": "{\"state\":{\"n\":0}}", "after": "{\"n\":1}"},
  "status": "pending",
  "created": 1789086000000,
  "decided": null,
  "reason": null,
  "by": null,
  "applied": null
}
```

`mode` is the policy verdict — `auto` or `confirm`. `status` then runs through the life of
the action:

| status | meaning |
|---|---|
| `pending` | waiting for a human decision |
| `applied` | it happened; `by` says `policy` or `human` |
| `failed` | it was attempted and the endpoint refused; autonomy on the class is revoked |
| `declined` | you said no; `reason` holds why |
| `reverted` | it was applied and then undone |

An action that is refused **before** anything is attempted — an allowlist that changed while
it waited — is put back to `pending` with the refusal in `policyWhy`, so your approval is not
consumed by a configuration problem.

The policy ledger, one record per class:

```json
{
  "cls": "POST localhost:11434/state",
  "level": "auto",
  "explicit": false,
  "approved": 9, "declined": 0, "auto": 4, "errors": 0, "reverted": 0,
  "firstSeen": 1789000000000, "lastDecision": 1789080000000,
  "lastDecline": null, "lastError": null, "cooldownUntil": 0,
  "note": "earned after 9 approvals and no declines or errors"
}
```
