# Security

## Reporting

Open a private security advisory from the repository's **Security** tab, or open a
regular issue if the report is not sensitive. Please include the browser and
version, the manifest version of the bundle, and the smallest reproduction you can
manage.

## What this extension can reach

Deliberately little, and it is worth being precise about it:

- **Its own storage.** Keys are prefixed `agent:` inside the extension's local
  storage area. It cannot read other extensions' data, the browser profile, or
  your files.
- **Allow-listed endpoints.** The background checks a URL prefix list before every
  request, and re-checks it when a proposal is applied.
- **Nothing else.** No page or tab access, no content scripts, no cookies, no
  history, no bookmarks. The manifests do not request those permissions.

## The threat model you should keep in mind

- **Extension storage is not encrypted.** The API key and the entire proposal
  queue live in `chrome.storage.local` / `browser.storage.local` in plain text.
  Anyone who can run developer tools against your profile, or read your profile
  directory, can read them. Prefer a local endpoint with no key where you can.
- **The audit log is client-side.** It records what the agent proposed and what you
  decided, but it is a local record. A motivated local attacker could edit it. If
  this harness becomes the front door to real state, move the durable record to the
  server that receives the changes.
- **The approval gate protects against the agent, not against you.** It exists so a
  model cannot change anything on its own. It is not a sandbox against a hostile
  extension you installed yourself.
- **Prompt injection is real.** Anything the agent reads through `api_read` can try
  to steer it. Two things limit the damage: an action on a `confirm` class can only propose
  — you see the rationale and the preview before anything happens — and an action on an
  `auto` class is journalled, quotad, and reversible from the panel.
- **Autonomy widens the blast radius, on purpose.** A class that has earned `auto` acts
  without asking. The mitigations are structural: nothing is autonomous by default, quotas
  cap autonomous actions per run and per hour, one decline, error or revert revokes
  immediately, `deny` is available for endpoints where a mistake is unacceptable, and
  `revoke all` returns everything to `confirm` in one click. If an endpoint can move money
  or delete data, put it in `alwaysConfirm` — the pattern list exists for exactly that.
- **The autonomy ledger is client-side too.** Levels, counters and cooldowns live in browser
  storage. Someone with developer tools can raise a level. Treat the ledger as a guard
  against a confused agent, not against a hostile local actor.

## Bookmarklet mode

The bookmarklet build runs the same harness **inside the page you click it on**, which
changes what is and is not protected:

- There is no extension boundary. The site's own scripts share the page's JavaScript
  context and its `localStorage`: they can read everything the harness has saved —
  settings (including the API key), sandbox, journals — and can tamper with the agent
  while it runs. Click it on sites you trust, and prefer a local endpoint with no key.
- There are no host permissions; the page's CORS rules are the gate. An endpoint that
  does not answer the page's origin fails as a tool error rather than being silently
  allowed.
- The allowlist is unchanged and still enforced in `actions.js`/`tools.js` — but it is
  now the *only* gate, so keep it tight.
- Pages with a strict `script-src` CSP refuse bookmarklets outright, and inline `style`
  may be blocked on some sites, leaving the panel unstyled.
- Storage is per-site (`localStorage`) and namespaced under `ningaui:`; the harness scopes
  its own keys and never reads the page's.
