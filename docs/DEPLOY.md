# Production deployment

One VPS (Ubuntu 24.04, 2 vCPU / 4 GB) running Docker Compose (SPEC §7). This repo owns the infrastructure;
the frontend repo only builds its image and asks this repo to deploy it.

```
                 ┌──────────────────────────── VPS ─────────────────────────────┐
 app.<domain> ──►│ caddy :443 ─┬─ /api/*  ──► api:3000  (NestJS, migrate on start)│
files.<domain> ─►│             ├─ /*      ──► web:3001  (Next.js standalone)      │
                 │             └─ files.  ──► minio:9000 (private bucket, SSE-S3) │
                 │                            postgres:5432 (16 + btree_gist)     │
                 └──────────────────────────────────────────────────────────────┘
   network `backend` is internal (no internet); only api, caddy and the backup tool also join `egress`
```

| File (`infra/`)           | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `docker-compose.yml`      | the production stack                                                               |
| `Caddyfile`               | TLS, routing, security headers, body limits, log redaction                         |
| `.env.prod.example`       | every setting/secret → `.env.prod` on the server                                   |
| `deploy.sh`               | pins images in `.env.images`, `pull` + `up --wait`, rollback                       |
| `backup.sh`               | nightly `pg_dump` + bucket mirror to off-site S3, retention, healthchecks.io pings |
| `backup.env.example`      | off-site target → `backup.env` on the server                                       |
| `postgres/01-app-role.sh` | first boot only: non-superuser app role `sila` owning db `sila`, `btree_gist`      |
| `minio/init.sh`           | every boot: private bucket, default SSE-S3, least-privilege `sila-api` user        |

**How a deploy flows**

- Push to `main` in **backend** → CI (lint, typecheck, unit, e2e) → `image` job pushes
  `ghcr.io/pera14/sila-api:<sha>` + `:latest` → `deploy` job (`.github/workflows/deploy.yml`).
- Push to `main` in **frontend** → CI → pushes `ghcr.io/pera14/sila-web:<sha>` + `:latest` →
  `repository_dispatch` (`deploy-web`) to this repo → the same `deploy.yml`.
- `deploy.yml` (one at a time, `concurrency: deploy-production`): syncs `infra/` files to `DEPLOY_PATH` over SSH
  (pinned host key), runs `./deploy.sh --api|--web <image:sha>`, then curls `/api/health` and `/login`.
- Why dispatch instead of a second SSH job in the frontend repo: SSH credentials, infra files and the deploy
  logic exist in exactly one place, and both repos' deploys share one concurrency queue.

Images are always pinned to the immutable `:<git sha>` tag (`.env.images` on the server). `:latest` is only
the fallback when nothing is pinned yet.

---

## 1. VPS

Any 2 vCPU / 4 GB Ubuntu 24.04 x86_64 VPS (e.g. Hetzner CX32/CPX21). For an ARM server (Hetzner CAX), add
`linux/arm64` to `platforms:` in both repos' `image` jobs.

```bash
# as root, once
apt-get update && apt-get -y full-upgrade
apt-get -y install unattended-upgrades fail2ban curl ca-certificates
dpkg-reconfigure -plow unattended-upgrades
timedatectl set-timezone Europe/Belgrade     # cron times below are server-local

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh

# firewall: SSH + HTTP(S) only (443/udp = HTTP/3)
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
```

Docker publishes ports by editing iptables directly, bypassing ufw. That is fine here because **only caddy
publishes ports** (80/443); never add `ports:` to another service. Also enable the provider's cloud firewall
with the same rules if available.

### Docker (official repository)

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version   # needs >= 2.24 (multiple --env-file, `up --wait`)
```

### Deploy user, folders

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy                       # NOTE: docker group = root-equivalent on this host
install -d -o deploy -g deploy -m 750 /opt/sila             # DEPLOY_PATH
install -d -o deploy -g deploy -m 700 /var/backups/sila     # BACKUP_LOCAL_DIR
```

CI key (on your machine, not the server):

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f sila_deploy
# public half → server
ssh root@<vps> 'install -d -m 700 -o deploy -g deploy ~deploy/.ssh && cat >> ~deploy/.ssh/authorized_keys && chown deploy:deploy ~deploy/.ssh/authorized_keys && chmod 600 ~deploy/.ssh/authorized_keys' < sila_deploy.pub
# host key for the DEPLOY_KNOWN_HOSTS secret; compare the fingerprint with the provider console
ssh-keyscan -t ed25519 <vps-ip-or-host> | tee known_hosts_line
ssh-keygen -lf known_hosts_line
```

Store the private key `sila_deploy` as the `DEPLOY_SSH_KEY` secret, then delete the local copy.
Add your own personal key to `~deploy/.ssh/authorized_keys` too, for manual work.

### Pulling from GHCR

The packages `sila-api` / `sila-web` are private. Create a **classic PAT with only `read:packages`** (no
expiry is tempting, but prefer 1 year and a calendar reminder), then as `deploy`:

```bash
echo '<PAT>' | docker login ghcr.io -u pera14 --password-stdin    # stored in ~deploy/.docker/config.json
```

(Alternative: make both packages public in GitHub → Packages → settings; the images contain no secrets.)

## 2. DNS

| Record           | Type     | Value         |
| ---------------- | -------- | ------------- |
| `app.<domain>`   | A / AAAA | VPS IPv4/IPv6 |
| `files.<domain>` | A / AAAA | VPS IPv4/IPv6 |

Caddy obtains Let's Encrypt certificates on first request; both names must resolve to the VPS first and
ports 80/443 must be open. Optional: a `CAA` record allowing only `letsencrypt.org`.

E-mail: whichever SMTP provider (Brevo, Postmark, …) — add its SPF/DKIM records and a DMARC record for the
`MAIL_FROM` domain, otherwise invites and password resets land in spam.

## 3. Configuration (`.env.prod`)

First copy the infra files by hand (later deploys sync them automatically):

```bash
# from a checkout of this repo
tar -C infra -czf - docker-compose.yml Caddyfile deploy.sh backup.sh postgres minio .env.prod.example backup.env.example \
  | ssh deploy@<vps> 'tar -xzf - -C /opt/sila'
```

On the server, as `deploy`:

```bash
cd /opt/sila
cp .env.prod.example .env.prod && chmod 600 .env.prod
# fill every empty value; generators:
openssl rand -hex 32                          # passwords, JWT/JOIN/SESSION secrets, S3_SECRET_KEY
echo "sila-key:$(openssl rand -base64 32)"    # MINIO_KMS_SECRET_KEY
```

- Secrets that end up in URLs (`APP_DB_PASSWORD`, `MINIO_ROOT_*`, `S3_*`) must be URL-safe: use hex.
- `SESSION_HINT_SECRET` is shared by api and web automatically (one variable).
- `MAIL_TRANSPORT` is forced to `smtp`: the API refuses to start in production without `SMTP_HOST`/`SMTP_PORT`.
- **Copy the finished `.env.prod` into the password manager.** A restore onto a new server needs it, and
  `JOIN_TOKEN_SECRET` must stay the same for issued join links / calendar URLs to keep working.

`docker compose --env-file .env.prod config --quiet` validates it (it names any missing required variable).

## 4. GitHub configuration

**Backend repo** (Settings → Secrets and variables → Actions; the `production` environment is created on the
first deploy — add required reviewers there if you want a manual approval gate):

| Name                 | Kind     | Value                                                  |
| -------------------- | -------- | ------------------------------------------------------ |
| `DEPLOY_HOST`        | secret   | VPS IP or hostname                                     |
| `DEPLOY_USER`        | secret   | `deploy`                                               |
| `DEPLOY_SSH_KEY`     | secret   | private key `sila_deploy` (whole file)                 |
| `DEPLOY_KNOWN_HOSTS` | secret   | the `ssh-keyscan` line(s) from §1 (pins the host key)  |
| `DEPLOY_PATH`        | secret   | `/opt/sila`                                            |
| `APP_URL`            | variable | `https://app.<domain>` (smoke test + environment link) |
| `DEPLOY_PORT`        | variable | optional, default `22`                                 |

`GITHUB_TOKEN` pushes the image (`packages: write`); no extra secret. After the first push, check
GitHub → Packages → `sila-api` is linked to this repo (Dockerfile label `org.opencontainers.image.source`).

**Frontend repo**:

| Name                     | Kind   | Value                                                                                                                                 |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_REPO_TOKEN`     | secret | already used by CI if the backend repo is private (read access)                                                                       |
| `BACKEND_DISPATCH_TOKEN` | secret | fine-grained PAT, repository `silatraining-backend` only, permission **Contents: Read and write** (required by `repository_dispatch`) |

## 5. First boot

Either push to `main`, or run **Actions → Deploy → Run workflow** in the backend repo with explicit
`api_image` / `web_image` (`ghcr.io/pera14/sila-api:<sha>`). By hand on the server it is the same:

```bash
cd /opt/sila
./deploy.sh --api ghcr.io/pera14/sila-api:<sha> --web ghcr.io/pera14/sila-web:<sha>
```

On the empty volumes this: creates the `sila` role/database + `btree_gist` (postgres init), creates the private
encrypted bucket and the `sila-api` MinIO user (`minio-init`), runs `prisma migrate deploy` (api start), waits
until every healthcheck is green, and Caddy fetches certificates. Check:

```bash
curl -fsS https://app.<domain>/api/health          # {"status":"ok","db":"ok"}
docker compose --env-file .env.prod --env-file .env.images ps
docker compose --env-file .env.prod --env-file .env.images logs -f api
```

### First trainer accounts (production is never seeded)

There is no sign-up for trainers; create them with the CLI baked into the API image. The password is prompted
twice without echo (never on the command line); weak ones are refused (≥ 12 chars, 3 character classes, no
name/e-mail/common words). An existing e-mail is refused, never overwritten.

```bash
cd /opt/sila
docker compose --env-file .env.prod --env-file .env.images exec api \
  node dist/cli/scripts/create-trainer.js --email marko@example.com --first-name Marko --last-name Ilić [--phone "+381 64 123 4567"]
```

Locally the same script runs with `pnpm --filter @sila/api user:create-trainer --email … --first-name … --last-name …`.
Clients join through the trainer's join link / QR code.

## 6. Backups

See `infra/backup.sh` (header) and [RESTORE.md](RESTORE.md).

1. Off-site bucket. **Backblaze B2**: create a private bucket (e.g. `sila-backups`, EU region), enable
   _Default Encryption (SSE-B2)_, set the lifecycle rule **"Keep only the last version of the file"** (the
   S3 API's deletes only hide files in B2; without this rule old versions are kept and billed forever, and
   retention is not real), create an application key restricted to this bucket (Read and Write).
   **Hetzner Object Storage** works the same (S3 API); keep versioning off.
2. `cp backup.env.example backup.env && chmod 600 backup.env`, fill it (single-quote secrets).
3. Optional: a healthchecks.io check (period 1 day, grace 2 h) → `HEALTHCHECK_URL`.
4. Run once by hand and look at the result: `./backup.sh`.
5. Cron as `deploy` (`crontab -e`):

   ```
   15 3 * * * /opt/sila/backup.sh 2>&1 | /usr/bin/logger -t sila-backup
   ```

   Logs: `journalctl -t sila-backup`. A failure exits non-zero and pings `<HEALTHCHECK_URL>/fail`.

Off-site layout: `<bucket>/<prefix>/db/{daily,weekly}/sila-YYYY-MM-DD.dump` and
`<prefix>/documents/{current,daily/YYYY-MM-DD,weekly/YYYY-MM-DD}/…` (14 daily + 8 weekly kept).
Store `backup.env` in the password manager as well.

## 7. Monitoring

- **Uptime**: an HTTP monitor on `https://app.<domain>/api/health` (it also checks the database) every 1–5 min,
  from **outside** the VPS — Uptime Kuma on another machine, or UptimeRobot / Better Stack free tiers.
  Add a second monitor on `https://app.<domain>/login` (web) and a TLS-expiry check.
- **Backups**: healthchecks.io via `HEALTHCHECK_URL` (alerts when the nightly ping is missing or `/fail`).
- **Disk**: Docker logs are capped (10 MB × 5 per container); still alert at 80 % disk (`df -h /`), e.g. via
  the provider's monitoring or a healthchecks.io cron check.

## 8. Day-2 operations

All commands in `/opt/sila` as `deploy`. Shorthand:
`alias dc='docker compose --env-file .env.prod --env-file .env.images'`.

| Task                           | How                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deploy a specific build        | Actions → Deploy → Run workflow (`api_image` / `web_image`), or `./deploy.sh --api …`                                                                                    |
| Roll back the last deploy      | Actions → Deploy → Run workflow with **rollback** ✓, or `./deploy.sh --rollback`                                                                                         |
| Roll back further              | pick a tag from `deploy-history.log` → `./deploy.sh --api ghcr.io/pera14/sila-api:<sha>`                                                                                 |
| Apply a changed `.env.prod`    | `./deploy.sh` (recreates only containers whose config changed)                                                                                                           |
| Logs                           | `dc logs -f --tail 200 api` (Caddy access logs: `dc logs caddy`, signatures redacted)                                                                                    |
| psql                           | `dc exec postgres psql -U postgres -d sila`                                                                                                                              |
| Base images (postgres/caddy/…) | `postgres:16-alpine` / `caddy:2-alpine` follow patch releases on every deploy (`pull`); MinIO/mc are pinned to a release tag in `docker-compose.yml` — bump deliberately |

**Rollback and migrations.** `deploy.sh` never rolls back automatically. Migrations run on API start and are
forward-only: rolling the API back is safe only if the older code works with the newer schema. Write
migrations expand → contract (add columns/tables first, remove them in a later release). If a migration
itself fails, the API stays down with the new pin; fix forward (new commit) or restore the database
([RESTORE.md](RESTORE.md)) before rolling back, because `prisma migrate deploy` refuses to run past a failed
migration (`_prisma_migrations`).

### Secret rotation

Edit `.env.prod`, then `./deploy.sh` unless stated otherwise. Update the password manager copy.

| Secret                                    | Effect / extra steps                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | every user is signed out                                                                                                                                                                                                                                             |
| `SESSION_HINT_SECRET`                     | api + web together (same variable); users sign in again                                                                                                                                                                                                              |
| `JOIN_TOKEN_SECRET`                       | invalidates every join link / QR and iCal feed URL; trainers must regenerate them. Rotate only if leaked                                                                                                                                                             |
| `APP_DB_PASSWORD`                         | first `dc exec postgres psql -U postgres -c "ALTER ROLE sila PASSWORD '<new>'"`, then edit + deploy                                                                                                                                                                  |
| `POSTGRES_SUPERUSER_PASSWORD`             | `ALTER ROLE postgres PASSWORD '<new>'`; the env value only matters on first init                                                                                                                                                                                     |
| `S3_SECRET_KEY`                           | `minio-init` re-runs on deploy and updates the `sila-api` user's secret; the api is recreated with the new one                                                                                                                                                       |
| `MINIO_ROOT_PASSWORD`                     | MinIO reads root credentials from env on restart; deploy                                                                                                                                                                                                             |
| `MINIO_KMS_SECRET_KEY`                    | **cannot be swapped in place** (stored objects are encrypted with it). If compromised: run a backup, stop the stack, remove the `sila_miniodata` volume, set the new key, deploy, then restore the bucket from `documents/current` ([RESTORE.md](RESTORE.md) step 6) |
| SMTP credentials                          | deploy                                                                                                                                                                                                                                                               |
| CI SSH key                                | new key pair → append public key → update `DEPLOY_SSH_KEY` → test a deploy → remove old line from `authorized_keys`                                                                                                                                                  |
| GHCR read PAT                             | new PAT → `docker login ghcr.io` again as `deploy`                                                                                                                                                                                                                   |
| Off-site backup key                       | new B2/Hetzner key → `backup.env` → `./backup.sh` once                                                                                                                                                                                                               |

## 9. Security notes

- Only Caddy is reachable from the internet; postgres, minio and web sit on an internal network with no route out.
- The API uses a non-superuser database role and a MinIO user limited to `sila-documents`; containers run as
  non-root with read-only root filesystems, `no-new-privileges` and all capabilities dropped (except Caddy).
- The bucket has no anonymous policy; objects are only reachable through 5-minute (PUT) / 60-second (GET)
  presigned URLs signed for `https://files.<domain>`. MinIO CORS allows only `https://app.<domain>`.
- Caddy adds HSTS, `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`/`frame-ancestors 'none'`,
  `Permissions-Policy`; limits bodies (1 MB app/API, 25 MB uploads); strips presigned signatures, tokens,
  cookies and `Authorization` from access logs.
- The `deploy` user is in the `docker` group, i.e. effectively root on the VPS: protect its key accordingly.
- Backups leave the server decrypted by MinIO; they are protected by the provider's server-side encryption and
  a bucket-scoped key. If client-side encryption is required, see the open question in RESTORE.md.
