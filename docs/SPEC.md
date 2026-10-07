# SILA Training App — Implementation Spec & Claude Code Agent Prompts

Sep 30, 2026 · @Petar Obradovic

## 1. Product overview

SILA Training is a mobile-first web app (installable PWA) for a personal trainer. The trainer sees every client's package, payment status, practices left, notes and workout plans, plus a day/week/month calendar. Clients join by link or QR code, book 1-hour practices from the trainer's slots, and see how many practices they have left.

**Scale:** 2 trainers, up to \~10 clients each (\~25 users). One monolith, one database, one VPS.

**Roles**

| Role | Can do |
| --- | --- |
| Trainer | Create 1h slots (single or repeating), leave gaps for breaks, lock slots, reserve repeating slots for a specific client; see the calendar by day, week or month; invite clients by link or QR code; see each client's package, payment status, practices left and valid-until date; mark a package paid; approve an extension to 5 weeks; keep notes per client; keep an exercise library and plans (Plan A, Plan B) per client and pick the plan for each practice; mark each practice with one tap (came / didn't come); book, move or cancel any practice; keep private documents per client |
| Client | Join the trainer via link or QR; see practices left, valid-until date and next practice; book a free slot at least 6h ahead; cancel at least 6h ahead; see upcoming and past practices |

**Key rules**

| Rule | Value |
| --- | --- |
| Practice length | 60 min |
| Slot start times | on the hour (:00) or half hour (:30) |
| Booking cutoff | at least 6h before start (client) |
| Cancellation cutoff | at least 6h before start (client); trainer can cancel anytime |
| Standard package | 10 practices, valid 1 month |
| Extension | up to 5 weeks from package start, approved by the trainer |
| Attendance | one button per practice: Came / Didn't come |
| Exercise tracking | none. Plans are a reference for the trainer, not a log |

**Trainer tab bar:** Today · Calendar · Clients · Profile. **Client tab bar:** Home · Book · Practices · Profile.

**Non-goals for MVP:** online payments (payment status is recorded manually), tracking which exercises were done, native apps, chat, group classes, multi-tenant SaaS.

**Assumptions to confirm:** a no-show uses up a practice; client documents, notes and plans are visible to the trainer only; clients cannot request an extension in-app (they ask the trainer).

## 2. Tech stack and repo layout

The app is a pnpm monorepo with a NestJS API, a Next.js web app, and a shared contracts package, run by Docker Compose.

| Layer | Choice |
| --- | --- |
| Language | TypeScript everywhere, strict mode |
| API | NestJS 11, Prisma ORM, class-validator, `@nestjs/schedule` for cron, `@nestjs/swagger` for OpenAPI |
| DB | PostgreSQL 16 (with `btree_gist` extension) |
| Files | MinIO (S3 API), private bucket `sila-documents`, presigned URLs via `@aws-sdk/client-s3` + `s3-request-presigner` |
| Web | Next.js (App Router), Tailwind, TanStack Query, React Hook Form + Zod; installable PWA |
| Calendar UI | FullCalendar (timeGrid/week + list views) |
| Auth | Email + password (argon2id), JWT access token (15 min) + httpOnly refresh cookie (30 days, rotated), invite tokens |
| Email | Nodemailer via SMTP (e.g. Brevo/Postmark); Mailpit in dev |
| Shared | `packages/contracts`: Zod schemas + inferred types for every request/response, used by API and web |
| Tests | Vitest/Jest unit tests, Supertest e2e against a Testcontainers Postgres, Playwright smoke for web |
| Infra | Docker Compose: `api`, `web`, `postgres`, `minio`, `caddy` (TLS), `mailpit` (dev only) |

**Repo layout**

```
sila/
  apps/
    api/                 # NestJS
      src/modules/{auth,users,join,slots,sessions,
                   packages,notes,exercises,plans,documents,notifications,calendar-feed}
      prisma/schema.prisma
    web/                 # Next.js
      app/(auth)/login, app/(auth)/join/[token]
      app/trainer/...    app/client/...
  packages/
    contracts/           # zod schemas + types (single source of truth for API shapes)
    ui/                  # design tokens + shared components ported from Claude Design
  infra/
    docker-compose.yml  docker-compose.dev.yml  Caddyfile  backup.sh
  docs/SPEC.md           # this document
  CLAUDE.md              # conventions for agents
```

**Environment variables (`.env.example`)**

```
DATABASE_URL=postgresql://sila:sila@postgres:5432/sila
JWT_ACCESS_SECRET=  JWT_REFRESH_SECRET=
APP_URL=https://app.<domain>   API_URL=https://app.<domain>/api
S3_ENDPOINT=http://minio:9000  S3_BUCKET=sila-documents
S3_ACCESS_KEY=  S3_SECRET_KEY=  S3_REGION=us-east-1
SMTP_HOST=  SMTP_PORT=  SMTP_USER=  SMTP_PASS=  MAIL_FROM="SILA Training <no-reply@<domain>>"
APP_TIMEZONE=Europe/Belgrade
BOOKING_CUTOFF_HOURS=6  CANCEL_CUTOFF_HOURS=6  SLOT_HORIZON_WEEKS=8
```

## 3. Data model

A practice is a booking of exactly one slot, and practices left are always computed from the package (total + adjustment − used), never stored as a counter. Overlapping slots and double bookings are blocked by Postgres exclusion constraints. The one exception is a *parallel slot*: an extra slot the trainer adds so two clients can train at once (see §4 Slots).

```prisma
enum Role { TRAINER CLIENT }
enum SlotStatus { OPEN LOCKED }
enum SessionStatus { BOOKED ATTENDED NO_SHOW CANCELLED }
enum PaymentStatus { UNPAID PAID }
enum PaymentMethod { CASH TRANSFER CARD OTHER }

model User {
  id String @id @default(uuid())
  role Role
  email String @unique
  passwordHash String
  firstName String
  lastName String
  phone String?
  photoUrl String?
  consentAt DateTime?
  createdAt DateTime @default(now())
}

model TrainerClient {            // a client belongs to exactly one trainer
  trainerId String
  clientId String @unique
  archivedAt DateTime?
  joinedAt DateTime @default(now())
  @@id([trainerId, clientId])
}

model JoinLink {                 // one active link per trainer, shown as URL + QR
  id String @id @default(uuid())
  trainerId String
  tokenHash String @unique       // sha256 of raw token; raw token only in the URL
  createdAt DateTime @default(now())
  revokedAt DateTime?
}

model RefreshToken { id String @id @default(uuid()) userId String tokenHash String @unique expiresAt DateTime revokedAt DateTime? }
model PasswordReset { id String @id @default(uuid()) userId String tokenHash String @unique expiresAt DateTime usedAt DateTime? }

model SlotSeries {               // repeating slots, e.g. Mon+Wed 18:00
  id String @id @default(uuid())
  trainerId String
  weekdays Int[]                 // ISO 1=Mon..7=Sun
  startTime String               // "18:00" or "18:30", local time
  validFrom DateTime @db.Date
  validUntil DateTime? @db.Date  // null = open-ended
  reservedForClientId String?    // repeating slot for one client
  autoBook Boolean @default(false) // book it for that client automatically
  createdAt DateTime @default(now())
}

model Slot {
  id String @id @default(uuid())
  trainerId String
  startsAt DateTime @db.Timestamptz
  endsAt DateTime @db.Timestamptz  // always startsAt + 60 min
  status SlotStatus @default(OPEN)
  lockReason String?               // e.g. "Break", "Personal"
  reservedForClientId String?      // only this client can see/book it
  seriesId String?
  parallel Boolean @default(false) // trainer-added extra slot that may overlap others (two clients at once)
  @@index([trainerId, startsAt])
}

model Session {                  // a practice
  id String @id @default(uuid())
  slotId String
  trainerId String
  clientId String
  packageId String?               // null = booked by trainer without package
  planId String?                  // which plan the trainer shows that day
  startsAt DateTime @db.Timestamptz
  endsAt DateTime @db.Timestamptz
  status SessionStatus @default(BOOKED)
  practiceReturned Boolean @default(false) // on cancel: given back to package
  createdById String
  cancelledAt DateTime?
  cancelledById String?
  attendanceMarkedAt DateTime?
  reminderSentAt DateTime?
  createdAt DateTime @default(now())
  @@index([clientId, startsAt])
}

model PackageType {              // catalog, e.g. "10 practices / month"
  id String @id @default(uuid())
  trainerId String
  name String
  practices Int                  // 10
  validityMonths Int @default(1)
  priceRsd Int?
  archivedAt DateTime?
}

model Package {
  id String @id @default(uuid())
  clientId String
  trainerId String
  packageTypeId String?
  name String
  totalPractices Int
  adjustment Int @default(0)     // manual +/- with note in AuditLog
  validFrom DateTime @db.Date
  validUntil DateTime @db.Date   // validFrom + 1 month - 1 day
  extendedUntil DateTime? @db.Date // max validFrom + 5 weeks - 1 day
  extensionNote String?
  extensionApprovedAt DateTime?
  priceRsd Int?
  paymentStatus PaymentStatus @default(UNPAID)
  paymentMethod PaymentMethod?
  paidAt DateTime?
  paymentNote String?
  createdAt DateTime @default(now())
}

model ClientNote {
  id String @id @default(uuid())
  clientId String
  trainerId String
  body String
  pinned Boolean @default(false)   // pinned note shows on the Today card
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Exercise {                 // trainer's library
  id String @id @default(uuid())
  trainerId String
  name String
  category String?
  description String?
  videoUrl String?
  archivedAt DateTime?
}

model Plan {                     // "Plan A", "Plan B"
  id String @id @default(uuid())
  trainerId String
  clientId String?               // null = template
  name String
  notes String?
  sortOrder Int @default(0)      // defines the A -> B -> A rotation
  archivedAt DateTime?
}

model PlanExercise {
  id String @id @default(uuid())
  planId String
  exerciseId String
  sets Int?
  reps String?                   // "8-10"
  weight String?
  restSec Int?
  notes String?
  sortOrder Int @default(0)
}

model Document {                 // trainer-only
  id String @id @default(uuid())
  clientId String
  uploadedById String
  s3Key String @unique
  fileName String
  mimeType String
  sizeBytes Int
  confirmedAt DateTime?
  deletedAt DateTime?
  createdAt DateTime @default(now())
}

model AuditLog { id String @id @default(uuid()) actorId String action String entity String entityId String meta Json? createdAt DateTime @default(now()) }
```

Add relations and `onDelete` rules in the real schema. The snippet above shows fields only.

**Raw SQL migration (required, Prisma can't express it)**

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- slots: 60 min, start on :00 or :30, regular slots never overlap per trainer (parallel slots may)
ALTER TABLE "Slot" ADD CONSTRAINT slot_len CHECK ("endsAt" = "startsAt" + interval '60 minutes');
ALTER TABLE "Slot" ADD CONSTRAINT slot_start CHECK (
  extract(minute from "startsAt") IN (0, 30) AND extract(second from "startsAt") = 0);
ALTER TABLE "Slot" ADD CONSTRAINT slot_no_overlap
  EXCLUDE USING gist ("trainerId" WITH =, tstzrange("startsAt", "endsAt") WITH &&) WHERE (NOT "parallel");

-- one live practice per slot
CREATE UNIQUE INDEX session_one_per_slot ON "Session"("slotId") WHERE status <> 'CANCELLED';
```

The `:00/:30` check on UTC is safe because Europe/Belgrade offsets are whole hours.

**Derived values** (one SQL view `package_usage` or a service method):

- `used` = count of sessions on the package with status BOOKED, ATTENDED or NO\_SHOW, plus CANCELLED where `practiceReturned = false`.
- `left` = `totalPractices + adjustment − used`.
- `effectiveUntil` = `extendedUntil ?? validUntil`.
- `active package` = the package where today (or the practice date) falls within `validFrom..effectiveUntil` and `left > 0`, earliest ending first.

## 4. Business rules

Every booking, cancellation and attendance change runs in one database transaction. The rules below are the acceptance criteria for tests.

**Time**

- Store all instants as `timestamptz` (UTC). Slot times are entered and shown in `APP_TIMEZONE` (Europe/Belgrade) using Luxon, so DST is handled correctly.

**Slots (trainer)**

- Every slot is 60 min and starts at :00 or :30 local time. Regular slots never overlap, so 09:00 and 09:30 cannot both exist.
- **Parallel slots** let the trainer run two clients at once: from a slot or a booked practice, "Add another client" creates a single extra slot (`parallel: true`) at the same start or ±30 min (08:00–09:00 + 08:00–09:00, or + 08:30–09:30). Each parallel slot still holds one practice. At most `MAX_PARALLEL_SLOTS` (default 2) slots may run at any moment; otherwise `409 PARALLEL_LIMIT`. Parallel slots are never shown to clients, and regular slots or series days cannot be added on top of one. A client can never have two overlapping live practices: booking (trainer, client or autoBook) or moving into one returns `409 CLIENT_BUSY` (autoBook skips that day). Group classes remain out of scope.
- The trainer creates a single slot, a bulk set (days × start times), or a repeating series (weekdays + time, from/until).
- A nightly cron materializes series into `Slot` rows `SLOT_HORIZON_WEEKS` (8) ahead. Editing or ending a series applies to future unbooked slots only.
- Breaks are simply gaps with no slots. "Block time" locks every open slot in a range with a reason ("Break", "Personal").
- A locked slot is hidden from clients. A booked slot cannot be locked or deleted until its practice is cancelled or moved.
- A slot or series can be reserved for one client, so only that client sees and books it. With `autoBook`, the cron books it for the client whenever an active package with practices left covers that date. Otherwise it stays reserved.

**Booking (client)**

1. The client sees OPEN, unbooked slots of their trainer (plus slots reserved for them) from now + 6h onward.
2. The rule is `startsAt − now ≥ BOOKING_CUTOFF_HOURS` (6); otherwise return `422 BOOKING_CUTOFF`.
3. There must be an active package whose validity covers the practice date with `left ≥ 1`; otherwise return `402 NO_PACKAGE`. Slots beyond `effectiveUntil` show as disabled with "outside your package".
4. Insert the session linked to that package. A unique index or exclusion violation returns `409 SLOT_TAKEN`.

**Booking (trainer)**

- The trainer can book any slot for any of their clients, with no cutoff. The trainer can also book without a package (`packageId = null`), which shows as "no package" in the client list.
- The trainer can move a practice to another free slot, keeping the package and plan.

**Cancellation**

- A client can cancel only if `startsAt − now ≥ CANCEL_CUTOFF_HOURS` (6). The practice goes back to the package and the slot reopens.
- Inside 6h, the client gets `403 CANCEL_CUTOFF` and the UI says "Less than 6 hours left — contact your trainer".
- The trainer can cancel anytime and chooses "return practice to package" (default: yes if ≥ 6h before, no otherwise).

**Attendance (one button)**

- Each practice card has one control: **Came** / **Didn't come**, toggling between ATTENDED and NO\_SHOW. The trainer can change it anytime.
- Practices still BOOKED at the end of the day are auto-marked ATTENDED by a nightly job, so the trainer only needs to tap for no-shows.
- Both ATTENDED and NO\_SHOW use up a practice. No exercise-level tracking.

**Packages and payments**

- The default package type is "10 practices / 1 month": `validUntil = validFrom + 1 month − 1 day`.
- The trainer adds a package with a type, start date, price and payment status. "Mark paid" takes one tap (method + date).
- **Extension:** the trainer approves it with a note and sets `extendedUntil` (at most `validFrom + 5 weeks − 1 day`). There is no client request flow in MVP.
- Unused practices expire at `effectiveUntil`. Manual adjustments of ±N require a note and are written to the AuditLog.
- Client list flags: **Unpaid**, **≤ 2 left**, **expires in ≤ 5 days**, **no active package**.

**Plans and exercises**

- The trainer has an exercise library and plan templates. Assigning a template to a client copies it, so the client's Plan A/B can be edited without touching the template.
- Every practice has an optional plan. A new booking gets the next plan in the client's rotation (by `sortOrder`, after the plan of their last ATTENDED practice: A → B → A). The trainer can switch it from the Today card.

**Notes**

- A client can have many dated notes. A pinned note shows on that client's Today card.

**Joining a trainer (link or QR)**

- Each trainer has one active join link, `APP_URL/join/{token}`, where the token is 32 random bytes (base64url) and only its sha256 is stored. The Profile tab shows it as a QR code (the `qrcode` package, rendered as SVG) with copy and share buttons. Regenerating revokes the old link.
- Opening the link shows the Login Invite screen with the trainer's name and photo. A new person signs up (name, email, phone, password, consent). An existing client logs in instead. Either way, they are linked to the trainer.
- A client belongs to one trainer. Joining a second trainer returns `409 ALREADY_LINKED`.
- The new client appears in Clients with a "no active package" flag.

**Documents (trainer only)**

- Uploads use a presigned PUT (5 min, ≤ 20 MB, pdf/jpg/png/heic/docx), then `confirm`. Downloads use a presigned GET with a 60s TTL, and each download is audit-logged. Deletes are soft, with the object purged after 30 days.

## 5. API contract

All routes live under `/api`. JSON uses camelCase, and errors follow the shape `{code, message, details?}`. Every schema lives in `packages/contracts` first. The guards are `JwtAuthGuard`, `RolesGuard`, and an ownership check in every service: a trainer only touches their own clients, slots and plans, and a client only touches themselves.

**Error codes:** `402 NO_PACKAGE` · `409 SLOT_TAKEN` · `409 ALREADY_LINKED` · `422 BOOKING_CUTOFF` · `403 CANCEL_CUTOFF` · `410 LINK_REVOKED` · `422 SLOT_BOOKED` (lock/delete of a booked slot).

**Auth and join (public)**

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/login` | `{email,password}` → access token + refresh cookie; 5/min/IP |
| POST | `/auth/refresh`, `/auth/logout` | rotate / revoke refresh token |
| GET | `/join/:token` | `{trainerName, trainerPhotoUrl}` or 410 |
| POST | `/join/:token/register` | `{firstName,lastName,email,phone,password,consent}` → logged in as client |
| POST | `/join/:token/accept` | logged-in existing client links to trainer |
| POST | `/auth/password/forgot`, `/auth/password/reset` |  |
| GET | `/me` | current user + role |

**Trainer**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/trainer/today` | today's practices: client, pinned note, plan, package left/paid, status |
| GET | `/trainer/calendar?from&to` | slots + practices for day/week/month views |
| POST | `/trainer/slots` | `{startsAt}` or bulk `{dates[], times[]}`; rejects overlaps |
| PATCH | `/trainer/slots/:id` | `{status, lockReason, reservedForClientId}` |
| DELETE | `/trainer/slots/:id` | only if not booked |
| POST | `/trainer/slots/lock-range` | `{from, to, reason}` → locks open slots (break) |
| GET/POST | `/trainer/slot-series` | `{weekdays, startTime, validFrom, validUntil?, reservedForClientId?, autoBook}` |
| PATCH/DELETE | `/trainer/slot-series/:id` | affects future unbooked slots |
| POST | `/trainer/sessions` | `{slotId, clientId, planId?, withoutPackage?}` |
| PATCH | `/trainer/sessions/:id` | `{status: ATTENDED\|NO_SHOW, planId}` |
| POST | `/trainer/sessions/:id/move` | `{slotId}` |
| POST | `/trainer/sessions/:id/cancel` | `{returnPractice}` |
| GET | `/trainer/clients?flag=` | list with left, validUntil, paymentStatus, next practice, flags |
| GET/PATCH | `/trainer/clients/:id` | profile; archive |
| GET | `/trainer/join-link` | `{url, qrSvg}` |
| POST | `/trainer/join-link/regenerate` | revokes old |
| GET/POST | `/trainer/clients/:id/packages` | history / add |
| PATCH | `/trainer/packages/:id` | payment fields (mark paid) |
| POST | `/trainer/packages/:id/extend` | `{extendedUntil, note}` ≤ 5 weeks |
| POST | `/trainer/packages/:id/adjust` | `{delta, note}` |
| CRUD | `/trainer/package-types` |  |
| GET/POST | `/trainer/clients/:id/notes` |  |
| PATCH/DELETE | `/trainer/notes/:id` | edit, pin |
| CRUD | `/trainer/exercises` | library; DELETE = archive |
| CRUD | `/trainer/plans?template=true` | templates |
| GET/POST | `/trainer/clients/:id/plans` | POST `{fromTemplateId?}` copies a template |
| PUT | `/trainer/plans/:id/exercises` | ordered list |
| GET/POST | `/trainer/clients/:id/documents` | POST → `{documentId, uploadUrl}` |
| POST | `/trainer/documents/:id/confirm` |  |
| GET | `/trainer/documents/:id/download` | `{url}` 60s |
| DELETE | `/trainer/documents/:id` | soft delete |
| GET | `/calendar/:token.ics` | public iCal feed of practices |

**Client**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/client/home` | `{left, total, validUntil, extended, packageName, nextPractice, trainer}` |
| GET | `/client/slots?from&to` | bookable slots (≥ 6h ahead), each flagged `withinPackage` |
| POST | `/client/sessions` | `{slotId}` → 201 / 402 / 409 / 422 |
| GET | `/client/sessions?scope=upcoming\|past` | with `canCancel` |
| POST | `/client/sessions/:id/cancel` | 403 `CANCEL_CUTOFF` inside 6h |
| GET | `/client/packages` | history |
| PATCH | `/client/profile` | name, phone, photo, password |

Enable Swagger at `/api/docs` in dev. The e2e suite covers every row for both the allowed and a forbidden role.

## 6. Frontend and design

The Claude Design project is the visual source of truth. The Login Invite screen is implemented first, pixel-faithful, and its tokens become the design system for every other screen.

**Design source (for the agent)**

```
Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import this project:
https://claude.ai/design/p/8e5d0005-d596-41aa-8867-f967d88841f3?file=Login+Invite.dc.html

Focus on these files (the whole project is readable):
- `Login Invite.dc.html`

Also read these files the selection imports:
- `assets/sila-mark.png`
- `support.js`

Implement: `Login Invite.dc.html`
```

**Rules for porting the design**

- Extract colors, font families, sizes, radii, spacing and shadows from the design into `packages/ui/tokens.ts` and the Tailwind theme. Never hard-code hex values in components.
- Copy `assets/sila-mark.png` to `apps/web/public/brand/`. Generate favicon, PWA icons (192/512) and an apple-touch-icon from it.
- Treat `support.js` as reference for the design's interactions. Re-implement its behavior in React and do not ship it as-is.
- Where the design has no screen yet (everything except Login Invite), build with the same tokens and components, mobile-first (clients will use phones). Keep it plain. Later designs will replace these screens.

**Mobile first.** Design every screen for a 390 px phone first. On desktop, client screens are centered at max-width 480 px, and only the trainer Calendar widens.

**Public routes**

| Route | Screen |
| --- | --- |
| `/login` | Login (same visual shell as Login Invite) |
| `/join/[token]` | **Login Invite**: trainer name + photo, sign up or log in, consent, then land on `/client` |
| `/forgot`, `/reset/[token]` | password reset |

**Trainer — bottom tab bar: Today · Calendar · Clients · Profile**

| Route | Screen |
| --- | --- |
| `/trainer` (Today) | Today's practices in time order. Each card shows time, client, pinned note, practices left + Unpaid badge, and a plan chip (tap to switch Plan A/B, long-press to see its exercises). One large **Came / Didn't come** toggle per card. |
| `/trainer/calendar` | Month · Week · Day toggle (FullCalendar). Slots are drawn as open, locked, reserved (client initials) or booked. Tap empty time to create a slot, bulk slots or a repeating series (:00/:30 picker). Tap a slot to lock/unlock, reserve for a client, book for a client, or delete. Tap a practice for a sheet: plan, attendance, move, cancel (return-practice toggle). "Block time" button for breaks. |
| `/trainer/clients` | Search + flag filters (Unpaid, ≤ 2 left, expiring, no package). The **Invite** button opens a sheet with a QR code, copy link and share. |
| `/trainer/clients/[id]` | Header: name, tap-to-call/WhatsApp, practices left, valid until, Paid/Unpaid. Tabs: **Package** (current + history, add package, mark paid, approve extension, adjust) · **Practices** (upcoming/past with attendance) · **Notes** · **Plans** (Plan A/B with exercises, add from template) · **Documents** |
| `/trainer/profile` | My profile + photo, join link & QR, package types, exercise library, plan templates, calendar feed (iCal) link, logout |

**Client — bottom tab bar: Home · Book · Practices · Profile**

| Route | Screen |
| --- | --- |
| `/client` (Home) | Big "7 of 10 practices left", valid until date (with "extended" label if so), next practice card (cancel button only if ≥ 6h away), Book button. With no active package: "Contact your trainer to start a package." |
| `/client/book` | Month calendar with dots on days that have free slots + a week strip, then a list of 1h slots for the selected day and a confirm sheet. Slots < 6h away are hidden; slots after the package end are disabled. Handle 402/409/422 with friendly messages. |
| `/client/practices` | Upcoming (with cancel when allowed) and past (Came / Didn't come) |
| `/client/profile` | name, phone, photo, password, logout |

Protect routes by role in Next.js `middleware.ts`. Use large tap targets (≥ 44 px), and make the Came/Didn't come toggle usable with one thumb.

## 7. Security, privacy, backups, deployment

Client documents may contain health data, so they are treated as sensitive personal data under Serbia's ZZPL (GDPR-aligned). Keep the bucket private, links short-lived and access logged.

**Security**

- Hash passwords with argon2id. Rate-limit login, invite accept and forgot-password with `@nestjs/throttler`.
- Keep the access token in memory on the web side and the refresh token in an httpOnly, Secure, SameSite=Lax cookie scoped to `/api/auth`.
- Enforce ownership in services, not only guards. Write e2e tests proving trainer A can't read trainer B's clients and client X can't read client Y.
- Set Helmet and CORS to `APP_URL` only. Validate all input with Zod/class-validator and whitelist fields.
- Keep the MinIO bucket private with no public policy. Enable server-side encryption. Build object keys from UUIDs, never raw filenames.
- Write `AuditLog` entries for document download/delete, credit adjustments, and session cancellations by the trainer.

**Privacy**

- Add a privacy notice page, and a consent checkbox on the Login Invite screen ("I agree to processing of my data, including uploaded health documents"). Store `consentAt` on the User.
- For data export and deletion, add a trainer-only "Export client data" (zip) and "Delete client" (hard delete + object removal) action.

**Backups**

- A nightly `pg_dump -Fc` plus `mc mirror` of the bucket goes to off-site storage (e.g. Hetzner Storage Box or Backblaze B2). Keep 14 daily and 8 weekly copies. `infra/backup.sh` runs from cron.
- Document the restore procedure in `docs/RESTORE.md` and test it once before go-live.

**Deployment**

- Run one VPS (2 vCPU / 4 GB, Ubuntu 24.04) with Docker Compose. Caddy terminates TLS for `app.<domain>`, sending `/api/*` to `api:3000` and the rest to `web:3001`. MinIO is not exposed publicly; presigned URLs go through Caddy at `files.<domain>` → `minio:9000`.
- For CI, use a GitHub Actions workflow that runs lint, typecheck, unit and e2e tests. On `main`, it builds images, pushes them to GHCR, then SSHes in to run `docker compose pull && up -d`, and `prisma migrate deploy` runs on API start.
- For monitoring, use Uptime Kuma or a healthchecks.io ping on `/api/health` and on the backup job.

## 8. Execution plan

Run Prompt 0 alone first. Then run Prompts A–D at the same time, each in its own git worktree and branch. Finish with Prompt E. Parallel work is safe because Phase 0 freezes the schema, defines every API contract, and pre-creates every module and route shell, so each agent owns separate folders.

&#91;embedded content: build order · 3 phases, 4 parallel agents\]

The UI agents (C, D) build against MSW mocks generated from `packages/contracts`, so they don't wait for A and B.

**Folder ownership during the parallel phase**

| Agent | Branch | Owns |
| --- | --- | --- |
| A | `feat/scheduling` | `apps/api/src/modules/{slots,sessions,packages}` + crons for series, auto-book, auto-attend |
| B | `feat/content` | `apps/api/src/modules/{notes,exercises,plans,documents,notifications,calendar-feed}`, `apps/api/src/common/storage` |
| C | `feat/trainer-ui` | `apps/web/app/trainer/**`, `apps/web/components/trainer/**`, `packages/ui/src/trainer-*` |
| D | `feat/client-ui` | `apps/web/app/client/**`, `apps/web/components/client/**`, `packages/ui/src/client-*`, PWA files |
| Nobody | — | `schema.prisma`, `app.module.ts`, auth + join modules; contracts are additive-only, logged in `docs/CONTRACT_CHANGES.md` |

**Option 1 — separate terminals (recommended, most visibility)**

```bash
# after Prompt 0 is merged and tagged v0.1-foundation
git worktree add ../sila-scheduling -b feat/scheduling
git worktree add ../sila-content    -b feat/content
git worktree add ../sila-trainer-ui -b feat/trainer-ui
git worktree add ../sila-client-ui  -b feat/client-ui

# one terminal per worktree; give each its own ports + dev DB to avoid clashes
cd ../sila-scheduling && cp ../sila/.env . && sed -i 's/PORT=3000/PORT=3100/' .env && pnpm i && claude
# ...paste Prompt A. Repeat with Prompt B (PORT 3200), C (web 3301, mocks on), D (web 3401, mocks on)
```

The backend agents' e2e tests use Testcontainers, so they don't share a database. For manual dev runs, point each worktree at its own DB name (`sila_a`, `sila_b`) on the shared dev Postgres.

**Option 2 — one orchestrator session using subagents**

Paste this into a single Claude Code session in the main repo:

```
Read docs/SPEC.md and CLAUDE.md. Phase 0 is merged (tag v0.1-foundation). Run the parallel phase:
1. Create four git worktrees with branches exactly as in SPEC §8 (../sila-scheduling, ../sila-content,
   ../sila-trainer-ui, ../sila-client-ui), install deps in each, give each its own PORT in .env.
2. In ONE message, launch four subagents in parallel. Give each the full text of its prompt from SPEC §9
   (A, B, C, D) plus: "Your working directory is <worktree path>. cd there first. Only modify files in the
   folders you own (SPEC §8). Commit to your branch. Do not merge."
3. When all four return, run lint/typecheck/tests in each worktree and give me a table: branch, status,
   tests, open issues, contract changes. Do not merge; I will run Prompt E after review.
```

Option 1 lets you watch and steer each agent. Option 2 is hands-off, but subagents report back only at the end. If they stall on long tasks, fall back to Option 1.

**Merge order:** A → B → C → D (rebase each on main before merging), then run Prompt E on main.

## 9. Agent prompts (copy-paste)

Save this doc as `docs/SPEC.md` in the repo first (export to Markdown). Every prompt below refers to it.

### Prompt 0 — Foundation (one agent, run first, alone)

```
You are building the SILA Training app, a mobile-first web app (PWA). Read docs/SPEC.md fully first; it is the
source of truth.

Goal: a runnable skeleton that 4 parallel agents can build on without touching the same files.

1. Scaffold the pnpm monorepo as in SPEC §2 (apps/api NestJS, apps/web Next.js App Router + Tailwind,
   packages/contracts, packages/ui, infra/). Strict TS, ESLint, Prettier, tests, Husky.
2. infra/docker-compose.dev.yml: postgres 16, minio (+ bucket job), mailpit. .env.example per SPEC §2.
3. Prisma: implement the FULL schema from SPEC §3 with relations, plus the raw SQL migration (slot length,
   :00/:30 start, slot no-overlap exclusion, one live practice per slot). Add the package_usage view or service.
   Seed: 2 trainers, 4 clients, 2 weeks of slots incl. one repeating series, package type "10 practices / month",
   one package per client (one unpaid, one extended), 12 exercises, Plan A + Plan B templates.
   schema.prisma is FROZEN after this phase.
4. packages/contracts: Zod schemas + types for EVERY endpoint and error code in SPEC §5.
5. API: implement auth + join fully (SPEC §4 "Joining a trainer", §5 Auth table): login, refresh rotation,
   logout, /me, join link get/regenerate with QR SVG (qrcode package), /join/:token GET/register/accept, forgot/reset,
   guards, @Roles, ownership helper, throttling, Helmet, error filter, /api/health, Swagger in dev, Mailer service.
   Create EMPTY but registered Nest modules for: slots, sessions, packages, notes, exercises, plans, documents,
   notifications, calendar-feed, so later agents never edit app.module.ts.
6. Web: import the design:
   Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import this project:
   https://claude.ai/design/p/8e5d0005-d596-41aa-8867-f967d88841f3?file=Login+Invite.dc.html
   Focus on these files (the whole project is readable):
   - `Login Invite.dc.html`
   Also read these files the selection imports:
   - `assets/sila-mark.png`
   - `support.js`
   Implement: `Login Invite.dc.html`
   Then: extract tokens into packages/ui + Tailwind theme (SPEC §6 rules). Build /join/[token] from the Login
   Invite design, wired to the real API (sign up or log in, consent, then /client). Build /login in the same
   shell, /forgot, /reset/[token]. Build the typed API client (TanStack Query, auto refresh on 401), role
   middleware.ts, both bottom tab bars (trainer: Today, Calendar, Clients, Profile; client: Home, Book,
   Practices, Profile), and EMPTY route shells for every route in SPEC §6. Add an MSW mock layer from
   packages/contracts with realistic fixtures (toggle NEXT_PUBLIC_API_MOCK=1). PWA manifest + icons from
   sila-mark.png.
7. Tests: e2e for auth + join (new user, existing client, revoked link, already linked, wrong role). CI workflow.
8. Write CLAUDE.md: commands, conventions, folder ownership from SPEC §8, "contracts first",
   "never edit schema.prisma or app.module.ts in the parallel phase", mobile-first at 390px.

Done when: `pnpm dev` runs everything, a seeded trainer shows a QR/link, a new person joins on the designed
screen and lands on /client, all tests green. Commit on main and tag v0.1-foundation.
```

### Prompt A — Scheduling backend (slots, practices, packages)

```
Read docs/SPEC.md and CLAUDE.md. You are Agent A in a parallel phase. You work ONLY in
apps/api/src/modules/{slots,sessions,packages} and their tests. Do not edit schema.prisma, app.module.ts,
other modules, or apps/web. Contract changes: additive only, logged in docs/CONTRACT_CHANGES.md.

Implement per SPEC §4 and §5:
- slots: single + bulk create (60 min, :00/:30 local, Europe/Belgrade via Luxon), lock/unlock, reserve for
  client, delete (not if booked), lock-range for breaks, slot series CRUD. Crons: materialize series 8 weeks ahead,
  autoBook reserved series when the client has an active package with practices left.
- sessions: client booking (6h cutoff, active package covering the date, unique slot -> 409), trainer booking
  (no cutoff, optional withoutPackage), move, cancel (client 6h cutoff; trainer returnPractice flag),
  attendance PATCH (ATTENDED/NO_SHOW), nightly auto-mark BOOKED -> ATTENDED, plan rotation on booking
  (next Plan by sortOrder after the last ATTENDED practice's plan), /trainer/today, /trainer/calendar,
  /client/home, /client/slots, /client/sessions.
- packages: package types CRUD, add package (validUntil = start + 1 month - 1 day), mark paid, extend
  (<= start + 5 weeks - 1 day, note required), adjust with note, left/used/effectiveUntil, client list flags.
- Tests: DST weeks (last Sunday of March/October), overlap rejection, :15 start rejected, 6h boundaries
  (5:59 vs 6:00), concurrent booking of one slot (exactly one 201), package expiry and extension, no-show uses a
  practice, cancel returns it, every endpoint allowed/forbidden role.
Branch feat/scheduling. Commit often. Finish green with a PR summary.
```

### Prompt B — Notes, plans, documents, notifications

```
Read docs/SPEC.md and CLAUDE.md. You are Agent B in a parallel phase. You work ONLY in
apps/api/src/modules/{notes,exercises,plans,documents,notifications,calendar-feed},
apps/api/src/common/storage and tests. Same rules: no schema.prisma/app.module.ts/other modules/apps/web edits;
additive contract changes logged in docs/CONTRACT_CHANGES.md.

Implement per SPEC §4, §5, §7:
- notes: CRUD per client, pin (one pinned per client).
- exercises: library CRUD with archive.
- plans: template CRUD, copy template to client, client plan CRUD, PUT ordered exercises, sortOrder for rotation.
- documents (trainer only): StorageService for MinIO (presigned PUT 5 min with type + size, GET 60s, HEAD,
  delete), create/confirm/list/download (audit log)/soft delete, nightly purge after 30 days.
- notifications: email templates (Serbian primary, English fallback, SILA mark) for welcome after joining,
  booking confirmed, cancelled (by client -> email trainer; by trainer -> email client), 24h reminder,
  package expiring in 5 days (to trainer). Listen to events 'session.booked', 'session.cancelled' via
  @nestjs/event-emitter so Agent A only emits events. Reminder cron every 15 min using reminderSentAt.
- calendar-feed: per-trainer token, public /calendar/:token.ics (ical-generator).
- e2e with a real MinIO (testcontainers) and cross-trainer access tests.
Branch feat/content. Finish green with a PR summary.
```

### Prompt C — Trainer web UI

```
Read docs/SPEC.md and CLAUDE.md. You are Agent C. You work ONLY in apps/web/app/trainer/**,
apps/web/components/trainer/** and packages/ui/src/trainer-*. No API, schema or client-route edits.

Build every trainer screen in SPEC §6 mobile-first (390px) against packages/contracts; develop with
NEXT_PUBLIC_API_MOCK=1. Match the Login Invite design's visual language (re-open the Claude Design project via the
claude_design MCP for reference).
- Bottom tab bar: Today, Calendar, Clients, Profile.
- Today: practice cards with time, client, pinned note, left + Unpaid badge, plan chip (switch A/B, view
  exercises), one big Came / Didn't come toggle with optimistic update.
- Calendar: FullCalendar Month/Week/Day in Europe/Belgrade. Slot states open/locked/reserved/booked. Create slot,
  bulk, repeating series (weekday chips + :00/:30 time picker, from/until, reserve for client, auto-book), Block
  time for breaks, slot actions sheet, practice sheet (plan, attendance, move, cancel with return toggle).
- Clients: search, flag filters, Invite sheet with QR + copy/share link (navigator.share).
- Client detail tabs: Package (add, mark paid, approve extension, adjust), Practices, Notes (pin), Plans (Plan A/B,
  add from template, reorder exercises), Documents (upload with progress).
- Profile: profile/photo, join link & QR, package types, exercise library, plan templates, iCal link, logout.
Loading/empty/error states everywhere. Playwright smoke test per screen at 390px. Branch feat/trainer-ui.
```

### Prompt D — Client web UI

```
Read docs/SPEC.md and CLAUDE.md. You are Agent D. You work ONLY in apps/web/app/client/**,
apps/web/components/client/** and packages/ui/src/client-*. No API, schema or trainer-route edits.

Build every client screen in SPEC §6 mobile-first against packages/contracts; develop with
NEXT_PUBLIC_API_MOCK=1. Follow the Login Invite design's visual language.
- Bottom tab bar: Home, Book, Practices, Profile.
- Home: big "X of Y practices left", valid until (+ "extended" label), next practice card (cancel only if
  >= 6h away, else "Less than 6 hours left - contact your trainer"), Book button, no-package state.
- Book: month calendar with dots on days with free slots + week strip, 1h slot list for the day, confirm
  sheet. Slots outside the package are disabled with a hint. Handle 402 NO_PACKAGE, 409 SLOT_TAKEN (refresh
  slots), 422 BOOKING_CUTOFF.
- Practices: upcoming (cancel when allowed) and past (Came / Didn't come).
- Profile: name, phone, photo, password, logout. iOS add-to-home-screen hint.
Playwright smoke tests at 390px. Branch feat/client-ui.
```

### Prompt E — Integration and deploy (one agent, after A–D merge)

```
Read docs/SPEC.md, CLAUDE.md, docs/CONTRACT_CHANGES.md. Merge feat/scheduling, feat/content, feat/trainer-ui,
feat/client-ui into main in that order, resolving conflicts in favor of the spec. Then:
1. Turn off mocks, run against the real API, fix every mismatch; wire Agent A's events to Agent B's notifications.
2. Full Playwright journey at 390px: trainer shows QR -> client joins -> trainer adds "10 practices / month"
   (unpaid) -> marks paid -> creates a Mon/Wed 18:00 series -> client books (and is blocked at < 6h) ->
   client cancels > 6h (practice returned) -> trainer taps Didn't come on another practice (practice used) ->
   trainer approves extension to 5 weeks -> client Home shows new valid-until date.
3. Security pass per SPEC §7 (cross-trainer e2e, rate limits, headers, private bucket), privacy page + consent.
4. Production: infra/docker-compose.yml, multi-stage Dockerfiles, Caddyfile, backup.sh + docs/RESTORE.md,
   GitHub Actions deploy over SSH, docs/DEPLOY.md.
Tag v1.0-mvp.
```
