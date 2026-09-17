# The approval gate

The design decision this project exists to explore: **the agent has no write tool**.

## Why not a permission prompt

A permission prompt asks "may I?" at the moment the model wants something. That is the
wrong moment. You are being asked to judge a request in isolation, with no time to think,
while the model waits. And once granted, nothing records why.

A proposal is different in three ways:

1. **It is a proposal, not an interruption.** The model keeps working and the requests
   queue up. You review them when you choose, in batches, without the model waiting on you.
2. **It carries a rationale and a preview.** The agent must say why, in one line, and the
   queue shows the state before and the state after.
3. **The decision is data.** Your reason is stored on the proposal, and the agent reads it
   back next run. Declining teaches the model; the alternative teaches it nothing.

## The invariants

These are enforced in code and asserted in `test/proposals.test.mjs`:

- **Proposing writes nothing.** State is untouched until a decision arrives.
- **Approval applies exactly what was proposed.** Method, URL and body, byte for byte,
  verified against a spy in the tests.
- **A declined proposal never touches state**, and declining without a reason is refused.
- **A proposal cannot be decided twice.** There is no "apply it anyway" path.
- **A rationale is required**, minimum three characters. No silent proposals.
- **The allowlist is re-checked at apply time.** If you changed the endpoint configuration
  while a proposal sat in the queue, the apply is refused and the proposal stays pending.
- **The queue is capped** at 200 pending, and one run may propose at most 12 things, so a
  looping model cannot bury your review screen.
- **Everything is logged.** Creations and decisions land in an append-only audit list, and
  each applied proposal records the HTTP status it actually got.

## The reviewer's side

The panel is built for going through a stack quickly: one row per proposal, the agent's
rationale under it, the before/after under that. Arrows to move, `a` to approve, `d` to
decline with a reason, `s` to skip. Quick reasons as buttons. Bulk approval for local
storage writes only — API calls are worth reading one at a time.

## What this does not protect against

- **A hostile local actor.** The queue and the audit log live in browser storage in plain
  text. Someone with developer tools can edit them.
- **Your own mistake.** Nothing stops you approving something bad. The gate buys review,
  not wisdom.
- **Prompt injection reaching the queue.** Anything the agent reads can try to steer it. The
  mitigation is structural rather than clever: a steered agent can only produce proposals,
  each with a rationale and a visible diff, and none of them happen until you say so. The
  worst case is a queue of bad proposals, not a bad write.

## Extending it

If you build on this, keep the shape: the apply step is the only code with real-world
effect. It should stay a single small function, so it can be read in full — that is the
property the whole design is for.
