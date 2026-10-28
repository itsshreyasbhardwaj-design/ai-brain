# Self-hosting

## What was verified

Honesty first, because this is the section people act on.

| Path | Status |
|---|---|
| `pnpm install && pnpm setup && pnpm dev` | **Verified.** Run on macOS with Node 24.16 and pnpm 11.17. |
| `pnpm build` (production) | **Verified.** 25 routes compile. |
| `pnpm test` | **Verified.** 251 tests pass. |
| CLI (`pnpm brain …`) | **Verified**, including against a real on-disk database. |
| MCP server over stdio | **Verified** by spawning the real process and speaking JSON-RPC. |
| Browser flow: setup → onboarding → dashboard → passport → universe → assistant | **Verified** in a real browser. |
| `docker compose up --build` | **Not executed.** The machine this was built on has no Docker. The files are written against the documented API and reviewed, but they have not been run. |

If you hit a problem on the Docker path, that is the most likely place for it.
Please open an issue — it will be fixed quickly.

## Requirements

- **Node 22.6 or newer.** `node:sqlite` and TypeScript type stripping both need a
  recent runtime. Node 24+ is recommended and is what development uses.
- **pnpm 10 or newer.**
- About 200 MB of disk for `node_modules`, plus your data.

No database server. No Redis. No object storage. No accounts.

## The quick path

```bash
git clone https://github.com/itsshreyasbhardwaj-design/ai-brain.git
cd ai-brain
pnpm install
pnpm setup
pnpm dev
```

`pnpm setup` writes `.env` with a generated `APP_SECRET`, creates `./data/`, and
applies migrations. Open <http://localhost:3000> and the first-run page will ask
you to create the only account on the installation.

## Production

```bash
pnpm install --frozen-lockfile
pnpm build
NODE_ENV=production pnpm start
```

Put a reverse proxy in front of it. Session cookies are marked `secure` when
`NODE_ENV=production`, so without TLS you will not stay signed in — which is the
intended failure mode.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name brain.example.com;

  ssl_certificate     /etc/letsencrypt/live/brain.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/brain.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### systemd

```ini
[Unit]
Description=AI BRAIN
After=network.target

[Service]
Type=simple
User=aibrain
WorkingDirectory=/opt/ai-brain
Environment=NODE_ENV=production
EnvironmentFile=/opt/ai-brain/.env
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5

# The process needs nothing outside its own directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/ai-brain/data

[Install]
WantedBy=multi-user.target
```

`ProtectHome=read-only` is worth noting: the local-directory connector reads the
filesystem of the machine running the server. On a remote deployment that is the
server's disk, not your laptop's — which is both a security property and a
limitation.

## Docker

```bash
cp .env.example .env     # set APP_SECRET
docker compose up --build
```

The compose file mounts `./data` so the database survives a rebuild. **This path
has not been executed** — see the table at the top.

## Configuration

Every value has a working default except `APP_SECRET`.

| Variable | Default | What it does |
|---|---|---|
| `AI_BRAIN_DB` | `./data/brain.db` | Database file. Relative paths resolve from the repository root. |
| `APP_SECRET` | — | Encrypts connector credentials. At least 16 characters. **Changing it makes stored credentials permanently undecryptable.** |
| `AI_PROVIDER` | `none` | `none`, `ollama`, `anthropic`, `openai-compatible`. |
| `AI_MODEL` | — | Model name for the chosen provider. |
| `AI_API_KEY` | — | For paid providers. On its own it does **not** authorize spending. |
| `AI_BASE_URL` | provider default | For self-hosted gateways or a non-default Ollama host. |
| `AI_MONTHLY_BUDGET_MINOR` | `0` | Spend cap in cents. `0` refuses all paid calls. |
| `AI_PRICE_*_PER_MILLION_MINOR` | — | Prices for the cost estimate shown in the UI. |
| `GITHUB_WEBHOOK_SECRET` | — | Required for the webhook endpoint to accept anything. |
| `NODE_ENV` | `development` | `production` enables secure cookies. |

## Backup and restore

The database is one file.

```bash
# Backup — safe while the app is running, because of WAL
sqlite3 data/brain.db ".backup 'backup-$(date +%F).db'"

# Or just stop the app and copy it
cp data/brain.db backup.db

# Restore
cp backup.db data/brain.db
```

There is also a logical export, which is what you want for moving between
machines or versions:

```bash
pnpm brain export --out ai-brain-export.json
```

That file contains every record and **no credentials**. Import it into a fresh
installation from **Settings → Import**, or with
`pnpm brain import-export ai-brain-export.json`.

## Upgrading

```bash
git pull
pnpm install
pnpm brain migrate    # idempotent; safe to run when there is nothing to do
pnpm build
```

Migrations are forward-only and run inside a transaction each. The schema version
is visible in **Settings** and at `/api/health`.

## Health

```bash
curl -s localhost:3000/api/health
```

```json
{"status":"ok","schemaVersion":3,"expectedSchemaVersion":3,"pendingMigrations":[]}
```

Returns `503` with `status: "migrations-pending"` if the code is newer than the
database. It deliberately reports nothing about your data — it has to be
reachable unauthenticated.

## Lost password

There is no password reset, because this installation has no way to email you.
You do still have the database:

```bash
node --input-type=module -e "
import { openDb } from './packages/core/src/db/client.ts';
import { Store } from './packages/core/src/db/repositories.ts';
import { hashPassword } from './packages/core/src/security/password.ts';
const db = openDb({ path: './data/brain.db' });
const store = new Store(db);
const user = store.users.byEmail('you@example.com');
store.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword('a-new-long-password'), user.id]);
store.sessions.revokeAllForUser(user.id);
console.log('password reset');
db.close();
"
```

## Troubleshooting

**`pnpm install` says build scripts were ignored.** pnpm requires approval for
dependency build scripts. The repository approves the two it needs in
`pnpm-workspace.yaml` (`allowBuilds` for pnpm 11, `onlyBuiltDependencies` for
pnpm 10). If your pnpm predates both, run `pnpm approve-builds`.

**`APP_SECRET is not set` in the interface.** The app reads `.env` from the
repository root. Run `pnpm setup`, or set it yourself and restart.

**GitHub sync finds nothing.** Check the allowlist. An empty allowlist means
"everything the token can see", and a typo'd `owner/repo` matches nothing. The
integrations page reports what the last run actually covered.

**CI pass rate is missing.** It comes from GitHub Actions runs on the default
branch. A repository with no Actions workflow has no CI data, and the passport
section says so rather than showing 0%.

**The 3D universe is blank.** Switch to the List view; it has the same
information. If WebGL is unavailable the app falls back automatically and says
why.

**`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.** Your Node is too old, or something in
the core used syntax that cannot be type-stripped (enums, namespaces, parameter
properties). `pnpm lint` catches the second case.
