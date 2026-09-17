# Contributing

## Getting set up

```bash
git clone <your fork>
cd ningaui
python3 build.py           # writes dist/chrome and dist/firefox
node test/loop.test.mjs    # the loop and the protocol
node test/actions.test.mjs # the two paths through the gate
node test/policy.test.mjs  # earned autonomy, quotas, revocation
node test/crossbrowser.test.mjs
```

`npm test` runs the build and all four suites. There are no dependencies to install, in
either language, apart from Pillow if you regenerate the mascot.

## The rules that matter here

1. **Every write goes through policy.** No tool may change the world directly: state
   changes are submitted to `actions.js`, which asks `policy.js` for a verdict. A pull
   request that adds a tool which acts first and records afterwards will be declined,
   however convenient it is. Autonomy is a policy outcome, never a tool's own decision.
2. **Platform differences go in `core/api.js`.** If you find yourself writing
   `if (isFirefox)` anywhere else, the adapter is missing a method — add it there
   and give both engines a path.
3. **One source tree, two manifests.** Change `platform/*/manifest.json` and let
   `build.py` validate. Do not add a Chrome-only key to the Firefox manifest; the
   build will fail and that is the point.
4. **Tests first, and they must run without a browser or a network.** The core takes
   its storage, fetch and model as injected dependencies precisely so this is
   possible. New behaviour needs a check in the matching suite.
5. **Comments explain why, not what.** Several of them record a specific engine
   behaviour that cost an afternoon; leave those in place.

## Adding a tool

Tools live in `core/tools.js` as specs plus handlers. A new tool needs:

- an entry in `TOOL_SPECS` with a one-line description the model will read
- a handler that either reads or proposes — never writes
- a test in `test/proposals.test.mjs` if it proposes, or `test/loop.test.mjs` if it
  does not

## Commits and pull requests

Keep the subject line imperative and under 72 characters. In the body, say what
changed and why, and note anything you deliberately did not do. Pull requests
should pass CI (both bundles build, all three suites green).

## Licence

By contributing you agree your work is licensed under the MIT Licence, as in
`LICENSE`.
