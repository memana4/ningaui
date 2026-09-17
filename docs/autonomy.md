# Autonomy

The gate and the leash are the same mechanism at different settings. This document is how
the settings work, what earns a change, and what takes it back.

## The three levels

Every action the agent takes belongs to a **class**. A class is the stable identity of a
kind of action, with ids normalised away:

```
POST api.example.com/orders/{id}      from https://api.example.com/orders/8412
PATCH api.example.com/x/{id}          from .../x/2fa8f1c0-9c2b-4a11-8f0e-9b1c2d3e4f50
store notes                           from a sandbox key called "notes:today"
```

Each class has one level:

| level | behaviour | how you get here |
|---|---|---|
| **confirm** | queues with a rationale and preview; a human decides | the default |
| **auto** | applies immediately, journals, reports back | earned from the record, or granted by hand |
| **deny** | refused; it cannot even queue | set by hand |

## What earns autonomy

A class is promoted from confirm to auto when **all** of these hold:

- at least `minApprovals` approvals (default 8)
- no declines and no apply errors for `minCleanMs` (default 72 hours)
- past its cooldown, if it ever had one
- `autoPromote` is on and the master switch is on

All four are configurable in the panel or in `config.policy`. Nothing is promoted on a
single success, and nothing is promoted on a good mood: the decision is counters and
timestamps.

## What takes it back

Any of these revokes autonomy **immediately**, with no grace period:

- **a decline.** You said no. If the class was autonomous, it goes back to confirm and
  starts a cooldown (default 24 hours), during which a clean record cannot re-promote it.
- **an apply error.** A 500, a refused connection, anything that fails. Recorded, and the
  class drops back.
- **a revert.** You undid something it did. Same effect.

The asymmetry is deliberate. Earning takes eight approvals and three clean days; losing
takes one bad outcome.

## Quotas, which apply no matter what

Even a class you granted by hand is capped:

| quota | default | why |
|---|---|---|
| autonomous actions per run | 20 | a looping model cannot empty the tank in one go |
| autonomous actions per hour | 30 | and not by running repeatedly |
| actions per run (any mode) | 12 | the queue stays reviewable |

When a quota is hit, the action does not fail — it **falls back to confirm** and queues.
You see it, the work is not lost, and nothing silent happened.

## Who can change a level

- **You**, from the panel: a dropdown per class, plus `revoke all` and an autonomy master
  switch. A level you set by hand is marked explicit and outranks the earned level; a
  promotion by the record never overrides your choice.
- **The agent, only by asking.** `request_autonomy` files an action of kind `policy` with a
  rationale. It goes through the same queue as everything else and a human approves it. The
  agent cannot grant itself anything.
- **Nothing else.** There is no model in the loop deciding whether the model has been good.

## Grants by pattern

For endpoints where every call is routine, `policy.autoAllow` takes class patterns:

```
POST localhost:11434/*
PUT api.example.com/cache/*
```

`policy.alwaysConfirm` is the mirror image, and it beats everything except `deny`:

```
DELETE *
POST api.example.com/billing/*
```

Both are visible in the panel, and a class matched by a pattern shows up as autonomous so
you can see exactly what is running without asking you.

## Reverting

Auto-applied actions are listed in the panel with a **revert** button:

- **sandbox actions** restore the previous value cleanly.
- **policy actions** put the class back to confirm.
- **API actions** cannot be generically undone. Ningaui records the state it saw before
  applying, marks the action reverted, and revokes autonomy on the class — which stops the
  same mistake happening twice while you compensate the change.

A revert always revokes. Undoing is not a no-op in the record.

## What is still true from the gate

Every original invariant survives, because the confirm path is unchanged:

- proposing writes nothing
- approval applies exactly what was proposed — method, URL, body
- a declined action never touches state, and declining needs a reason
- an action cannot be decided twice
- the allowlist is re-checked at apply time, and **a pre-flight refusal does not consume
  your approval** — the action stays pending with the reason attached so you can fix the
  config and retry
- everything lands in an append-only audit log, including every autonomous action with the
  policy state that allowed it

## The honest limitation

Autonomy is bounded by code, not by judgement. A class that earned trust on three days of
routine calls will keep that trust when the fourth day is unusual — the record cannot tell
the difference, and neither can this design. That is why the quotas exist, why a revert
revokes, and why `deny` is available for the endpoints where being wrong is not a cost you
are willing to pay.
