# Security

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting
(the **Security** tab → **Report a vulnerability**) so the problem can be fixed
before it is public.

Please include what you can: the version or commit, what you did, what happened,
and what you expected. A proof of concept helps enormously.

You should get an acknowledgement within a few days. This is a volunteer
project; there is no bug bounty and no paid support contract, and pretending
otherwise would be dishonest.

## What this project defends against

AI BRAIN is a single-tenant, self-hosted personal data system. The threat model
is accordingly specific.

**In scope, and tested:**

| | How it is defended | Test |
|---|---|---|
| Cross-workspace data access | Every repository method is workspace-scoped; there is no method that can return another workspace's rows | `privacy.test.ts` |
| Credential theft from the database | Connector tokens are AES-256-GCM encrypted; passwords are scrypt; access tokens are stored only as SHA-256 hashes | `privacy.test.ts` |
| Secrets leaking into the knowledge base | Imported text is redacted locally before storage, with a Luhn check to avoid false positives | `privacy.test.ts`, `knowledge.test.ts` |
| Reading files outside an authorization | A built-in denylist blocks `.env`, SSH keys, credential files, `node_modules` and `.git`, plus user globs | `privacy.test.ts` |
| Prompt injection via imported content | Untrusted text is scanned, fenced in `<untrusted-data>` blocks, and the signals are reported | `privacy.test.ts` |
| Forged webhooks | HMAC-SHA256 signature verification with constant-time comparison; fails closed with no secret configured | `integration.test.ts` |
| Unscoped assistant access | MCP tools are gated per scope; the only write tool records a proposal rather than applying it | `e2e-tools.test.ts` |
| Credential stuffing | Per-email rate limiting; identical error and comparable work for unknown email and wrong password | `privacy.test.ts` |
| Runaway AI spend | Budget checked before the request; a key alone does not authorize spending | `privacy.test.ts` |

**Out of scope:**

- **An attacker with the database file.** It is a SQLite file on your disk. Full-
  disk encryption is your operating system's job, not this application's.
- **An attacker with `APP_SECRET`.** It decrypts connector credentials by design.
- **Multi-tenant hosting.** This release targets one person per installation.
  Workspace isolation is enforced, but it has not been audited as a multi-tenant
  boundary and should not be treated as one.
- **Denial of service.** Rate limiting is in-process and adequate for a personal
  installation. A public deployment needs a reverse proxy in front of it.

## Deployment notes

- **Set `APP_SECRET`** to at least 16 random characters, and keep it. Changing it
  makes stored connector credentials permanently undecryptable.
- **Do not expose this to the internet without a reverse proxy** terminating TLS.
  Session cookies are marked `secure` only when `NODE_ENV=production`.
- **Use a read-scope GitHub token** and an allowlist. The application never needs
  write access to your repositories.
- **`GITHUB_WEBHOOK_SECRET` must be set** for the webhook endpoint to accept
  anything. With it unset, every request is refused.
- **Back up `./data/brain.db`.** It is one file. Copying it is a complete backup.

## Supported versions

This is a 0.x release. Security fixes land on `main`; there are no backported
release branches yet.
