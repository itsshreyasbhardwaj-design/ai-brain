# Privacy

## The short version

Your data is a file on your disk. Nothing leaves your machine unless you connect
a source or turn on a remote AI provider, and both are off until you do it.

There is no telemetry in this repository. You can check: `grep -ri "analytics\|telemetry\|track(" apps packages tools --include=*.ts --include=*.tsx`.

## What is collected

Nothing, by this project. Everything in your brain is either something you typed,
something you imported, or something a connector you authorized observed.

## Defaults

| Setting | Default | Why |
|---|---|---|
| Remote AI | **off** | A key in the environment is not consent. |
| File content import | on | Secrets are stripped locally first. |
| Excluded categories | none | You add them. |
| Source retention | keep | Opt in to deletion; nothing is discarded silently. |
| Project auto-registration | review | Ambiguity goes to a human. |
| Additional sign-ups | **off** | A self-hosted instance is not an open sign-up form. |

For an account marked as belonging to a minor, remote AI cannot be enabled at
all, and the student profile also defaults file content import to off.

## Workspace isolation

Every repository method takes a `workspaceId` and puts it in the `WHERE` clause.
There is no method that can return another workspace's rows.

This is tested rather than asserted: `privacy.test.ts` creates two accounts,
writes records to one, and checks that every list, search, read, update and
delete scoped to the other returns nothing — including that an update aimed at
another workspace's record id is a no-op rather than a silent success.

## Secret redaction

Imported text is scanned **before** it is written, and before it could reach an
AI provider. Detected: private key blocks, AWS access keys, GitHub tokens, Slack
tokens, OpenAI and Anthropic keys, Google API keys, JWTs, bearer tokens,
database connection strings with inline credentials, `*_SECRET=`/`*_TOKEN=`
assignments, and card numbers that pass a Luhn check.

The Luhn check matters: without it, every sixteen-digit order number in your
notes would be redacted. The test asserts both directions — a valid test card is
redacted, a random sixteen-digit number is left alone.

## Files that are never read

Regardless of what you authorize:

```
.env and .env.*          id_rsa, id_ed25519      *.pem *.key *.p12 *.pfx
credentials, .netrc      .npmrc, .pgpass         secrets.json, .htpasswd
node_modules/  .git/  .ssh/  .aws/  .gnupg/  Library/Keychains/  .cache/
```

Plus any globs you add. And authorizing an entire home directory is refused
outright — the connect form tells you to point at your projects folder instead.

## Credentials

| Secret | Storage |
|---|---|
| Password | scrypt (N=32768, r=8, p=1), random 16-byte salt |
| Connector token | AES-256-GCM, key derived from `APP_SECRET` |
| Session token | SHA-256 hash; the raw value exists only in your cookie |
| Access token | SHA-256 hash; the raw value is shown once and never again |

Revoking a connection destroys the stored credential immediately. Records already
synced are kept until you delete them, which is deliberate — you may have written
notes against a project that came from that source.

## Prompt injection

Imported documents, repository READMEs and connector payloads are data. Before
any of it reaches a model it is scanned for instruction-override patterns, role
assertions, fence-break attempts, exfiltration requests, tool coercion and
authority claims; wrapped in an `<untrusted-data>` block with the escape
sequences neutralised; and the detected signals are reported to you rather than
swallowed.

The system prompt then states that the computed answer is authoritative and that
anything inside an untrusted block is content to describe, never an instruction.

That is defence in depth, not a guarantee. The structural protection is that a
model cannot write to your brain at all.

## AI providers

With `AI_PROVIDER=none` — the default — there is no network call and no cost.
Every feature works.

If you enable one, only the computed answer text is sent, never raw records, and
only when your privacy setting allows it. An environment key is not enough on its
own: `AI_MONTHLY_BUDGET_MINOR` must also be set, and a call estimated to exceed
the remaining budget is refused before it is made. Spend is recorded and visible
on the Assistant page.

`ollama` runs locally and costs nothing.

## Your data, leaving

| Action | What happens |
|---|---|
| **Export** | Every record, as JSON. No credentials. Re-importable anywhere. |
| **Export configuration** | `brain.config.json`. No records at all. |
| **Export context package** | Your brain for an AI tool. No credentials. |
| **Delete a source's data** | Source records, imported knowledge and activity are deleted; projects from it are archived rather than destroyed, so your own notes survive. |
| **Delete workspace** | Cascades through every table. |
| **Delete account** | Removes the user, every workspace they own, and every session. |

Deletion is immediate and real — foreign keys cascade, and the tests check that
rows are actually gone rather than flagged.

## Audit log

Account creation, sign-in, failed sign-in, password change, token issue and
revoke, connector connect/sync/revoke, data deletion, imports, exports and MCP
proposals are all recorded, visible under **Settings → Audit log**.

The log never contains a raw token. There is a test for that.
