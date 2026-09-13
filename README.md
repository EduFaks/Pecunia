# Pecunia

**Your financial life. Yours.** A self-hosted personal finance app — accounts,
transactions, projects, assets and valuations, budgets — that runs entirely on
your own server, with a dark-first interface designed to be worth keeping open.

---

## Quickstart

```bash
git clone <your-fork-or-mirror> pecunia
cd pecunia
cp .env.example .env
docker compose up -d
```

Then open **http://localhost:8480**. A fresh instance greets you with the
first-run **setup wizard** — create the owner account, choose your base
currency and regional preferences, optionally add accounts or explore demo
data, and you're in. Nothing else is manual: the containers wait for the
database, run migrations, seed reference data, and generate a secret key on
first boot.

Three containers, one published port:

| Container | Role |
|-----------|------|
| `pecunia-web` | nginx — serves the web UI and reverse-proxies `/api` (the only container that publishes a host port, `PECUNIA_PORT`, default `8480`) |
| `pecunia-api` | FastAPI — authentication, domain services, the finance engine, the audit service, the API (internal only) |
| `pecunia-db` | PostgreSQL 17 — finance data, users, sessions, audit log |

Data lives in Docker volumes (`pecunia_db_data`, `pecunia_config`,
`pecunia_files`); the config volume holds the generated secret key so tokens
survive restarts.

## The setup wizard

Uninitialized instances route to the wizard and **every enforcement lives in
the API** — while uninitialized, non-setup endpoints return `409 SETUP_REQUIRED`;
once initialized, the setup endpoints return `409 SETUP_ALREADY_COMPLETE`
permanently. Initialization is a single atomic, race-safe call that creates the
owner, the default workspace, and your preferences, then logs you in. There is
no API path that can ever de-initialize an instance — a factory reset means
dropping the database volume (`docker compose down -v`), which requires host
access.

## Operating Pecunia

**Network egress** — Pecunia runs fully offline, with one exception: the
optional crypto price sync, which makes outbound HTTPS calls to CoinGecko
(`api.coingecko.com`) to price portfolio holdings. It's on by default; disable
it with `PECUNIA_ENABLE_PRICE_SYNC=false`. The on-demand "Update prices"
button on a portfolio and the holding form's coin picker also reach CoinGecko
directly, regardless of that setting — everything else never leaves your
server.

**Health check** — diagnose an instance:

```bash
docker compose exec pecunia-api pecunia doctor
```

It verifies database connectivity, that migrations are at head, storage
writability, and the secret key, and notes backup status. It exits non-zero if
a critical check fails. It is diagnostic only — never required for setup.

**Backups** — Pecunia is a single Postgres database plus a files volume. The
commands read the container's own credentials, so they work whatever you set
`PECUNIA_DB_*` to:

```bash
# Back up (schema + data + alembic_version, drop-and-recreate on restore)
docker compose exec -T pecunia-db sh -c \
  'pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"' > pecunia-$(date +%F).sql
```

Restore is a full replacement, so bring the stack down first and load into a
database-only start (this preserves the dump's `alembic_version`, so the API's
migrate-on-boot is a no-op afterward):

```bash
docker compose down -v
docker compose up -d pecunia-db          # DB only, no app/migrations yet
docker compose exec -T pecunia-db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < pecunia-YYYY-MM-DD.sql
docker compose up -d                     # start the rest; migrations no-op at head
```

Schedule the dump with host cron for automatic backups. (A wizard-integrated
restore UI is planned; V1 uses this documented path.)

## Production

Pecunia is safe to run on localhost or a trusted LAN out of the box. Before
exposing it beyond that:

- **Set a strong `PECUNIA_SECRET_KEY`** (32+ random characters). Left empty,
  Pecunia generates and persists one; a *weak* configured key makes the API
  refuse to start.
- **Front it with HTTPS** (a reverse proxy terminating TLS). Auth cookies get
  the `Secure` flag automatically when the request arrives over https
  (`X-Forwarded-Proto`). Set `PECUNIA_SERVER_NAMES_RAW` to your hostname(s) to
  reject DNS-rebinding via a Host allowlist.
- **Exposed before first setup?** Set `PECUNIA_SETUP_TOKEN` so initialization
  additionally requires an `X-Setup-Token` header, closing the
  first-visit-wins window until you've created the owner.
- `pecunia-web` itself overwrites `X-Forwarded-For` with the connecting peer,
  so a client can't spoof its IP. Note the consequence if you add your **own**
  TLS proxy in front: the API then sees (and audits/throttles by) that proxy's
  address, since only `pecunia-web` is a trusted hop. This fails safe (throttle
  keys collapse onto one IP rather than being spoofable); a trusted-upstream
  option to carry the real client IP through is future work.

The audit log is append-only (a Postgres trigger blocks row updates/deletes).
Honestly: on a self-hosted instance the database owner can always bypass that —
true tamper-proofing is impossible when you control the hardware. The trigger
protects against application bugs and casual tampering, not against yourself.

## Development

```bash
# Backend (Python 3.12, uv) — tests use a throwaway Postgres via testcontainers, so Docker must be running
cd api && uv sync && uv run pytest

# Frontend (Node 20, npm)
cd web && npm install && npm run dev     # Vite dev server, proxies /api → localhost:8480
cd web && npm run test                   # Vitest
```

Design and engineering docs:

- `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md` — the technical &
  product design proposal (the decision board).
- `docs/CONVENTIONS.md` — the engineering conventions every contribution follows.
- `docs/superpowers/plans/` — the per-plan implementation records.

## Not in V1 (deliberately deferred)

Honesty over feature-creep — reserved for later, with the architecture already
shaped to accept them: a light theme (the token system exists; values don't),
CSV/OFX transaction import, attachments/receipts/asset-photo storage,
TOTP/2FA and passkeys, personal access tokens, OAuth/OIDC, a wizard-integrated
backup restore, multi-user workspaces (the schema is workspace-scoped from day
one; the invitation/role UI is future work), and cross-currency net-worth
consolidation (V1 reports per currency).

## License

See `LICENSE` (add one before publishing).
