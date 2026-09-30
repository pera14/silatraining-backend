# documents module

**Owner:** Agent B (feat/content) · endpoints `trainer.documents.*` · storage in `common/storage`

Trainer-only client documents (SPEC §4, §7) on a private MinIO/S3 bucket with default SSE.

- **Upload:** `POST /trainer/clients/:id/documents` creates a pending row and returns a presigned PUT (5 min). The
  signature covers `Content-Type` and `Content-Length`, so the browser must `PUT` exactly the declared bytes with the
  declared type (anything else is a 403 from storage). Then `POST /trainer/documents/:id/confirm` HEADs the object
  (size/type must match, else `422 UPLOAD_INVALID` and the object is removed). Confirm is idempotent.
- **Download:** presigned GET (60 s, `Content-Disposition: attachment` with the original UTF-8 name). An
  `AuditLog` row (`document.download`) is written before the URL is issued.
- **Delete:** soft (`deletedAt`) + `AuditLog` (`document.delete`).
- **Cron** `documents.purge` (03:45 Europe/Belgrade): removes objects deleted ≥ 30 days ago and uploads never
  confirmed within 24 h, then the rows (`AuditLog` `document.purge`, actor `system`). Storage errors retry next night.
- Keys are `documents/<clientId>/<documentId>` (UUIDs only). Audit `meta` holds ids only, never file names.
- Archived clients' documents stay reachable for their trainer; anything of another trainer is 404.

**`S3_ENDPOINT` must be the URL browsers can reach** (it is embedded in presigned URLs): dev `http://localhost:9000`,
prod `https://files.<domain>` via Caddy (SPEC §7); the API talks to MinIO through the same address.

Tests: `test/documents.e2e-spec.ts` runs against a real MinIO (Testcontainers `pgsty/minio`, started in
`test/setup/global-setup.ts`). To reuse a running MinIO instead (e.g. `pnpm infra:up`), set `TEST_S3_ENDPOINT`
(+ `TEST_S3_ACCESS_KEY` / `TEST_S3_SECRET_KEY`).
