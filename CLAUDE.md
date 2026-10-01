# SILA Training — backend repo

Mobile-first PWA for a personal trainer. **`docs/SPEC.md` is the source of truth**; read it before any work.

## Two repos (deviation from SPEC §2)

The spec's monorepo is split into two sibling repos that must live in the same parent folder:

```
silatraining/
  backend/    ← this repo: apps/api (NestJS) · packages/contracts · infra/ · docs/
  frontend/   ← apps/web (Next.js) · packages/ui   — consumes contracts via link:../backend/packages/contracts
```

Internal paths match the spec (`apps/api/src/modules/...`), so SPEC §8/§9 prompts apply unchanged.
**Git worktrees for the parallel phase must also be siblings in `silatraining/`** (e.g.
`git worktree add ../backend-scheduling -b feat/scheduling`), otherwise the frontend's `../backend` link breaks.

## Commands (repo root)

| Command                                        | What                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                 | install (Node 22, pnpm 10)                                                                                                                                            |
| `pnpm db:setup`                                | **once**: creates role `sila` + databases `sila` / `sila_test` / `sila_e2e` in your local PostgreSQL 16 (e.g. `brew services start postgresql@16`). No Docker needed. |
| `pnpm dev`                                     | build contracts → migrate → contracts watcher + API on :3000 (watch), against local Postgres                                                                          |
| `pnpm dev:docker`                              | optional: same, but Postgres/MinIO/Mailpit in Docker (`infra/docker-compose.dev.yml`)                                                                                 |
| `pnpm db:seed`                                 | wipe + seed dev data (prints logins + join URLs; password `Sila-dev-2026!`)                                                                                           |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | static checks                                                                                                                                                         |
| `pnpm test`                                    | unit tests (contracts: Vitest, api: Jest)                                                                                                                             |
| `pnpm test:e2e`                                | API e2e (Supertest). Uses `TEST_DATABASE_URL` (local `sila_test`, schema reset each run); if unset, Postgres 16 in Testcontainers (CI)                                |
| `pnpm start:e2e`                               | migrate + seed + build + start (used by the frontend's real-stack Playwright; no Docker)                                                                              |
| `pnpm infra:up` / `infra:down`                 | optional Docker containers only                                                                                                                                       |

API docs (dev): http://localhost:3000/api/docs · health: `/api/health`.
**Emails:** with `SMTP_HOST` empty (default locally) `MAIL_TRANSPORT=log` prints every email, e.g. the password-reset link,
to the API console. Set `SMTP_HOST`/`SMTP_PORT` to really send (production refuses log mode).
Parallel worktrees: give each its own `PORT` (A 3100, B 3200) and database (`createdb -O sila sila_a`, `sila_b`) in `.env`.

## Rules for every agent

1. **Contracts first.** Every request/response/error lives in `packages/contracts` (`src/endpoints.ts` registry +
   `src/schemas/*`). Change the contract, rebuild (`pnpm --filter @sila/contracts build`), then implement.
   During the parallel phase changes are **additive only** (new endpoints/optional fields/error codes) and must be
   logged in `docs/CONTRACT_CHANGES.md`.
2. **Never edit in the parallel phase:** `apps/api/prisma/schema.prisma` + migrations (FROZEN), `apps/api/src/app.module.ts`
   (FROZEN — every module is already registered), `modules/{auth,users,join,health}`, `src/common/**` except
   `common/storage` (Agent B), `src/config/**`.
3. **Validation:** controllers take DTOs generated from the registry: `class Dto extends bodyDto('trainer.slots.create') {}`
   (`queryDto`, `paramsDto` too, in `common/http/zod-dto.ts`). A global `ZodValidationPipe` enforces them.
4. **Errors:** throw `new DomainError('SLOT_TAKEN')` (codes/status from contracts `ERROR_STATUS`). The global filter
   renders `{ code, message, details? }`. Translate DB violations with `isConstraintViolation(err, 'unique' | 'exclusion' | 'check', 'constraint_name')`
   (`common/prisma/prisma-errors.ts`): `session_one_per_slot` → `SLOT_TAKEN`, `slot_no_overlap` → `SLOT_OVERLAP`.
5. **Auth & ownership:** every route is authenticated by default (`@Public()` opts out). Add `@Roles('TRAINER' | 'CLIENT')`
   matching the endpoint's `access`. **Also check ownership in the service** with `OwnershipService`
   (`assertTrainerOwnsClient`, `assertOwnedByTrainer`, …); foreign rows are 404 NOT_FOUND. Test allowed + forbidden roles
   and cross-trainer access for every endpoint.
6. **Package numbers are derived, never stored:** use `PackageUsageService` (`common/package-usage`, reads the
   `package_usage` SQL view): `getUsage(ids, tx)`, `findActivePackage(clientId, at, tx)`.
7. **Time:** store UTC `timestamptz`; compute local times in `APP_TIMEZONE` with Luxon via `common/time/time.ts`
   (`localToInstant`, `localDay`, `addMonthsMinusDay`, `addWeeksMinusDay`). `@db.Date` columns are `YYYY-MM-DD` in the API.
8. **Transactions:** every booking, cancellation and attendance change runs in one `prisma.$transaction`.
9. **Events (A emits, B listens):** names and payload types in `common/events/events.ts` (`session.booked`,
   `session.cancelled`, `session.moved`, `client.joined`). Additive only.
10. **Crons:** `ScheduleModule` is global; declare `@Cron()` in your own module's providers.
11. Mail: inject `MailerService` (`send()` never throws); templates live in the notifications module (B).

## Folder ownership (parallel phase, SPEC §8)

| Agent  | Branch                              | Owns (this repo)                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A      | `feat/scheduling`                   | `apps/api/src/modules/{slots,sessions,packages}` + their tests. Also serves `/trainer/today`, `/trainer/calendar`, `/trainer/clients*` (list/flags/detail/archive), `/client/{home,slots,sessions,packages}` and the crons (materialize series, auto-book, auto-attend). |
| B      | `feat/content`                      | `apps/api/src/modules/{notes,exercises,plans,documents,notifications,calendar-feed}`, `apps/api/src/common/storage` + tests                                                                                                                                              |
| C, D   | `feat/trainer-ui`, `feat/client-ui` | nothing here (frontend repo); may request additive contract changes                                                                                                                                                                                                      |
| Nobody | —                                   | `schema.prisma`, `app.module.ts`, auth/users/join/health modules, the rest of `common/`                                                                                                                                                                                  |

Each empty module has a `README.md` listing the endpoint keys to implement.

## Schema notes (frozen; deviations from SPEC §3 are deliberate)

- `Session.slotId` is **nullable, onDelete SetNull**: deleting a slot never erases a cancelled practice (which may still count as used).
- Added `CalendarFeedToken` (Agent B's iCal token) and `NotificationLog` (`@@unique([kind, entityId, recipientId])`, idempotent emails).
- All instants are `timestamptz(3)`; package/series days are `date`.
- Raw SQL (`prisma/migrations/*_constraints_and_views`): `slot_len`, `slot_start` (UTC :00/:30), `slot_no_overlap` (gist
  exclusion, SQLSTATE 23P01), `session_one_per_slot`, `join_link_one_active`, `calendar_feed_one_active`,
  `client_note_one_pinned`, package sanity checks, and the `package_usage` view. Prisma ignores these, so
  `prisma migrate diff` stays empty — do not "fix" that.
- `Slot.parallel` (migration `*_parallel_slots`): trainer-added slots that may overlap others (two clients at once).
  `slot_no_overlap` covers non-parallel slots only; the `MAX_PARALLEL_SLOTS` cap is enforced in `SlotsService` under
  `lockTrainerSlots` (per-trainer advisory lock). Any code that inserts slots must take that lock first.
- onDelete: client-owned data cascades on user delete (supports "Delete client"); `AuditLog`/`NotificationLog` have no FKs.
- Join/calendar tokens: `token = HMAC(JOIN_TOKEN_SECRET, "<purpose>:<rowId>")` (`deriveToken`), DB stores only `sha256(token)`.

## Auth model

Access JWT (15 min, `Authorization: Bearer`) + refresh token in httpOnly cookie `sila_refresh` (Path `/api/auth`, 30 d,
rotated; reuse after a 10 s grace revokes all of the user's sessions). A second httpOnly cookie `sila_session` (Path `/`)
carries a JWT `{sub, role}` signed with `SESSION_HINT_SECRET`, read only by the web app's route gate (`proxy.ts`).
Login/register/accept/forgot/reset are limited to `AUTH_RATE_LIMIT` per minute per IP (default 5; dev `.env` relaxes it).

## Gotchas

- Prisma 7: client is generated to `apps/api/src/generated/prisma` (git-ignored; `pnpm install` / `db:generate` creates it).
  Import from `../generated/prisma/client`. Driver adapter `@prisma/adapter-pg`. Config in `apps/api/prisma.config.ts`.
- Jest needs `NODE_OPTIONS=--experimental-vm-modules` (already in the scripts): Prisma's WASM compiler uses dynamic import.
- Contracts are built with `clean: false` on purpose: the API type-checks against `dist/` while the watcher rebuilds, and an
  emptied `dist/` causes TS7016 in `nest --watch`. `pnpm --filter @sila/contracts build:clean` for a from-scratch build.
- MinIO (only with `dev:docker`; Agent B's storage will need it or a local alternative): upstream images are gone from Docker Hub; compose uses the maintained fork `pgsty/minio` / `pgsty/mc`.
- TypeScript is pinned to 6.0 (typescript-eslint/ts-jest do not support 7 yet).
- Use `migrate deploy` (`pnpm --filter @sila/api db:migrate`); never `migrate dev` in the parallel phase.
