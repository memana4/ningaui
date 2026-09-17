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
  to steer it. The gate is the mitigation: a steered agent can only propose, and
  you see the rationale and the before/after preview before anything happens.
