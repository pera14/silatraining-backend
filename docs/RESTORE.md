# Restore

How to bring SILA back from the off-site backups made by `infra/backup.sh` (SPEC §7), onto a fresh VPS or in
place. **Do the restore drill (end of this file) before go-live and then every quarter.**

## What is backed up, and what is not

| Data                       | Where (`<bucket>/<prefix>/…`)                                                      | Kept                |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| PostgreSQL `sila` database | `db/daily/sila-YYYY-MM-DD.dump`, `db/weekly/…` (`pg_dump -Fc`)                     | 14 daily + 8 weekly |
| Documents bucket           | `documents/current/` (mirror), `documents/daily/YYYY-MM-DD/`, `documents/weekly/…` | 14 daily + 8 weekly |
| Last DB dumps (local)      | `/var/backups/sila/sila-YYYY-MM-DD.dump` on the VPS                                | 3 days              |

Not in the backups — keep them in the password manager:

- `.env.prod` (all secrets). `JOIN_TOKEN_SECRET` must be the same after a restore, otherwise every issued join
  link / QR code and calendar-feed URL stops working. JWT/session secrets may differ (users just sign in again).
- `backup.env` (off-site endpoint, bucket and key).
- The GHCR read token (or create a new one).

Caddy certificates are re-issued automatically. `MINIO_KMS_SECRET_KEY` need not match the old server: objects
come back from the backup decrypted and are re-encrypted by the new MinIO with its own key.

All times are UTC dates in object names. Dumps and documents of the same date belong together (same night).

## Shell helpers used below

On the server, as `deploy`, in `/opt/sila`:

```bash
cd /opt/sila
touch .env.images
set -a; . ./backup.env; set +a
export MC_HOST_offsite="${BACKUP_S3_ENDPOINT%%://*}://${BACKUP_S3_ACCESS_KEY}:${BACKUP_S3_SECRET_KEY}@${BACKUP_S3_ENDPOINT#*://}"
OFF="offsite/${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-prod}"
dc() { docker compose --env-file .env.prod --env-file .env.images "$@"; }
# mc inside the stack's networks: alias `src` = local MinIO (root), `offsite` = backup storage
mc() { dc --progress quiet --profile tools run --rm --no-deps -T -e MC_HOST_offsite -v /var/backups/sila:/backup mc "$@"; }
```

## A. Full restore onto a fresh VPS

1. **Provision** the server as in [DEPLOY.md](DEPLOY.md) §1 (VPS, Docker, `deploy` user, folders, GHCR login).
   Do not point DNS at it yet if the old server is still up.

2. **Files**: copy the infra files (DEPLOY.md §3, `tar … | ssh`), then put `.env.prod` and `backup.env` from the
   password manager into `/opt/sila` (`chmod 600`). Load the shell helpers above.

3. **Start only the data services** (empty volumes → init creates role `sila`, database `sila`, `btree_gist`,
   the private encrypted bucket and the `sila-api` MinIO user):

   ```bash
   dc up -d --wait postgres minio
   dc run --rm minio-init
   ```

4. **Pick the backup**: list what exists and choose a date (normally the newest).

   ```bash
   mc ls "$OFF/db/daily/"; mc ls "$OFF/db/weekly/"
   mc ls "$OFF/documents/daily/"
   DAY=2026-10-01            # the chosen date
   ```

5. **Restore the database** (into the empty `sila` database created in step 3):

   ```bash
   mc cp "$OFF/db/daily/sila-$DAY.dump" /backup/restore.dump     # or db/weekly/
   dc exec -T postgres pg_restore -U postgres -d sila --exit-on-error --single-transaction \
     < /var/backups/sila/restore.dump
   # sanity checks: row counts, owner must be `sila`, extension present, migrations recorded
   dc exec -T postgres psql -U postgres -d sila -c 'SELECT count(*) AS users FROM "User"' \
     -c "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'" \
     -c "SELECT extname FROM pg_extension" \
     -c 'SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at'
   ```

   `--single-transaction` makes it all-or-nothing; on error fix the cause, then drop and recreate the database
   (see B.2) and repeat.

6. **Restore the documents** from the snapshot of the same date (use `documents/current/` for the very latest
   state; it is the mirror from the last successful run):

   ```bash
   mc mirror --overwrite "$OFF/documents/daily/$DAY/" src/sila-documents
   mc du src/sila-documents
   mc stat --recursive src/sila-documents | grep -m3 Encryption     # expect: SSE-S3
   ```

   The snapshot contains `documents/<clientId>/<documentId>` keys, exactly the bucket layout. A `.empty` marker
   file means the bucket was empty that night; it is harmless if copied.

7. **Start the app** on the last known-good images (see `deploy-history.log` from the old server if available,
   or the newest `:<sha>` tags in GHCR):

   ```bash
   ./deploy.sh --api ghcr.io/pera14/sila-api:<sha> --web ghcr.io/pera14/sila-web:<sha>
   dc logs api | grep -iE "migrat"        # "No pending migrations to apply" (or newer ones applied)
   ```

8. **Switch DNS** (`app.` and `files.`) to the new server, wait for TLS, then verify (checklist below).
   Update the `DEPLOY_HOST` / `DEPLOY_KNOWN_HOSTS` secrets for CI (DEPLOY.md §4).

9. **Re-enable backups**: install the cron line (DEPLOY.md §6) and run `./backup.sh` once by hand.

## B. In-place restore (same server, e.g. bad data or a broken migration)

1. Stop writers, keep data services up: `dc stop caddy web api`.
2. Recreate the database (it drops everything in `sila`):

   ```bash
   dc exec -T postgres dropdb -U postgres --force sila
   dc exec -T postgres createdb -U postgres -O sila sila
   dc exec -T postgres psql -U postgres -d sila -c 'CREATE EXTENSION IF NOT EXISTS btree_gist'
   ```

   For a quick restore of a recent night the local dump is enough: `ls /var/backups/sila/`.

3. Continue with A.5 (database), optionally A.6 (documents; add `--remove` to `mc mirror` to also delete
   objects that did not exist on that date), then `./deploy.sh` (pin the image matching the restored schema).

### Restore a single document

```bash
mc find "$OFF/documents/daily/$DAY/" --name "<documentId>"
mc cp "$OFF/documents/daily/$DAY/documents/<clientId>/<documentId>" src/sila-documents/documents/<clientId>/<documentId>
```

(The database row must still exist; otherwise restore the database too.)

## Verification checklist (after any restore)

- [ ] `curl -fsS https://app.<domain>/api/health` → `{"status":"ok","db":"ok"}`
- [ ] a trainer can sign in; the client list and calendar show the expected data of that date
- [ ] open a client → Documents → download a file: it opens, with its original name
- [ ] upload a small PDF and download it again (presigned PUT/GET through `files.<domain>`)
- [ ] an existing join link / QR from before the restore still opens the invite screen (`JOIN_TOKEN_SECRET`)
- [ ] a password-reset e-mail arrives (SMTP)
- [ ] `./backup.sh` succeeds on the restored server; healthchecks.io shows the ping

## Restore drill (before go-live, then quarterly)

Goal: prove that last night's backup can rebuild the service, and measure how long it takes.

- [ ] Backups have run at least once: `journalctl -t sila-backup`, healthchecks.io green, objects visible in
      the off-site bucket (`mc ls -r "$OFF" | tail`).
- [ ] Create a throwaway VPS (smallest size is fine) — never drill on production.
- [ ] Follow **A** steps 1–7 using only the password manager and this document. Note every step that was
      unclear or missing and fix this file.
- [ ] Instead of switching DNS, test via the throwaway server's IP with hosts-file entries for `app.<domain>`
      and `files.<domain>` (Caddy cannot get real certificates then: temporarily add `tls internal` to both
      site blocks in the drill server's Caddyfile and accept the browser warning).
- [ ] Run the verification checklist (skip e-mail if the SMTP sender restricts IPs).
- [ ] Compare: user count and newest booking/session timestamp match production as of the backup date;
      the number of objects in `src/sila-documents` matches `documents/daily/$DAY/`.
- [ ] Record the date, backup used, duration (RPO ≤ 24 h, RTO target: < 2 h) and findings below.
- [ ] Destroy the throwaway VPS **and its volumes** (it holds real client health data).

| Date | Backup used | Duration | Result / follow-ups |
| ---- | ----------- | -------- | ------------------- |
|      |             |          |                     |
