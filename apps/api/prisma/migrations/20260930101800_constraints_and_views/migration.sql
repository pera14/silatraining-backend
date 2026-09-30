-- SILA Training: rules Prisma cannot express (SPEC §3 "Raw SQL migration").
-- Do not remove: booking correctness depends on these constraints.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Slots: exactly 60 min.
ALTER TABLE "Slot" ADD CONSTRAINT slot_len
  CHECK ("endsAt" = "startsAt" + interval '60 minutes');

-- Slots start on :00 or :30 with no seconds. Evaluated in UTC so the check is immutable and independent of
-- the session TimeZone; safe because Europe/Belgrade offsets are whole hours.
ALTER TABLE "Slot" ADD CONSTRAINT slot_start CHECK (
  extract(minute FROM ("startsAt" AT TIME ZONE 'UTC')) IN (0, 30)
  AND extract(second FROM ("startsAt" AT TIME ZONE 'UTC')) = 0
);

-- Slots never overlap per trainer (09:00 and 09:30 cannot both exist). Violations raise SQLSTATE 23P01.
ALTER TABLE "Slot" ADD CONSTRAINT slot_no_overlap
  EXCLUDE USING gist ("trainerId" WITH =, tstzrange("startsAt", "endsAt") WITH &&);

-- One live (non-cancelled) practice per slot. Violations raise 23505 -> 409 SLOT_TAKEN.
CREATE UNIQUE INDEX session_one_per_slot ON "Session"("slotId") WHERE status <> 'CANCELLED';

-- One active join link per trainer.
CREATE UNIQUE INDEX join_link_one_active ON "JoinLink"("trainerId") WHERE "revokedAt" IS NULL;

-- One active calendar feed token per trainer.
CREATE UNIQUE INDEX calendar_feed_one_active ON "CalendarFeedToken"("trainerId") WHERE "revokedAt" IS NULL;

-- At most one pinned note per client (the one shown on the Today card).
CREATE UNIQUE INDEX client_note_one_pinned ON "ClientNote"("clientId") WHERE pinned;

-- Sanity checks on package numbers.
ALTER TABLE "Package" ADD CONSTRAINT package_total_positive CHECK ("totalPractices" > 0);
ALTER TABLE "Package" ADD CONSTRAINT package_valid_range CHECK ("validUntil" >= "validFrom");
ALTER TABLE "Package" ADD CONSTRAINT package_extension_range
  CHECK ("extendedUntil" IS NULL OR "extendedUntil" >= "validUntil");

-- Derived package values (SPEC §3). Practices left are never stored.
--   used           = sessions BOOKED | ATTENDED | NO_SHOW, plus CANCELLED with practiceReturned = false
--   left           = totalPractices + adjustment - used
--   effectiveUntil = extendedUntil ?? validUntil
CREATE VIEW package_usage AS
SELECT
  p.id                                                   AS "packageId",
  p."clientId"                                           AS "clientId",
  p."trainerId"                                          AS "trainerId",
  (p."totalPractices" + p.adjustment)::int               AS "available",
  COALESCE(u.used, 0)::int                               AS "used",
  (p."totalPractices" + p.adjustment - COALESCE(u.used, 0))::int AS "left",
  COALESCE(p."extendedUntil", p."validUntil")            AS "effectiveUntil"
FROM "Package" p
LEFT JOIN LATERAL (
  SELECT count(*) AS used
  FROM "Session" s
  WHERE s."packageId" = p.id
    AND (
      s.status IN ('BOOKED', 'ATTENDED', 'NO_SHOW')
      OR (s.status = 'CANCELLED' AND s."practiceReturned" = false)
    )
) u ON true;
